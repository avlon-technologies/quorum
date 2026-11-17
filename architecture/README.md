# Claim attestation pilot (experimental, prompt 029)

The assessor's intent for `continuum conformance report`, read from git at `--baseline`:

| File | What it is |
|---|---|
| `handoff.json` | `continuum inspect continuum/model/quorum.adl-manifest.json --business continuum/model/quorum.bdl --handoff architecture/handoff.json`; baseline attestation `sha256:6d1550a3…`, change-state `sha256:434cfdc2…` |
| `verification/reviewstore-writers.verification.json` | ADL claim: ReviewStore (`7cbfd5c5…`) is written only by its declared writer(s). Carries its versioned `continuum-claim-spec/0` |
| `verification/verified-reviewers-only.verification.json` | BDL claim: rule `VerifiedReviewersOnly` (`r-q012`) on AssignReviewer. Carries its versioned `continuum-claim-spec/0` |
| `verifiers/*.mjs` | The verifiers. They **observe** and write values. The Host (Platform `judgeClaimAttestation`) computes every pass, the scope and the level. |

The levels are informational and never set the report's exit:
- **L0**: the claim compiled, with no positive evidence.
- **L1**: observed.
- **L2**: verified within scope.
- **L3**: enforced.

They are not the retired AACS levels (DR-1).

The four specifications name `continuum-claim-rubric/2`, where the levels read L0 Model Valid, L1 Observed
Conformance, L2 Covered Conformance and L3 Strong Conformance. A spec that names no rubric is judged under
`continuum-claim-rubric/1`, where L3 keeps its historical meaning "Enforced".

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

Expected for this pilot: three claims at **L3 — Strong Conformance** (`reviewstore-writers`, `verified-reviewers-only`,
`chair-decides-scored-only`). `orcid-verification-lifecycle` is a **MISMATCH**: account erasure sets a Verified
reviewer's `orcidStatus` back to Unverified, and the BDL state model `OrcidVerification` (sm-q002) declares no such
transition. The overall level is therefore unset. That mismatch is a real finding awaiting the owner's decision. It is
not a pilot defect, and it stays in the report.

## Exit status: 3, and why

The command exits **3 (ERROR)**, with the reason `no implementation test was evaluated`. Quorum's tests run under
Vitest (`"test": "vitest run"`), and `conformance report` runs only a `node --test` suite. The implementation tests
are therefore `not-evaluated`, and the report rule is that a run with no evaluated test is ERROR, never PASS.

The claim attestations play no part in this: they are informational and never set the exit code. `result.reasons`
names only the test runner, and `result.unverified` is empty, because an attested verification is judged into
`attestations` and not listed as unverified. A MISMATCH there leaves the exit unchanged.
`--tests-from ci` (a JUnit artifact from a CI run for the exact commit) is the supported way to supply non-`node
--test` results. This repository has no such CI job yet.
