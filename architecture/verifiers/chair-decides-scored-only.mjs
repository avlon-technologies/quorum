// Verifier for the claim `chair-decides-scored-only` (continuum-claim-spec/0, rubric continuum-claim-rubric/3; first
// written for prompt 030): ADL business rule ChairOnScoredOnly (#6ab58159-…) — a panel decision is recorded only by a
// panel chair, only for a proposal with an open adjudication case (which exists only once the proposal is scored),
// only once, and an award only when no integrity hold is on the case. The business model says the same of the
// decision RecordPanelDecision (#ac-q019, rule #r-q008), whose Award outcome is the approval (Proposal Scored →
// Awarded, t-q016); it is read here to corroborate three of the rule's parts, each from its own source:
//   performers  ac-q019 mayPerform — closed (BDL §9.2): PanelChair, and no other
//   scored      ac-q019 precondition: Proposal.status == ProposalStatus "Scored"  (r-q008's condition is its negation)
//   once        derived: after a decision the proposal is Awarded or Declined, both terminal, and only Score enters
//               Scored (sm-q003, closed by §5.8 R-07) — so the precondition cannot hold twice
//
// It OBSERVES and reports values; Platform's evaluator judges.
//
//   scope        every write that records a panel decision (adj_decision, and adj_case moved to 'decided'), every
//                publish of the decision fact (ProposalAwarded / ProposalDeclined), every write that moves a proposal
//                to awarded/declined, and every entry point into the decision writes
//   cases        the real route: the chair awards and declines a scored proposal (allowed); every other role, an
//                unscored proposal and an award on a held case (rejected); and the rule's edges (boundary) — a
//                proposal one review short of scored, and a second decision. The persisted decision and proposal
//                state are read back. Every case reports `reached`: the in-scope sites whose block V8's precise
//                coverage saw execute during the act alone (the request and the delivery of its events; setup
//                excluded) — observed by the runtime, never declared by this file
//   enforcement  the route admits only the declared role; the scored and once guards dominate the decision writes; the
//                fact is published only after them; proposal outcomes are applied only on the fact
//   correspondence  each part of the rule against the code that implements it
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, excludedBy, sha256, lineOf } from './lib/scan.mjs';
import { enclosingFunction, topLevelBefore, callersOf, harnessRunner } from './lib/flow.mjs';
import { reachObserver } from './lib/reach.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const OUTCOMES = new Set(spec.scope.outcomeStatuses);   // the stored proposal statuses a decision produces
const FACTS = new Set(spec.scope.decisionFacts);        // the events that carry the decision
const results = []; const unresolved = []; const excluded = [];
const files = sourceFiles(impl, 'src');
const texts = new Map(files.map((f) => [f, readFileSync(join(impl, f), 'utf8')]));
const lexed = new Map(files.map((f) => [f, lex(texts.get(f))]));
const treeDigest = sha256(files.map((f) => `${f}\n${sha256(texts.get(f))}`).join('\n'));

// ---------------------------------------------------------------- the model, from the business model at the baseline
const bdl = readFileSync(spec.scope.businessModel, 'utf8');
const block = (kind, id) => new RegExp(`${kind}\\s+\\w+\\s*(?:\\[[^\\]]*\\])?\\s*#${id}\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}`).exec(bdl)?.[1] ?? '';
const modelCondition = /\bcondition\s+(.+)/.exec(block('rule', spec.scope.businessRule))?.[1]?.trim() ?? null;
const modelPreconditions = [...block('decision', spec.scope.action).matchAll(/precondition\s*\{\s*([^}]*?)\s*\}/g)].map((m) => m[1].trim()).sort();

/** The arguments of the call whose '(' is at `open`, as raw text, split at depth-0 commas. */
function argsAt(text, open) {
  const args = []; let depth = 0; let cur = ''; let q = null;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q && text[i - 1] !== '\\') q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) { if (depth === 0) { args.push(cur.trim()); return args; } depth--; }
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return args;
}
const literalOf = (a) => /^'([^']*)'$/.exec(a ?? '')?.[1] ?? null;
/** The target status an argument names: a literal, or `{ status: '<literal>' … }`; null when it is computed. */
const targetOf = (a) => literalOf(a) ?? (/^\{/.test(a ?? '') ? /\bstatus\s*:\s*'(\w+)'/.exec(a)?.[1] ?? null : null);
/** A forwarded parameter: an identifier, or `{ status: <identifier> … }`. */
const forwardsParam = (a) => /^\w+$/.test(a ?? '') || /^\{[^}]*\bstatus\s*:\s*\w+\s*[,}]/.test(a ?? '');

// ---------------------------------------------------------------- scope
const writes = [];      // decision writes: { path, at, offset, op, table, fn }
const publishes = [];   // decision fact publishes
const outcomes = [];    // proposal outcome writes
for (const path of files) {
  const lx = lexed.get(path); const text = texts.get(path);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      const stmt = lit.text.slice(w.at);
      if (w.table === 'adj_decision') writes.push({ path, at, offset: lit.offset, op: w.op, table: w.table, statement: w.statement });
      else if (w.table === 'adj_case' && w.op === 'UPDATE' && /SET\s+[^;]*?\bstatus\s*=\s*'decided'/i.test(stmt.split(/\bWHERE\b/i)[0])) writes.push({ path, at, offset: lit.offset, op: w.op, table: w.table, statement: w.statement });
      else if (w.table === 'sub_proposal' && w.op === 'UPDATE' && /\bstatus\s*=/.test(stmt.split(/\bWHERE\b/i)[0])) {
        // the proposal's status channel: a literal outcome is an outcome write; a parameter is resolved through its callers
        const to = /\bstatus\s*=\s*'(\w+)'/i.exec(stmt.split(/\bWHERE\b/i)[0])?.[1] ?? null;
        if (to && OUTCOMES.has(to)) outcomes.push({ path, at, offset: lit.offset, form: 'sql', to });
        else if (!to) {
          const fn = enclosingFunction(lx.code, lit.offset);
          if (fn?.name !== spec.scope.statusChannel) unresolved.push({ path: at, why: `UPDATE sub_proposal sets a computed status outside ${spec.scope.statusChannel}()` });
        }
      }
    }
  }
  for (const s of nonLiteralSql(path, text, lx)) if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` });
  // the decision fact
  for (const m of lx.code.matchAll(/\.publish\s*\(/g)) {
    const first = argsAt(text, m.index + m[0].length - 1)[0] ?? '';
    const lit = literalOf(first);
    const at = `${path}:${lx.lineAt(m.index)}`;
    if (lit !== null) { if (FACTS.has(lit)) publishes.push({ path, at, offset: m.index, type: lit }); continue; }
    const named = [...FACTS].filter((x) => first.includes(`'${x}'`));
    if (named.length) publishes.push({ path, at, offset: m.index, type: named.join('|') });
    else unresolved.push({ path: at, why: `publish with a computed event type (${first.slice(0, 60)}): whether it is the decision fact cannot be shown` });
  }
  // proposal outcomes through the status channel: calls whose target status argument is literal
  for (const callee of [spec.scope.statusChannel, ...spec.scope.statusForwarders]) {
    // a bare call only: `res.status(…)` and other methods are not the channel
    for (const m of lx.code.matchAll(new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, 'g'))) {
      if (/(?:function\s+|const\s+)$/.test(lx.code.slice(Math.max(0, m.index - 12), m.index))) continue;   // its definition
      const args = argsAt(text, m.index + m[0].length - 1);
      const toArg = args[spec.scope.statusArgument[callee]];
      const to = targetOf(toArg);
      const at = `${path}:${lx.lineAt(m.index)}`;
      if (to !== null) { if (OUTCOMES.has(to)) outcomes.push({ path, at, offset: m.index, form: callee, to }); continue; }
      // a forwarder passing its own parameter on is resolved through ITS callers (scanned here too)
      const definer = [...text.slice(0, m.index).matchAll(/(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*\()/g)].pop();
      if (forwardsParam(toArg) && spec.scope.statusForwarders.includes(definer?.[1] ?? definer?.[2])) continue;
      // a parameter whose declared type is a union of string literals: those values (assumption C8)
      const fn = enclosingFunction(lx.code, m.index);
      const typed = fn && /^\w+$/.test(toArg ?? '') ? new RegExp(`\\b${toArg}\\s*:\\s*((?:'\\w+'\\s*\\|?\\s*)+)[,)]`).exec(text.slice(fn.at, fn.open)) : null;
      if (typed) {
        const values = [...typed[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
        for (const v of values.filter((x) => OUTCOMES.has(x))) outcomes.push({ path, at, offset: m.index, form: callee, to: v });
        continue;
      }
      unresolved.push({ path: at, why: `${callee}() with a computed target status (${toArg ?? '?'})` });
    }
  }
}
// entry points into the decision writes
const decisionFns = new Map();
for (const w of writes) {
  const { code } = lexed.get(w.path);
  const fn = enclosingFunction(code, w.offset);
  w.fn = fn?.name ?? null;
  if (!fn) { unresolved.push({ path: w.at, why: 'the decision write lies in no named function' }); continue; }
  decisionFns.set(`${w.path}::${fn.name}`, { path: w.path, fn });
}
const entries = [];
for (const { path, fn } of decisionFns.values()) {
  const r = callersOf(fn.name, { files, texts, lexed, excludes: spec.boundary.excludes, definedIn: { path, at: fn.at } });
  for (const e of r.entries) entries.push({ ...e, reaches: writes.filter((w) => w.fn === fn.name && w.path === path).map((w) => w.at) });
  excluded.push(...r.excluded);
}
// the handler each outcome write lies in
for (const o of outcomes) {
  const before = lexed.get(o.path).code.slice(Math.max(0, o.offset - 300), o.offset);
  o.handler = /(\w+)\s*:\s*$/.exec(before)?.[1] ?? /(\w+)\s*:\s*(?:on\()?\s*\([^)]*\)\s*=>\s*(?:\{[^{}]*)?$/.exec(before)?.[1] ?? null;
  if (!o.handler) unresolved.push({ path: o.at, why: `a proposal moves to ${o.to} here, and the handler it runs in cannot be named` });
}
const discovered = [...new Set([...writes.map((w) => w.at), ...publishes.map((p) => p.at), ...outcomes.map((o) => o.at), ...entries.map((e) => e.path)])].sort();
results.push({ check: 'decision-scope', ran: 'completed', path: 'src/**', inputs: treeDigest, observed: {
  method: 'lexed src/**: SQL writes to adj_decision and adj_case→decided; publishes of the decision fact; proposal status writes to an outcome through the status channel; every call of each decision function',
  discovered, writes: writes.map(({ at, op, table, statement, fn }) => ({ path: at, op, table, statement, function: fn })),
  publishes: publishes.map(({ at, type }) => ({ path: at, type })), outcomes: outcomes.map(({ at, form, to, handler }) => ({ path: at, form, to, handler })),
  entries, unresolved, excluded,
} });

// ---------------------------------------------------------------- structural: outcomes are applied only on the decision fact
for (const o of outcomes.filter((x) => x.handler)) {
  results.push({ check: 'outcome-follows-decision-fact', ran: 'completed', path: o.at, inputs: sha256(texts.get(o.path)), observed: { handler: o.handler, to: o.to, onDecisionFact: FACTS.has(o.handler) } });
}

// ---------------------------------------------------------------- enforcement: the guards dominate every in-scope path
const guards = {};
for (const { path, fn } of decisionFns.values()) {
  const { code } = lexed.get(path);
  // the guard window ends at the decision RECORD (adj_decision): the conditional claim of the case (adj_case →
  // decided, checked to have changed one row) is itself one of the guards it must follow
  const mine = writes.filter((w) => w.fn === fn.name);
  const first = Math.min(...(mine.some((w) => w.table === 'adj_decision') ? mine.filter((w) => w.table === 'adj_decision') : mine).map((w) => w.offset));
  const { top } = topLevelBefore(code, fn, first);
  const raw = texts.get(path).slice(fn.open + 1, first);
  guards[fn.name] = {
    scored: /if\s*\(\s*!\s*(\w+)\s*\)\s*throw\s+conflict\(\s*'not_scored'/.test(raw) && /const\s+\w+\s*=\s*deps\.db\s*\.prepare\(\s*`SELECT \* FROM adj_case WHERE proposal_id = \?`\s*\)\s*\.get\(\s*proposalId\s*\)/.test(raw),
    decidedRefused: /if\s*\(\s*\w+\.status\s*===\s*'decided'\s*\)\s*throw\s+conflict\(\s*'already_decided'/.test(raw),
    conditionalClaim: /UPDATE adj_case SET status = 'decided' WHERE proposal_id = \? AND status IN \('awaitingDecision','reconsider'\)/.test(raw) && /if\s*\(\s*\w+\.changes\s*!==\s*1\s*\)\s*throw\s+conflict\(\s*'already_decided'/.test(raw),
    noEarlyReturn: !/\breturn\b/.test(top.replace(/return new CommittedRefusal[\s\S]*?;/g, '')),
    // an award on a held case is refused before anything is committed
    holdRefusesAward: /if\s*\(\s*\w+\.integrity_hold\s*\)\s*throw\s+conflict\(\s*'integrity_hold'/.test(raw) && raw.search(/if\s*\(\s*\w+\.integrity_hold\s*\)/) > raw.search(/if\s*\(\s*input\.outcome\s*===\s*'award'\s*\)/) && raw.search(/if\s*\(\s*\w+\.integrity_hold\s*\)/) < raw.search(/commitAward\s*\(/),
  };
}
const fnGuarded = Object.values(guards).every((g) => g.scored && g.decidedRefused && g.conditionalClaim && g.noEarlyReturn && g.holdRefusesAward);
const routesGuarded = entries.every((e) => e.path.startsWith('HTTP ') && Array.isArray(e.access) && e.access.length > 0);
const factOnlyAfterGuards = publishes.every((p) => { const fn = enclosingFunction(lexed.get(p.path).code, p.offset); return fn && guards[fn.name] && decisionFns.has(`${p.path}::${fn.name}`); });
const outcomesOnFact = outcomes.every((o) => FACTS.has(o.handler));
const dominates = fnGuarded && routesGuarded && factOnlyAfterGuards && outcomesOnFact;
results.push({
  check: 'guards-dominate-decision', ran: 'completed', path: [...decisionFns.values()].map(({ path, fn }) => `${path}:${fn.name}`).join(', ') || 'none', inputs: treeDigest,
  observed: {
    dominates, appliesTo: dominates ? discovered : [],
    parts: { functionGuards: guards, everyEntryIsARouteWithAccess: routesGuarded, factPublishedOnlyByTheGuardedFunction: factOnlyAfterGuards, outcomesAppliedOnlyOnTheFact: outcomesOnFact },
  },
});

// ---------------------------------------------------------------- correspondence: each part of the compiled rule
{
  const admittedRoles = [...new Set(entries.flatMap((e) => (Array.isArray(e.access) ? e.access : [])))].sort();
  const caseInserts = files.flatMap((path) => lexed.get(path).literals.flatMap((lit) => sqlWrites(lit).filter((w) => w.table === 'adj_case' && (w.op === 'INSERT' || w.op === 'REPLACE')).map((w) => ({ path, at: `${path}:${lineOf(lit, w.at)}`, offset: lit.offset }))));
  const caseOnScored = caseInserts.length > 0 && caseInserts.every((c) => /ProposalScored\s*:\s*\([^)]*\)\s*=>\s*\{\s*$/.test(lexed.get(c.path).code.slice(Math.max(0, c.offset - 200), c.offset).replace(/const\s+\w+\s*=[^;]*;\s*db\.prepare\(\s*$/, '').replace(/db\.prepare\(\s*$/, '')));
  const schema = texts.get('src/platform/schema.ts') ?? '';
  const onePerProposal = /CREATE TABLE adj_decision \(\s*proposal_id\s+TEXT PRIMARY KEY/.test(schema);
  const scoredOnly = Object.values(guards).every((g) => g.scored) && caseOnScored;
  const once = Object.values(guards).every((g) => g.decidedRefused && g.conditionalClaim) && onePerProposal;
  const awardOnlyWithoutHold = Object.values(guards).length > 0 && Object.values(guards).every((g) => g.holdRefusesAward);
  results.push({
    check: 'guards-implement-rule', ran: 'completed', path: [...decisionFns.values()].map(({ path, fn }) => `${path}:${fn.name}`).join(', ') || 'none', inputs: sha256(`${treeDigest}\n${schema}`),
    observed: {
      modelCondition, modelPreconditions, admittedRoles, scoredOnly, once, awardOnlyWithoutHold,
      parts: { performer: { admittedRoles, at: entries.map((e) => e.path) }, scored: { refusesWithoutCase: Object.values(guards).every((g) => g.scored), caseOpenedOnlyOnProposalScored: caseOnScored, caseInserts: caseInserts.map((c) => c.at) }, once: { decidedRefused: Object.values(guards).every((g) => g.decidedRefused), conditionalClaim: Object.values(guards).every((g) => g.conditionalClaim), onePerProposal }, hold: { awardRefusedBeforeCommit: awardOnlyWithoutHold } },
    },
  });
}

// ---------------------------------------------------------------- cases: the real route, the persisted state
const scenario = harnessRunner(impl);
const route = entries.find((e) => e.path.startsWith('HTTP POST'))?.path ?? 'HTTP POST /api/adjudications/:id/decision';
const url = (id) => route.replace(/^HTTP POST /, '').replace(':id', id);
/** The span of the arguments of the call at `offset`: from its '(' to the matching ')'. */
function argumentSpan(code, offset) {
  const open = code.indexOf('(', offset); let depth = 0;
  for (let i = open; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')') { depth--; if (!depth) return [open, i + 1]; } }
  return [open, open];
}
// every in-scope site: what a case can be seen to reach. An outcome applied through a call carries the span of that
// call's arguments: a handler built by a factory call runs no code at the call itself, only the functions passed to it
const sites = [...writes, ...publishes, ...outcomes.map((o) => (o.form === 'sql' ? o : { ...o, within: argumentSpan(lexed.get(o.path).code, o.offset) }))];
const RATIONALE = 'Attestation pilot: the panel found the proposal strong on every criterion.';
const decisionOf = (h, id) => h.one(`SELECT outcome FROM adj_decision WHERE proposal_id = ?`, id)?.outcome ?? null;
const decisions = (h) => h.one(`SELECT COUNT(*) n FROM adj_decision`).n;
const holdOf = (h, id) => h.one(`SELECT integrity_hold x FROM adj_case WHERE proposal_id = ?`, id)?.x ?? null;
const observer = await reachObserver(impl, (path) => lexed.get(path).code);
const caseRun = async (check, body) => {
  let reached = [];
  // only the ACT is measured — the request and the delivery of the events it published — never the setup
  const act = async (h, fn) => { const r = await observer.act(async () => { const v = await fn(); await h.settle(); return v; }, sites); reached = r.reached; return r.value; };
  try { const observed = await scenario((h) => body(h, (fn) => act(h, fn))); results.push({ check, ran: 'completed', path: route, reached, inputs: treeDigest, observed }); }
  catch (e) { results.push({ check, ran: 'error', path: route, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
};
const decide = (h, who, id, outcome) => h.post(url(id), who, { outcome, rationale: RATIONALE });
await caseRun('chair-decides-scored', async (h, act) => {
  const w = h.world(); const id = await h.scored(w);
  const before = h.status(id);
  const r = await act(() => decide(h, w.chair, id, 'award'));
  return { statusBefore: before, httpStatus: r.status, decided: r.status < 400, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id) };
});
await caseRun('chair-declines-scored', async (h, act) => {
  const w = h.world(); const id = await h.scored(w);
  const before = h.status(id);
  const r = await act(() => decide(h, w.chair, id, 'decline'));
  return { statusBefore: before, httpStatus: r.status, decided: r.status < 400, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id) };
});
await caseRun('non-chair-refused', async (h, act) => {
  const w = h.world(); const id = await h.scored(w);
  const before = { status: h.status(id), events: h.totalEvents(), decisions: decisions(h) };
  const tried = {};
  await act(async () => {
    for (const [who, u] of [['programOfficer', w.officer], ['operator', w.operator], ['applicant', w.alice], ['reviewer', w.r[0]], ['unverifiedReviewer', w.unverified]]) {
      const r = await decide(h, u, id, 'award');
      tried[who] = { httpStatus: r.status, code: r.body?.error?.code ?? null };
    }
  });
  return { tried, allRefused: Object.values(tried).every((x) => x.httpStatus >= 400), decisionsAdded: decisions(h) - before.decisions, statusBefore: before.status, proposalStatusAfter: h.status(id), eventsAdded: h.totalEvents() - before.events };
});
await caseRun('unscored-refused', async (h, act) => {
  const w = h.world(); const id = await h.underReview(w);
  const before = { status: h.status(id), events: h.totalEvents() };
  const r = await act(() => decide(h, w.chair, id, 'award'));
  return { statusBefore: before.status, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id), eventsAdded: h.totalEvents() - before.events };
});
// the edge of "scored": two of the three reviews are in, so the proposal is one review short of a case
await caseRun('one-review-short-refused', async (h, act) => {
  const w = h.world(); const id = await h.underReview(w);
  for (const rv of w.r.slice(0, 2)) h.review(w, id, rv);
  await h.settle();
  const before = { status: h.status(id), events: h.totalEvents(), submitted: h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND status = 'completed'`, id).n };
  const r = await act(() => decide(h, w.chair, id, 'award'));
  return { reviewsSubmitted: before.submitted, statusBefore: before.status, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id), eventsAdded: h.totalEvents() - before.events };
});
// the edge of "only once": the first decision was admitted, the second is the act
await caseRun('second-decision-refused', async (h, act) => {
  const w = h.world(); const id = await h.scored(w);
  const first = await decide(h, w.chair, id, 'decline');
  await h.settle();
  const before = { status: h.status(id), events: h.totalEvents(), decision: decisionOf(h, id) };
  const r = await act(() => decide(h, w.chair, id, 'award'));
  return { firstHttpStatus: first.status, statusBefore: before.status, decisionBefore: before.decision, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id), eventsAdded: h.totalEvents() - before.events };
});
/** A scored proposal whose case carries an integrity hold: a reviewer's conflict is declared after scoring, through the route. */
async function held(h) {
  const w = h.world(); const id = await h.scored(w);
  const d = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0].id, reason: 'Conflict disclosed after scoring.' });
  await h.settle();
  return { w, id, declared: d.status };
}
await caseRun('held-award-refused', async (h, act) => {
  const { w, id, declared } = await held(h);
  const before = { status: h.status(id), events: h.totalEvents(), hold: holdOf(h, id) !== null };
  const r = await act(() => decide(h, w.chair, id, 'award'));
  return { conflictHttpStatus: declared, holdBefore: before.hold, statusBefore: before.status, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id), eventsAdded: h.totalEvents() - before.events };
});
await caseRun('held-decline-recorded', async (h, act) => {
  const { w, id, declared } = await held(h);
  const before = { status: h.status(id), hold: holdOf(h, id) !== null };
  const r = await act(() => decide(h, w.chair, id, 'decline'));
  return { conflictHttpStatus: declared, holdBefore: before.hold, statusBefore: before.status, httpStatus: r.status, decided: r.status < 400, decisionAfter: decisionOf(h, id), proposalStatusAfter: h.status(id) };
});
await observer.stop();

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix', database: 'SQLite (better-sqlite3), an isolated file per case; manual clock' },
  results: results.sort((a, b) => (`${a.check}\0${a.path}` < `${b.check}\0${b.path}` ? -1 : 1)),
};
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'chair-decides-scored-only', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'ChairOnScoredOnly', kind: `${spec.claim.language}:${spec.claim.kind}` }] },
  implementation: { commit, tree },
  expectation: { statement: decl.expectation, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static scope, guard and correspondence checks over src/**; the real HTTP route driven through the implementation\'s app, with V8 precise coverage observing which in-scope sites executed',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: discovered, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-rubric/3)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the route ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
