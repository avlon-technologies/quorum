# Quorum: release report

| | |
|---|---|
| Date | 2026-11-16 |
| Commit | Production-readiness work: `649bbb4`. This report and the load evidence: the commit that follows it on `main` (https://github.com/avlon-technologies/quorum). §10 records the commit the clean-checkout checks ran against. |
| Verdict | **Ready to demo. Production gaps closed in code and tested locally; not yet releasable.** Remaining blockers: owner decisions (§9), credentials only the owner can supply, and a review-path performance limit found by load testing (§11). |

Labels used throughout:
- A **tool** verdict is quoted from a tool that ran.
- **NOT CHECKED** means nothing ran.
- *Declared* means the model says it. *Derived* means a tool computed it. *Recommended* is my own judgment.

## 1. Tool versions

| Tool | Version |
|---|---|
| Node.js | 24.22.1 (TypeScript through type stripping; no build step) |
| Continuum CLI | 0.37.0, `continuum-host-api/1` |
| Fastify / @fastify/static | 5.12.8 / 10.1.11 |
| better-sqlite3 | 13.2.0 (SQLite in WAL mode) |
| jose | 6.2.17 |
| Vitest | 5.1.0 |
| Playwright | 1.65.1 (Chromium) |

## 2. Results

| Check | Command | Result (quoted) |
|---|---|---|
| Type check | `npm run typecheck` | exit 0 |
| Unit, invariant and scenario tests | `npm test` | "Test Files 24 passed (24) · Tests 122 passed (122)" |
| Browser journey (4 roles, 1366px and 390px) | `npm run test:e2e` | "[e2e] PASS", 64 screenshots, 0 console errors, 0 accessibility-smoke issues |
| Model compile | `continuum compile …/quorum.adl-manifest.json --state` | 0 errors, 1 warning (`adl/execution/unset-field-read`, explained in §7) |
| Bindings | the same compile, with `--bindings --vocabulary --environment LocalDevelopment` | "passed (declared)". "29 claim-bearing bindings unverified — no evidence record to witness any claim" |
| Package build | `continuum package build continuum` | "binding LocalDevelopment (complete)", "15 scenarios … every Requirement has a verifying scenario" |
| Package check | `continuum package check continuum` | "every inventoried file matches its digest and a rebuild reproduces the derived files — bytes, not behaviour" |
| Acceptance scenarios | `continuum package run continuum` | "15 passed, 0 failed, 15 executed" (against this implementation, §3) |
| Code coupling vs model | `continuum conformance check continuum` | "CONFORMS — every coupling this check can observe is declared" (4 verified, 1 unverified, 26 unsupported) |
| Evidence citations | `continuum evidence check continuum` | "verified 59 … touched 0 … stale 0" |
| Architecture Guard | `continuum guard ci` | PASS on a committed copy (§4). In the working tree before the first commit it said INDETERMINATE because there was no HEAD |
| `conformance report` | | **NOT CHECKED.** It needs an accepted baseline revision and a `handoff.json` intent directory, and neither exists before the owner's acceptance |
| BDL ↔ ADL alignment | | "not evaluated — no .realization.json declares which ADL elements realize which BDL elements" |

Package identity:
- attestation `sha256:f75646711920628a45e67531ba5fdee8eb85c2efeeea8068ecf268664cee4c12`
- changeState `sha256:e9c76035f0e316fe41e96df7578d2a5043f82e38f99907545af21c2ec0ec1d68`

## 3. Evidence for each invariant

Every invariant has a negative test (NFR-9) and an acceptance scenario. Each is traced: requirement → ADL element → code → test.

The acceptance adapter (`continuum/acceptance/adapter.mjs`) is **not** a reference realization. It drives the real application in-process: the same routes, services, SQLite store and outbox that `npm start` runs.

| Invariant | ADL requirement / rule | Enforced in | Negative evidence |
|---|---|---|---|
| INV-1: submit only while the call is open | `CallAdministration.SubmissionWindow` | `submission/service.ts` submit → synchronous `calls/api.ts` GetCallStatus | `inv-01`; `deadline-boundaries` (refused at exactly the deadline); scenario `inv01-submission-window` |
| INV-2: submitted at most once | `ProposalSubmission.SubmitOnce` | conditional status update and idempotency log | `inv-02`; `duplicate-submission`; `inv02-submit-once` |
| INV-3: no conflicted assignment | `ReviewerAssignment.NoConflictedAssignment` | `peer-review/service.ts` assignmentEligibility, a DB trigger, declareConflict | `inv-03` (service check **and** trigger); `conflict-lifecycle`; `inv03-no-conflicted-assignment`. **Deviation after scoring: §6** |
| INV-4: no self-review | `ReviewerAssignment.NoSelfReview` | assignmentEligibility `self_review` | `inv-04`; `inv04-no-self-review` |
| INV-5: three reviews before scoring | `ReviewCompletionTracking.ThreeReviewsBeforeScoring` | `peer-review/completion.ts` (exactly three, once) | `inv-05`; `two-of-three-readiness` (including redelivery); `inv05-three-reviews` |
| INV-6: every criterion scored | `BlindPeerReview.CompleteScoring` | submitReview → 422 `incomplete_review` | `inv-06`; `inv06-complete-scoring` |
| INV-7: blind until own submission | `BlindPeerReview.BlindUntilOwnSubmitted` | `getPeerReviews` | `inv-07`; `blind-visibility`; `inv07-blind-until-own-submitted` |
| INV-8: chair decides scored proposals only | `PanelAdjudication.ChairDecidesScoredOnly` | `recordDecision` and route access | `inv-08`; `inv08-chair-decides-scored-only` |
| INV-9: envelope never exceeded | `PanelAdjudication.EnvelopeNeverExceeded` | one conditional `UPDATE adj_budget` plus a CHECK constraint (ADR-006) | `inv-09`; `concurrent-awards` (10 OS processes racing a $300,000 envelope → exactly 7 commit; 4 chairs → 3 awarded, 1 reconsider); `inv09-envelope-never-exceeded` |
| INV-10: the agent only proposes | `EligibilityScreening.AgentNeverDecides`, guardrail `AgentProposesOnly` | `submission/triage.ts` (writes `sub_triage` only; the agent gets a frozen read-only snapshot) | `inv-10`; `agent-authority`; `inv10-agent-never-decides` |
| INV-11: role-scoped authority | `AccessControl.RoleScopedAuthority` | `platform/http.ts` (every route declares `access`), per-resource scoping | `inv-11`; `cross-role-access` (57 tests); `inv11-role-scoped-authority` |
| INV-12: verified reviewers only | `ReviewerAssignment.VerifiedReviewersOnly` | synchronous `identity/api.ts` GetReviewerStanding | `inv-12`; `inv12-verified-reviewers-only` |

Beyond the invariants:
- `replay-and-recovery`: SIGKILL inside each consumer's delivery; parking after 5 attempts and retry; projector rebuild.
- `overdue-escalation`.
- `pre-release-review` (§5).
- `adr-005-inv-03-mismatch` (§6).

## 4. Deliberate-regression demonstration

**Setup:** an isolated copy of this tree, given its own baseline commit, so this repository was never touched. Three deliberate regressions were each committed, checked and reverted. Script: `scripts/regression-demo.sh <empty dir>`.

| | Tests | `package check` | `package run` | `conformance check` | `evidence check` | `guard ci` |
|---|---|---|---|---|---|---|
| **Baseline** | 122 passed | intact | 15 passed | CONFORMS | 59 verified | PASS |
| **R1 behavioural:** blind review removed (`getPeerReviews` shows peers before submission) | **2 failed** (`inv-07`, `blind-visibility`) | intact | **FAIL `inv07-blind-until-own-submitted`**: "visible reviews: expected 0, got 2" | CONFORMS (a behaviour change does not change imports) | 2 citations *touched* in `peer-review/service.ts` | **FAIL**: "implementation drift … error implementation acceptance" |
| **R2 structural:** Adjudication imports PeerReview's completion module | 122 passed | intact | 15 passed | **VIOLATED**: "AdjudicationService → ReviewCompletion violated — the code imports; the model declares no dependency" | 2 citations *touched* in `adjudication/service.ts` | PASS (**gap**: the guard does not run the coupling check) |
| **R3 model drift:** the ADL is edited and the package is not rebuilt | 122 passed | **"integrity NOT intact"** | 15 passed | CONFORMS | 59 verified | **FAIL**: "architecture drift … error architecture package.inventory" |
| **Restored** (all three reverted) | 122 passed | intact | 15 passed | CONFORMS | 59 verified | PASS |

What this shows:
- **Each class of regression is caught by at least one check:**
  - behaviour, by the tests, the scenarios and the guard;
  - illegal coupling, by `conformance check`;
  - model/package drift, by `package check` ("integrity NOT intact") and the guard ("architecture drift").
- **No single check catches all three.** CI must run the package check, the scenarios, the conformance check and the tests together; the guard alone missed R2.
- The evidence check flags *any* change to cited code. That makes it a review prompt, not a semantic verdict.

**Found and fixed during this release, not staged:**
- The first `conformance check` on the real code reported two genuine undeclared couplings. The Triage workflow imported Calls' API directly, and it imported the agent provider's module.
- **Fix:** the code was realigned to the declared paths. ProposalService's declared CallApi dependency is now used, and the provider port types moved to `src/contracts/triage-port.ts`. Workflows got their own modules.
- **Rejected alternative:** changing the model. That would have moved the attestation and stranded the pinned diagrams.

### 4.1 Reproducing it

Run `bash scripts/regression-demo.sh <empty dir>`. It copies the tree, commits a baseline, and then for each regression applies it, commits, runs the six checks and reverts it. The exact edits are the three `node -e` lines in the script: the `if (false && …)` guard in `getPeerReviews`, the import of `countedReviews` into `adjudication/service.ts`, and the edited INV-9 `desc` in `quorum.adl`.

## 5. Pre-release architecture review: findings and disposition

**Source:** a `continuum-architect` agent reviewed the brief, model, decisions, code and tests, and ran its own probes. Its findings are evidence; the fixes below were verified by tests that **fail without the fix** (A1 and A2 were checked by reverting each fix).

| # | Finding | Severity | Disposition |
|---|---|---|---|
| A1 | Projection rebuild or a transient failure undercounted the portfolio's committed total. It showed 50k against a ledger of 150k, because awards from different proposal partitions arrive out of order | demo | **Fixed:** the call total is recomputed from the projection, never incremented. Test `pre-release-review` A1 |
| A2 | Integrity hold failed open: (a) an award succeeded while ConflictDeclared was still undelivered to Adjudication; (b) a hold was lost if the conflict landed before the case existed | demo | **Fixed:** (a) an award fails closed (409 `integrity_pending`) while any Adjudication delivery for that proposal is outstanding; (b) holds are recorded in `adj_pending_hold` and applied when the case opens. Two tests |
| A3 | The hold message promised an officer action that does not exist | demo | **Fixed:** the copy now says only a decline remains and the release path is an open owner decision |
| — | Advancing the demo clock signed everyone out (found by the browser journey) | demo | **Fixed:** sessions use wall-clock time; tests inject the manual clock |
| B1 | Demo mode on by default; auto-seeding with a shared password; demo buttons always shown | production | **Fixed:** demo mode is impossible when `NODE_ENV=production`; no auto-seed or password log outside demo; the sign-in shortcuts appear only when the server reports demo mode |
| B2 | A malformed agent verdict was silently lost (`INSERT OR IGNORE` swallowed the CHECK failure); no timeout on the provider | production | **Fixed:** output validated against the declared verdict shape, so a bad verdict becomes a retry and then "screen manually"; 30 s timeout; `ON CONFLICT DO NOTHING`. Test B2 |
| B3 | Decision escalation notifies no one (the model says the officer is notified) | production | **Fixed:** `DecisionEscalated` declared and published once per case; officers notified (ADR-018). Scenario `decision-escalated` |
| B4 | Refused-award reconsider, hold placement and escalation publish no event (NFR-8 gaps) | production | **Fixed:** `AwardRefused`, `AwardHeld`, `DecisionEscalated` published and audited (ADR-018) |
| B5 | A revoked reviewer could still open the assignment; applicants see the mean score and screener id during deliberation; officers can declare conflicts for non-existent ids; ops routes sit under the programOfficer role; role-addressed `markRead` is shared | production | **Fixed:** revoked reviewer 404; ghost conflict ids 404; ops routes moved to a new `operator` role (ADR-019); read state per account. **Open:** applicant visibility (owner question) |
| B6 | A poison delivery holds its partition forever; there is no skip-with-reason | production | **Fixed:** alert on parking; operator retry or skip with a recorded reason; skip refused for invariant-guarding consumers (ADR-020) |
| B7 | INV-5 "at most 3 active" relies on SQLite's whole-database write lock | production | **Fixed:** database triggers; six processes racing assign exactly three |
| B8 | INV-6 was vacuous if the criteria replica was empty | production | **Fixed:** refused with `criteria_unavailable` |
| B9 | BDL `Voided` state is realized as a `voided_at` column | note | **Open:** record as an accepted mapping or change it |

## 6. ADR-005 vs INV-3: the exact mismatch (owner decision)

**What the brief says** (`product/PRODUCT_REQUIREMENTS.md` §5): *"A reviewer with a declared conflict against a proposal can never hold an assignment to it."* Consequence: *"A conflicted review is void and voids the award."*

**What ADR-005 says and the code does** (proposed, recorded as such):
- A conflict on a live assignment **revokes** it, in the same transaction.
- A conflict after a review is submitted but before scoring **voids** the review, and the officer reassigns.
- **After scoring, the conflict holds the award.** The assignment stays `completed`, the review stands and still counts toward the mean, and only a decline remains.
- After a decision, the outcome is unspecified (BDL `ConflictAfterDecision`, accountable: Program Officer).

**Reproduction:** `tests/scenarios/adr-005-inv-03-mismatch.test.ts`, which passes and pins today's behaviour. After a proposal is scored, a reviewer declares a conflict, and then:
- `rev_conflict` has a row for (proposal, reviewer), **and** `rev_assignment` for the same pair is `completed`. Not revoked: in the code's own terms (`ACTIVE` includes `completed`) the reviewer still **holds** the assignment.
- The review's `voided_at` is null, and `rev_completion.mean_score` is unchanged. The conflicted review is **not void**.
- An award returns 409 `integrity_hold` (INV-3); a decline returns 200. So the award is not "voided" either; it is blocked, and the applicant can only be declined.

**Each side requires something different:**
- INV-3, read literally, requires that no state exists where a conflict row and a held assignment coexist, and that the review is void.
- ADR-005 requires that a scored proposal's reviews are never reopened, and settles the integrity problem at the award.
- The BDL also contradicts itself: r-q003 ("declaring a conflict revokes any active assignment at once") against r-q013 (award held after scoring).

**Options:**

| | Keep ADR-005, amend INV-3's wording | Void and re-score | Hold plus an officer "void and re-review" action |
|---|---|---|---|
| INV-3 literally | no (redefined) | **yes** | yes, once the officer acts |
| Applicant penalised for the reviewer's conflict | yes (decline only) | no | no |
| Mean score free of the conflicted review | no | **yes** | yes |
| Cost | wording, plus a hold-release path | backward transition Scored → UnderReview; per-round completion and case identity; cancel the open case; new scenarios | as void-and-re-score, plus one human step |

**Recommendation** (my judgment, consistent with the architect's): **keep ADR-005 for the demo** with the A2 and A3 fixes in place, and record the deviation from INV-3 explicitly, which this section does. **For production, adopt void-and-re-score**, triggered automatically or by an officer action, because it honours the brief's own consequence clause. Either way, resolve the r-q003 / r-q013 contradiction in the BDL.

The decision is the owner's. It needs an `.adl-change` and a BDL change, and nothing has been changed yet.

## 7. Continuum artifacts and their limits

- **Model:** `continuum/model/quorum.adl` (7 bounded contexts, 8 services, 3 workflows, 1 agent with a guardrail, 21 events, 15 declared tests) and `quorum.bdl`.
  - Compiler warning, carried and explained: `adl/execution/unset-field-read` on `Submission.Triage.record`. The verdict is legitimately unset when the agent fails (on-fail=continue), and the step records an absent verdict.
- **Bindings:** `LocalDevelopment` is complete.
  - The triage agent is bound to `fake-triage-provider`, a deterministic rules stand-in. Following the Continuum reference example, the fake claims `reasoning` and `structured-output`. It does **not** reason; a real provider belongs in a second environment's binding.
  - `sqlite-wal` claims `erasure-capable` as a storage capability. Quorum has **no** application-level erasure flow.
  - Every claim is *declared, unverified*.
- **Decisions:** ADR-001..016, all **proposed**. None is accepted (owner act, §9).
- **Diagrams:** `docs/diagrams/` holds three diagrams, **none accepted**. No further paid diagram run was made. Their limits, from `docs/diagrams/README.md`:
  1. *Review workflow*: seven declared hops are drawn as dotted "proposed", and the PanelDecision transition `decline → declined` is missing. Communication rated "NOT YET (0.63, 4 misleading)".
  2. *Asynchronous delivery*: the tool reported a verification failure, which is a reading artifact (a wrapped label). TriageProposed has no publisher drawn, and one edge label is meaningless.
  3. *Authority boundaries*: "51 of 51 DECLARED", but the synchronous INV-1 and INV-12 calls are labelled only "invokes", and the arrows do not name their events.
  4. The diagrams pin attestation `sha256:f7564671…cc4c12`. This release kept that attestation, because the conformance fixes were made in code, not the model. They predate the workflow-module split, which changes no declared element.

## 8. Demo readiness vs production readiness

**Demo: READY.** The four role journeys and the new operator page pass the browser journey at desktop and phone widths (68 screenshots). Every invariant holds, with negative tests and executed scenarios.

**Production: closed in code, verified locally** (`tests/scenarios/production-readiness.test.ts`, 19 tests, and scenarios `decision-escalated`, `account-erasure`):
- escalation delivery to role mailboxes; audit of refused awards, holds and escalations;
- recovery from repeatedly failing deliveries (park, alert, retry, skip with reason);
- reviewer limit under concurrent writes (database trigger, 6-process race);
- online verified backups and a guarded offline restore (`npm run ops`);
- monitoring (`/healthz`, `/readyz`, `/metrics`, alert webhook);
- personal-data erasure, including redaction of the retained event log;
- rate limiting;
- real ORCID, Anthropic and SMTP adapters, tested against local fakes only.

The runbook is `docs/OPERATIONS.md`.

**Production release: NOT READY.** Blocking items:
1. The owner decisions in §9, in particular ADR-017 (INV-3 after scoring).
2. **The review path saturates one CPU core** beyond about 25 concurrent active reviewers, and the server stopped answering at 200 (§11). It needs profiling and a fix, then a re-run of `scripts/load/`.
3. The integrations have never run against the real services. Each needs the owner's credentials and decisions (`docs/OPERATIONS.md` §7).
4. The reverse proxy, TLS and `trustProxy` are not configured, because the proxy is not chosen.
5. Governance: no accepted package, so the guard's implementation dimension judges against nothing accepted.
6. Security review and an accessibility audit (contrast, screen reader): **NOT CHECKED**.

## 9. Remaining owner decisions (Michael Kang)

Nothing below has been performed by an agent.
1. **ADR-017** (`docs/proposals/adr-017-conflict-resolution.md`): the phase-5 policy (recommended: suspend the decision for a Program Officer integrity review), Q2–Q10, and whether to adopt its Part 0 repair first. Then supersede ADR-005.
2. **Accept or reject ADR-001..022:** `continuum decision accept <ADR> --reason "<why>"`.
3. **Accept the package:** `continuum package accept continuum --as <you> --verified-against HEAD`, then `continuum ledger record continuum --verified-against HEAD`.
4. **Accept or reject the diagrams** (`docs/diagrams/README.md` quotes each tool verdict; none passed the communication check).
5. **Applicant visibility during deliberation** (review B5).
6. **Integration inputs** (`docs/OPERATIONS.md` §7): ORCID credentials and whether existence-only verification is enough; an Anthropic key and the data terms for abstracts; an SMTP relay, sender domain and role mailboxes.
7. **The expected workload:** peak concurrent reviewers and applicants. It decides how far the review-path fix must go (§11).

## 10. Clean-checkout verification

**From the previous release.** The clean-checkout run and `scripts/regression-demo.sh` for this release have not run yet: **NOT CHECKED** at this commit.

On 2026-11-16, commit `75176ba` was cloned into an empty directory and the README was followed exactly:

| Step | Result (quoted) |
|---|---|
| `npm ci` | "added 115 packages" |
| `npm run typecheck` | exit 0 |
| `npm test` | "Test Files 24 passed (24) · Tests 122 passed (122)" |
| `npm start` (fresh data directory) | It seeded automatically: "listening on http://127.0.0.1:… (demo clock on)". `/api/health` returned 200; `officer@quorum.test` signed in with 200 |
| `npm run test:e2e` | "[e2e] PASS", 64 screenshots |
| `continuum package check continuum` | "every inventoried file matches its digest and a rebuild reproduces the derived files" |
| `continuum package run continuum` | "15 passed, 0 failed, 15 executed" |
| `continuum conformance check continuum` | "CONFORMS" |
| `continuum evidence check continuum` | "verified 59 … touched 0 … stale 0" |
| `continuum guard ci` (clean tree) | "guard ci: PASS": lifecycle ok, architecture ok, implementation ok; hygiene "drift" is the one carried compiler warning |
| `NODE_ENV=production npm start` | "demo clock off". Nothing was seeded and no password was printed; `/api/health` reported `demo:false`; demo-account sign-in returned 401 |

## 11. SQLite viability (load and crash evidence)

The full evidence is in `docs/evidence/sqlite-viability.md`, with raw results in `docs/evidence/results/`. The harness is `scripts/load/`. The run was stopped at the owner's request before the 10-year capacity step finished.

| Question | Result (quoted from the results) |
|---|---|
| Write ceiling (single writer) | about 250 commands/s, flat from 10 to 200 VUs; `sqliteBusy: 0` |
| Crash safety | 8 hard kills under load: **0** acknowledged writes lost, **0** command-log entries lost; restart in about 0.56 s |
| Rate limiter under load | limits applied within about 1 s; a limited request costs p95 24 ms |
| Review path | p95 131 ms at 10 VUs, 785 ms at 25, 3.7 s at 50, 16 s at 100; at 200 the server stopped answering (1,443 errors). CPU at one full core, with no SQLite lock waits |
| Size over 10 years | **NOT CHECKED.** 60 KB per decided lifecycle was measured; 30,000 lifecycles ≈ 1.8 GB (extrapolated) |

**Verdict (recommended):** SQLite is viable for one funding body, and it is not the bottleneck. The review-path limit is application CPU, and moving to Postgres would not remove it.
