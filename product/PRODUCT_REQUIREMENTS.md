# Quorum — Product Requirements

**Status:** MVP requirements, authored 2026-10-12 as the experimental vehicle for an
independent evaluation of Continuum.
**Author:** the evaluating engineer (autonomous — the application was not specified by
the stakeholder).

---

## 1. The problem

Research funding bodies run **calls for proposals**. Each call attracts dozens to
hundreds of submissions, and every submission must be peer-reviewed by independent
experts before a panel awards money against a fixed budget envelope.

The process is administratively brutal and the failure modes are reputational:

- **Conflicts of interest leak through.** A reviewer at the applicant's own
  institution, or a recent co-author, reviews the proposal anyway. When this is
  discovered after an award, the award is void and the body is in the press.
- **Reviews are not blind.** A reviewer reads a colleague's scores before writing
  their own and anchors to them.
- **Panels adjudicate on incomplete evidence.** A proposal reaches the panel with
  two of three reviews in, because the third reviewer went silent and nobody
  noticed until the meeting.
- **Budget overruns are discovered at the end.** Awards are recorded one at a time
  with no running check against the envelope.
- **Nobody can answer "where is proposal 412?"** without asking three people.

These are not UI problems. They are **invariant-enforcement problems**, which is
exactly why this application was chosen as the vehicle: the interesting
requirements are domain rules that a formal architecture ought to be able to carry.

## 2. Intended users

| User | Role name | What they do |
|---|---|---|
| Principal investigator | **Applicant** | Drafts and submits a proposal to an open call; withdraws it; sees only their own. |
| Domain expert | **Reviewer** | Declares conflicts; receives assignments; scores proposals against published criteria. |
| Funding body staff | **ProgramOfficer** | Opens and closes calls, assigns reviewers, chases overdue reviews, screens submissions. |
| Panel lead | **PanelChair** | Records the panel's award or decline decision against the call's budget. |

Plus two non-human participants:

| Participant | Kind | Role |
|---|---|---|
| **ORCID** | external system | Verifies that a reviewer's claimed researcher identity exists. A credible adapter: real HTTP in production, a deterministic stub locally. |
| **EligibilityTriage** | AI agent | Reads a submitted proposal and proposes an eligibility verdict for a human to confirm. It never decides — it is constrained by a guardrail that forbids autonomous rejection. |

## 3. Business capabilities

1. **Call administration** — publish a call with a deadline, a budget envelope and
   scoring criteria; close it.
2. **Proposal submission** — draft, validate, submit, withdraw.
3. **Automated eligibility triage** — an AI agent screens each submission and
   proposes a verdict; a program officer confirms or overrides.
4. **Conflict-aware reviewer assignment** — assign three reviewers per proposal,
   with conflicts mechanically impossible to assign through.
5. **Blind peer review** — reviewers score independently, seeing nothing of each
   other until their own review is submitted.
6. **Review completion tracking** — detect when a proposal is fully reviewed, and
   when a review is overdue.
7. **Panel adjudication** — the chair awards or declines, under a budget envelope.
8. **Notification** — participants are told what happened, via a durable outbox.
9. **Portfolio reporting** — a read model answering "where is every proposal, and
   what has it scored?" without querying the write side.

## 4. Domain model — the entities that matter

| Entity | Identity | Lifecycle |
|---|---|---|
| **Call** | `CallId` | `open` → `closed` |
| **Proposal** | `ProposalId` | `draft` → `submitted` → `screening` → `under_review` → `scored` → `awarded` \| `declined`; `withdrawn` from any pre-`scored` state |
| **Account** | `AccountId` | registered; roles granted; ORCID `unverified` → `verified` |
| **ConflictDeclaration** | `(AccountId, ProposalId)` | declared, permanent |
| **Assignment** | `AssignmentId` | `assigned` → `accepted` → `completed`; or `overdue`, or `revoked` |
| **Review** | `ReviewId` | `pending` → `submitted` (terminal) |
| **PanelDecision** | `ProposalId` | recorded once, terminal |
| **OutboxMessage** | `MessageId` | `queued` → `delivered` \| `failed` |

## 5. Domain invariants (the requirements with teeth)

These are the acceptance surface of the product. Each is numbered and each is
traced into the architecture and into an automated test.

| # | Invariant | Consequence if violated |
|---|---|---|
| **INV-1** | A proposal may be submitted only while its call is `open` and before the call's deadline. | Late submissions are rejected, not quietly accepted. |
| **INV-2** | A proposal may be submitted at most once; submission is irreversible except by withdrawal. | No silent re-submission after the deadline. |
| **INV-3** | A reviewer with a declared conflict against a proposal can never hold an assignment to it. | A conflicted review is void and voids the award. |
| **INV-4** | An applicant can never be assigned to review their own proposal. | Self-review. |
| **INV-5** | A proposal requires exactly **three** `submitted` reviews before it may enter `scored`. | A panel adjudicating on partial evidence. |
| **INV-6** | A review must score **every** published criterion of its call, each on 1–5, before it may be submitted. | Incomplete reviews skew the mean. |
| **INV-7** | A reviewer may not read any other review of a proposal until their own review for it is `submitted`. | Anchoring; the review is no longer independent. |
| **INV-8** | Only a `PanelChair` may record a panel decision, and only for a proposal in `scored`. | Decisions out of process. |
| **INV-9** | The sum of all `awarded` amounts for a call may never exceed the call's budget envelope. | Committing money that does not exist. |
| **INV-10** | The eligibility triage agent may propose a verdict but may never move a proposal out of `screening`. | An AI silently rejecting a research proposal. |
| **INV-11** | An account may only act in a role it has been granted, and only on resources its role scopes it to. | Privilege escalation. |
| **INV-12** | A reviewer may hold an assignment only if their ORCID identity is `verified`. | Unaccountable reviewers. |

## 6. User journeys

### J1 — Applicant submits a proposal
Register → verify nothing (applicants need no ORCID) → see open calls → create draft
→ fill title, abstract, requested amount → submit. **INV-1, INV-2** are enforced at
submission. A `ProposalSubmitted` event is published.

### J2 — Automated triage (asynchronous)
`ProposalSubmitted` is consumed by the screening service, which runs the
`EligibilityTriage` agent. The agent returns `eligible` / `ineligible` / `unclear`
with a rationale. The proposal moves to `screening` and waits for a human. **INV-10**
is architectural: the agent's output is a *proposal*, not a transition.

### J3 — Program officer screens and assigns
Officer reviews the agent's verdict, confirms or overrides. On `eligible` the
proposal becomes assignable. The officer assigns three reviewers; the system refuses
any reviewer who is conflicted (**INV-3**), is the applicant (**INV-4**), or is not
ORCID-verified (**INV-12**). On the third assignment the proposal enters
`under_review`.

### J4 — Reviewer scores blind
Reviewer sees their assignment list, opens a proposal, sees the abstract and the
criteria but **no other review** (**INV-7**), scores every criterion (**INV-6**),
adds a comment, submits. A `ReviewSubmitted` event is published. Once submitted, the
reviewer can read the other reviews.

### J5 — Completion detection (asynchronous)
`ReviewSubmitted` is consumed by the aggregation service. On the third submitted
review (**INV-5**) it publishes `ProposalFullyReviewed` and the proposal enters
`scored`.

### J6 — Overdue escalation (asynchronous, time-driven)
Each assignment carries a due date. When it passes without a submitted review the
assignment becomes `overdue` and `ReviewOverdue` is published; the outbox notifies
the reviewer and the officer.

### J7 — Panel adjudication (workflow)
`ProposalFullyReviewed` triggers the adjudication workflow: it computes the mean
score, waits on a human task for the chair's decision with a deadline, and on an
award checks the envelope (**INV-9**) before recording the decision (**INV-8**).
`ProposalAwarded` or `ProposalDeclined` is published.

### J8 — Portfolio view
Any officer or chair opens the portfolio read model: every proposal, its state, its
review progress, its mean score, and the call's remaining envelope — served from a
projection, not from the write model.

## 7. Non-functional requirements

| # | NFR | Target |
|---|---|---|
| NFR-1 | Runs entirely locally with no paid infrastructure | single `npm start`, SQLite file, stub ORCID, stub LLM |
| NFR-2 | Authentication | bearer tokens (JWT, HS256, locally signed), 8-hour expiry |
| NFR-3 | Authorization | role-scoped at every API operation; deny by default |
| NFR-4 | Persistence durability | durable, strongly consistent writes; business-record retention |
| NFR-5 | Event delivery | at-least-once, ordered per proposal, durable (outbox table, not in-memory) |
| NFR-6 | Idempotency | every command carries an occurrence identity; replays are no-ops |
| NFR-7 | Input validation | every request body validated against a schema; 400 with a field-level error |
| NFR-8 | Auditability | every state transition is recorded with actor, timestamp and reason |
| NFR-9 | Test coverage of invariants | all 12 invariants have at least one automated negative test |
| NFR-10 | API shape | JSON over HTTP, consistent error envelope, no stack traces to clients |

## 8. MVP boundaries — explicitly out of scope

Recorded so that the architecture is not judged for omitting them:

- **Not in MVP:** real ORCID OAuth (the adapter is a stub with the same contract);
  real LLM calls for triage (a deterministic stub provider; the architecture carries
  the Agent, the implementation carries a fake);
  email/SMTP delivery (outbox writes rows, a drain job marks them delivered);
  file upload of proposal PDFs (abstract text only);
  multi-round review / rebuttal; reviewer bidding; budget negotiation; i18n;
  password reset; rate limiting; multi-tenancy.
- **Deliberately simplified:** exactly three reviewers (not a per-call policy);
  a single fixed criteria set per call; no partial awards.

## 9. Technology decisions (made autonomously, recorded here)

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 + TypeScript (strict) | local, no infra, strong typing for invariant code |
| HTTP | Fastify 5 | schema-first validation satisfies NFR-7 natively |
| Persistence | SQLite via `better-sqlite3`, WAL | durable + strongly consistent (NFR-4), zero infrastructure |
| Auth | `jose` HS256 JWT | NFR-2, no external IdP needed |
| Async | durable outbox table + in-process dispatcher | NFR-5 with at-least-once and ordering, still local |
| Agent | stub provider behind a provider interface | NFR-1; real provider is a binding change, not a model change |
| UI | server-served static HTML + vanilla ES modules | browser-testable without a build step |
| Tests | Vitest | unit, invariant, API, persistence, event and UI-workflow suites |

## 10. Why this application, for this evaluation

It was chosen to stress the parts of Continuum that are distinctive rather than the
parts every modelling tool has:

- 12 invariants → does ADL carry **business rules and guardrails** with meaning?
- an 8-state machine → can ADL express **state transitions** at all?
- three asynchronous reactions and a time-driven escalation → **Reactions, causality,
  `one-of`/`all-of`, WaitStep deadlines**.
- an AI agent that must not be allowed to decide → **Agent + Guardrail + `constrainedBy`**.
- a human-in-the-loop adjudication → **Workflow with `human-task` and `wait`**.
- a portfolio projection → **ReadModel, `projects`, `projectsFrom`**.
- four roles with scoped authority → **Actor, `owns`, Policy**.
- one external integration → **ExternalSystem** and a binding that swaps stub for real.

If Continuum cannot express these faithfully, the gap will be visible.
