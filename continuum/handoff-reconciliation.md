# Handoff reconciliation matrix

This file is a review aid: it is authored by hand and is not authority. It maps each material agreement in `product/PRODUCT_REQUIREMENTS.md` and the build conversation to the artifact that carries it and the evidence that shows it holds.

Dispositions:
- **represented**: carried in its native artifact, with executed evidence.
- **deviation**: the code or model departs from the brief's wording, and the departure is recorded.
- **deferred**: left open, with an owner.

Paths are shortened:
- `RF.` means `::Quorum.ResearchFunding.`
- `inv-NN` means `tests/invariants/inv-NN-*.test.ts`
- `scn` means an acceptance scenario in `continuum/acceptance/scenarios/`

## Invariants

| Intent | Model element (ADL / BDL) | Evidence | Disposition |
|---|---|---|---|
| INV-1: submit only while the call is open | `RF.CallAdministration.SubmissionWindow`, `RF.Submission.SubmissionWindowOpen`, synchronous `CallApi.GetCallStatus` (ADR-003) | inv-01, `deadline-boundaries`, scn `inv01-submission-window` | represented |
| INV-2: a proposal is submitted at most once | `RF.ProposalSubmission.SubmitOnce`, `SubmittedOnce` | inv-02, `duplicate-submission`, scn `inv02-submit-once` | represented |
| INV-3: no conflicted assignment | `RF.ReviewerAssignment.NoConflictedAssignment`, `AssignmentValidity`, ADR-005 | inv-03 (service check and DB trigger), `conflict-lifecycle`, scn `inv03-no-conflicted-assignment` | **deviation after scoring**: `adr-005-inv-03-mismatch.test.ts`. Resolution proposed as ADR-017 (`docs/proposals/adr-017-conflict-resolution.md`), owner decision |
| INV-4: no self-review | `RF.ReviewerAssignment.NoSelfReview` | inv-04, scn `inv04-no-self-review` | represented |
| INV-5: exactly three reviews before scoring | `RF.ReviewCompletionTracking.ThreeReviewsBeforeScoring`, `ThreeSubmittedReviews`, `ReviewCompletion` | inv-05, `two-of-three-readiness`, scn `inv05-three-reviews` | represented. "At most 3 active" is enforced by database triggers; six processes racing assign exactly three (`production-readiness`, review B7 closed) |
| INV-6: every criterion scored | `RF.BlindPeerReview.CompleteScoring`, `EveryCriterionScored` | inv-06, scn `inv06-complete-scoring` | represented. An empty criteria replica is now refused (review B8) |
| INV-7: blind until own review submitted | `RF.BlindPeerReview.BlindUntilOwnSubmitted`, policy `BlindReview` | inv-07, `blind-visibility`, scn `inv07-blind-until-own-submitted` | represented |
| INV-8: only the chair decides, only on scored proposals | `RF.PanelAdjudication.ChairDecidesScoredOnly`, workflow `PanelDecision` | inv-08, scn `inv08-chair-decides-scored-only` | represented |
| INV-9: the envelope is never exceeded | `RF.PanelAdjudication.EnvelopeNeverExceeded`, `DecisionApi.CommitAward` (ADR-006, ADR-015) | inv-09, `concurrent-awards` (10 processes), scn `inv09-envelope-never-exceeded` | represented |
| INV-10: the agent proposes, never decides | `RF.EligibilityScreening.AgentNeverDecides`, guardrail `AgentProposesOnly`, policy `HumansDecide` (ADR-011) | inv-10, `agent-authority`, scn `inv10-agent-never-decides` | represented |
| INV-11: role-scoped authority | `RF.AccessControl.RoleScopedAuthority`, policy `RoleScopedAccess` (ADR-012) | inv-11, `cross-role-access` (57 tests), scn `inv11-role-scoped-authority` | represented. Applicant visibility of the mean score and of the screener's id is an open question (review B5) |
| INV-12: verified reviewers only | `RF.ReviewerAssignment.VerifiedReviewersOnly`, `IdentityApi.GetReviewerStanding` | inv-12, scn `inv12-verified-reviewers-only` | represented |

## Journeys and non-functional requirements

| Intent | Carried by | Evidence | Disposition |
|---|---|---|---|
| J1–J4, J7, J8 user journeys | ADL services, workflows and commands. BDL state models | `npm run test:e2e` (all four roles, desktop and mobile), the scenarios above | represented |
| J5: completion detection | `ReviewCompletion` reaction | inv-05, scn `inv05-three-reviews` | represented |
| J6: overdue escalation | workflow `ReviewDeadline`, `ReviewApi.MarkOverdue` (ADR-016) | `overdue-escalation`, scn `overdue-review-escalated` | represented. Decision escalation: `DecisionEscalated` (ADR-018), scn `decision-escalated` (B3 closed) |
| NFR-1: runs locally, no paid infrastructure | bindings: `node-process`, `sqlite-wal`, `sqlite-outbox`, `fake-triage-provider` | clean-checkout verification | represented. Production bindings (`production.adl-binding.json`) select paid integrations only when configured |
| NFR-2 and NFR-3: JWT for 8 hours, deny by default | `src/platform/auth.ts`, `http.ts` (every route declares `access`) | `cross-role-access` | represented. Sessions use wall-clock time |
| NFR-4 and NFR-5: durable storage, at-least-once ordered delivery | Resource `persistence[...]`, Event `delivery[...]`, ADR-007, ADR-014 | `replay-and-recovery` (SIGKILL), scn `delivery-survives-interruption` | represented. Claims are *declared, unverified* |
| NFR-6: idempotency | ADR-008 | `duplicate-submission` | represented |
| NFR-7 and NFR-10: validation and the error envelope | `src/platform/http.ts` | `cross-role-access`, the field-error tests | represented |
| NFR-8: auditability | ADR-013, `RF.PortfolioReporting.TransitionsAudited` | scn `portfolio-from-projection` | represented: `AwardRefused`, `AwardHeld`, `DecisionEscalated` are audited (ADR-018, B4 closed); operator acts in append-only `ops_action` (ADR-019) |
| NFR-9: a negative test per invariant | `test` elements `Inv01`..`Inv12` | `tests/invariants/*` (12 files) | represented |

## Production readiness (the owner's request of this release)

| Intent | Carried by | Evidence | Disposition |
|---|---|---|---|
| Escalation delivery | ADL `DecisionEscalated`, `DecisionsEscalated`, ADR-018; role mailboxes (`QUORUM_ROLE_EMAIL_*`) | scn `decision-escalated`; `production-readiness` | represented. Real mail: external (SMTP inputs) |
| Audit records | ADL `AwardRefused`, `AwardHeld`, `AuditTrail` projections; `ops_action` | `production-readiness` | represented |
| Recovery from failing deliveries | ADR-020; `EventBus.skip`, alerts | `production-readiness` (park alert, skip, skip refused) | represented |
| Reviewer limits under concurrent writes | DB triggers `rev_assignment_at_most_three*` | `production-readiness` (6-process race) | represented |
| Production integrations | Environment `Production`, its bindings; `src/integrations/factory.ts` | `tests/integrations/*` (local fakes) | **blocked on owner input**: credentials and decisions (`docs/OPERATIONS.md` §7) |
| Backup and restore | `src/platform/backup.ts`, `npm run ops` | `production-readiness` (online backup, restore to the point, refusal while live, corrupt refused) | represented |
| Monitoring | `/healthz`, `/readyz`, `/metrics`, alerts | `production-readiness` | represented. Alert routing: owner's webhook |
| Data erasure | ADL `EraseAccount`, `AccountErased`, `PersonalDataErasable`, ADR-021 | scn `account-erasure`; `production-readiness` | represented, with stated limits (delivered mail, old backups) |
| Rate limiting | ADR-022, `src/platform/rate-limit.ts` | `production-readiness` | represented. `trustProxy` waits for the proxy choice |
| SQLite viability | `docs/evidence/sqlite-viability.md` | load and kill tests in `scripts/load/` | see the evidence document |

## Rejected alternatives (recorded in the decisions)

| Rejected | Why | Where |
|---|---|---|
| Each context writes `Proposal.status` for its own transitions | Several writers of one aggregate | ADR-001 |
| Asynchronous INV-1 and INV-12 checks | A stale replica lets an invariant be violated | ADR-003 |
| Read-then-write budget check | Lost update under concurrency | ADR-006 |
| Agent auto-screens confident cases | Violates INV-10 and HumansDecide | ADR-011 |
| Roles cached in the token | Revocation not seen until expiry | ADR-012 |
| Escalation flagged on the work queue only | Notifies no one | ADR-018 |
| Operations under the programOfficer role | Mixes business authority with platform recovery | ADR-019 |
| Skipping any parked delivery, or auto-skip | Silently breaks the invariant whose input is skipped | ADR-020 |
| Crypto-shredding, or deleting events, for erasure | No key management; the log is the audit trail and replay source | ADR-021 |
| A shared rate-limit store | Infrastructure a single instance does not need | ADR-022 |

## Deferred, with an owner

| Item | Owner |
|---|---|
| ADR-005 vs INV-3 (ADR-017 proposed, with Q1–Q10); the r-q003 / r-q013 BDL contradiction | Michael Kang (product owner) |
| A conflict found after a decision: ADR-017 option (c) recommended; funds disbursement is a new unknown | Michael Kang; Program Officer per the BDL |
| Acceptance of ADR-001..022, the package and the diagrams | Michael Kang |
| Integration credentials and decisions (ORCID ownership, model data terms, sender domain) | Michael Kang |
| Model gaps: the hold guard, the Voided mapping, BDL coverage of erasure and the operator (`HANDOFF.md`) | Michael Kang, as proposed changes |
