# Quorum

Quorum runs research funding calls end to end, for one funding body. Researchers submit proposals to an open call. Program officers screen them, helped by an advisory AI triage agent. Three independent, ORCID-verified reviewers score each eligible proposal blind. A panel chair decides within the call's budget. Oversight follows every proposal through an audit trail.

This repository is also a complete [Continuum](continuum/) demonstration. It contains the business model (BDL), the architecture (ADL), technology bindings, 16 proposed architecture decisions, executable acceptance scenarios, code-level evidence and diagrams. Each of the 12 business invariants is traced from the requirement through the model and code to a test that fails when the invariant is broken.

| Read next | |
|---|---|
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | A five-minute walkthrough with screenshots |
| [docs/RELEASE_REPORT.md](docs/RELEASE_REPORT.md) | Results, evidence for each invariant, open owner decisions, demo vs production readiness |
| [docs/DECISIONS.md](docs/DECISIONS.md) | ADR-001..016 (proposed in the Continuum decision space) |
| [docs/diagrams/](docs/diagrams/) | Three Continuum Diagram views and their known limitations |
| [continuum/](continuum/) | The development package: `GOAL.md`, `model/`, `acceptance/`, `IMPLEMENTATION.md`, `HANDOFF.md` |
| [product/PRODUCT_REQUIREMENTS.md](product/PRODUCT_REQUIREMENTS.md) | The brief |

## Run it

You need Node.js 24 or later (Quorum runs TypeScript directly through Node's type stripping, so there is no build step). It runs on one machine and uses no paid services.

```
npm install
npm start          # http://127.0.0.1:3000
```

On the first start, Quorum seeds a demo database in `data/` with two calls, seventeen accounts and proposals at every stage. To reset to that state, stop the server and run `npm run seed`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where to listen |
| `QUORUM_DATA_DIR` | `data` | Holds the SQLite database, the token secret and the outbound mail log |
| `QUORUM_DEMO` | on | Enables the demo clock control, the seeded accounts and the sign-in shortcuts. Set `QUORUM_DEMO=0` to turn it off. Demo mode is **always off when `NODE_ENV=production`**. |
| `QUORUM_ORCID` / `QUORUM_TRIAGE` / `QUORUM_MAIL` | `stub` / `stub` / `file` | Selects the real adapters (`http` / `anthropic` / `smtp`) and their credentials. Startup fails if a selected adapter is missing configuration. |

A production deployment (one instance, a persistent volume, backups, monitoring, rate limits, erasure, and the real integrations with the exact credentials each needs) is described in **[docs/OPERATIONS.md](docs/OPERATIONS.md)**. Whether SQLite is viable for the expected workload is measured in [docs/evidence/sqlite-viability.md](docs/evidence/sqlite-viability.md).

### Demo accounts

Every seeded account has the password **`quorum-demo-2026`**. In demo mode the sign-in page offers one-click buttons for these accounts.

| Role | Account | Notes |
|---|---|---|
| Program officer | `officer@quorum.test`, Dr. Amara Okafor | Screening, assignment, calls, audit log, demo clock |
| Panel chair | `chair@quorum.test`, Prof. Henrik Lindqvist | Decisions within the budget envelope |
| Applicant | `priya.raman@quorum.test` | Has an empty draft on the climate call |
| Reviewer | `fatima.alsayed@quorum.test` | One review is overdue on the permafrost proposal |
| Reviewer (unverified) | `marc.dubois@quorum.test` | Cannot be assigned until his ORCID iD is verified (INV-12) |
| Applicant and reviewer | `sarah.chen@quorum.test` | Can never review her own proposal (INV-4) |
| Operator | `operator@quorum.test`, Jordan Reyes | Delivery health, retry or skip, backups, personal-data erasure. Holds no business role. |

The other applicants are mateo, kwame, elena and liam. The other reviewers are hannah, david, jonas, grace and aisha. All addresses are `@quorum.test`, and the seed (`src/seed.ts`) has the full list.

By default, ORCID, the triage model and outbound email are local stand-ins behind their declared boundaries; the real adapters are selected by the variables above. The stub ORCID accepts any checksum-valid iD that is not already registered, for example `0000-0002-1234-5677` (`0000-0002-1825-0097` is already registered to a seeded reviewer, so the stub refuses it as a duplicate). Outbound mail is appended to `data/mail.jsonl`.

## Verify it

```
npm run typecheck              # tsc, no emit
npm test                       # 29 files, 203 tests: a negative test per invariant, scenario tests,
                               #   production readiness, and the integrations against local fakes
npm run test:invariants        # only the 12 invariant suites
npm run test:e2e               # Playwright: the four roles and the operator, desktop and mobile, 68 screenshots
npm run ops -- backup|verify|list|restore   # operator command line (docs/OPERATIONS.md)
```

Before the first `test:e2e` run, install the browser once with `npx playwright install chromium`.

The Continuum checks need the `continuum` CLI (0.37.0) and a Continuum Host login:

```
continuum package check continuum        # the package's model, bindings and derived files are current
continuum package run continuum          # 17 acceptance scenarios, executed against this implementation
continuum conformance check continuum    # the code's imports agree with the model's declared dependencies
continuum evidence check continuum       # every code citation still points at what it cited
continuum guard ci                       # the Architecture Guard (CI form)
continuum decision list                  # ADR-001..017 and their status (all proposed)
```

`.githooks/` runs the guard on commit and push (`git config core.hooksPath .githooks`). `.github/workflows/continuum.yml` runs it in CI.

## How it is built

The application is a single Node process, organised as seven bounded contexts. Each one is the only writer of its own tables:

| Context | Owns | Tables |
|---|---|---|
| Identity | accounts, roles, ORCID verification | `idn_` |
| Calls | calls, criteria, deadlines, envelopes | `cal_` |
| Submission | proposals and their status, screening, the triage workflow | `sub_` |
| PeerReview | conflicts, assignments, reviews, review completion, the review deadline | `rev_` |
| Adjudication | the budget ledger, panel cases, decisions | `adj_` |
| Notification | messages to people | `ntf_` |
| Oversight | portfolio and audit-trail projections, fed only by events | `ovs_` |

How the contexts work together:
- Contexts communicate through a transactional outbox in the same SQLite database. Delivery is at-least-once, ordered per proposal and tracked per consumer, and a delivery is parked after five failures. A crash between a command and its consequences loses nothing and duplicates nothing.
- Two checks are consistency-critical, so they are synchronous calls inside the command's transaction: the submission window (INV-1) and reviewer standing (INV-12).
- Every command carries an Idempotency-Key.
- The browser UI (`public/`) is plain ES modules with no build step.
- Operations (retry or skip a parked delivery, backup, erasure) belong to the `operator` role, and every operator action is written to an append-only log.

Source layout: `src/platform/` (database, schema, outbox, HTTP, auth), `src/contexts/<context>/`, `src/api/routes.ts` (every route declares its access rule and the model element it realizes), `src/integrations/` (the stubs and the production adapters, chosen in `factory.ts`), `src/ops.ts` (backup and restore), and `src/seed.ts`.

## Status

The demo is ready. The production gaps listed in the previous release are closed in code and verified locally. Production release still depends on the owner's decisions and on credentials only the owner can provide. [docs/RELEASE_REPORT.md](docs/RELEASE_REPORT.md) has the details.
