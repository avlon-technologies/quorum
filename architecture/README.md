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

## Reproduce

These commands need a Host that judges claim attestation. That is the unreleased stack from prompt 029: Platform `attestation-029/claim-levels`, host-api and host-contract `attestation-029/judge-report-model`, and the CLI `attestation-029/claim-attestation`.

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
