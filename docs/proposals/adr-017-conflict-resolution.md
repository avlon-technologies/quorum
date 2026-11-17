# ADR-017 (proposed): resolving ADR-005 vs INV-3

**Status: PROPOSAL.** Nothing here is adopted. The owner (Michael Kang) accepts or rejects.
No agent has accepted, rejected, superseded or revoked any decision, accepted a package or recorded a ledger entry.
`continuum/model/quorum.adl` and `quorum.bdl` were not edited.

| Artifact | Path | Verdict (quoted from the tool that ran) |
|---|---|---|
| ADL change | `continuum/model/changes/adr-017-conflict-void-rereview.adl-change` | `continuum_apply`: `status: applied`, `applicability: applies`, `validity: valid`, `errors: 0`, `warnings: 1` (the existing `adl/execution/unset-field-read` on `Submission.Triage.record`); base `sha256:434cfdc2…ef96` → state `sha256:d5a6de97…3064`; 107 operations |
| BDL proposal | `continuum/model/changes/adr-017-quorum.proposed.bdl` (full proposed document; diff in Appendix B) | `continuum business compile`: `valid yes`, `0 errors`, 1 warning `bdl/analytical/no-declared-performer — ac-q023` (also present in the adopted BDL) |
| Decision | ADR-017 (Host event 28; check event 29) | `continuum decision check`: "Alignment Change required: 0 hold, 0 contradicted by a declaration, 4 missing from the model". Expected: the change is not applied. Option `void-rereview-integrity-review`: "applies: sha256:434cfdc2... -> sha256:d5a6de97..." |

## Re-base notice

The change is pinned to the **working-tree** state at the time of writing, changeState
`sha256:434cfdc26bc0503ab8b87c0737759ea0a99fd017baed8c376ec76256cec2ef96` (attestation
`sha256:6d1550a3…8d59`). That state includes the owner's in-flight edits (Operator actor, AwardHeld,
AwardRefused, DecisionEscalated, AccountErased, PersonalDataErasable). HEAD 6912f6c is
`sha256:e9c76035…1d68`. **If `quorum.adl` moves, the change is stale and must be re-based**:
recompile with `--state`, re-pin `base … state`, and re-derive the four whole-set
`attributes.reactions` values (ProposalService, AssignmentService, ReviewCompletion,
AdjudicationService), which restate every reaction of those services. The owner's new `AwardHeld`
event keeps a meaning under this proposal (the transient hold of phase 4), but its description
("holds the award after scoring (ADR-005)") must be revised on re-base.

## Pre-existing defect found (declared by the tool, not by me)

A no-op change against the current state **and against HEAD** fails `apply` result validation with
three `adl/semantic/reaction-correlation` errors that `continuum compile` does not report
(`ProposalService` reactions 2 and 3: key-type `text` vs `ProposalId`; `AssignmentService` reaction 3:
`ProposalId` vs `text`). The host's `continuum_apply` gives the same three. Consequence: **no change to
this model can apply until it is repaired.** Part 0 of the change repairs it by typing PeerReview's
proposal-keyed records as Submission's `ProposalId` alias (`ConflictData`, `AssignmentRequest`,
`AssignmentData`, `ReviewersAssignedData`, `ReviewSubmittedData`, `DeadlineState`, `ReviewDeadline`
state; version cascades `v2`). Alternative: type Submission's records as `text` (tried: it cascades
into six more mismatches). Why `compile` and `apply` disagree is NOT CHECKED; it is a tool question
worth raising. Part 0 can be split out as its own change if the owner prefers.

## 1. What the sources say (read, not summarised from the brief)

- **INV-3** (`product/PRODUCT_REQUIREMENTS.md` §5): "A reviewer with a declared conflict against a proposal can never hold an assignment to it." Consequence column: "A conflicted review is void and voids the award."
- **§1**: "When this is discovered after an award, the award is void and the body is in the press."
- **§4**: PanelDecision, identity `ProposalId`, "recorded once, terminal". Proposal lifecycle ends `awarded | declined`.
- **ADR-005** (proposed): revoke a live assignment; void before scoring; after scoring the conflict holds the award (decline still possible); after a decision unspecified.
- **ADR-001** (proposed): only `Submission.ProposalService` changes `Proposal.status`, by conditional update; a late event is a recorded no-op. (Per-store single writer is ADR-002.)
- **ADR-006** (proposed): one conditional write on `adj_budget`; envelope immutable; "awards are final", so a refused award can never later succeed and `reconsider` admits only a decline. Risk recorded there: "A future 'adjust envelope' feature would invalidate the reconsider-only-declines reasoning."
- **ADR-015** (proposed): `reconsider` admits only the chair's acknowledged decline.
- **BDL**: r-q003 says declaring a conflict "revokes any active assignment at once"; r-q013 says after scoring the award is held and decline remains. Code's `ACTIVE` includes `completed`, so under r-q003 a completed assignment must be revoked, which r-q013 forbids. That is the contradiction. `unspecified ConflictAfterDecision` is accountable to "Program Officer".
- **Code** (derived from reading it):
  - `declareConflict` (`src/contexts/peer-review/service.ts`) decides "scored" by reading `rev_completion`. The ADL does not declare that `AssignmentService` reads `CompletionLedger`. This change declares it.
  - `revoke(..., {voidSubmitted:true})` voids by setting `rev_review.voided_at`; `revokeAssignment` refuses `completed`.
  - `completionConsumer` (`completion.ts`) no-ops if any `rev_completion` row exists (PK `proposal_id`): once per proposal, forever.
  - `react` in `submission/service.ts` is conditional on the prior status.
  - `adj_case`, `adj_decision` and `adj_pending_hold` are keyed by `proposal_id`.
  - `recordDecision` fails closed while any `adjudication.*` delivery for the proposal partition is not delivered. `publish` fans out an `evt_delivery` row per subscribed consumer in the publishing transaction (`platform/events.ts`), so this check covers every event Adjudication subscribes to.
- **Disbursement**: neither model nor code has any disbursement concept. Quorum records commitments only. *Unknown* how money leaves the body.

## 2. The decision in one paragraph (recommended)

INV-3 becomes literal in the context that owns conflicts. `DeclareConflict` revokes the reviewer's assignment in **every** state, including `completed`, and voids their review in the same transaction. Completion becomes **per review round**. A voided review that counted in the current round supersedes that round (`ProposalReviewReopened`). Submission returns a `scored` proposal to `underReview` (`ProposalReturnedToReview`), and the officer assigns a replacement; INV-5 always requires one, because a void always leaves two counted reviews. Adjudication fails closed from the conflict until the open case is superseded (`CaseSuperseded`). After a decision, **option (c)**: the decision is suspended, and a Program Officer's integrity review upholds or rescinds it.

## 3. Phase-by-phase trace (proposed behaviour)

Notation: **PR** PeerReview (AssignmentService writes `rev_case/rev_conflict/rev_assignment/rev_review/rev_score`; ReviewCompletion writes `rev_completion`); **SUB** Submission.ProposalService (only writer of `sub_proposal.status`, ADR-001); **ADJ** AdjudicationService (only writer of `adj_*`); **NTF** Notification; **OVS** Oversight projector. Every event goes to the outbox in the writer's transaction (ADR-007), partition `proposal:<id>`, delivered in sequence per consumer. Audit = the event log projected by OVS (ADR-013).

### Phase 1 — before assignment

| | |
|---|---|
| Commands / events | `DeclareConflict` (reviewer for self only if assigned, so in practice an officer) → `ConflictDeclared{voidedReview: none, countedInRound: none, revokedAssignment: none}`. A later `AssignReviewer` is refused (409 `conflict_of_interest`, INV-3), also by trigger `rev_assignment_no_conflict`. |
| Writes | PR inserts `rev_conflict` (PK reviewer, proposal). Nothing else. |
| States | proposal eligible or underReview, unchanged; no assignment or review; no case. |
| Mean / completion / decision / budget | untouched. |
| Notifications / audit | Audited (`ConflictDeclared` → AuditTrail). No notification (unchanged; NTF does not subscribe to ConflictDeclared). |
| Idempotency / races | Natural key (reviewer, proposal), occurrence identity `conflictKey`, `Idempotency-Key` (ADR-008). A repeat changes nothing and publishes nothing. Conflict vs a concurrent assign: SQLite serialises them; whichever commits second sees the other's row (the trigger refuses the insert, or the conflict finds the new assignment and revokes it, as in phase 2). |

### Phase 2 — assigned, review not submitted

| | |
|---|---|
| Commands / events | `DeclareConflict` → `ConflictDeclared{revokedAssignment: id, voidedReview: none}` + `AssignmentRevoked`. |
| Writes | PR: `rev_conflict`; `rev_assignment` assigned/accepted/overdue → `revoked`; pending `rev_review.voided_at` set. |
| States | assignment revoked; review Pending → Voided; proposal unchanged (eligible or underReview). Active count drops to 2, so the officer assigns a replacement; the third assignment republishes `ReviewersAssigned`, a no-op for SUB if already underReview. |
| Mean / completion / decision / budget | untouched. `ReviewDeadline` ends on `AssignmentRevoked`. |
| Notifications / audit | NTF on `AssignmentRevoked` (reviewer, officer); audit both events. |
| Races | Conflict vs the reviewer's `SubmitReview`: serialised. If the conflict commits first, submit is refused (`assignment_revoked`). If the submit commits first, this becomes phase 3. Conflict vs `MarkOverdue`: both are conditional updates; overdue → revoked is allowed. |

### Phase 3 — review submitted, round not closed

| | |
|---|---|
| Commands / events | `DeclareConflict` → `ConflictDeclared{revokedAssignment, voidedReview: reviewId, countedInRound: none}` + `AssignmentRevoked`. |
| Writes | PR: completed → revoked; submitted review `voided_at` set. **No change from today** except the payload fields. |
| States | proposal underReview; review Submitted → Voided; counted reviews drop by one. |
| Mean / completion | `countedReviews` excludes it; no round exists yet, so nothing to supersede. The next round closes only on three counted reviews. |
| Decision / budget | none exist. ADJ ignores the event: `countedInRound` is none, so no hold and no `adj_pending_hold`. This removes a stale-hold hazard the round-less design would have had. |
| Notifications / audit | as phase 2. |
| Races | **Conflict vs ReviewCompletion closing the round** (third `ReviewSubmitted` in flight). (i) Conflict commits first: ReviewCompletion recounts, finds 2, opens no round. (ii) ReviewCompletion commits first: the round exists; `declareConflict` reads `rev_completion`, sets `countedInRound = N`, and the case becomes **phase 4**. Both orders are deterministic. Concurrent reviews by other reviewers only add counted reviews. |

### Phase 4 — scored, adjudication open (including `reconsider` and an existing hold)

| | |
|---|---|
| Commands / events | `DeclareConflict` → `ConflictDeclared{voidedReview, countedInRound: N}` + `AssignmentRevoked`. ReviewCompletion → `ProposalReviewReopened{round N, voidedReviewId, remainingReviewIds}`. SUB → `ProposalReturnedToReview` (scored → underReview). ADJ on `ConflictDeclared`: integrity hold on the open case (the owner's new `AwardHeld` event fits here). ADJ on `ProposalReturnedToReview` → `CaseSuperseded{round N}`. PR on `ProposalReturnedToReview`: `rev_case` assignable again. |
| Writes | PR (AssignmentService): conflict, revoke, void. PR (ReviewCompletion): `rev_completion(proposal, N).superseded_at`. SUB: status. ADJ: `adj_case(proposal, N)`: hold, then status `superseded`, and the human task (decide or reconsider) is closed with no decision. |
| States | assignment revoked; review Voided; round N Superseded; proposal scored → underReview; case awaitingDecision, reconsider or held → superseded. |
| Mean score | Round N's mean is withdrawn, not edited. It stays in `rev_completion` row N (superseded) and in `adj_case` N for audit. The new mean is computed when round N+1 closes over the two surviving reviews plus the replacement's. OVS shows "under review, 2 of 3" and the voided review. |
| Completion record | Per round: PK `(proposal_id, round)`, plus partial unique index "one current round per proposal". `ProposalFullyReviewed` and `ProposalScored` carry `round`; `ScoredData.caseKey = proposalId:round`. |
| PanelDecision unique-by | `payload.caseKey`, so the round N+1 `ProposalScored` starts a new instance. `adj_case` and `adj_decision` are keyed `(proposal_id, round)`. |
| Budget | Untouched: nothing was committed, and a refused award never committed. **`reconsider`**: superseded like any open case; the acknowledged decline is never recorded. In round N+1 the envelope is the same, so an award will likely be refused again (ADR-006 still holds). |
| Existing hold | Holds now exist only between `ConflictDeclared` and `CaseSuperseded`. A second conflict in that window voids another review: round N is already superseded, so there is no second reopen (idempotent). `adj_pending_hold` is cleared on `ProposalReturnedToReview`, never carried into round N+1. |
| Notifications / audit | NTF: applicant, officer and chair on `ProposalReturnedToReview` ("returned to review: a reviewer declared a conflict"; the applicant is not told who). Audit: all five events. |
| Races | **Conflict vs the chair's award.** (i) Conflict commits first: the award fails closed (`integrity_pending` while `ConflictDeclared` is undelivered to ADJ, then `integrity_hold`) until the case is superseded. **Decline is refused too** (changed from ADR-005), because the case is about to be superseded. (ii) Award commits first: budget is committed and `ProposalAwarded` is sequenced before `ConflictDeclared`. SUB applies awarded first, then `ProposalReviewReopened` finds `awarded` (a recorded no-op), and ADJ sees `countedInRound = decided round`, which is **phase 5**. **Conflict vs the third review of round N+1**: the replacement cannot be assigned before `ProposalReturnedToReview` reaches PR. |

### Phase 5 — after a final decision (award, committed or disbursed; or decline)

Common to every option: PR revokes, voids and supersedes round N exactly as in phase 4 (INV-3 literal); SUB no-ops `ProposalReviewReopened` (status awarded or declined); `rev_case` stays not assignable. Options differ only in ADJ and SUB.

**(a) Rescind automatically, release, re-review.**
- ADJ on `ConflictDeclared` (decided round): mark `adj_decision` rescinded, `UPDATE adj_budget SET committed = committed - amount WHERE committed >= amount` once per decision, publish `DecisionRescinded`. SUB: awarded/declined → underReview.
- Trade-offs: it is the brief's §1 literally and the fastest. But no human acts, which breaks HumansDecide and puts a reviewer's self-declaration in control of money. It releases funds Quorum cannot know were not disbursed, so a later award could commit money that does not exist (the INV-9 intent, not its letter). It invalidates ADR-006's premise outright.
- Model: no IntegrityReview workflow. `ConflictDeclared -> DecisionRescinded` on ADJ.

**(b) The decision stands; integrity finding plus human review outside Quorum.**
- ADJ records an `adj_integrity_finding` and publishes `IntegrityFindingRecorded`. The proposal stays awarded or declined, and the budget stays as it is.
- Trade-offs: simplest; nothing reverses. But it contradicts §1 and the INV-3 consequence column ("voids the award"), the mean that justified the award still includes a conflicted review on record, and a wronged declined applicant has no path.
- Model: no `RescindAward`/`RescindDecline` transitions; Awarded and Declined stay terminal; `ConflictAfterDecision` resolved to "stands".

**(c) Suspend pending an officer integrity review with an explicit outcome — RECOMMENDED** (encoded in the change).
- ADJ on `ConflictDeclared` with `countedInRound` = the decided round: `adj_decision(proposal, N).status = suspended`, insert `adj_integrity_review` (PK proposal, round), publish `DecisionSuspended` once. The budget stays committed. Workflow `IntegrityReview` (unique-by caseKey) gives the Program Officer a human task with outcome `{verdict: uphold | rescind, fundsDisbursed, rationale}`. It escalates to the chair after 14 days and never decides by timeout.
- **Uphold**: `UpholdDecision` → decision `standing` with a recorded finding, `DecisionUpheld`. Proposal and budget unchanged. Round N stays superseded in PR: the review is void, but the decision stands on the officer's finding.
- **Rescind**: `RescindDecision` → decision `rescinded`. For an award with `fundsDisbursed = false`, one conditional release of `amount`, guarded by `adj_rescission` PK (proposal, round) so a retry releases nothing twice. With `fundsDisbursed = true`, nothing is released and the amount stays consumed. Then `DecisionRescinded`; SUB awarded/declined → underReview (`ProposalReturnedToReview`); PR reopens assignment; round N+1, a new case and a new chair decision. That decision is a second `adj_decision` row and is the only standing one (partial unique index `WHERE status <> 'rescinded'`).
- Trade-offs: a human decides money (HumansDecide, ADR-010 style); the award can be voided, as §1 says, but only by an accountable person; it matches the BDL's existing accountability (Program Officer); and declines get the same remedy. Costs: one workflow, two operations, four events, Awarded and Declined become non-terminal, and §4 "recorded once, terminal" is read per round.
- Model: as in the change, Part 4.

**Phase 5 in every option**
- Notifications: applicant, chair and officer on `DecisionSuspended`, `DecisionUpheld` and `DecisionRescinded`, without naming the reviewer.
- Audit: every event, with actor and rationale from the task outcome (ADR-015 pattern).
- Idempotency: `DecisionSuspended` once per (proposal, round) (PK); the IntegrityReview instance is unique per caseKey; release once per decision.
- Race with a concurrent officer outcome: the human task completes once, with a conditional update `status = 'suspended'`.
- Disbursed: Quorum cannot see disbursement, so it rests on the officer's attestation (`unspecified FundsDisbursement`).

## 4. Decisions affected

| Decision | Effect |
|---|---|
| ADR-005 | Would be **superseded** by ADR-017 if accepted. That supersede act is the owner's. |
| ADR-001 | Kept; gains `scored → underReview` (on ProposalReviewReopened) and `awarded/declined → underReview` (on DecisionRescinded), still conditional updates. |
| ADR-002 | Kept; `AssignmentService reads CompletionLedger` declared (same context; already done by code). |
| ADR-006 | Kept for commits. **Its premise "awards are final, the envelope never grows" no longer holds** under (a) or (c)-rescind. `reconsider` stays decline-only (recommended default: unchanged; see Q4). |
| ADR-015 | Kept. A `reconsider` case can now also end as `superseded`. |
| ADR-010 | Pattern reused for the integrity task: escalate, never decide by timeout. |

## 5. Implementation impact (not done; src/ and tests/ untouched)

**Schema migrations** (`src/platform/schema.ts`)
1. `rev_completion`: add `round INTEGER NOT NULL`, `superseded_at`, `superseded_by_review`; PK `(proposal_id, round)`; `CREATE UNIQUE INDEX rev_completion_current ON rev_completion(proposal_id) WHERE superseded_at IS NULL`. Backfill `round = 1`.
2. `rev_case.status`: add `'scored'` (not assignable) to `CHECK (status IN ('open','scored','withdrawn'))`.
3. `adj_case`: add `round`, PK `(proposal_id, round)`, status adds `'superseded'`. Backfill `round = 1`.
4. `adj_decision`: add `round`, `status CHECK IN ('standing','suspended','rescinded')`, `suspended_at`, `resolved_at`, `resolved_by`, `finding`; PK `(proposal_id, round)`; `UNIQUE INDEX adj_decision_standing ON adj_decision(proposal_id) WHERE status <> 'rescinded'`.
5. New `adj_integrity_review (proposal_id, round, opened_at, due_at, escalated_at, verdict, funds_disbursed, rationale, decided_by, decided_at, PK(proposal_id, round))`. New `adj_rescission (proposal_id, round, released_minor, at, PK(proposal_id, round))`.
6. `adj_pending_hold`: clear on `ProposalReturnedToReview` (or key it by round).
7. `adj_budget` CHECK unchanged (`0 <= committed <= envelope`); the release is `committed_minor - ? WHERE committed_minor >= ?`.

**Code**
- `peer-review/service.ts`: `declareConflict` always calls `revoke(..., {voidSubmitted: true})`; computes `countedInRound` from the current `rev_completion` row; drops `heldAward`. `revokeAssignment` (officer) still refuses `completed`. New handlers `ProposalScored` → `rev_case.status = 'scored'`, `ProposalReturnedToReview` → `'open'`. `assignmentEligibility` requires `open`.
- `peer-review/completion.ts`: guard on "a current round exists", not "any row exists"; insert `round = max + 1`; new `ConflictDeclared` handler that supersedes the round once and publishes `ProposalReviewReopened`.
- `submission/service.ts`: handlers for `ProposalReviewReopened` (`['scored'] → 'underReview'`) and `DecisionRescinded` (`['awarded','declined'] → 'underReview'`); `ScoredData` carries `round` and `caseKey`; `WITHDRAWABLE` unchanged (an owner question: may an applicant withdraw after a return to review?).
- `adjudication/panel-decision.ts`: case keyed by round; `ProposalReturnedToReview` → supersede the open case, close the task, clear the pending hold.
- `adjudication/service.ts`: `recordDecision` refuses **both** outcomes while held; works on the current round. `ConflictDeclared`: hold if a case is open in round N; suspend if decided in round N. New `upholdDecision`, `rescindDecision` (single conditional release), integrity task routes (programOfficer), and an escalation sweep for integrity reviews.
- `contracts/model.generated.ts`: regenerate (payload shapes v2).
- `api/routes.ts`: `POST /api/integrity-reviews/:proposalId/:round/outcome` (programOfficer); decision route takes the current round.
- `oversight`, `notification`: project and notify the new events; the portfolio shows round, superseded mean and suspension.
- The owner's in-flight `AwardHeld` publishing: still valid for the phase-4 hold.

**Tests and acceptance scenarios**
- **Replace** `tests/scenarios/adr-005-inv-03-mismatch.test.ts` with `inv-03-conflict-voids-review.test.ts`. After scoring: conflict ⇒ assignment `revoked`, `voided_at` set, round 1 superseded, status `underReview`, case `superseded`; replacement ⇒ round 2 mean excludes the voided review; award in round 2 succeeds.
- **Add**:
  - phase 1–3 cases;
  - conflict from `reconsider`;
  - conflict while held, and a second conflict (one reopen only);
  - races: conflict vs third review, both orders; conflict vs award, both orders, the second landing in phase 5;
  - decline refused while held;
  - phase 5 (c): suspend once, replayed `ConflictDeclared` suspends nothing twice;
  - uphold: budget unchanged;
  - rescind with `fundsDisbursed = false` releases exactly once under retry; `true` releases nothing;
  - rescinded decline returns to review;
  - round-2 decision is the only standing one;
  - integrity task escalation never decides;
  - portfolio rebuild by replay shows the same rounds.
- **Update**: `Inv05ThreeReviews` (per round), `Inv08ChairOnly` (once per round; refused while held), `pre-release-review` A2 tests (hold semantics now transient), `DeliveryAndReplay` (new events).
- **Acceptance** (`continuum/acceptance/`): add scenarios traced to `ConflictedEvidenceVoided`, the two new tests and `IntegrityReview`, and regenerate the package. NOT CHECKED: the package was not rebuilt.

## 6. Open questions for the owner (each with a recommended default)

| # | Question | Why it matters | Recommended default |
|---|---|---|---|
| Q1 | Phase-5 policy: (a), (b) or (c)? | Decides whether Awarded/Declined stay terminal, and whether money is ever released | **(c)** |
| Q2 | Who records the integrity outcome: Program Officer, Panel Chair, or both? | Reversing a chair's decision; INV-8 governs panel decisions only | Program Officer (the BDL's accountable party), chair notified |
| Q3 | How is "funds disbursed" known? | Releasing disbursed money breaks INV-9's intent | The officer attests it in the outcome; `fundsDisbursed = true` releases nothing |
| Q4 | When budget is released, may a proposal in `reconsider` (refused for budget) be revisited? | ADR-006's premise no longer holds | No: `reconsider` stays decline-only; revisit as its own decision |
| Q5 | Is §4's "PanelDecision recorded once, terminal" acceptably read as "once per review round; a rescinded decision stays on record"? | A wording deviation from the brief | Yes; record it as a deviation, like ADR-004 |
| Q6 | Should a decline be refused while a hold is on the case (ADR-005 allowed decline)? | The applicant may be declined on void evidence | Yes, refuse both outcomes until the case is superseded |
| Q7 | Is there a time limit after which a late conflict no longer reopens a decided proposal? | Unbounded reopening of settled awards | None in the MVP; the officer may uphold |
| Q8 | Does the voided reviewer's replacement need to come from a fresh pool, and may the officer reuse the other two reviewers? | Fairness and anchoring: the surviving two have read each other | Keep the two surviving reviews; the replacement is blind to them until submission (INV-7 already) |
| Q9 | May the applicant withdraw after a return to review? | `WITHDRAWABLE` includes underReview | Yes (current rule) |
| Q10 | Split Part 0 (the pre-existing correlation-type repair) into its own change? | It is unrelated to INV-3 and blocks every change | Yes, adopt it first |

## 7. What was and was not checked

- **Ran**: `continuum compile --state --json` (base); `continuum compile --apply` and `continuum_apply` (applied, valid); `continuum business compile` (proposed and adopted BDL); `continuum decision propose` / `show` / `check`.
- **NOT CHECKED**: `continuum preview` / `continuum_process_graph` over state B; `continuum package check`, `continuum guard`, `continuum conformance report`; any test run. No code was changed, so the implementation still realizes ADR-005.
- The phase traces in §3 are **derived** from the model and code as read, and **recommended** where they describe new behaviour. They are not tool verdicts.
- The ADR-017 propose act was recorded by the Host under the owner's credential cached for this session ("By Michael Kang … under grant owner"). It is a proposal, not an approval.

## Appendix A — ADL change, summary of operations

Part 0 (pre-existing defect: `ProposalId` typing, 13 ops). Part 1 (requirement `ConflictedEvidenceVoided`; INV-5 wording). Part 2 (PeerReview: `ConflictDeclaredData v2` with `voidedReview`, `countedInRound`; `FullyReviewedData v2` with `round`; `ReviewReopenedData`, `ProposalReviewReopened`, rule `ConflictVoidsReview`; ReviewCompletion subscribes ConflictDeclared, publishes ProposalReviewReopened; AssignmentService reads CompletionLedger). Part 3 (Submission: `ScoredData v2` with `round`, `caseKey`; `ProposalReturnedToReview`; AssignmentService subscribes ProposalScored and ProposalReturnedToReview). Part 4 (Adjudication: `AdjudicationState v2`, `PanelDecision v2` unique-by `payload.caseKey`; `DecisionSuspended`, `DecisionRescinded`, `DecisionUpheld`, `CaseSuperseded`; `RescindDecision`, `UpholdDecision`; rule `DecisionRestsOnStandingReviews`; workflow `IntegrityReview`; ProposalService subscribes DecisionRescinded). Part 5 (Notification and Oversight subscriptions and projections). Part 6 (tests `Inv03ConflictVoidsReviewAtEveryPhase`, `ConflictAfterDecisionIntegrityReview`; Inv03/05/08 wording).

Known limit: ADL here has no construct used to cancel a running workflow instance from an event. The case supersession is declared on AdjudicationService (`ProposalReturnedToReview -> CaseSuperseded`) and in the PanelDecision description, not as a workflow step. Whether ADL 1.7 can express it is *unknown* (not researched).

## Appendix B — BDL diff (adopted `quorum.bdl` → `changes/adr-017-quorum.proposed.bdl`)

```diff
@@ -4,3 +4,3 @@ model {
   expressions adl-expr/1.0
-  definition  "quorum.2026-11-16.1"
+  definition  "quorum.2026-11-16.adr-017-proposed"
 }
@@ -80,3 +80,3 @@ business Quorum #b-q001 {
     entity Proposal #en-q003 {
-      description "A request for funding against one call. Eligible and Ineligible are additions to the brief's lifecycle: an officer's screening outcome is not a panel decision, so it may not reuse Declined (decision D4)."
+      description "A request for funding against one call. Eligible and Ineligible are additions to the brief's lifecycle: an officer's screening outcome is not a panel decision, so it may not reuse Declined (decision D4). ADR-017 (proposed): Awarded and Declined are no longer terminal; a proposal returns to UnderReview when a counted review is voided before a decision, or when a suspended decision is rescinded."
       identity proposalId
@@ -90,3 +90,3 @@ business Quorum #b-q001 {
         initial Draft
-        terminal Awarded Declined Withdrawn Ineligible
+        terminal Withdrawn Ineligible
 
@@ -143,2 +143,26 @@ business Quorum #b-q001 {
         }
+        transition ReturnToReview #t-q023 {
+          description "ADR-017: a review counted in the current round was voided by a conflict before a decision; the round is superseded and a replacement reviewer is needed (INV-5)."
+          from Scored
+          to UnderReview
+          triggeredBy ReopenReview
+          produces ProposalReturnedToReview
+          requires ProposalReviewReopened
+        }
+        transition RescindAward #t-q024 {
+          description "ADR-017, option (c): a program officer rescinded an award taken on a round that lost a counted review to a conflict."
+          from Awarded
+          to UnderReview
+          triggeredBy ReturnRescindedToReview
+          produces ProposalReturnedToReview
+          requires DecisionRescinded
+        }
+        transition RescindDecline #t-q025 {
+          description "ADR-017, option (c): a program officer rescinded a decline taken on a round that lost a counted review to a conflict."
+          from Declined
+          to UnderReview
+          triggeredBy ReturnRescindedToReview
+          produces ProposalReturnedToReview
+          requires DecisionRescinded
+        }
         transition WithdrawDraft #t-q018 { from Draft to Withdrawn triggeredBy WithdrawProposal produces ProposalWithdrawn }
@@ -201,3 +225,3 @@ business Quorum #b-q001 {
         transition RevokeCompletedOnConflict #t-q061 {
-          description "D5: a conflict declared after the review was submitted but before the proposal is Scored voids the review and revokes the assignment; the officer assigns a replacement."
+          description "ADR-017: a conflict declared after the review was submitted, in any phase, revokes the assignment and voids the review; if the review counted in a closed round, that round is superseded."
           from Completed
@@ -228,3 +252,3 @@ business Quorum #b-q001 {
         transition VoidOnConflict #t-q041 {
-          description "D5: a submitted review whose author later declares a conflict, before scoring, no longer counts."
+          description "ADR-017: a submitted review whose author later declares a conflict no longer counts, in any phase (INV-3)."
           from Submitted
@@ -239,8 +263,57 @@ business Quorum #b-q001 {
 
+    entity ReviewRound #en-q009 {
+      description "ADR-017: one closed set of exactly three counted reviews of a proposal and its mean score. At most one round of a proposal is Current."
+      identity roundKey
+      roundKey: text
+      proposal: Proposal
+      round: int32
+      meanScore: decimal(4,2)
+      status: RoundStatus
+
+      state-model RoundLifecycle for status #sm-q009 {
+        initial Current
+        terminal Superseded
+        transition Supersede #t-q070 {
+          from Current
+          to Superseded
+          triggeredBy SupersedeRound
+          produces ProposalReviewReopened
+          requires ConflictDeclared
+        }
+      }
+    }
+
     entity PanelDecision #en-q007 {
-      description "Recorded once per proposal; terminal."
-      identity proposalId
+      description "Recorded once per review round of a proposal (ADR-017 reads the brief's 'recorded once' per round). A decision is never edited: suspension, upholding and rescission are its lifecycle, and a rescinded decision stays on record."
+      identity decisionKey
+      decisionKey: text
       proposalId: text
+      round: int32
       outcome: PanelOutcome
       amount: Money
+      status: DecisionStatus
+
+      state-model DecisionLifecycle for status #sm-q007 {
+        initial Standing
+        terminal Rescinded
+        transition Suspend #t-q071 {
+          from Standing
+          to Suspended
+          triggeredBy SuspendDecision
+          produces DecisionSuspended
+          requires ConflictDeclared
+        }
+        transition Uphold #t-q072 {
+          from Suspended
+          to Standing
+          triggeredBy RecordIntegrityOutcome
+          produces DecisionUpheld
+        }
+        transition Rescind #t-q073 {
+          from Suspended
+          to Rescinded
+          triggeredBy RecordIntegrityOutcome
+          produces DecisionRescinded
+        }
+      }
     }
@@ -270,2 +343,5 @@ business Quorum #b-q001 {
     enum MessageStatus #e-q008 { Queued Delivered Failed }
+    enum RoundStatus #e-q009 { Current Superseded }
+    enum DecisionStatus #e-q010 { Standing Suspended Rescinded }
+    enum IntegrityVerdict #e-q011 { Uphold Rescind }
 
@@ -344,2 +420,3 @@ business Quorum #b-q001 {
       creates ConflictDeclaration
+      changes Assignment
       produces ConflictDeclared
@@ -405,4 +482,49 @@ business Quorum #b-q001 {
     }
+    action SupersedeRound [permitted] #ac-q026 {
+      description "ADR-017: the platform supersedes the current review round when a review it counted is voided by a conflict."
+      mayPerform QuorumPlatform
+      exercises BlindPeerReview
+      changes ReviewRound
+      produces ProposalReviewReopened
+      requires ConflictDeclared
+    }
+    action ReopenReview [permitted] #ac-q027 {
+      description "ADR-017: the platform returns a Scored proposal to UnderReview when its review round is superseded."
+      mayPerform QuorumPlatform
+      exercises ReviewerAssignment
+      changes Proposal
+      produces ProposalReturnedToReview
+      requires ProposalReviewReopened
+    }
+    action SuspendDecision [permitted] #ac-q028 {
+      description "ADR-017, option (c): the platform suspends a decision taken on a round that has lost a counted review to a conflict. Committed money stays committed while suspended."
+      mayPerform QuorumPlatform
+      exercises PanelAdjudication
+      changes PanelDecision
+      produces DecisionSuspended
+      requires ConflictDeclared
+    }
+    decision RecordIntegrityOutcome [permitted] #ac-q029 {
+      description "ADR-017, option (c): the human outcome of an integrity review. Uphold lifts the suspension with a recorded finding; rescind voids the decision, releases an award's amount only if no funds were disbursed, and sends the proposal back to review."
+      mayPerform ProgramOfficer
+      exercises PanelAdjudication
+      changes PanelDecision
+      produces DecisionUpheld, DecisionRescinded
+      requires DecisionSuspended
+      determines {
+        verdict: IntegrityVerdict
+        fundsDisbursed: boolean
+        rationale: text
+      }
+    }
+    action ReturnRescindedToReview [permitted] #ac-q030 {
+      description "ADR-017, option (c): the platform returns an Awarded or Declined proposal to UnderReview when its decision is rescinded."
+      mayPerform QuorumPlatform
+      exercises ReviewerAssignment
+      changes Proposal
+      produces ProposalReturnedToReview
+      requires DecisionRescinded
+    }
     decision RecordPanelDecision [permitted] #ac-q019 {
-      description "Only a Panel Chair, only for a Scored proposal, only once (INV-8). An award commits the requested amount, never a part of it, and only within the envelope (INV-9)."
+      description "Only a Panel Chair, only for a Scored proposal, only once per review round (INV-8, ADR-017). An award commits the requested amount, never a part of it, and only within the envelope (INV-9)."
       mayPerform PanelChair
@@ -412,2 +534,3 @@ business Quorum #b-q001 {
       produces ProposalAwarded, ProposalDeclined
+      outcome { PanelDecision.status == DecisionStatus "Standing" }
       requires ProposalFullyReviewed
@@ -449,3 +572,3 @@ business Quorum #b-q001 {
     fact ReviewOverdue #f-q011 { assignmentId: text }
-    fact ProposalFullyReviewed #f-q012 { proposalId: text meanScore: decimal(4,2) }
+    fact ProposalFullyReviewed #f-q012 { proposalId: text round: int32 meanScore: decimal(4,2) }
     fact ProposalAwarded #f-q013 { proposalId: text amount: Money }
@@ -457,2 +580,7 @@ business Quorum #b-q001 {
     fact ProposalUnderReview #f-q019 { proposalId: text }
+    fact ProposalReviewReopened #f-q020 { proposalId: text round: int32 }
+    fact ProposalReturnedToReview #f-q021 { proposalId: text }
+    fact DecisionSuspended #f-q022 { proposalId: text round: int32 }
+    fact DecisionUpheld #f-q023 { proposalId: text round: int32 }
+    fact DecisionRescinded #f-q024 { proposalId: text round: int32 releaseRequested: boolean }
 
@@ -475,3 +603,3 @@ business Quorum #b-q001 {
       condition true
-      assertion "A reviewer with a declared conflict against a proposal can never hold an assignment to it: assignment through a conflict is refused, and declaring a conflict revokes any active assignment at once."
+      assertion "A reviewer with a declared conflict against a proposal can never hold an assignment to it: assignment through a conflict is refused, and declaring a conflict revokes their assignment at once in every state, including Completed, and voids their review (ADR-017)."
     }
@@ -499,3 +627,3 @@ business Quorum #b-q001 {
       condition Proposal.status != ProposalStatus "Scored"
-      assertion "Only a Panel Chair records a panel decision, only for a Scored proposal, and only once."
+      assertion "Only a Panel Chair records a panel decision, only for a Scored proposal, and only once per review round."
     }
@@ -519,7 +647,13 @@ business Quorum #b-q001 {
     }
-    rule AwardHeldOnLateConflict #r-q013 {
-      description "Decision D5: a conflict disclosed after scoring holds the award; the chair may still decline."
-      scope RecordPanelDecision
+    rule DecisionRestsOnStandingReviews #r-q015 {
+      description "ADR-017 (replaces r-q013 AwardHeldOnLateConflict, which contradicted r-q003)."
+      scope RecordPanelDecision, RecordIntegrityOutcome
+      condition true
+      assertion "A panel decision rests only on a review round whose counted reviews all still stand. While a conflict has voided a review of the current round, no decision is recorded; a decision already recorded on that round is Suspended until a Program Officer upholds or rescinds it."
+    }
+    rule RescissionReleasesOnlyUndisbursed #r-q016 {
+      description "ADR-017, option (c), with INV-9."
+      scope RecordIntegrityOutcome
       condition true
-      assertion "While a conflict declared after scoring stands against a proposal, it may be declined but not awarded."
+      assertion "Rescinding an award releases its amount to the call's envelope at most once, and only when the Program Officer records that no funds were disbursed; otherwise the amount stays committed."
     }
@@ -529,3 +663,3 @@ business Quorum #b-q001 {
       governs Proposal
-      assertion "A Proposal enters Scored only when exactly three Reviews on its non-revoked Assignments are Submitted."
+      assertion "A Proposal enters Scored only when exactly three non-Voided Reviews on its non-revoked Assignments are Submitted in its Current ReviewRound."
     }
@@ -554,12 +688,12 @@ business Quorum #b-q001 {
 
-    unspecified ConflictAfterDecision #u-q001 {
+    unspecified FundsDisbursement #u-q003 {
       modality { epistemic underspecified }
-      questions ConflictDeclaration
-      question "What happens to an award already recorded when a reviewer of that proposal later declares a conflict?"
-      reason "The brief says a conflicted review voids the award, but names no process for clawing back committed money; the MVP records the conflict and leaves the award standing."
+      questions PanelDecision
+      question "How does Quorum know whether an award's funds were disbursed when the award is rescinded?"
+      reason "Quorum records commitments, not payments; disbursement happens outside it. ADR-017 (option c) has the Program Officer attest it in the integrity outcome. This replaces ConflictAfterDecision (u-q001), which ADR-017 resolves."
       accountable "Program Officer"
       alternatives
-        "the award is voided and its amount released to the envelope"
-        "the award stands and the proposal is re-reviewed by a fresh panel"
-        "the award is suspended pending an integrity review outside Quorum"
+        "the Program Officer attests it in the integrity outcome"
+        "a finance system reports disbursement to Quorum"
+        "a rescission never releases budget"
     }
@@ -589,2 +723,9 @@ business Quorum #b-q001 {
   }
+  obligation ResolveIntegrityReview [internal-commitment] #o-q005 {
+    borneBy ProgramOfficer
+    activatedBy ResearchFunding.DecisionSuspended
+    dischargedBy ResearchFunding.RecordIntegrityOutcome
+    statement "A suspended decision is upheld or rescinded by a program officer; it is never resolved by timeout."
+    timing { "Fourteen days from suspension, then escalated to the panel chair." }
+  }
   obligation TellParticipants [internal-commitment] #o-q003 {
```
