---
name: development-package
description: Produce a Continuum development package, the implementation-ready handoff - compiled ADL, bindings, traced Given/When/Then scenarios and a contract, checked by `continuum package build` and `check`. Use when explicitly asked for a development package or handoff. Never implements the app.
---

# Development package (intent → verified handoff)

**Load the `continuum` skill first** — knowledge routing, tool routing,
diagnostics and evidence discipline live there. This file is the
packaging flow only. The guide for the package format and its
authority boundaries is `continuum://guides/development-package`; the
worked example is `continuum://examples/development-package/conversation-room/README.md`.

The deliverable is a **checked package** — not "a folder of documents", not proof the implementation is right:
`GOAL.md` · `model/<system>.adl` + manifest · `model/<env>.adl-binding.json`
· `acceptance/scenarios/*.scenario.json` · derived `IMPLEMENTATION.md`,
`acceptance/README.md`, traces and `PACKAGE.json` — built by
`continuum package build`, which refuses to write anything
until the model compiles, the bindings apply and are complete, and every
scenario reference resolves; `package run` then executes the scenarios.

**One layout** (`continuum://guides/development-package` §2): the
package has the same shape standalone and as a repository's `continuum/`.
`model/` holds the semantic state (source, manifest, bindings, claims, a
shipped change, the derived projection and proof); `acceptance/` the
executable specification; the root the spec, the Goal and the derived
documents. The spec names only choices — `name`, `environment`,
`controls`, a change to apply — everything else is discovered from its
canonical location; never write `continuum/` *inside* a package, and
never a semantic file at its root.

```
Goal          why                         prose; adds no claim the model does not make
semantic ADL  what the system means       AUTHORITY inside the package
bindings      how THIS environment does it  the only place a technology may appear
scenarios     what must be true, executably  each names what it verifies
implementation  outside the package
```

## 0a. Conversation-to-handoff accountability (mandatory for a development-ready handoff)

**The task is the complete outcome, not a sequence of file requests.** When a
human asks to "prepare the development package", "make it developer-ready", or
"commit the handoff", take ownership of a single end-to-end deliverable. Do not
mark the request complete because some files were created or a compiler returned
zero errors. The acceptance question is: **Can an implementation agent unfamiliar
with the conversation implement the agreed system from the repository alone,
without material loss or contradiction of intent?**

### Preserve and reconcile the conversation

Before writing or changing artifacts, recover the relevant architectural
conversation, including explicit choices, rejected alternatives, constraints,
behaviour examples, security boundaries, acceptance criteria, and unresolved
questions. Read the existing repository and any prior decision records; do not
silently replace previously agreed intent with convenient defaults. If the
conversation is unavailable, identify the missing source rather than claiming
complete reconciliation.

Maintain a **handoff reconciliation matrix** during authoring, with one row per
material agreement: intent / source or evidence / authoritative artifact and
semantic element / executable scenario or verification / disposition. A row is
complete only when its implementation-relevant intent is represented in the
correct native artifact and its evidence is inspectable. Include negative
requirements and rejected alternatives. Distinguish **represented**,
**explicitly deferred**, **blocked**, and **missing**; missing or contradictory
material intent blocks delivery. Keep the matrix as an authored review artifact
outside generated files (for example `continuum/handoff-reconciliation.md`),
not as a substitute for ADL, BDL, bindings or scenarios.

Use **native artifacts for their own authorities**: semantic architecture in
ADL; business semantics in BDL when part of the agreed scope; technologies in
bindings; behaviour in traced native acceptance scenarios; architectural
choices in ADRs or the governed decision ledger; diagrams from the model where
supported. Do not present a prose technology table as bindings, prose Given/
When/Then as executable scenarios, candidate ADR Markdown as Host-accepted
decisions, or an inferred diagram edge as a declared relationship. The package
builder's minimum inventory is **not** the full inventory of what the user may
have agreed to deliver. Verify both.

### Pre-commit delivery gate

Before committing or declaring the handoff developer-ready:

1. Reconcile the package against the conversation and existing decisions; close
   or explicitly defer every material row with an accountable owner.
2. Compile the target ADL state; compile BDL if in scope; explain
   warnings, unknowns and gaps rather than treating a green compile as fidelity.
3. Realize and validate **complete** technology bindings for the target
   environment, with pins derived from the compiled model, not invented.
4. Build with `continuum package build` and verify the built inventory with
   `continuum package check`. Confirm the generated `PACKAGE.json`, derived
   documents, model identity and scenario-reference coverage actually exist.
5. Execute `continuum package run` where an adapter or implementation exists;
   distinguish validated-but-unexecuted scenarios from passing tests. Inspect
   diagrams for semantic fidelity and clearly mark inferred content.
6. Independently review the handoff **as a cold implementation agent**: check
   whether its tools, interfaces, data contracts, failure modes, trust boundaries,
   deployment, acceptance criteria and unresolved decisions are sufficiently
   specified without relying on chat history. Repair the package and rerun the
   applicable gates if this review finds material omissions.
7. Confirm decision governance separately: proposed Markdown ADRs do not imply
   accepted Host decisions; never claim acceptance without ledger evidence and
   authorized identity. Do not perform acceptance on a human's behalf.
8. **Only then commit** the verified package, when repository write access is
   available and the user has authorized committing. Do not commit incomplete
   work to `main` as a substitute for finishing. If the user explicitly asks
   for a WIP checkpoint, label it unverified and never call it a handoff.

**Do not equate build/check success with runtime conformance or human approval.**
Report the three separately: package consistency, executed behaviour, and
accepted decisions.

### Recover before escalating

A missing tool, inaccessible builder, invalid scenario, stale binding or absent
`PACKAGE.json` is a diagnostic, **not a completion state**. Investigate
supported alternate routes: local CLI, toolchain/project-kit commands,
repository scripts, connected Host/MCP capabilities, and reproducible CI. Use
`continuum package build` to generate `PACKAGE.json`; never hand-author
proofs or fabricate passing results. Do not commit a partially verified package
simply because one route failed. After reasonable recovery attempts, stop with
an exact blocker, commands attempted, evidence, what remains incomplete, and
the minimal next action; do not claim success or silently delegate ownership
back to the user.

### Required delivery report

Present a concise **handoff readiness report** with the repository/commit (if
committed), source intent coverage, ADL/BDL diagnostics, binding completeness,
package build/check verdict, scenario count and execution status, diagram
fidelity, ADR governance status, unresolved gaps and any blockers. Say
**READY** only if the agreed handoff inventory is complete, reconciliation
passes and the applicable pre-commit gates passed. Otherwise say **NOT READY**
with specific evidence. A tool's inability to verify is **UNVERIFIED**, never
PASS; quote Guard outcomes as given (PASS, FAIL, INDETERMINATE — exit 2, or exit 3 where a judgment was required — and NOT APPLICABLE). Keep the report distinct from the generated Continuum contract.

## 0. In five commands

```
continuum package build  <dir>                 create: discover model/, acceptance/, GOAL.md (spec name kebab-case); compile, bind, derive
continuum package check  <dir>                 verify: CURRENT, or the file that drifted
continuum package run    <dir>                 execute the suite here (a run, never an acceptance)
continuum package accept <dir> --as <you> --verified-against HEAD   the initial acceptance (§9.5)
continuum package export <dir> --out <dir>     export: the portable package, verified on its own
```

`realize` and `bind refresh` maintain binding state (§3); a change is a
transition (§5a). You run build, check, run and export and relay the verdicts;
`package accept` and `ledger record` are the person's acts, handed to them.

## 1. Classify the mode, then establish the state

| You were given | Mode | The state the package rests on |
|---|---|---|
| a goal, an idea, requirements | **new system** | author it with `author-architecture`, then continue here |
| a manifest + `.adl` | **existing model** | that model, compiled — identities preserved, nothing re-minted |
| a model + `.adl-change` | **change** | **state B = apply(A, Δ)** — never A |

Establish the state mechanically before authoring anything else — and
establish it for the state the package will rest on, which in change mode is
**B**:

```
continuum compile <manifest> --state --json                                  A
continuum compile <manifest> --apply <change> --emit-source <dir> --state --json   B, materialized
```

`--state` answers the **attestation** and the **changeState** every binding
and the package must pin; the Environment ids come from the same compile.
`--emit-source` writes B as authored `.adl` + manifest, which is what you then
author and build against — a change whose base does not pin A is refused as
`stale`, and that is reported, never built around. Errors stop here; warnings
are carried into the package and explained (`continuum_diagnostics` for each
id), never silenced. Over MCP the same answer is `continuum_resolve_state
{manifestPath, changePath?}`. (`continuum package resolve` is **toolchain-owned**
and is not a verb the client CLI serves — it refuses with that in so many
words.)

## 2. Author the Goal

`GOAL.md`: short, outcome-oriented, what success feels like. It must not
introduce a claim the model does not make; end it with the authority
line (the guide has the wording). If the user's intent needs a claim the
model lacks, that is an architecture change (`change-architecture`), not
a sentence in the Goal.

## 2a. The business model, when there is one

BDL, one document, no manifest, at `model/<name>.bdl` (only `model/` is
packaged). Copy its shape, including the required `model { bdl 1.0 … }`
preamble, from `continuum help authoring` (BUSINESS); the grammar is
`continuum://guides/bdl-consumer`. `continuum business compile <file>` is BDL's
verdict; `package build` refuses an invalid one at stage `business`.

## 3. Author the bindings — technology lives only here

Do not transcribe pins or skeletons by hand — `continuum package realize
<dir> --environment <Name>` creates the pinned skeleton for an Environment
the model declares (no Binding entries: the technology is yours to write),
and after a semantic change `continuum package bind refresh <dir>` re-pins
every document, prunes Bindings whose target is gone and lists what is now
unbound (`continuum://guides/development-package` §6.2). Both rewrite the
package in place, so neither runs on an adopted package: there the binding
change is a transition (`reconcile-architecture`). Pin repair is not a
client verb (`package repair` is the toolchain's).

One `model/<environment>.adl-binding.json` per Environment the
package covers, pinning the attestation from §1 (`base.canonicalModel`),
plus a `*.vocabulary-claims.json` per vocabulary you name. Retrieve the
shape before writing it: `continuum://examples/order-platform.production.adl-binding.json`
and LANGUAGE-SPEC §16 (`continuum_knowledge {mode:"search", query:"binding document"}`).

- **Completeness is judged per Environment**: every owned Deployable,
  Resource, Agent, Event, MessageChannel and Service needs exactly one
  Binding — the build refuses an incomplete environment.
- Claims are the closed A.4.3 tokens only; a vocabulary is a dotted name
  (no hyphens); a technology identifier is free (`sqlite-wal`,
  `deepseek-chat`, `fake-model-provider`).
- **Secrets are locators, never values**: `{ "secretLocator": "env://DEEPSEEK_API_KEY" }`.
- **Fake provider first**: the local-development environment binds
  every Agent to the shipped fake provider; a real provider is a second
  environment's document. Provider changes (Anthropic → DeepSeek) are
  binding changes and must leave the attestation untouched.
- Budget and safety controls (`MODEL_PROVIDER=fake`, `MAX_AUTONOMOUS_TURNS`,
  `MAX_SESSION_MODEL_CALLS`, timeouts, retry ceiling, circuit breaker,
  pause/resume) go in the spec's `controls` as **recommended defaults**,
  labelled so — the architecture declares no number, and you invent none.

Mint Binding ids with `continuum_mint_ids`; never derive an id from a
name, never reuse a removed one.

## 4. Author the acceptance scenarios — executable, and traced

`acceptance/scenarios/<name>.scenario.json` (shape in the guide §4): a
kebab-case `name`, `verifies` (root-anchored qualified names or `#ids` —
Requirements, Services, Workflows, Agents, Messages, Guardrails,
BusinessRules), optionally the declared `test` element it realizes, the
`environment`, a `provider` script per Agent name (completion order by
`latency`, `output`, `silence`, `fail`, `failuresBeforeSuccess`,
`malformed`, a `budget`), and `given` / `when` / `then` as **step keys
with args** — the adapter binds keys, humans read `text`.

Scenarios prove **declared** behaviour: each claim traces to an element
(`verifies`), each ordering to a Reaction, a Workflow or a delivery
expectation. Where the model is silent (how a coordinator ranks, what a
malformed answer means beyond "the task failed") do not assert it — or
route it as a gap. Give the important scenarios a `trace.from` message
so the build derives the process-graph trace; an authored
`expectedTrace` is your expectation and is labelled as such.

A **reference adapter** (`acceptance/adapter.mjs`) may ship so the
package is self-verifying — an in-memory realization of the model's
services and workflow over the fake provider, labelled as not the
implementation. Without one, the build validates and does not execute,
and `PACKAGE.json` says `executed: false`.

## 5. Build, and read the refusal as evidence

```
continuum package build <dir>     derives in place; the client CLI has no --out, so never build a change in an adopted package
continuum package check <dir>     the inventory and its digests
```

The pipeline (guide §6): resolve → compile → refuse on errors, carry
warnings → bind (applies? complete?) → resolve every scenario reference
→ derive traces, `BEHAVIOUR.md` and `IMPLEMENTATION.md` → write `PACKAGE.json`
(identities, digests, file inventory; no timestamps); `build` never
executes — `package run <dir>` executes the scenarios on the fake
provider, and `check` reproduces and byte-compares. A refusal names
its stage and the engine's ids: a `stale` binding means the attestation
moved; `resolves to no element` means the scenario claims something the
model does not declare — fix the claim or change the architecture,
never the reference. `check` rebuilds and byte-compares every derived
file. Whether a change pins this package's state (`package.changeState ==
change.base.state`) is `continuum_package_check {packageDir, changePath}`;
the CLI's `package check` takes no `--change`. A change to an adopted
package is built by its transition (§5a), never by `package build`; to see
what it does without writing, `continuum_apply` and `continuum preview`.
Without `continuum_package_check`, the pin is **NOT CHECKED**.

## 5a. In a client repository — the package is `continuum/`, same shape

When the user's repository uses Continuum (`continuum/toolchain.json`
exists, or `continuum install` is wanted), the package root is
`continuum/` — the layout inside is exactly the standalone one, with
the semantic state in `continuum/model/` (`continuum://guides/client-install`).
Prefer the CLI verbs over hand layout:

```
continuum package init continuum --environment <Name>                     the spec, once model/ holds a compiling model (author it first)
continuum package build continuum/development-package.json                  re-derive every derived file from the state already in model/; a change goes through a transition
continuum package run continuum                                             execute the scenarios (never part of build)
continuum package check continuum/                                          before trusting or handing off
continuum package accept continuum --as <you> --verified-against HEAD       the initial acceptance (§9.5) — the person runs it
continuum ledger record continuum --verified-against HEAD                   the checkpoint, resting on it — the person runs it
```

**A resulting package after a transition** is never assembled by hand:
`continuum icp materialize continuum/transitions/<id> --base continuum`
builds it through the full pipeline into the transition's own `result/` (the
next state stages inside its transition, never at a repository-root sibling)
and executes the complete suite — as the sanctioned target only once a person
has approved the transition, with `--analysis` building the same package for
inspection before that. Adoption (`continuum icp adopt <transition>
--verified-against HEAD`, when readiness says it is the awaited act, and run by
the person, never by you — `continuum` skill §1b) makes
that result current, carries `ledger.json`, `history/`, `transitions/` and
`gaps/`, and records the checkpoint with its transition in one atomic swap;
there is no adoption without the record. **Which act may happen next, and who performs it, is
`continuum icp ready <transition>`'s answer and never a sequence restated
here** — drive it with the readiness loop (`continuum` skill §1b) and hand
the person one command at a time. Say which checkpoint the package now is
(`continuum ledger current`) — the sequence is a label; the digests are the
identity.

With the MCP server connected, the same verdicts are one call away and
read-only: `continuum_package_check {packageDir, changePath?}` and
`continuum_resolve_state {manifestPath, changePath?}` relay the CLI's
`--json` verbatim. A path argument means the machine the surface reads — which
is yours on the local bridge and not yours on a hosted one (`continuum` skill
§0).

## 6. Deliver

- **the export, when the package leaves the repository**: `continuum
  package export <dir> --out <dir>` — exactly the inventory, never the
  workspace (`gaps/`, ledger, `transitions/`, pins); refused unless the
  source checks; verified on its own with the same attestation and
  changeState. The receiver needs only the `continuum` CLI: `package
  check`, `package build`, `package run` on the export alone;
- the package directory and `PACKAGE.json` — a successful `build` is a
  generated package, not a verified implementation or an approval; without a
  toolchain, label everything **UNCOMPILED**;
- the attestation and changeState, the environment, the scenario count
  and execution result, the warnings explained;
- the obligations the implementer's work is expected to satisfy — each
  carried warning and `UNKNOWN` with its reason. Say plainly that the model
  digest establishes nothing about an implementation that does not yet exist;
- the behavioural projection, read before handing off — `BEHAVIOUR.md`,
  or `continuum preview <dir>` (or `<dir>/development-package.json`) for a
  state not yet built (and
  `--change <file>` for a proposed change): walk the owner through the
  order the model establishes, the steps it leaves unordered (their
  concurrency is an implementation policy to record, never architecture)
  and each underspecified-causality finding, which is either declared
  now or recorded as a gap — "valid, but not how I want it to behave"
  is decided here, before implementation cost;
- what the package deliberately leaves to the implementation
  (policies the model does not declare) and the gap protocol the
  contract prescribes (`continuum/gaps/<date>-<slug>.md`, then an
  `.adl-change` pinned to this changeState);
- assumptions and open questions — outside every artifact;
- **diagrams, when asked for** ("a development-ready architecture and its
  component and workflow diagrams"): load `continuum-diagram`, which first
  establishes that this session can draw; then `continuum diagram push <package dir>`
  pins the built package in Continuum Diagram straight from disk — the
  semantic manifest `PACKAGE.json` names, the BDL beside it, and every
  binding document and vocabulary `PACKAGE.json` lists — and checks the
  attestation Diagram pinned against this compile. Then follow
  `continuum-diagram` with its `snapshotId`, once per diagram. Do not read the
  package into your context to import it. Report the snapshot, the
  attestation match, and what was pinned (BDL compiled and pinned is **not**
  BDL-to-ADL realization; bindings are declared, not corroborated).

## 7. Scope limits — state them

This skill does not implement, deploy, or generate application code.
The semantic model carries no technology, no budget number and no test
runner: those are bindings, controls and the shipped acceptance runtime.
The derived documents are never authority — if `IMPLEMENTATION.md` and
the `.adl` disagree, the tool has a defect and the model governs. ADL 1.x
is frozen: an intent the language cannot express is recorded as a gap,
never modelled around.
