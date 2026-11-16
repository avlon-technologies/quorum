---
name: continuum-diagram
description: Draw, show, improve, propose, revise and polish grounded, narrative-first architecture diagrams from Continuum models with Continuum Diagram, including speculative proposals from an existing model. Diagram requests take priority over unrelated ADL change and implementation workflows. Use when the person asks for C1/C2/C3, domain, conceptual, system integration, workflow, and other architecture explanations. There is one entry point and no diagram type input: a named view (C1/C2/C3, ERD, use-case) goes in the question. The Continuum Diagram composer authors the visual narrative and imaging instructions; the image pipeline reconstructs and verifies an editable diagram. Always review the narrative, the actual rendered image, semantic fidelity, and communication quality before claiming acceptance.
---

# Continuum Diagram — Agent Skill

**Load the `continuum` skill first when it is installed.** It carries the evidence discipline this workflow relies on.

> This skill is owned by `continuum-diagram`, the authoritative diagram capability, and is checked against the server's MCP contract (`contract/skill-contract.json`). The Continuum Project Kit distributes it unchanged from a pinned commit.

## Authority and intent

In a `continuum-diagram` checkout, its repository-root `VISION.md` states **why** Continuum Diagram exists; this skill tells an external agent **how** to use it. In any other repository a `VISION.md` is that project's own and says nothing about Diagram. The vision is not an MCP schema. Query the connected server's current tool descriptions for exact argument names and supported operations.

**The core capability is narrative composition.** Given an architecture question, audience, and grounded Continuum knowledge, the AI composer determines the story and visual hierarchy, then **authors the instructions for the imaging model**. The image model creates a visual proposal; reconstruction produces editable SVG; verification checks that the communicated meaning remains grounded. Do not bypass this process simply because the user requested a C1, C2, or C3 diagram.

> Continuum determines what is known. The composer determines what the diagram should say and how to tell that story. The imaging model determines the visual realization. Verification ensures the result remains grounded.

Continuum owns ADL/BDL semantics, technology bindings, architectural evidence, and future intent-versus-implementation reconciliation. Continuum Diagram owns visual narrative and communication. Do not invent repository-analysis or reconciliation findings inside Diagram. Consume them from Continuum when such evidence is actually available.

## 0. Diagram-first routing

**A diagram is the deliverable, not the last step of an agent-selected process.** For requests to draw, show, revise, improve, propose or polish an architectural diagram, use Continuum Diagram first against the existing compiled model. The user's requested output determines routing; do not load `change-architecture` or `implement-against-architecture` merely because the diagram depicts improvements. A proposed diagram does **not** require an ADL or BDL change, and verification of a visual proposal is not architectural approval. Route adoption or implementation through the governed workflow only when it is separately requested ("now adopt that proposal in ADL" → `change-architecture`, obeying its approval boundary).

**Complete the user-facing job.** Starting a run, writing an ADL change, producing an internal PNG without presenting it, or listing a run ID does not satisfy "show the diagram." Display the actual artifact or provide a working accessible link, distinguishing a provisional image from a verified SVG. Never say "shown above" when the client has not displayed the image.

**Establish that a drawing can happen, read-only, before anything that changes state.** When Continuum Diagram is requested, first confirm that this session can draw. Either the `diagram_request` tool is connected (it is among your tools, or a tool search finds it), or a `continuum-diagram` checkout is present for the local flow (§8). Use read-only discovery only. Never run `continuum diagram push`, an import or an upload as an availability probe. `continuum diagram list` and the CLI help show what the account holds, not whether this session can draw.

- **Unavailable:** say plainly that Continuum Diagram is not connected in this session and what would connect it (the Continuum Diagram MCP server in this client, or `continuum install --diagram <url>`), then stop. Do not push or import: a pinned snapshot that nothing can draw from only holds one of the account's slots for 24 hours. When Continuum Diagram was asked for by name, do not substitute Mermaid, hand-drawn SVG or another renderer. Offer one only as an alternative the person may choose.
- **Available:** continue with §3. Pin a model only when the requested drawing needs one, meaning there is no usable `snapshotId` or bundled `modelId`; the request to draw is what authorises that pin. Pinning for a drawing is not persisting or publishing. Keeping a snapshot past the task, re-pinning with `--fresh`, and releasing a snapshot you did not create each still need the person's explicit request.

**Minimize friction without weakening truth.** Ask only for blocking missing inputs; infer a sensible audience from context. Pin the existing model, then compose. Do not front-load optional code inspection, conformance checks, formal transition proofs, or approval ceremonies. If the server cannot perform a requested action, state the actual limitation; do not invent a model-first requirement or silently hand-draw a substitute.

## Two deliveries, inferred from what the person said

**Exploratory is the default.** "Show me how this works", "what use cases should this support", "help me see where X
fits": call `diagram_request` with the person's own words. It composes, generates the image and returns it at once as
a **provisional image proposal**. Show it, say it is a proposal, and give the grade breakdown (`confidence`). Do not
wait for, or imply, verification.

**Polished is for a finished deliverable.** "A polished diagram", "presentation quality", "the verified, editable
version": the same `diagram_request` continues into reconstruction and verification because the composer reads the
request that way. Do not pick a mode for the person; pass `rendering` only when they explicitly asked to override, and
pass `context` when the conversation changes what the request means.

**Grounding is not a mode.** "As it exists today" is answered from established architecture; "what should it
support" is answered as a proposal, with the model as grounding and not as a limit. Both are read from the question
and reported in `intent`. Never restate a speculative box as architecture, under either delivery.

| The person says | You call |
|---|---|
| a new question | `diagram_request` |
| "make X more prominent", "simplify", "focus on …", "show more of …" | `diagram_revise` with their words as `notes` |
| "I like this, give me the polished / verified / editable version" | `diagram_render` on the same run (it reuses the proposal) |
| concrete drawn defects in an editable SVG | `diagram_correct` (one pass) |
| a call timed out before you saw a `runId`, or "the previous diagram" and its id is lost | `diagram_runs`, then `diagram_status` |
| the model changed | pin it again (§3), then a new `diagram_request` |

**Say what the result is**, from `delivery.kind`: a provisional proposal, a verified editable SVG, an SVG whose
verification failed, or a failed verification with the proposal preserved. Never call a proposal verified, and never
report a failed stage as success. Visual acceptance is the person's in every case.

## Completeness without changing authority

**Grade; do not refuse.** The pinned ADL/BDL establishes what is declared, not the maximum content a useful picture may communicate. A model omission is not by itself a reason to refuse a diagram, leave a key connection disconnected, ask the user to edit ADL, or switch to an unrelated drawing tool.

For ordinary `diagram_request` composition, consider relationships and supporting concepts implied by the user's question, element descriptions, and the model's context. Include defensible inferred relationships that make the requested architectural story coherent, grading them **inferred** (dashed) with explicit supporting reasoning. Where the user deliberately asks to explore a hypothesis or future architecture, grade unsupported proposals **speculative** (dotted and marked), not declared. Keep declared relationships solid. Do not invent detailed protocols, permissions, or implemented behavior that the evidence cannot support.

**Review for omissions:** for a C1 system context, if named human actors have role descriptions suggesting use of the central system but no explicit `uses` edges, consider dashed inferred actor-to-system edges instead of an unexplained disconnected actor row. This is an example, not a rule to connect every actor automatically: explain the evidence and respect contrary evidence. If a selection misses such a meaningful connection, call `diagram_revise` with explicit inference/provenance notes and render that revised selection. No ADL edit is needed or implied. Only suggest promoting inferred relationships into ADL when the user specifically requests an authoritative model change.

Keep the semantic model unchanged throughout a diagram-only request. Semantic fidelity means truthful epistemic grading and evidence, **not diagram completeness limited to declared edges**. Report genuinely unsupported claims or limits honestly without substituting a declared relationship for an inference.

## 1. One operation, and the diagram type goes in the question

**`diagram_request` is the only operation that decides what a diagram says.** Send a pinned model (`snapshotId` or `modelId`), one meaningful question and an audience, and optionally `presentation`. There is no diagram-type or view-selection input: the server refuses an input it no longer accepts by name (`input-removed`, see MIGRATION.md). Use only the operations and parameters the connected server actually advertises.

| User intent | How to ask |
|---|---|
| “Explain this system”, “draw the architecture” | `diagram_request` with the question as the user means it |
| “Show a C1/C2/C3”, “an ERD”, “a use-case diagram”, “a sequence of …” | `diagram_request`, with the convention named **in the question** (“As a C2 container diagram: …”) |
| “An exact, mechanical listing of what the model declares” | Not a diagram operation. Say so plainly; offer a composed diagram (graded, with its evidence), or Continuum's own `continuum_query` / `continuum_text_projection` (CLI: `continuum compile <manifest> --query …`) for an exact model listing. Never present a composed diagram as a mechanical listing. |
| “Draw exactly these elements and this workflow” | Name the elements and the workflow in the question, then check the brief and the verification report for what was drawn and how it is graded. |

Examples of intent (illustrative):

```js
diagram_request({ snapshotId: "...", question: "As a C3 component diagram: how do the components inside DecisionService collaborate to finalize a revision?", audience: "Software architects" })
diagram_request({ snapshotId: "...", question: "Draw a conceptual architecture proposal for Mobile Proxy: how would a developer diagnose, experiment, verify and restore?", audience: "Product owner and engineers" })
```

**Every notation makes claims of its own.** Keys, cardinalities and multiplicities; a deployment, container or runtime boundary; a numbered order. The composer is told to draw those only where the model declares them, and the verifier lists any that slip through under `UNSUPPORTED ASSERTIONS` in `verification-reconstructed-vN.md`. Report that line to the person beside semantic fidelity.

**C4 conventions matter.** C1 describes a system in context and its external relationships; C2 describes containers and their responsibilities; C3 describes components within a chosen container and their collaboration. Do not relabel domains as deployable containers, components as systems, or logical stores as separate physical databases. Where the model lacks the requested altitude or container boundary, communicate the limitation rather than fabricate a standard-looking diagram.

## 2. Every mutating call is paid, and it holds the connection

`diagram_request`, `diagram_revise`, `diagram_render`, and `diagram_correct` each spend real model calls — a composition, an image, a reconstruction, a correction. The server runs that work in the background but **holds the call open for it** (about 45 s by default) and returns the finished run when it fits, so there is often nothing to poll and never a reason to call anything twice.

A first image usually takes longer than the wait window. The call then returns `{runId, phase: "running"}` instead of a finished result, and the work **continues regardless**. That is not a failure and not a timeout to retry:

- Call `diagram_status({runId})` with the id you were given. It reports `phase`, which selection and render versions exist, the artifacts available, and — once a render completes — the preview image itself, under the same inline-size rules as `diagram_render`.
- **Never reissue the mutating call.** A second `diagram_render` for one selection is a second image nobody asked for, and some server versions refuse it outright rather than pay for it.
- Poll only while `phase` is `queued` or `running`. A call that already returned a finished phase has nothing further to report; asking again is noise.
- A call that timed out on your side has *not* failed on the server. Recover the run with `diagram_runs` rather than starting a second paid one.
- Send a `requestKey` with every `diagram_request` — a fresh id for each request the person makes — and reuse it only to retry that same request: a retry with the same key returns the run already started, never a second paid run.

`diagram_status` is also how you read a **failure**. It carries `failure.stage`, `failure.exitCode`, and `failure.reason`, plus a fetchable stage log. Say what those report and stop there. A failure is often operational — a stage crashed, a worker restarted — rather than architectural, and the reported reason is the only evidence you have; do not supply an explanation it does not contain.

A completed job is not passing checks, and passing checks are not visual acceptance.

## 3. Pin authoritative knowledge

**The model is on disk and this session can draw (§0)? Push it by reference — never retype it.** When you have a shell and the package is in the working tree (Claude Code, a repository with `continuum/`), and the drawing needs a pinned model, run:

```sh
continuum diagram push            # from the repository root; or name a manifest, a PACKAGE.json or a directory
```

It reads the manifest, every document it names, the BDL beside it and the binding documents (from `PACKAGE.json`, or the `*.adl-binding.json` beside the manifest) **from disk**, uploads them over Diagram's own import tools with the developer's `continuum login`, compiles the ADL locally and compares attestations, and prints a `snapshotId` plus the exact `diagram_request` to make next. **Do not read the model files into your context to import them, and do not drop the BDL or bindings to save tokens** — push carries them for free, and they are what lets the composer label technology and business meaning. Use `--dry-run` to see what would be sent, `--json` for a machine-readable result. One push serves every diagram of that model: use the `snapshotId` for each `diagram_request` until the model changes. **Pushing is safe to repeat**: Diagram keys a package by the content and role of every file (ADL, BDL, each binding), so pushing a package you already hold returns the same snapshot, uploads nothing and uses no slot. When unsure whether you still have a usable id, push again rather than keeping ids in your head. Exit 1 means the model, its BDL or its bindings did not compile on Diagram, or the attestations differ — read its diagnostics and fix the package; exit 2 means it could not run (no login: `continuum login`).

Without a shell (ChatGPT, claude.ai), or for a model that exists only in the conversation, the MCP sources remain:

1. **Server-bundled model:** inspect `diagram_models`, then use `modelId`.
2. **Your own model:** use `diagram_model_import` with a `*.adl-manifest.json` and every referenced document (and optionally `business` and `bindings`), or `diagram_model_upload_begin`, `diagram_model_upload_chunk`, `diagram_model_upload_finish` for a package too large for a single call. Use the resulting `snapshotId`.

`diagram_model_status` diagnoses imports and uploads. Imports compile the exact submitted bytes and return an attestation and digest. Compilation failure is an evidence/model problem; inspect diagnostics and fix the package, not the prompt. A repository without an ADL package is not already a compiled Continuum model; recover or author architecture through Continuum first.

**Snapshot slots.** The account holds a limited number of live snapshots (16 by default, shared by the CLI and every chat connector; each lives 24 h). Every import result reports `quota`; `continuum diagram list` (or `diagram_model_list`) shows what is held. **Release what you created when the task is finished** (`continuum diagram release <id>` / `diagram_model_release`): it is idempotent, and a diagram already accepted from the snapshot still completes. Never release a snapshot you did not create in this task unless the person asks, and do not ask the person to manage snapshot ids. If an import is refused `too-many`, the refusal lists what is held: release one you created, or say which ones are held and when the next expires. `continuum diagram push --fresh` releases the held snapshot of that exact package and re-imports it; use it only when a re-pin is actually wanted.

**The business model, when the caller has one.** `diagram_model_import` takes an optional `business` document — ONE BDL document, which is how a business model is shaped; there is no manifest around it. Pin it whenever the question is about what the business MEANS: entities and their fields, value objects, business actions, entity lifecycles and their transitions, rules, invariants, obligations. None of those is in ADL, and without a business model pinned the composer will correctly report them as not established rather than approximate them from service and message names. It is compiled by BDL's own toolchain, and an invalid business document fails the import exactly as an invalid package does. Check `languages` on the result to see what was actually pinned.

**What pinning establishes.** A pinned BDL document is *compiled and pinned*, nothing more: no BDL-to-ADL realization is checked by an import. **Neither language is evidence for the other:** a business entity and a similarly named service establish nothing about whether one realizes the other, and the server downgrades any arrow that claims it. Bindings are *declared*, not corroborated, unless the snapshot says otherwise.

Record the pinned snapshot/attestation and model revision in the result. Only describe BDL, technology bindings, repository observations, or reconciliation findings as grounded if they were **actually supplied or retrieved** for this run. Vision-level future capabilities are not evidence that the current server already supports them.

For model questions, inspect the relevant Continuum content rather than inferring reality from a generated image, README, or prior diagram. The composer may use supported model retrieval operations internally; do not replace its grounded retrieval with your own invented scene facts.

## 4. Ask a question and establish the narrative

Write the question in a form the intended audience can answer by looking at the picture:

- Good: “Which actors and external systems interact with DecisionForge, and for what purposes?”
- Good: “Within the order-processing container, which components coordinate checkout and stock changes?”
- Good: “How does the review workflow branch, wait for human input, and rejoin?”
- Weak: “DecisionForge C3” (names a subject/viewpoint but not a communication goal).

Keep the audience concrete: “engineering leads new to the system”, “architects assessing ownership”, or “product stakeholders”. Use `presentation` **only when the actual tool supports it** to express how the diagram should read (reading order, visual emphasis, distinctions). Presentation text cannot create architectural facts.

Narrative composition should establish:

- The central architectural message and what a reader should learn.
- The relevant entities, roles, relationships, flows, and constraints.
- Viewpoint-consistent abstraction and boundaries.
- Grouping, reading order, emphasis, and what may be summarized.
- Mandatory semantics, important unknowns, and evidence classifications.
- Concrete instructions for image generation, preserving meaningful visual freedom.

Do not prescribe every box and arrow before allowing the composer to reason.

## 5. Review the composition **before a polished render**

`diagram_request` produces reviewable composition artifacts. For an exploratory request the provisional image is already in the result: show it, and use this review to decide whether a `diagram_revise` is worth it. For a polished deliverable, review before reconstruction is spent. Inspect the artifacts **actually returned by the run** rather than assuming every pipeline version uses the same filenames. Established artifacts may include:

- `selection-v1/brief.md`: the narrative, intended message, and assumptions.
- `selection-v1/evidence.json`: what grounded material the composer consulted.
- `selection-v1/facts.json`: selected facts, relationships, derived routes, and omissions.
- `selection-v1/plan.json`: the composer's own checklist of what the picture must make visible; the render's check reports each item VISIBLE or not.

Check three independent questions:

1. **Narrative fulfilment:** Does the proposed story answer the user's question at the right altitude and for the stated audience? Is an essential step, actor, business rule, or relationship missing?
2. **Grounding and epistemic truth:** Does each architectural claim have adequate evidence? Are logical relationships misrepresented as physical deployment? Are inferred or proposed concepts marked appropriately?
3. **Communication plan:** Will the hierarchy, grouping, sequence, and emphasis be understandable without reading an exhaustive graph inventory?

For composition failures, use `diagram_revise({runId, notes})`. Give specific notes about **what the diagram should say**, what evidence is missing, and what must be preserved. Re-read the revised brief before spending an image-generation call. Never render an unreviewed narrative and then try to hide substantive omissions with SVG edits.

## 6. Epistemic classification is not a confidence ladder

Use the classifications described by the project's vision as **different kinds of knowledge, not an ordered ranking**:

| Classification | Meaning |
|---|---|
| **Declared** | Specified by authoritative ADL/BDL or equivalent model evidence |
| **Observed** | Directly established by identified implementation or operational evidence |
| **Inferred** | Reasoned from evidence but not directly established |
| **Speculative** | Hypothesized or proposed; not established as current fact |
| **Unknown** | Insufficient evidence to establish a claim |

A claim can have both declared and observed support. Preserve its claim, evidence references, and classifications instead of forcing it into a single confidence score. **Aligned**, **Divergent**, and **Unverified** are *reconciliation outcomes*, not additional epistemic classifications; they belong to Continuum's reasoning, not ad hoc diagram generation.

The deployed renderer may currently offer native visual treatments for only **declared**, **inferred**, and **speculative** (e.g., solid/dashed/dotted). Do not claim visual support for Observed/Unknown unless the server actually implements it. Carry unsupported distinctions in evidence and accompanying explanation. Inferential or speculative elements can complete a useful explanation **if their status is disclosed**; they must never appear as authoritative model facts. Unknowns should be acknowledged, not silently filled.

A generated proposal is not evidence that an element, dependency, deployment, or flow exists.

## 7. Render, inspect, correct

Call `diagram_render({runId})` only for the polished, verified, editable version: when the composer read the request that way, or when the person asks for it after seeing a proposal. It is paid work; an exploratory proposal the person has not asked to polish is already delivered. The established rendering path generates an image proposal, reconstructs editable SVG, renders a PNG, and runs verification. Do not replace this with an independently generated image, a hand-written Mermaid diagram, or a fixed graph layout when the user requested Continuum Diagram.

The result may include the reconstructed PNG as native MCP image content. If the result exceeds inline limits, use `diagram_artifact` or available signed URLs. **Tool-returned images are not necessarily visible in the user's client.** Show the actual preview or give an accessible artifact link; never claim it was shown merely because the server generated it.

Inspect the **reconstructed final image**, not just the generative proposal or check summary. Evaluate:

- **Semantic fidelity:** identities, edge direction, labels, containment, responsibilities, technology, logical vs. physical boundaries, provenance; no newly invented architectural claims.
- **Visual integrity:** legible text, accurate arrowheads and line endpoints, no label/edge collisions, clear nesting, whitespace, and readable routing.
- **Narrative fulfilment:** central message recognizable at a glance, correct abstraction level, intelligible hierarchy, necessary details present without graph clutter.
- **Epistemic communication:** declared, observed, inferred, speculative, and unknown information distinguishable to the extent supported, with important limitations disclosed.

A clean geometry check is not visual acceptance; a beautiful diagram is not semantic verification. Review all three separately.

Then read `render-vN/communication-vN.md` when the server produced it: a reader that saw ONLY the picture answered an exam written from the pinned model, and the report says what it could and could not get, what it was misled about, and whether reconstruction lost anything the proposal carried. Use it as a second pair of eyes, not a verdict — you still look yourself, and the person still decides. Its `-notes-compose.md` is ready for `diagram_revise`, its `-notes-correct.md` for `diagram_correct`.

In a diagram that explains how something happens, an arrow from an event to its subscriber (or a command to its handler) drawn as **declared** and labelled "received by" / "handled by" is correct: it is the declared `subscribesTo` / `handles` read in the direction the information moves. Do not report it as reversed. Likewise a solid arrow from a step to a service labelled with a message name (for example "AuthorizePayment") stands for a declared path through that message: the step sends it and the service handles it.

**Route defects to the appropriate stage:**

- Wrong meaning, misplaced emphasis, missing concept, inappropriate altitude or aggregation → `diagram_revise`, then rerender and reinspect.
- Correct meaning but wrong text placement, bad line routing, overlaps or geometry → `diagram_correct` with precise observed defects and elements to preserve, then reinspect the corrected result.
- Model or evidence contradiction → repair or clarify the grounded input through Continuum before claiming correctness.

Use purposeful feedback; paid generation, reconstruction, and correction calls should not be repeated without a concrete defect. The established correction path performs a targeted SVG pass, not a fresh image proposal. Some server versions allow only one correction pass; follow current tool descriptions.

### Completeness and legibility

Prefer a complete, intelligible answer over either a hairball or a misleadingly sparse diagram. Start with hierarchy, logical grouping, meaningful edge routing, and visual emphasis. Summarize redundant connections only if meaning remains recoverable from labels or companion evidence. Never bundle reads and writes into one ambiguous dependency, collapse distinct ownership boundaries, or delete model facts to satisfy an arbitrary box limit. A domain is not automatically a deployable container; a logical store is not automatically its own physical database.

If the question needs more detail than one view can intelligibly show, explain the scope and propose another focused view. Do not silently omit essential information.

## 8. Local execution

If the MCP server is unavailable and a `continuum-diagram` checkout is present, the local flow counts as available (§0). Run it from that checkout's `tools` folder:

```bash
node diagram.mjs request (--snapshot <dir> | --model <checkout>) --question "..." --audience "..." --out runs/<name>
node diagram.mjs revise --out runs/<name> --review notes.md
node diagram.mjs render --out runs/<name>
node diagram.mjs correct --out runs/<name> --defects defects.md
```

Use the checkout's current CLI help as authority for syntax. Options it no longer accepts are refused by name (MIGRATION.md).

Do not call nonexistent tools, fabricate signed artifact URLs, or state that future BDL/GitHub knowledge integrations are already deployed.

## 9. Acceptance and delivery

**Completion contract.** A Continuum Diagram request is done only when (1) a model is pinned, (2) the request succeeded, (3) the run has a picture, (4) you read its `delivery.kind` and label, and (5) the person can see it. Each response carries a `deliver` block saying what is still owed — read it. A run ID, a committed file, an ADL change or a compile is not completion. If a stage fails, report the stage and the reported reason and stop; never substitute Mermaid or another renderer without the person's permission.

Before reporting completion, state independently:

1. **Grounding / semantic checks:** what the server verified and what it did not.
2. **Narrative fulfilment:** whether the rendered diagram answers the question at the requested viewpoint.
3. **Human-facing visual acceptance:** whether you inspected the actual reconstructed image, and whether it communicates effectively.
4. **Limitations:** known unknowns, inferred/speculative details, intentionally summarized relationships, unsupported assertions of notation, deployment or order, and unverified claims.

If you cannot inspect the image, label it **unreviewed**, not accepted. If checks fail, label the preview **unverified**. Show or link the actual resulting PNG/SVG through supported mechanisms and retain the narrative/brief and provenance artifacts so the user can review both **what the diagram intended to say** and **what it actually drew**.

**Success is not a rendered picture or a passing geometry check. Success is an evidence-grounded, editable visual explanation the intended audience can understand and an architect can confidently share.**
