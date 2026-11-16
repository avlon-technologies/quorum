---
name: reconcile-architecture
description: Interpret Architecture Guard drift evidence for a continuum/ package and carry the reconciliation as drafts - drift is reported, a draft is a proposal, adoption stays governed. Use when a guard or CI blocks on drift, `continuum reconcile plan` is not clean, or a pending transition is stale.
---

# Reconcile an architecture (evidence → draft, never acceptance)

**Load the `continuum` skill first** — knowledge routing, tool routing,
diagnostics and evidence discipline live there. This file is the
reconciliation flow only. The client surface is
`continuum://guides/client-install` (§2 the guard, §2a reconciliation, §4
transitions, §5 the ledger); the categories are
`continuum://guides/development-workflow` §4.

**Three authorities, kept separate (LC-9).** The code was the developer's
to change, and needed no Continuum artifact. A reconciliation **proposes**:
anyone may, as a draft the tools validate. **Adopting** it into the
authoritative model is governed: in a client repository it goes through a
transition and the ledger, and the person performs the adoption acts. So:
drift is **reported**, a draft is a **proposal**, and adoption is **governed**.

The deliverable is a **proposal a human can accept**, never an
accepted state: the guard gathers evidence, `continuum reconcile plan`
derives the disposition, this workflow reads both, explains them and
drafts what the disposition calls for. Only a transition the person adopts
turns a proposal into a checkpoint.
**Implementation never silently becomes architecture.**

**Once a transition exists, drive it with the readiness loop**
(`continuum` skill §1b): `continuum icp ready <transition> --json` says the
next step, its actor and whether it is ready. You perform the `agent` steps
(check, rebase, materialize, commit) — never `adopt`, which the person always
runs (`continuum` skill §1b); the person records the `human`
ones — one command at a time, the awaited one only, with one sentence on what
they are judging — and you read readiness again after each. Never hand over
`approve → materialize → accept → adopt` as a sequence.

## 1. Start from the evidence, not from the code

```
continuum guard pre-push --json          the full judgment: five outcomes (PASS, FAIL, INDETERMINATE — exit 2, or 3 where required — and NOT APPLICABLE), four dimensions, every finding
continuum reconcile plan continuum/      the evidence and the disposition, read-only
continuum package check continuum/       what drifted, file by file
continuum ledger verify continuum/       lineage, and whether the live state is recorded
```

With the MCP server connected, `continuum_guard {repoDir, hook}` and
`continuum_reconcile {packageDir}` return the same judgments read-only.
Quote the guard's `classification`, every failing finding, and the
plan's `disposition` verbatim. Neither says "semantic drift" — and
neither do you until a human has accepted a draft that says so.

Within the Guard's architecture dimension the reconciliation evidence is four rows, and none reads
application code: the **checkpoint delta** (which of semantic,
bindings, acceptance, derived moved since `history/NNNN`); the
**implementation delta** (files outside `continuum/` that changed since
the commit the checkpoint was verified against — a count and names);
**acceptance execution** on the fake adapter; the **recorded gaps**
under `continuum/gaps/`. Everything you conclude from them is an
interpretation and is labelled as one.

## 2. One disposition per plan

Every command below is one the installed CLI serves. `continuum reconcile
draft`, `continuum reconcile adopt` (R7) and `continuum package repair` (R6)
are **toolchain-only**: the client refuses them, so never give them as the
next step. Where the toolchain is installed they automate the same rows; say
so, and say it is optional.

| `reconcile plan` says | What you do (the tool proves every step) |
|---|---|
| `clean` | nothing to reconcile; if the guard still blocks, the finding is elsewhere — quote it |
| `mechanical` — only derived files are stale | `continuum package build continuum/` re-derives them — safe on an adopted package only because nothing authored moved; if the plan says anything else moved, this row does not apply. Then `package check` and `ledger verify`; the rebuild is the proof. If the compile fails, the authored model is the defect: fix it as architecture (`change-architecture`), never by editing derived files |
| `binding-reconciliation` — bindings moved, the attestation did not | report the binding delta as a proposal. To adopt it: a binding-only transition (`continuum icp init <dir> --base continuum --bindings changed --reason "…"`, the moved binding inside it, `icp check`), adoptable when it **reproduces the working tree** (same changeState, same binding digests, same inventory) — drive it with §1b. `reconcile draft`/`adopt` automate this case on the toolchain only; never run them in a client |
| `acceptance-draft` — the contract moved | a changed contract is a changed meaning: present the delta for the person to decide. Until it is adopted the recorded suite is the accepted contract, and you report what the implementation does instead. To adopt it: an acceptance-only transition (`icp init … --acceptance changed`) driven with §1b — the person approves and accepts it |
| `semantic-draft` — the semantic state moved outside a transition | derive the `.adl-change` **by diff** between the checkpoint state (`continuum ledger current continuum/`) and the working tree (`continuum_diff`, element identity; verify it with `continuum_apply`) and label it **DRAFT — requires acceptance**. You explain what it declares and what the evidence says; a human accepts it, or the tree is reverted (§3) |
| `no-checkpoint` | nothing recorded: verify, then hand the person `continuum ledger record continuum/ --verified-against HEAD` — recording a checkpoint is theirs |
| guard `base-drift` — a pending transition pins another state | after the reconciliation is recorded: `continuum icp rebase <icp> --onto continuum/`; read the refusal — only the refused operations need a Δ', and you draft those |
| guard `unexplained` — a malformed artifact, or a failure no row accounts for | report it as a gap; propose nothing |

## 3. A semantic proposal is a draft with a name on it

Whether the draft came from a diff (the working tree moved) or from
evidence that the model is silent (a failing scenario, a recorded gap
under `continuum/gaps/`, a human's report):

1. the `.adl-change` is the smallest one that declares it, pinned to
   the checkpoint's `changeState` (`continuum ledger current
   continuum/`), ids from `continuum_mint_ids`, never derived from a
   name, never a removed one reused — a derived draft already satisfies
   this; a hand-written one must;
2. `REASON.md` and your report carry **DRAFT — semantic reconciliation,
   requires acceptance**, the evidence it rests on, and what the
   implementation does meanwhile — the code has usually moved already, and
   it is not held for the draft;
3. to be adopted it goes into a transition (`continuum icp init …
   --semantic changed`), and `continuum icp check` derives whether it
   applies — you never write "verified". Open it when the person wants it
   adopted, or now when the change is risky or policy requires one; until
   then it stays a proposal — chat agreement adopts nothing;
4. stop before adoption. Whether the draft proceeds is the person's call: it
   proceeds when they **approve** it — the first human step readiness awaits.
   Until that approval exists, do not materialize it as the sanctioned target
   or call it the accepted model; after it, drive the transition with §1b.

Never invent architecture to make the evidence tidy: a claim the
evidence does not establish stays out of the draft and goes into the
report as unknown. A derived diff can only ever say what the working
tree already declares; if that is not what anyone intended, the right
proposal is to revert the tree to the checkpoint, not to accept.

## 4. Deliver

- the classification, the disposition and the findings, quoted;
- the disposition per finding, with the exact command that proves it — one
  the client serves, or marked toolchain-only;
- every draft, labelled as a draft, with its `icp check` result once it is in a transition, otherwise its
  `continuum_apply` result, and
  whether it reproduces the working tree;
- what remains unexplained.

## 5. Scope limits — state them

You read the guard's evidence, the plan and the model; you do not read
application source to infer what the architecture "really" is — that
is recovery, and its output is also a draft. The implementation delta
is a count of files, never a reading of them. Without a toolchain, no
disposition may be called proven; label everything **UNCOMPILED**.
