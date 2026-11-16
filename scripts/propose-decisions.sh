#!/bin/sh
# Proposes the initial-modeling decisions (ADR-001 was proposed first, by hand: D3).
# Idempotent: every act carries a --request id, so re-running appends nothing.
set -e
cd "$(dirname "$0")/.."
M=continuum/model/quorum.adl-manifest.json
Q=::Quorum.ResearchFunding
p() { continuum decision propose --model "$M" "$@" | head -3; }

p --request quorum-d01 --title "Seven bounded contexts, one writer per store, one SQLite file" \
  --decision "Identity, Calls, Submission, PeerReview, Adjudication, Notification and Oversight each own their data-store resources exclusively; other contexts read through an API operation or an event, never the store. All stores live in one SQLite file (WAL) in one process." \
  --rationale "One writer per fact puts every invariant in exactly one place; one file keeps NFR-1 (local, no paid infrastructure) and lets synchronous cross-context checks be strongly consistent." \
  --scope $Q --alternative "Modules writing each other's tables" --alternative "One database per context" \
  --consequence "The implementation enforces ownership by table prefix and module imports, checked by continuum conformance" \
  --expect "$Q.PeerReview.AssignmentService writes $Q.PeerReview.ReviewStore" \
  --expect "not $Q.PeerReview.ReviewCompletion writes $Q.PeerReview.ReviewStore" \
  --expect "$Q.Adjudication.AdjudicationService writes $Q.Adjudication.AdjudicationStore"

p --request quorum-d02 --title "Consistency-critical cross-context checks are synchronous in-transaction calls" \
  --decision "INV-1 (call open and before deadline) is checked by ProposalService invoking CallApi.GetCallStatus inside the submit transaction; INV-12 (ORCID verified) by AssignmentService invoking IdentityApi.GetReviewerStanding inside the assign transaction. Event-fed replicas are used only where staleness is safe (applicant id, criteria snapshot, budget envelope)." \
  --rationale "A replica fed by CallClosed lags, so a proposal could be submitted to a call the officer already closed. In one SQLite file a synchronous read inside the writer's transaction is strongly consistent at no cost." \
  --scope $Q.Submission.ProposalService --scope $Q.PeerReview.AssignmentService \
  --alternative "Event replica of call status and reviewer standing" \
  --expect "$Q.Submission.ProposalService invokes $Q.Calls.CallService.CallApi.GetCallStatus" \
  --expect "$Q.PeerReview.AssignmentService invokes $Q.Identity.AccountService.IdentityApi.GetReviewerStanding"

p --request quorum-d04 --title "Add Eligible and terminal Ineligible to the proposal lifecycle" \
  --decision "Screening -> Eligible (screened in, awaiting reviewers) and Screening -> Ineligible (terminal, screened out by a program officer). Eligible -> UnderReview on the third assignment." \
  --rationale "Declined is a panel outcome only a Panel Chair may record (INV-8); an officer writing Declined would read as an INV-8 violation in the audit trail and the portfolio. A flag inside Screening hides the most important queue state." \
  --scope $Q.Submission.ProposalService --business continuum/model/quorum.bdl \
  --alternative "Reuse Declined for screening rejections" --alternative "Keep Screening and add an eligibility flag" \
  --consequence "Deviation from the brief's lifecycle, recorded in BDL Proposal description" \
  --expect "lifecycle Proposal.status Eligible between Screening" \
  --expect "precondition RecordPanelDecision excludes Proposal.status Eligible"

p --request quorum-d05 --title "Conflicts live with assignments; declaring one revokes atomically" \
  --decision "ConflictDeclaration is owned by PeerReview. Declaring a conflict revokes any active assignment of that reviewer to that proposal in the same transaction. After the review was submitted but before scoring, the review is voided and the officer reassigns. After scoring, the conflict holds the award (decline still possible). After a decision: unspecified (BDL ConflictAfterDecision, accountable Program Officer)." \
  --rationale "INV-3 says a conflicted reviewer can never HOLD an assignment, not only never be given one. Refusing a late declaration hides the conflict, which is worse than holding an award." \
  --scope $Q.PeerReview.AssignmentService --scope $Q.Adjudication.AdjudicationService --business continuum/model/quorum.bdl \
  --alternative "Refuse conflict declarations after review submission" --alternative "Automatically void decided awards" \
  --expect "$Q.PeerReview.AssignmentService handles $Q.PeerReview.DeclareConflict" \
  --expect "$Q.Adjudication.AdjudicationService subscribesTo $Q.PeerReview.ConflictDeclared"

p --request quorum-d06 --title "INV-9 enforced by one conditional write on Adjudication's own budget ledger" \
  --decision "CommitAward runs UPDATE adj_budget SET committed = committed + amount WHERE call_id = ? AND committed + amount <= envelope, plus a CHECK (committed <= envelope). The envelope is copied from CallPublished and is immutable once a call opens; an award equals the requested amount. A refused award returns the case to the chair through a reconsider task that admits only a decline." \
  --rationale "A conditional write is atomic across connections and processes, not just within one Node thread; reading the sum from the portfolio would trust an eventually consistent view. The envelope never grows and awards are final, so a refused award can never later succeed." \
  --scope $Q.Adjudication.AdjudicationService --scope $Q.Adjudication.PanelDecision \
  --alternative "Sum awarded amounts from the portfolio read model" --alternative "Read-then-write check in application code" --alternative "Loop the workflow back to the chair's decision task (irreducible control flow)" \
  --risk "A future 'adjust envelope' feature would invalidate the reconsider-only-declines reasoning" \
  --expect "$Q.Adjudication.AdjudicationService writes $Q.Adjudication.AdjudicationStore" \
  --expect "$Q.Adjudication.AdjudicationService subscribesTo $Q.Calls.CallPublished" \
  --expect "not $Q.Adjudication.AdjudicationService reads $Q.Oversight.Portfolio"

p --request quorum-d07 --title "Transactional outbox, per-proposal ordering, per-consumer progress, park after five attempts" \
  --decision "Events are appended to one outbox table in the publishing transaction, with a global sequence and a partition key (the proposal, call or account). Delivery progress is tracked per consumer; a consumer's effect and its delivery mark commit in one transaction; a later event is never delivered to a consumer while an earlier one in the same partition is undelivered; failures retry with backoff and park as failed after five attempts, holding the partition until an officer retries. The log is retained and is the audit trail." \
  --rationale "NFR-5 orders events per proposal across publishers; fan-out needs per-consumer progress; committing effect and mark together makes an interrupted delivery roll back whole and a replay a no-op." \
  --scope $Q --alternative "Per-aggregate sequences" --alternative "One delivered flag per outbox row" --alternative "In-memory event bus" \
  --consequence "Delivery guarantees are realized by the sqlite-outbox technology in the binding, which claims ordered, at-least-once and durable" \
  --risk "A parked message stops that proposal's progress for that consumer until an officer acts; surfaced on the operations view"

p --request quorum-d08 --title "Every command carries an Idempotency-Key logged in the same transaction as its effect" \
  --decision "Mutating requests require an Idempotency-Key header; the key, a hash of the request and the response are stored in the command's own transaction. A repeat returns the stored response; the same key with a different body is refused (422). Natural occurrence identities (proposalId for submit and decide, assignmentId for assign) make the domain idempotent as well." \
  --rationale "Logging after the effect would replay the effect after a crash between the two (NFR-6)." \
  --scope $Q.Submission.SubmitProposal --scope $Q.PeerReview.AssignReviewer \
  --alternative "Header-only dedupe written after the effect" --alternative "No dedupe; rely on state guards alone"

p --request quorum-d09 --title "Fixed 21-day review period; late reviews accepted; explicit acceptance" \
  --decision "Each assignment is due P21D after it is made; the stored dueAt is authoritative and a sweeper re-reads it. An overdue assignment still accepts a review (Overdue -> Completed), which carries a no-conflict attestation. The officer may revoke and replace an overdue reviewer. Reviewers accept an assignment before scoring." \
  --rationale "Refusing a finished review helps nobody; ADL wait deadlines take a fixed duration; acceptance is where a reviewer attests no conflict." \
  --scope $Q.PeerReview.ReviewDeadline --scope $Q.PeerReview.AssignmentService --business continuum/model/quorum.bdl \
  --alternative "Reject late reviews" --alternative "Per-call configurable review period" \
  --expect "lifecycle Assignment.status Overdue between Accepted" \
  --expect "$Q.PeerReview.ReviewDeadline triggeredBy $Q.PeerReview.ReviewerAssigned"

p --request quorum-d10 --title "The chair's decision deadline escalates and never decides" \
  --decision "The PanelDecision human task has a 14-day escalation to the program officer and no expiry; nothing is decided by timeout." \
  --rationale "A timeout is not a panel decision (INV-8, HumansDecide)." \
  --scope $Q.Adjudication.PanelDecision --alternative "Expiry that auto-declines"

p --request quorum-d11 --title "Triage is advisory and non-blocking; the agent holds no command-sending tool and no decision autonomy" \
  --decision "Submission enters Screening by its own reaction to ProposalSubmitted. The Triage workflow runs the EligibilityTriage agent (autonomy score-only, constrained by AgentProposesOnly) and records its verdict as a TriageProposal through an operation; on agent failure the verdict is recorded as absent. Only a program officer's ConfirmEligibility leaves Screening. The agent runs as its own principal with no roles, distinct from the platform." \
  --rationale "INV-10. A failed provider must not strand proposals. The first draft copied 'approval: decide-rejection' from an example, which would have described the opposite of INV-10; the architect's review caught it." \
  --scope $Q.Submission.EligibilityTriage --scope $Q.Submission.Triage --business continuum/model/quorum.bdl \
  --alternative "Screening waits for the agent" --alternative "The agent's verdict auto-applies when confident" \
  --risk "INV-10 in ADL rests on the absence of a command-sending tool; a later 'uses' edge would erase it with no diagnostic, so a test verifies the agent itself" \
  --expect "$Q.Submission.EligibilityTriage constrainedBy $Q.Submission.AgentProposesOnly" \
  --expect "$Q.Submission.ProposalService handles $Q.Submission.ConfirmEligibility" \
  --expect "$Q.Submission.Triage triggeredBy $Q.Submission.ProposalSubmitted"

p --request quorum-d12 --title "Roles are read from the account store on every request" \
  --decision "The JWT carries only the account id; roles are loaded from the account store per request and every API route declares the roles it admits. A route with no declaration fails server startup." \
  --rationale "A revoked role in a token claim would persist for up to 8 hours (INV-11, NFR-3). Deny by default is enforced at build time of the server, not by convention." \
  --scope $Q.Identity.AccountService --alternative "Role claims in the token"

p --request quorum-d13 --title "The event log is the audit trail, projected by Oversight" \
  --decision "Every state transition publishes an event carrying actor, timestamp and reason in the same transaction; the Oversight PortfolioProjector projects the AuditTrail read model (per proposal: the timeline) and the Portfolio. Neither reads a write-side store." \
  --rationale "A shared audit table would have seven writers (cross-context resource access). J8 requires the portfolio to come from a projection." \
  --scope $Q.Oversight.PortfolioProjector \
  --alternative "A shared audit_log table written by every context" \
  --expect "$Q.Oversight.PortfolioProjector projects $Q.Oversight.AuditTrail" \
  --expect "$Q.Oversight.PortfolioProjector projects $Q.Oversight.Portfolio" \
  --expect "not $Q.Oversight.PortfolioProjector reads $Q.Submission.ProposalStore"

p --request quorum-d14 --title "Delivery is a binding claim; OutboxMessage is Notification's outbound store" \
  --decision "The event outbox is technology (binding: sqlite-outbox, claiming ordered/at-least-once/durable), not a model resource. The brief's OutboxMessage (queued -> delivered | failed) is Notification's OutboundMessageStore, unique on (event, recipient), drained to a mail transport that is a stub locally." \
  --rationale "Delivery is how, not what; the semantic model stays technology-free and the guarantee is checked as a binding claim." \
  --scope $Q.Notification.NotificationService --alternative "Model the event outbox as a domain resource"

p --request quorum-d15 --title "The refused-award path admits only the chair's acknowledged decline" \
  --decision "After CommitAward is refused, the workflow enters a 'reconsider' human task assigned to the Panel Chair whose only outcome type is DeclineAcknowledgement (rationale, actor, time). Decision events carry the deciding actor and rationale from the task outcome." \
  --rationale "The architect's review found the first shape recorded a decline even if the chair answered 'award' (the workflow deciding, not the chair), and that decision events carried no actor, breaking the audit trail at its most important point." \
  --scope $Q.Adjudication.PanelDecision --alternative "Unguarded reconsider -> decline" --alternative "Loop back to the decide task"

p --request quorum-d16 --title "Only AssignmentService writes Overdue; the deadline workflow invokes it" \
  --decision "ReviewDeadline waits for ReviewSubmitted or AssignmentRevoked with a P21D deadline; on the deadline it invokes AssignmentService.ReviewApi.MarkOverdue and then publishes ReviewOverdue. AssignmentService does not itself publish ReviewOverdue." \
  --rationale "The review found ReviewOverdue had two publishers and no declared writer of the Overdue status." \
  --scope $Q.PeerReview.ReviewDeadline --scope $Q.PeerReview.AssignmentService \
  --alternative "AssignmentService sweeper publishes ReviewOverdue directly" \
  --expect "$Q.PeerReview.ReviewDeadline.mark invokes $Q.PeerReview.AssignmentService.ReviewApi.MarkOverdue"
