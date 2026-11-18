// Verifier for the claim `envelope-not-exceeded` (continuum-claim-spec/0, rubric continuum-claim-rubric/3): ADL business
// rule EnvelopeNotExceeded (#a4b26ee8-…) — an award commits its amount only by a single conditional write on the call's
// ledger row that succeeds only if committed + amount <= envelope; otherwise nothing is recorded and the case returns
// to the chair.
//
// It OBSERVES and reports values; it judges nothing. Platform's claim-attestation evaluator decides every pass, the
// scope and the level.
//
//   node envelope-not-exceeded.mjs <declaration> <implementation> <result> <out> <commit> <tree> <attestation> <changeState>
//
//   scope        every literal SQL write to the ledger table (adj_budget) in src/**: the function holding it and how it
//                is entered — every call of that function, followed through named callers to an HTTP route (named by
//                method and URL), or the event whose handler holds the write. Excluded calls are listed apart;
//                non-literal SQL must resolve
//   structural   per write: what it does to the ledger — the conditional commit, or opening a row at zero; anything
//                else (an unconditional change of the committed amount, a change of the envelope, a delete, a replace)
//                is reported as not admitted
//   enforcement  static: commitAward's one conditional UPDATE and its use of the row count; the refusal leaving before
//                the decision is recorded; the store's CHECK constraint (all counted at L1 only)
//   cases        the real routes through the implementation's app (its own harness: an isolated SQLite file, a manual
//                clock), amounts read back from adj_budget in minor units. Every case reports `reached`: the ledger
//                writes whose code V8's precise coverage saw execute during the act alone — the request and the
//                delivery of the events it published; setup excluded. Observed by the runtime, never declared here
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, sha256, lineOf } from './lib/scan.mjs';
import { enclosingFunction, callersOf, harnessRunner } from './lib/flow.mjs';
import { reachObserver } from './lib/reach.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const TABLE = spec.scope.table; const COMMITTED = spec.scope.committed; const ENVELOPE = spec.scope.envelope;
const results = []; const unresolved = []; const excluded = [];
const files = sourceFiles(impl, 'src');
const texts = new Map(files.map((f) => [f, readFileSync(join(impl, f), 'utf8')]));
const lexed = new Map(files.map((f) => [f, lex(texts.get(f))]));
const treeDigest = sha256(files.map((f) => `${f}\n${sha256(texts.get(f))}`).join('\n'));

// ---------------------------------------------------------------- scope: every write to the ledger
const sites = [];
for (const path of files) {
  const lx = lexed.get(path);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      if (w.table !== TABLE) continue;
      const stmt = lit.text.slice(w.at).split(';')[0];
      const [head, where = ''] = stmt.split(/\bWHERE\b/i);
      let observed;
      if (w.op === 'UPDATE') {
        const set = head.slice(head.search(/\bSET\b/i));
        const raises = new RegExp(`\\b${COMMITTED}\\s*=\\s*${COMMITTED}\\s*\\+\\s*\\?`, 'i').test(set);
        const touchesCommitted = new RegExp(`\\b${COMMITTED}\\s*=`, 'i').test(set);
        const touchesEnvelope = new RegExp(`\\b${ENVELOPE}\\s*=`, 'i').test(set);
        const conditional = new RegExp(`\\b${COMMITTED}\\s*\\+\\s*\\?\\s*<=\\s*${ENVELOPE}\\b(?!\\s*[-+*/])`, 'i').test(where);
        const oneRow = /\bcall_id\s*=\s*\?/i.test(where);
        const kind = touchesEnvelope ? 'changes-the-envelope' : touchesCommitted ? (raises && conditional && oneRow ? 'conditional-commit' : 'unconditional-change-of-committed') : 'other-column';
        if (kind === 'other-column') continue;
        observed = { kind, admitted: kind === 'conditional-commit', raisesByParameter: raises, conditional, oneRow };
      } else if (w.op === 'INSERT') {
        const cols = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(head);
        const names = cols ? cols[1].split(',').map((x) => x.trim().toLowerCase()) : null;
        const values = cols ? cols[2].split(',').map((x) => x.trim()) : null;
        const i = names ? names.indexOf(COMMITTED) : -1;
        const atZero = !!names && (i === -1 || values[i] === '0');       // the column default is 0
        const keepsExisting = /\bINSERT\s+OR\s+IGNORE\b/i.test(head) || !/\bINSERT\s+OR\s+\w+/i.test(head);   // never replaces a row
        observed = { kind: atZero && keepsExisting ? 'opens-at-zero' : 'opens-with-an-amount-or-replaces', admitted: atZero && keepsExisting, atZero, keepsExisting };
      } else {
        observed = { kind: w.op === 'DELETE' ? 'deletes-the-ledger-row' : 'replaces-the-ledger-row', admitted: false };
      }
      sites.push({ path, at, offset: lit.offset, op: w.op, statement: w.statement, observed });
    }
  }
  for (const s of nonLiteralSql(path, texts.get(path), lx)) if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` });
}

/** The offset, in a file's code, of the call of `name` on a 1-based line. */
function offsetOfCall(path, line, name) {
  const { code } = lexed.get(path);
  let start = 0; for (let n = 1; n < line; n++) start = code.indexOf('\n', start) + 1;
  const i = code.indexOf(name, start);
  return i === -1 ? start : i;
}
/** Every way into `fn`: its calls, each followed through its own named caller until an HTTP route (or no caller) is found. */
function entriesInto(fn, path, trail = []) {
  const out = [];
  const r = callersOf(fn.name, { files, texts, lexed, excludes: spec.boundary.excludes, definedIn: { path, at: fn.at } });
  excluded.push(...r.excluded);
  for (const e of r.entries) {
    if (e.path.startsWith('HTTP ')) { out.push({ ...e, through: [...trail, fn.name].reverse().join(' → ') }); continue; }
    const [file, line] = [e.site.slice(0, e.site.lastIndexOf(':')), Number(e.site.slice(e.site.lastIndexOf(':') + 1))];
    const outer = enclosingFunction(lexed.get(file).code, offsetOfCall(file, line, fn.name));
    if (!outer || outer.name === fn.name || trail.includes(outer.name) || trail.length > 4) { unresolved.push({ path: e.site, why: `${fn.name}() is called here, outside any route this scan can name` }); continue; }
    const further = entriesInto(outer, file, [...trail, fn.name]);
    if (further.length) out.push(...further);
    else unresolved.push({ path: e.site, why: `${outer.name}() calls ${fn.name}() and no route into it was found` });
  }
  return out;
}
const entries = [];
for (const s of sites) {
  const { code } = lexed.get(s.path);
  const fn = enclosingFunction(code, s.offset);
  s.fn = fn?.name ?? null;
  if (!fn) { unresolved.push({ path: s.at, why: 'the write lies in no named function, so its callers cannot be enumerated' }); continue; }
  // a write inside an event handler of a consumer is entered by that event's delivery, not by a call
  const handler = /(\w+)\s*:\s*\([^()]*\)\s*=>\s*\{[^{}]*$/.exec(code.slice(Math.max(fn.open, s.offset - 400), s.offset))?.[1] ?? null;
  if (handler && /Consumer$/.test(fn.name)) {
    const consumer = /\bname:\s*'([^']+)'/.exec(texts.get(s.path).slice(fn.open, s.offset))?.[1] ?? fn.name;
    s.handler = handler;
    entries.push({ path: `event ${handler}`, site: s.at, through: consumer, form: 'event-handler', reaches: s.at });
    continue;
  }
  for (const e of entriesInto(fn, s.path)) entries.push({ ...e, reaches: s.at });
}
const routes = [...new Set(entries.filter((e) => e.path.startsWith('HTTP ')).map((e) => e.path))];
const discovered = [...new Set([...sites.map((s) => s.at), ...routes])].sort();
results.push({ check: 'ledger-scope', ran: 'completed', path: 'src/**', inputs: treeDigest, observed: {
  method: `lexed literal SQL over src/** for every write to ${TABLE}; each write's function, every call of it followed to its HTTP route, and the event whose handler holds a write`,
  discovered, writes: sites.map(({ at, op, fn, handler, statement, observed }) => ({ path: at, op, function: fn, ...(handler ? { handler } : {}), statement, kind: observed.kind })), entries, unresolved, excluded,
} });

// ---------------------------------------------------------------- structural: what each write does to the ledger
for (const s of sites) results.push({ check: 'ledger-write-admitted', ran: 'completed', path: s.at, inputs: sha256(texts.get(s.path)), observed: { ...s.observed, function: s.fn } });

// ---------------------------------------------------------------- enforcement (static, L1 only)
{
  const path = 'src/contexts/adjudication/service.ts';
  const t = texts.get(path) ?? '';
  const commitFn = /export function commitAward\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(t)?.[1] ?? '';
  const oneWrite = (commitFn.match(/\b(UPDATE|INSERT|DELETE|REPLACE)\b/g) ?? []).length === 1;
  const conditional = new RegExp(`UPDATE ${TABLE} SET ${COMMITTED} = ${COMMITTED} \\+ \\? WHERE call_id = \\? AND ${COMMITTED} \\+ \\? <= ${ENVELOPE}\``).test(commitFn);
  const sameAmount = /\.run\(\s*amountMinor\s*,\s*callId\s*,\s*amountMinor\s*\)/.test(commitFn);
  const byRowCount = /committed:\s*r\.changes\s*===\s*1/.test(commitFn);
  results.push({ check: 'single-conditional-write', ran: 'completed', path: `${path}:commitAward`, inputs: sha256(t), observed: { guarded: oneWrite && conditional && sameAmount && byRowCount, parts: { oneWrite, conditional, sameAmountAddedAndTested: sameAmount, outcomeFromRowCount: byRowCount } } });

  const decide = /export function recordDecision\([\s\S]*?\n\}/.exec(t)?.[0] ?? '';
  const commitAt = decide.search(/commitAward\s*\(/);
  const refusal = /if\s*\(\s*!\s*result\.committed\s*\)\s*\{([\s\S]*?)\n    \}/.exec(decide);
  const recordAt = decide.search(/INSERT INTO adj_decision/);
  const returnsToChair = !!refusal && /UPDATE adj_case SET status = 'reconsider'/.test(refusal[1]);
  const leaves = !!refusal && /return new CommittedRefusal\(/.test(refusal[1]);
  const beforeRecord = !!refusal && commitAt !== -1 && commitAt < refusal.index && refusal.index < recordAt;
  results.push({ check: 'refusal-leaves-before-decision', ran: 'completed', path: `${path}:recordDecision`, inputs: sha256(t), observed: { guarded: returnsToChair && leaves && beforeRecord, parts: { caseReturnedToChair: returnsToChair, refusalLeavesTheFunction: leaves, refusalPrecedesTheDecisionRecord: beforeRecord } } });

  const schema = texts.get('src/platform/schema.ts') ?? '';
  const table = new RegExp(`CREATE TABLE ${TABLE} \\(([\\s\\S]*?)\\n  \\);`).exec(schema)?.[1] ?? '';
  const check = new RegExp(`CHECK \\(${COMMITTED} >= 0 AND ${COMMITTED} <= ${ENVELOPE}\\)`).test(table);
  results.push({ check: 'store-check-constraint', ran: 'completed', path: `src/platform/schema.ts:${TABLE}`, inputs: sha256(schema), observed: { guarded: check } });
}

// ---------------------------------------------------------------- cases: the real routes; amounts read back in minor units
const scenario = harnessRunner(impl);
const ROUTE = routes.find((r) => /decision/.test(r)) ?? 'HTTP POST /api/adjudications/:id/decision';
const url = (id) => ROUTE.replace(/^HTTP POST /, '').replace(':id', id);
const RATIONALE = 'Claim verification: the panel found the proposal strong on every criterion.';
const ledger = (h, callId) => h.one(`SELECT ${COMMITTED} c, ${ENVELOPE} e FROM ${TABLE} WHERE call_id = ?`, callId) ?? null;
const decisionOf = (h, id) => h.one(`SELECT outcome, amount_minor FROM adj_decision WHERE proposal_id = ?`, id) ?? null;
const caseOf = (h, id) => h.one(`SELECT status s FROM adj_case WHERE proposal_id = ?`, id)?.s ?? null;
const decide = (h, w, id, outcome) => h.post(url(id), w.chair, { outcome, rationale: RATIONALE });
const observer = await reachObserver(impl, (path) => lexed.get(path).code);
const caseRun = async (check, path, body) => {
  let reached = [];
  // only the ACT is measured — the request and the delivery of the events it published — never the setup
  const act = async (h, fn) => { const r = await observer.act(async () => { const v = await fn(); await h.settle(); return v; }, sites); reached = r.reached; return r.value; };
  try { const observed = await scenario((h) => body(h, (fn) => act(h, fn))); results.push({ check, ran: 'completed', path, reached, inputs: treeDigest, observed }); }
  catch (e) { results.push({ check, ran: 'error', path, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
};
/** A world with the given envelope, and one scored proposal per requested amount (all by the same applicant). */
async function scoredWorld(h, envelope, requests) {
  const w = h.world({ envelope, maxRequest: 150_000 });
  const ids = [];
  for (const requested of requests) ids.push(await h.scored(w, w.r.slice(0, 3), w.alice, { requested }));
  return { w, ids };
}
const after = (h, w, id) => {
  const b = ledger(h, w.callId); const d = decisionOf(h, id);
  return { committedAfterMinor: b.c, remainingAfterMinor: b.e - b.c, decisionAfter: d?.outcome ?? null, decisionAmountMinor: d?.amount_minor ?? null, caseStatusAfter: caseOf(h, id) };
};

// the ledger is opened by the delivery of CallPublished: the publication route is the act
const opening = entries.find((e) => e.form === 'event-handler');
await caseRun('ledger-opens-empty', opening?.path ?? 'event CallPublished', async (h, act) => {
  const w = h.world();
  const deadline = new Date(h.clock.now().getTime() + 30 * 24 * 3600_000).toISOString();
  const r = await act(() => h.post('/api/calls', w.officer, {
    title: 'A second call, published through the route', summary: 'Published by the claim verifier to observe the ledger row the publication opens.',
    deadline, envelope: 250_000, maxRequest: 100_000, criteria: [{ name: 'Merit', guidance: 'Scientific merit.' }],
  }));
  const b = r.body?.id ? ledger(h, r.body.id) : null;
  return { httpStatus: r.status, opened: b !== null, committedMinor: b?.c ?? null, envelopeMinor: b?.e ?? null };
});
await caseRun('award-within-envelope', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 300_000, [100_000]);
  const before = ledger(h, w.callId).c;
  const r = await act(() => decide(h, w, ids[0], 'award'));
  return { committedBeforeMinor: before, refused: r.status >= 400, httpStatus: r.status, ...after(h, w, ids[0]) };
});
// the edge of the bound: the award that brings committed to exactly the envelope is admitted
await caseRun('award-exactly-fills-envelope', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 200_000, [100_000, 100_000]);
  const first = await decide(h, w, ids[0], 'award'); await h.settle();
  const before = ledger(h, w.callId).c;
  const r = await act(() => decide(h, w, ids[1], 'award'));
  return { firstAwarded: first.status < 400, committedBeforeMinor: before, refused: r.status >= 400, httpStatus: r.status, ...after(h, w, ids[1]) };
});
// one minor unit past the edge
await caseRun('award-one-over-refused', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 200_000, [100_000, 100_000.01]);
  const first = await decide(h, w, ids[0], 'award'); await h.settle();
  const before = { committed: ledger(h, w.callId).c, awarded: h.count('ProposalAwarded') };
  const r = await act(() => decide(h, w, ids[1], 'award'));
  return { firstAwarded: first.status < 400, committedBeforeMinor: before.committed, overByMinor: before.committed + 10_000_001 - ledger(h, w.callId).e, refused: r.status >= 400, httpStatus: r.status, code: r.body?.error?.code ?? null, awardedPublished: h.count('ProposalAwarded') - before.awarded, ...after(h, w, ids[1]) };
});
await caseRun('award-over-envelope-refused', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 200_000, [150_000, 150_000]);
  const first = await decide(h, w, ids[0], 'award'); await h.settle();
  const before = { committed: ledger(h, w.callId).c, awarded: h.count('ProposalAwarded') };
  const r = await act(() => decide(h, w, ids[1], 'award'));
  return { firstAwarded: first.status < 400, committedBeforeMinor: before.committed, refused: r.status >= 400, httpStatus: r.status, code: r.body?.error?.code ?? null, awardedPublished: h.count('ProposalAwarded') - before.awarded, ...after(h, w, ids[1]) };
});
// "the case returns to the chair": after the refusal the chair still holds the case, and only a decline is left
await caseRun('refused-case-admits-decline', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 200_000, [150_000, 150_000]);
  await decide(h, w, ids[0], 'award'); await h.settle();
  const refusal = await decide(h, w, ids[1], 'award'); await h.settle();
  const before = { committed: ledger(h, w.callId).c, caseStatus: caseOf(h, ids[1]) };
  const o = await act(async () => ({ again: await decide(h, w, ids[1], 'award'), decline: await decide(h, w, ids[1], 'decline') }));
  return { firstRefusalCode: refusal.body?.error?.code ?? null, caseStatusBefore: before.caseStatus, committedBeforeMinor: before.committed, secondAwardRefused: o.again.status >= 400, secondAwardCode: o.again.body?.error?.code ?? null, declined: o.decline.status < 400, ...after(h, w, ids[1]) };
});
// two awards in flight at once, against one process and one store: together they would exceed the envelope
await caseRun('concurrent-awards-one-admitted', ROUTE, async (h, act) => {
  const { w, ids } = await scoredWorld(h, 200_000, [150_000, 150_000]);
  const rs = await act(() => Promise.all([decide(h, w, ids[0], 'award'), decide(h, w, ids[1], 'award')]));
  const b = ledger(h, w.callId);
  return { admitted: rs.filter((r) => r.status < 400).length, committedAfterMinor: b.c, envelopeMinor: b.e, awardsRecorded: h.one(`SELECT COUNT(*) n FROM adj_decision WHERE outcome = 'award'`).n };
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
  verifier: { name: 'envelope-not-exceeded', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'EnvelopeNotExceeded', kind: `${spec.claim.language}:${spec.claim.kind}` }] },
  implementation: { commit, tree },
  expectation: { statement: decl.expectation, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static scope, structural and guard checks over src/**; the real HTTP routes driven through the implementation\'s app, with V8 precise coverage observing which ledger writes executed',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: discovered, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-rubric/3)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the routes ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
