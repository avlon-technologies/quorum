# Claim attestation pilot (experimental, prompt 029)

The assessor's intent for `continuum conformance report`, read from git at `--baseline`:

| File | What it is |
|---|---|
| `handoff.json` | `continuum inspect continuum/model/quorum.adl-manifest.json --business continuum/model/quorum.bdl --handoff architecture/handoff.json`; baseline attestation `sha256:2099b4d9…`, change-state `sha256:d95dfab0…` (ADR-023; the bdd0ffa pilot was `sha256:6d1550a3…` / `sha256:434cfdc2…`) |
| `verification/reviewstore-writers.verification.json` | ADL claim: ReviewStore (`7cbfd5c5…`) is written only by its declared writer(s). Carries its versioned `continuum-claim-spec/0` |
| `verification/verified-reviewers-only.verification.json` | BDL claim: rule `VerifiedReviewersOnly` (`r-q012`) on AssignReviewer. Carries its versioned `continuum-claim-spec/0` |
| `verifiers/*.mjs` | The verifiers. They **observe** and write values. The Host (Platform `judgeClaimAttestation`) computes every pass, the scope and the level. |

The levels are informational and never set the report's exit:
- **L0**: the claim compiled, with no positive evidence.
- **L1**: observed.
- **L2**: verified within scope.
- **L3**: enforced.

They are not the retired AACS levels (DR-1).

All five specifications now name `continuum-claim-rubric/3`, the one rubric the Host judges (`/2` was removed): L0
Assessed, L1 Supported, L2 Verified in scope, L3 Violation-sensitive. The sections below describe the `/2` pilot and
`continuum conformance report`; they are kept as its record.

Under `/3`, run `continuum conformance check continuum`. Expected: all six claims at **L3**, each deliberate fault
detected: `reviewstore-writers`, `at-most-three-reviewers`, `verified-reviewers-only` (3.0.0),
`chair-decides-scored-only` (2.0.0), `orcid-verification-lifecycle` (3.1.0) and `envelope-not-exceeded` (1.0.0).

- `orcid-verification-lifecycle` 3.1.0 declares the `boundary-shift` class it lacked at 3.0.0 (where it stopped at
  L2). Its fault, `unconfirmed-id-verifies`, records an iD the registry does not confirm; the existing boundary case
  `unregistered-id-stays-unverified` detects it. The verifier is unchanged.
- `envelope-not-exceeded` 1.0.0 claims the ADL rule `EnvelopeNotExceeded` (whole statement, quoted as its clause). Its
  scope is every write to `adj_budget`: the conditional commit in `commitAward`, reached from the decision route, and
  the row opened at zero when `CallPublished` is delivered. Cases place committed + amount below, at, one minor unit
  above and far above the envelope, and send two awards at once. Four faults, one per violation class: the check
  removed, the bound off by one, the check moved outside the write transaction, and a refused award recorded anyway.

What changed for `/3`:

- `chair-decides-scored-only` claims the ADL rule `ChairOnScoredOnly` (whole statement, quoted as its clause) in place
  of BDL `r-q008`, and adds the integrity-hold cases. The Host reports any ADL business-rule claim as a clause, so the
  rule's own row stays where its scenarios put it.
- Every case reports `reached`, read from V8 block coverage by `verifiers/lib/reach.mjs`. It corrects one V8 reading:
  code after an early `throw` is not counted as executed when a `? :` sits between them.
- The lifecycle's store-constraint check (which never passed) is reported beside the results, not judged.

## Requirements

| | |
|---|---|
| CLI | `@avlon/continuum-cli` **0.38.0** or later, from the Azure Artifacts feed (`npm i -g @avlon/continuum-cli`) |
| Host | one serving host-contract **1.30.0** or later. The dev Host `https://continuum.dev.avlon.ca` does (continuum-host `develop`). Point the CLI at it with `continuum login` or `CONTINUUM_HOST` + `CONTINUUM_HOST_API_KEY`, and check with `continuum doctor` (`Host contract 1.30.0`) |

An older CLI or Host reports no `attestations`: the claim rows only show UNVERIFIED.

## Reproduce

```sh
git clone <this repo> quorum && cd quorum && git checkout attestation-029/pilot
B=$(git rev-parse HEAD)
continuum conformance report architecture --baseline $B --commit $B \
  --business continuum/model/quorum.bdl --out ../report --json
```

The report's `attestations` hold, for each claim:
- the verdict and level;
- the model revision and the commit;
- the verified scope and the evidence;
- what the next level needs.

`attestationSummary` holds the overall level across the included claims. It is unset when any included claim has no
earned level.

Expected for this pilot since ADR-023 (account erasure clears ORCID verification): `reviewstore-writers`,
`verified-reviewers-only` and `chair-decides-scored-only` stay at **L3 — Strong Conformance**; their specifications
changed only their model pin. `orcid-verification-lifecycle` (spec 2.0.0) is judged against sm-q002 with the
declared `ClearOnErasure` (Verified → Unverified, by EraseAccount). Because the evaluator admits a transition by its
states alone, the specification also checks the restriction itself: every write that sets Unverified lies in
`eraseAccount` and is reached only from the operator's erase route, every write that sets Verified lies in
`recordOrcidVerification`, is reached only from the verification route and fixes Unverified as its prior value, and
a Verified reviewer re-verifying (another iD, an unknown iD, their own iD) stays Verified. It can reach at most
**L2 — Covered Conformance**: no database constraint refuses an undeclared change of `idn_account.orcid_status`, so
its enforcement (L3) check does not pass. The overall level is then the lowest of the four.

At bdd0ffa (before ADR-023) the same report gave three L3 claims and a **MISMATCH** on sm-q002 (account erasure
set a Verified reviewer back to Unverified with no declared transition); that report is kept as the baseline.

## Exit status: 3, and why

The command exits **3 (ERROR)**, with the reason `no implementation test was evaluated`. Quorum's tests run under
Vitest (`"test": "vitest run"`), and `conformance report` runs only a `node --test` suite. The implementation tests
are therefore `not-evaluated`, and the report rule is that a run with no evaluated test is ERROR, never PASS.

The claim attestations play no part in this: they are informational and never set the exit code. `result.reasons`
names only the test runner, and `result.unverified` is empty, because an attested verification is judged into
`attestations` and not listed as unverified. A MISMATCH there leaves the exit unchanged.
`--tests-from ci` (a JUnit artifact from a CI run for the exact commit) is the supported way to supply non-`node
--test` results. This repository has no such CI job yet.
