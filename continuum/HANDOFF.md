# Handoff: Quorum

The next session continues from this file. Read `GOAL.md` first, then this file, then `continuum decision list`.

## State (2026-11-16)

| What | Value |
|---|---|
| Package | `avlon.quorum package-1`, environment `LocalDevelopment`, built in place in `continuum/` |
| Attestation | `sha256:f75646711920628a45e67531ba5fdee8eb85c2efeeea8068ecf268664cee4c12` |
| changeState | `sha256:e9c76035f0e316fe41e96df7578d2a5043f82e38f99907545af21c2ec0ec1d68` |
| Bindings | 38 bindings, complete. All 29 claim-bearing bindings are *declared, unverified* (no evidence record witnesses a claim) |
| Scenarios | 15. `continuum package run` result: 15 passed, 0 failed, run against the real implementation (`acceptance/adapter.mjs` drives the app in-process) |
| Conformance | `continuum conformance check`: CONFORMS (4 verified, 1 unverified, 26 unsupported) |
| Evidence | 59 citations, all verified |
| Decisions | ADR-001..016, all **proposed**. None is accepted. |
| Package acceptance | **None.** `package accept` and `ledger record` have not been run. |
| Diagrams | Three diagrams, all **not accepted**. They are pinned to the same attestation (`docs/diagrams/README.md`). |

## Owner acts awaiting Michael Kang (never performed by an agent)

1. **Decide ADR-005 vs INV-3** (`docs/RELEASE_REPORT.md` §6). The recommendation is to keep ADR-005 for the demo and adopt void-and-re-score for production. Either way, the BDL contradiction between r-q003 and r-q013 must be resolved.
2. **Accept or reject each decision.** Example:
   `continuum decision accept ADR-001 --reason "<why>"`. If a decision lists options, add `--option <name>`; `continuum decision show <ADR>` lists them. Repeat for each ADR you accept. Settle ADR-005 last, after decision 1. An acceptance binds to the model state at the time you run it.
3. **Accept the initial package**, after the first commit:
   `continuum package accept continuum --as <you> --verified-against HEAD`, then
   `continuum ledger record continuum --verified-against HEAD`
4. **Accept or reject the diagrams** (`docs/diagrams/README.md` lists their known disagreements with the model).

## Known model gaps (each is a proposed change, not yet authored)

- **Escalation notifies no one.** The PanelDecision `decide` task says "the program officer is notified". The code flags the case on the officer's work queue and publishes no event. A fix needs a declared `DecisionEscalated` event (review B3).
- **Some transitions publish no event.** The refused-award transition to reconsider, placing an integrity hold, and stamping an escalation are all unaudited (review B4, NFR-8).
- **The integrity hold is not modelled as a guard.** It is enforced in code (`adj_case.integrity_hold`, plus a fail-closed check on in-flight deliveries) and described in BDL prose, but there is no guard on the ADL `isAward -> commit` step.
- **Reviews: `Voided` state vs `voided_at` column.** The BDL `ReviewLifecycle.Voided` state is realized as a `voided_at` column overlay. This is an accepted mapping, but it is not declared.
- **`adl/execution/unset-field-read` on `Submission.Triage.record`.** The `verdict` may be unset when the agent fails (on-fail=continue). This is intentional: the record step stores an absent verdict. The warning is carried, not silenced.

The gap protocol: write `continuum/gaps/<date>-<slug>.md`, then an `.adl-change` pinned to the changeState above.
