#!/bin/sh
# Proposes the production-readiness decisions (ADR-018 onwards). Proposals only: acceptance is the owner's.
# Idempotent: every act carries a --request id, so re-running appends nothing.
set -e
cd "$(dirname "$0")/.."
M=continuum/model/quorum.adl-manifest.json
Q=::Quorum.ResearchFunding
p() { continuum decision propose --model "$M" "$@" | head -3; }

p --request quorum-d18 --title "Escalation, refused awards and integrity holds are published events" \
  --decision "PanelDecision's escalation publishes DecisionEscalated at most once per case (the escalated_at stamp is written in the same transaction) and NotificationService tells the program officers; a refused award publishes AwardRefused before the reconsider task; placing an integrity hold publishes AwardHeld. All three are projected into the audit trail." \
  --rationale "The decide task's escalation clause says the officer is notified, and NFR-8 audits every transition; a stamp the officer only sees when opening the work queue notifies no one, and an unpublished transition cannot appear in the audit trail (review B3, B4)." \
  --scope $Q.Adjudication.AdjudicationService --scope $Q.Adjudication.PanelDecision \
  --alternative "Flag the case on the officer's work queue only" --alternative "Write audit rows directly from Adjudication into the Oversight store" \
  --expect "$Q.Adjudication.AdjudicationService publishes $Q.Adjudication.DecisionEscalated" \
  --expect "$Q.Notification.NotificationService subscribesTo $Q.Adjudication.DecisionEscalated" \
  --expect "$Q.Oversight.PortfolioProjector subscribesTo $Q.Adjudication.AwardRefused"

p --request quorum-d19 --title "An Operator role owns operations; officers no longer retry deliveries" \
  --decision "Delivery retry and skip, projection rebuild, backup and personal-data erasure require the operator role, which holds no business authority; every operator act is written with actor and reason to an append-only platform log (ops_action). Program officers see delivery health read-only." \
  --rationale "Recovery actions change what the system does with business events; giving them to a business role mixes authority (review B5) and leaves platform acts unaudited." \
  --scope $Q.Identity.AccountService \
  --alternative "Keep operations under the programOfficer role" --alternative "Operations only from the host command line, with no audit" \
  --expect "exists ::Quorum.Operator"

p --request quorum-d20 --title "Repeatedly failing deliveries: park, alert, then retry or skip with a reason; never skip an invariant's input" \
  --decision "After five attempts a delivery is parked (its partition held for that consumer only) and an alert is raised (structured log line and optional webhook). An operator retries it after fixing the cause, or skips it with a recorded reason. Skipping is refused for submission.*, peer-review.* and adjudication.* consumers, whose effects guard an invariant." \
  --rationale "Ordering over liveness is kept (ADR-007), but a poison message must not hold a proposal forever where its effect is informational or rebuildable (review B6). Skipping an invariant's input (a ConflictDeclared hold, a ledger row, a status transition) would silently break the invariant." \
  --scope $Q \
  --alternative "Automatic skip after N attempts" --alternative "Allow skipping any consumer" --alternative "Dead-letter queue with manual replay only" \
  --risk "A skip drops the event's whole effect, including state later events rely on (a skipped ProposalSubmitted notification means later applicant emails cannot be addressed)"

p --request quorum-d21 --title "Erasure by pseudonymisation and redaction of the retained event log" \
  --decision "EraseAccount (operator only) pseudonymises the account, deletes its credentials and roles, and in the same transaction replaces the account's personal values in every retained event payload and the command log with a fixed marker; AccountErased (carrying no personal data) makes Notification and Oversight scrub their copies. Business records are kept and refer to the account by id." \
  --rationale "The event log is the audit trail and the replay source, so it must stay replayable; a projection rebuilt from the redacted log equals the live erased projection. Quorum has no key management for per-subject encryption." \
  --scope $Q.Identity.AccountService \
  --alternative "Crypto-shredding with per-subject keys" --alternative "Delete the account's events" --alternative "Leave the event log untouched" \
  --risk "Mail already delivered and backups taken before the erasure keep the data until they age out; free text that does not contain the exact values is not found" \
  --expect "$Q.Identity.AccountService handles $Q.Identity.EraseAccount" \
  --expect "$Q.Identity.AccountService publishes $Q.Identity.AccountErased"

p --request quorum-d22 --title "Rate limiting in process, on failed sign-ins and per-account request rates" \
  --decision "Fixed-window limits held in memory: failed sign-ins per (address, email) and per address, writes and reads per account (per address when anonymous); 429 with Retry-After and nothing applied." \
  --rationale "The deployment is exactly one process (ADR on SQLite viability), so in-memory windows are exact; a shared store adds infrastructure NFR-1 avoids." \
  --scope ::Quorum.QuorumServer \
  --alternative "Limits at a reverse proxy only" --alternative "A shared store (Redis) for counters" \
  --risk "A second instance would need a shared store; behind a proxy, trustProxy must be configured or every client shares one address"
