# Handoff: Quorum

The next session continues from this file. Read `GOAL.md` first, then this file, then `continuum decision list`.

## State (2026-11-16, production-readiness release)

| What | Value |
|---|---|
| Package | `avlon.quorum package-1`, spec environment `LocalDevelopment`, built in place in `continuum/` |
| Attestation | `sha256:6d1550a331264391077c000f34a7a527f5e1d4cbc8374d7c94cdfb6c679b8d59` |
| changeState | `sha256:434cfdc26bc0503ab8b87c0737759ea0a99fd017baed8c376ec76256cec2ef96` |
| Environments | `LocalDevelopment` (42 bindings, complete) and `Production` (42 bindings: `production.adl-binding.json`). Production reported "binding Production (complete)" in a scratch build with the spec set to Production. Every claim in both is *declared, unverified* |
| Scenarios | 17. `continuum package run`: 17 passed, 0 failed, against the real implementation |
| Conformance | `continuum conformance check`: CONFORMS |
| Evidence | 59 citations verified |
| Decisions | ADR-001..017 and the production decisions, all **proposed**; none accepted. ADR-017 is the architect's ADR-005/INV-3 resolution |
| Package acceptance | **None.** `package accept` and `ledger record` have not been run |
| Diagrams | See `docs/diagrams/README.md`. **None is accepted** |

### What changed in the model this release (pre-acceptance authoring, in place)
No package has been accepted, so these additions were authored directly in `quorum.adl` rather than as an `.adl-change`. They are listed here so the owner reviews them before the first acceptance:
- **Actor:** `Operator`.
- **Enum:** `Role += operator`.
- **Requirements:** `PersonalDataErasable` and `DecisionsEscalated`.
- **Identity:** `EraseAccount` command and `AccountErased` event.
- **Adjudication events:** `AwardRefused`, `AwardHeld` and `DecisionEscalated` (closes B3 and B4).
- **PanelDecision:** a `publish refused` step before `reconsider`.
- **Notification and Oversight:** subscribe to the four new events.
- **Environment:** `Production`.
- **Tests:** `DecisionEscalation` and `AccountErasure`.
- **TypeScript:** contracts regenerated with `continuum compile --emit-typescript`.

## Owner acts awaiting Michael Kang (never performed by an agent)

1. **Decide ADR-017** (`docs/proposals/adr-017-conflict-resolution.md`). It covers the phase-5 policy (Q1, recommended: (c) suspend for an officer's integrity review) and the open questions Q2–Q10. On acceptance, supersede ADR-005.
   - The `.adl-change` in `continuum/model/changes/` is pinned to the changeState above. It must be re-based if the model moves.
   - Its Part 0 repairs a latent `reaction-correlation` typing error. That error makes **every** change to the current model fail `apply`, even though `compile` passes (NOT CHECKED why the two tools disagree). Q10 recommends adopting Part 0 first.
2. **Accept or reject each decision:** `continuum decision accept <ADR> --reason "<why>"`. Add `--option <name>` where a decision lists options.
3. **Accept the package**, after the commit: `continuum package accept continuum --as <you> --verified-against HEAD`, then `continuum ledger record continuum --verified-against HEAD`.
4. **Accept or reject the diagrams.**
5. **Provide the integration inputs** in `docs/OPERATIONS.md` §7: ORCID credentials, an Anthropic key with data terms, and an SMTP relay with sender domain.

## Known model gaps (each a proposed change, not yet authored)

- **The integrity hold is not modelled as a guard** on `isAward -> commit`. ADR-017 replaces the hold, so this is deferred to that decision.
- **Reviews: the `Voided` state vs the `voided_at` column.** This is an accepted mapping, but it is not declared.
- **The BDL does not describe the Operator, erasure or the escalation event.** The ADL carries them. A BDL update should follow ADR-017's BDL changes, so that the two are rebased once.
- **`adl/execution/unset-field-read` on `Submission.Triage.record`.** It is intentional and carried, not silenced.
- **Operator actions (`ops_action`)** are a platform table and are not modelled: they are not business transitions.

The gap protocol: write `continuum/gaps/<date>-<slug>.md`, then an `.adl-change` pinned to the changeState above.
