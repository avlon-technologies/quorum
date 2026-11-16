# Quorum — architectural decisions (index)

**The authoritative record is the Continuum decision space** (`continuum/decisions.jsonl`, signed
by the Continuum Host; `continuum decision list`, `continuum decision show ADR-NNN --verbose`).
This file is only a readable index. Every decision was proposed with its rejected alternatives,
and most carry `--expect` assertions the Host checks against the ADL/BDL (`continuum decision check`).
Proposing is the engineer's act; **accepting is the space owner's** and has not been performed here.

Origin: initial-modeling critique and model review by the Continuum Architect (2026-11-16),
resolved by the implementing engineer. Script: `scripts/propose-decisions.sh`.

| ADR | # | Decision | Rejected alternative | Why |
|---|---|---|---|---|
| ADR-002 | D1 | Seven bounded contexts (Identity, CallAdministration, Submission, PeerReview, Adjudication, Notification, Oversight), each the **single writer** of its own tables in one SQLite file. | Modules writing each other's tables. | One writer per fact makes every invariant enforceable in one place; one file keeps NFR-1. |
| ADR-003 | D2 | **Consistency-critical cross-context checks are synchronous in-process API calls** inside the caller's transaction (call open/deadline for INV-1, reviewer standing for INV-12). Event-fed replicas only where staleness is safe (applicant id, criteria snapshot). | An event replica of call status for INV-1. | A replica lags a `CallClosed`; one SQLite file makes a synchronous read strongly consistent at no cost. |
| ADR-001 | D3 | **Submission is the single writer of `Proposal.status`.** Every transition is a conditional update (`WHERE status = :expected`); a late event against a terminal state is a recorded no-op. Adjudication starts on **`ProposalScored`**, not `ProposalFullyReviewed`. | Each context writes status; adjudication triggered by `ProposalFullyReviewed`. | A withdrawal can race the third review; only the status owner can decide the proposal reached `scored`. |
| ADR-004 | D4 | Two states added to the brief's lifecycle: **`eligible`** (screened in, awaiting reviewers) and terminal **`ineligible`** (screened out by an officer). | Reusing `declined` for screening rejections; a flag inside `screening`. | `declined` is a panel outcome that only a PanelChair may record (INV-8). |
| ADR-005 | D5 | **Conflict declarations live in PeerReview with assignments.** Declaring a conflict revokes any active assignment of that reviewer to that proposal **in the same transaction**. After the review was submitted but before `scored`, the review is voided and the officer reassigns. After `scored`, the conflict is recorded and the award is **held** (decline still possible). After a decision: *unspecified* (BDL `unspecified`, accountable: Program Officer). | Refusing late declarations; voiding decided awards automatically. | INV-3 says "can never hold"; hiding a disclosed conflict is worse than blocking an award. |
| ADR-006 | D6 | **INV-9 is checked against Adjudication's own budget ledger** with one conditional write (`UPDATE … SET committed = committed + :amt WHERE committed + :amt <= envelope`) plus a `CHECK` constraint. The envelope is **immutable once a call opens**; award amount = requested amount (no partial awards). | Summing from the portfolio; a read-then-write in application code. | The conditional write is atomic across connections and processes, not only within one Node thread. |
| ADR-007 | D7 | **Event delivery: one transactional outbox**, global sequence, partitioned by proposal (or call), **progress tracked per consumer**, consumer effect + progress committed in one transaction, retries with backoff, **parked as `failed` after 5 attempts with the partition held** until an officer retries. The log is retained (it is the audit trail). | Per-aggregate sequences; a per-row delivered flag; in-memory bus. | NFR-5 orders per proposal across publishers; fan-out needs per-consumer progress. |
| ADR-008 | D8 | **Every mutating request carries an `Idempotency-Key`**; the key, request hash and response are stored in the same transaction as the effect. Same key + different body → 422. Natural identities (proposal id for submit, proposal id for decide) also make the domain itself idempotent. | Header-only dedupe written after the effect. | A crash between effect and log would replay the effect. |
| ADR-009 | D9 | Review period is fixed at **21 days** (`P21D`); **late reviews are accepted** (`overdue → completed`); the officer may revoke and replace an overdue reviewer. Reviewers explicitly **accept** an assignment (attesting no conflict). | Rejecting late reviews; dropping the `accepted` state. | Refusing a finished review helps nobody; acceptance is where a conflict is declared. |
| ADR-010 | D10 | The chair's decision deadline (`P14D`) **escalates and never decides**. A budget refusal returns the case to the chair (who may decline). | Expiry that auto-declines. | A timeout is not a panel decision (INV-8). |
| ADR-011 | D11 | **Triage is advisory and non-blocking.** Submission enters `screening` on its own reaction; the agent's verdict is stored as a `TriageProposal`; if the agent fails the officer screens without it. The agent has **no tool that sends a command**. | Screening waits for the agent. | INV-10, and a failed provider must not strand proposals. |
| ADR-012 | D12 | **Roles are read from the database on every request**, not trusted from the JWT. | Role claims in the token. | A revoked role would otherwise persist up to 8 hours (INV-11). |
| ADR-013 | D13 | **The event log is the audit trail.** Every transition publishes an event carrying actor, timestamp and reason in the same transaction; the Oversight context projects the per-proposal timeline. | A shared `audit_log` table written by every context. | A shared table would have seven writers (cross-context resource access). |
| ADR-014 | D14 | Delivery guarantees are a **binding** claim (`sqlite-outbox`), not a model resource; the brief's `OutboxMessage` is the Notification context's outbound message store (`queued → delivered | failed`). | Modeling the event outbox as a domain resource. | Delivery is how, not what; the semantic model stays technology-free. |
| ADR-015 | D15 | The refused-award path admits only the chair's acknowledged decline; decision events carry actor and rationale from the task outcome. | Unguarded reconsider → decline; loop back to the decide task. | Review found the workflow, not the chair, could decide a decline, and decisions carried no actor. |
| ADR-016 | D16 | Only AssignmentService writes Overdue; ReviewDeadline invokes `MarkOverdue` then publishes `ReviewOverdue`; a revocation ends the wait. | Sweeper publishing directly from the service. | Review found two publishers of ReviewOverdue and no declared writer of Overdue. |

## Check results at proposal time (model changeState sha256:e9c76035…)

| ADR | `continuum decision check` | Note |
|---|---|---|
| 001, 002, 003, 005, 006, 011, 013 | **Aligned** — every expectation holds | |
| 004 | Change required — 2 MISSING | Expectation phrasing error: `lifecycle … between <A>` takes an *action* A. And `precondition RecordPanelDecision …` was reported as "no action RecordPanelDecision" although it is declared as a BDL `decision` — a possible checker gap. |
| 009 | Change required — 1 MISSING | Same `between` phrasing error. |
| 016 | Change required — 1 MISSING | A step-level subject (`ReviewDeadline.mark invokes …`) was not resolved; the model declares the invoke (compiles). |
| 007, 008, 010, 012, 014, 015 | no expectations | prose decisions — realized and evidenced in code and tests |

`decision amend` cannot change expectations, so these findings stay on the record; the owner may
accept with the finding noted, or reject and re-propose with corrected expectations.
