---
name: implement-against-architecture
description: Check code against accepted architecture intent, and turn a question the code raises into a proposed ADL/BDL change. Never blocks coding; approval gates adoption into the authoritative model. Use when someone wants code checked against the model, or code needs an answer the model lacks.
---

# Implement against the architecture (classify · propose · adopt · check)

**Load the `continuum` skill first** — knowledge routing, tool routing,
diagnostics and evidence discipline live there. This skill adds one thing to
it: **a boundary between what code may do and what the authoritative model
may become.**

**Three authorities, kept separate (LC-9):**
1. **Modify application code** — the developer's and their assistant's. It
   needs no ADL, no ICP and no Continuum artifact. ADL does not authorize coding.
2. **Propose a model change** — anyone, as a draft (`.adl-change`, a
   `proposal.md`, a candidate `.bdl`), validated by the deterministic tools.
3. **Adopt it into the authoritative model** — governed as before: compile,
   apply, a transition and the ledger, with approval and adoption performed
   by the person.

This skill is not on every build request. It loads when someone wants code
checked against accepted intent, or when code raises a question the model does
not answer — and it never blocks the code.

It delegates: reading the model is `understand-architecture`; an
`.adl-change` and `apply(A, Δ) = B` are `change-architecture`; a handoff is
`development-package`; drift is `reconcile-architecture`. Whether the model
must move, and what waits for adoption, is this skill's.

## Scope boundary: visualization is not implementation

A request to **draw, show, propose, improve, revise or polish a diagram** is not an implementation request and authorizes no ADL, BDL, code or transition edit: route it to the `continuum-diagram` skill. The model grounds a proposed diagram; it is not a mandate to adopt speculative parts. When a request includes both, handle the implementation part here and still deliver the diagram, labelled proposal or implementation.

## 0. The rule this exists for

> **An unrecorded architectural decision is still a decision. It is just one
> nobody approved, nobody can find, and the next reader has to reverse-engineer
> from code.**

Implementation that quietly assumes a new service, message, owner, dependency
or business rule has moved the architecture without moving the model. That is
the failure this skill prevents — not by forbidding the code, but by making the
assumption explicit as a **proposed** change, so it is never silently absorbed.
Two absolute prohibitions: **never edit the authoritative model to unblock
yourself** (not `continuum/model/`, not a `.bdl` source, not "just to make it
compile" — the model moves by an adopted change and by nothing else), and
**never treat "it compiles" or "it applies" as approval** — each is a
mechanical fact, and whether the change is a good idea is the user's judgment.

## 1. Classify the request — four outcomes

State the outcome in one line so the user can disagree with it cheaply.

| Outcome | What it means | Go to |
|---|---|---|
| **neither** | the model already answers every question the code needs | §2 |
| **ADL** | the structure changes: what exists, who owns it, what talks to what | §3 |
| **BDL** | what the business MEANS changes: a rule, a policy, a term, an outcome | §4 |
| **both** | the business meaning changes and its realization changes with it | §5 |

### How to decide, concretely

Read the model before answering — `continuum_query` for one element,
`continuum_text_projection` for a bounded slice, `continuum_process_graph` for
anything causal. Do **not** classify from the repository's code, its layout or
its README: those are the implementation, and the question is whether the
*intent* covers what is being asked.

- **ADL** if the request adds, removes, renames, moves or re-owns an element
  (service, actor, resource, capability, message, workflow, bounded context,
  domain), an edge (`dependsOn`, `publishes`, `consumes`, `reads`, `writes`,
  `owns`, `realizes`, `deployedAs`), a constraint, a requirement or a policy —
  or changes *who* is responsible for something already declared.
- **BDL** if it changes what the business means: a capability's purpose, a
  policy or rule, a value definition, a term, an outcome, a modality
  (*stated*, *required*, *observed*?), or an assertion's provenance. A business
  model answers what the organization does and means, independent of any
  system realizing it.
- **neither** if it is entirely inside something already declared: an
  algorithm, a data structure, error handling, performance, logging, a
  refactor preserving every declared element and edge, a test, or a fix making
  code match what the model *already* says.

**When the answer is genuinely unclear, say so and ask.** An honest "this could
be read two ways, and they lead to different work" costs one question. Guessing
costs a wrong model or a silent divergence.

### 1a. Check the starting model — before the work, never instead of it

Compile the **authoritative** model — `continuum compile <manifest>` or
`continuum_compile {manifestPath}` — and, where an implementation exists, run
`continuum guard` and `continuum conformance report`. Split what came back:
**pre-existing problems** this work will not fix (an `error` diagnostic, an
unresolved reference, a guard `FAIL`), said before building; and
**obligations** the work is meant to satisfy (the `UNKNOWN`s, each with its
reason). These are facts you report, never a gate on the work.

## 2. Neither — implement

Say which declared elements the work sits inside, then build it. Naming them
makes it checkable later that you stayed inside them.

**If building it turns out to need something the model does not declare, that
classification was wrong — go to §8.** "Neither" is a finding about the model,
not a commitment to finish without one.

At the end, confirm conformance rather than assuming it — §7 step 3, then §7a.

## 3. ADL — the change artifact path

`change-architecture` does this work — establishing state A, deciding the
architecture in concepts, authoring the `.adl-change` against the repository's
change record, and proving `apply(A, Δ) = B`. Delegate to it rather than
re-deriving its steps here. What this skill adds is the **stop**, and three
rules it will not relax:

- a population or correction is a **change**, never a rewrite — that is what
  keeps element identity stable, so a later `continuum_diff` reports a rename
  as a rename;
- **adding an element, edge, owner or reaction to silence a warning is not a
  change and is never permitted** — it is a lie with a digest behind it. An
  unrealized-intent warning can be the honest finding; explain it instead;
- where the change records claims, only `VERIFIED` and `INTENDED` may be
  declared, and an `INTENDED` claim says so in its `desc`. `PROPOSED`,
  `UNKNOWN` and `CONFLICT` are not declared at all — they are gaps.

Then **§6 — present for adoption.**

## 4. BDL — the source-diff path

**There is no `.bdl-change`, and you must not invent one.** BDL change
semantics are deliberately ABSENT rather than stubbed — no diff, no apply, no
change artifact, no change source — and the MCP contract's `BUSINESS_ABSENT`
names each capability that does not exist and why. Read that record rather
than guessing, never emulate what it says is absent, and never describe a BDL
change as if it were proved the way an ADL change is: the two paths are
asymmetric because the languages are. The authority, the interfaces and what
BDL does not do: `continuum://guides/bdl-consumer`.

So the proposal is a **source diff plus a compile result**:

1. **Read the current model** — `continuum_business_inspect` (`view` is the
   closed set `elements` | `worklist`; there is no filter, because BDL has
   fixed projections rather than a query language) and
   `continuum_business_text_projection` for the readable form.
2. **Write the proposed `.bdl` as a candidate** beside the authoritative
   document, never over it; `continuum_business_parse` says whether it reads
   as a BDL model at all.
3. **Compile it** — `continuum_business_compile`. Diagnostics carry `rule`
   and `jurisdiction`, and nothing resolves a BDL rule id to a registry:
   quote the rendered diagnostic, never invent a lookup.
4. **Diff the CANONICAL source, not your draft** — `continuum_business_emit`
   returns each model as authored `.bdl`, so emit both and compare those.
   Diffing a draft shows your formatting as change and hides a real change
   that reformats.
5. **Show the behavioural delta**, which no tool derives: the canonical
   diff; the `elements` and `worklist` views before and after; valid/invalid
   with every diagnostic that appeared or disappeared; and in words, which
   rule, policy, term or outcome now means something different and what
   follows for anyone relying on the old meaning.
6. **BDL never mints identity** (R3): a new element's id is authored by a
   human, deliberately. Do not generate one; do not reuse one.
7. Where both languages are present, `continuum-bdl`'s
   business-to-architecture correspondence checkers say whether the two still
   agree. Use them; never assert correspondence by reading.

Then **§6 — present for adoption.**

## 5. Both — coordinate, then present once

Order matters, and it follows from what the two languages are for: **BDL says
what the business means; ADL says how a system realizes it.** So:

1. Settle the **business** delta first (§4). Meaning is upstream of
   realization, and an architecture built to realize a rule nobody has agreed
   on is work done twice.
2. Derive the **architecture** delta from it (§3), and say explicitly which
   business change each architectural change serves.
3. Check **correspondence** between the two before presenting: a pair that
   does not correspond is one incoherent proposal.
4. Present **one** delta with both halves, and take **one** approval: the
   halves are not independently adoptable.

Then **§6 — present for adoption.**

## 6. The stop — before ADOPTION, not before code

§6–§7 gate **adoption into the authoritative model** (authority 3). They never
gate code: coding continues meanwhile, and code that relies on the proposal is
reported as built against a *proposed* state, not the accepted one.

**Present, then stop before adopting.** Do not fold the proposal into the model
in the same breath. While the choices are open, package nothing: no transition, scenario or adapter.
Once they are settled, present the proposed `.adl-change` or BDL delta with
the reviewer brief below; coding does not wait for more. Package only to
adopt — when the person wants it adopted, or policy requires it — and
**before** asking for approval, package the transition
(`change-architecture` §7) with bindings, scenarios and the adapter that runs
them, drafts inside it, then `icp check` and `icp ready`, so approval binds what
was reviewed. Without one the proposal stays a proposal.

What a reviewer needs, and nothing more: **what changes**, in architecture or
business concepts rather than syntax; **the wording it implies** — a realistic
sample of what a user would read, or that none changes; **why**, and what it
makes possible that is not possible now; **is it all needed** — what would be
lost without each addition; simplify first, and say what you cut; **the proof,
labelled for what it is** — for ADL, `apply(A, Δ) = B` with the state digests;
for BDL, the compile result and projection comparison, no `apply` proof
(§4); **what would check it** — each commitment as *executed* (a test or
scenario exercises it), *lexical* (text or structure is inspected) or
*declared only* (nothing checks it), empty classes named, planned checks
marked; the **compile of the proposed target**, with its model digest, as an
observation, never an endorsement; **what it does not settle**, as gaps rather
than omissions; and **what you will implement** once it is accepted, routine
details (bindings, test mechanics) marked apart from architectural decisions.

Ask the person whether the proposal says what they intend, and say back what
they decided and which objections remain — conversation, never written
anywhere as an approval. When it is to be adopted, the transition is packaged
first (above). Then ask for approval, explicitly, and wait, with the `icp approve` command `icp ready` printed for the person to run themselves; chat agreement is not that fact. Approval of the *model change* is not approval of an
implementation plan you have not shown. On a challenge, re-show only what
moved: wording, necessity, checks.

## 7. After approval — adopt, then check

For ADL, the order of acts and who performs each is `continuum icp ready
<transition>`'s answer, never yours (`continuum` skill §1b). Two rules always
hold: **the model is adopted only once the approval fact exists and the person
has adopted it** — chat agreement, or code already written, adopts nothing
(§7.2 of the lifecycle) — and **nothing you ran is a lifecycle fact**: a
passing suite, a clean guard and a compile are evidence a person weighs, never
an act they performed. Code is not held for this; what it relies on is
reported as built against a *proposed* state until adopted. Told to proceed,
read `icp ready`: approved, implement without asking again; if not, repeat
that command. With no transition, implement and label the work as built
against the proposal.

1. **Prepare the approved target.** For ADL, read readiness and perform the
   agent steps it awaits, except `icp adopt`, which the person runs
   (`continuum` skill §1b); the `.adl-change` stays as the transition's
   explanation. Compile the target you will build against — the resulting
   package's model, not state A — and carry its actionable diagnostics into
   the work: the diagnostic id verbatim, the element ids from
   `warnings[].elements`, and which implementation or verification task
   addresses each. Keep **observed**, **proposed** and **approved** apart in
   words. For BDL, edit the authoritative `.bdl` source, then recompile and
   re-inspect to confirm it is the source that was approved.
2. **Implement against the accepted model**, not your memory of the proposal.
   **The moment the work needs an answer the accepted model does not carry,
   go to §8** — including when the missing piece looks like a small extension
   of what was just approved.
3. **Check conformance rather than assuming it.** `continuum_guard` for what
   the Architecture Guard would say on this evidence; `continuum_package_check`
   where a package is built; `continuum_icp_check` for a transition;
   `continuum_workflow_verify {packageDir}` for whether the record those facts
   live in verifies at all — when it does not, no state read from it is
   trustworthy. On drift, `reconcile-architecture` owns what to do: never
   hand-repair state it is built to reason about.

   **"The check did not run" is not "the check passed."** A guard invocation
   can come back without a judgment for reasons unrelated to the
   architecture: no credential, an unreachable Host, a route the deployment
   does not implement, a package never built (`package check` needs a
   `PACKAGE.json`). A git hook may let the commit through, and locally that is
   deliberate — it is still not evidence of conformance. So read the answer
   for WHICH outcome it is — PASS, FAIL, INDETERMINATE (exit 2, or exit 3
   where a judgment was required) or NOT APPLICABLE — say which you got, never
   report an absent answer. For an indeterminate one the honest report is
   "conformance was not established, because X", with X beside what you built.
4. **Report what was approved, what was built, and what still differs.** A
   difference you can name is a finding; one you cannot is a divergence.

### 7a. After implementation — verify, report

Run what actually exercises the implementation — the repository's own tests,
`continuum package run`, `continuum conformance check`, `continuum evidence
check --anchored-at <rev>`, `continuum package check`, `continuum guard ci`
(step 3 for reading its outcome) — and name each result as itself, at the
revision it was obtained at. A compile is not a conformance claim: compiling
the same model again establishes nothing about the implementation. `UNKNOWN` is
reported with its reason, never as a pass.

Report in one place: the **model digest** built against; the
**implementation revision**; the **verification results**, each as itself;
the **unresolved obligations** with their reasons; the **blind spots**; and
the **lifecycle state** (`continuum icp ready <transition>`, else
`continuum ledger current`) — which no verification result changes.

## 8. When implementation outruns the model

This is the case the whole skill exists for, and it will happen: you are
building and the model does not answer something the code must answer. A name
it does not declare. An owner it does not name. A message with no publisher. A
rule the business model leaves open.

**The question becomes a PROPOSED change, and the work continues.** Re-classify
(§1), then:

- **Do** record it as a draft — an `.adl-change` (§3) or candidate `.bdl` (§4),
  or a `proposal.md` when it is not yet decided — saying what is missing, what
  the code needs from it, the candidate answers and the one the code assumes.
  Validate the draft with the tools; it is authority 2, and it adopts nothing.
- **Do** keep coding (authority 1), and name the code that depends on the
  proposal, so it is reported as built against a proposed state.
- **Do not** edit the authoritative model to match what you built.
- **Do not** widen an approved change because the addition is "nearly the
  same change". It was approved as what it was; this is a new proposal.
- **Do not** absorb it silently: an assumption the code makes and no record
  names is the defect this skill exists to prevent.

Adoption of the proposal is §6–§7, when the owner wants it. If the question is
real but nobody is ready to decide it, **record it as a gap** rather than
leaving it in your head — an open question with a name is an asset; the same
question inside an implementation is a defect waiting to be found.

## 9. What this skill never does

- Blocks code on a model decision, or adopts a model change into the
  authoritative model before an approval fact binds its transition and the
  person has adopted it.
- Reports code built on a proposal as conforming to the accepted model.
- Presents a compile, a green suite or a `conformance check` row as proof that
  the implementation built the accepted architecture, or reports an `UNKNOWN`
  as a pass.
- Hands a person a chain of lifecycle commands, or any command readiness does
  not name as the awaited human step.
- Infers technology. A `Resource [data-store]` is not a product name.
- Reports an architecture question answered from code, prose or a generated
  view when the model is what was asked about.
