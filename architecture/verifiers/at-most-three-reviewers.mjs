// Verifier for the claim `at-most-three-reviewers` (continuum-claim-spec/0, rubric continuum-claim-rubric/3, prompt 036):
// ADL business rule AssignmentValidity (#61505d55-…) — the clause "the proposal has fewer than three active
// assignments": an assignment is made only while the proposal has fewer than three active (non-revoked) assignments,
// so no proposal ever holds more than three.
//
// It OBSERVES and reports values; it judges nothing. Platform's claim-attestation evaluator decides every pass, the
// scope and the level.
//
//   node at-most-three-reviewers.mjs <declaration> <implementation> <result> <out> <commit> <tree> <attestation> <changeState>
//
//   scope        every write that creates an ACTIVE assignment — INSERT/REPLACE INTO rev_assignment, or an UPDATE that
//                moves a revoked assignment back to an active status — the named function holding it, and every call
//                of that function in src/** (an HTTP route is named by method and URL); excluded calls are listed
//   cases        the real HTTP route through the implementation's app (its own harness: an isolated SQLite file, a
//                manual clock), each observing the resulting count of active assignments. Every case also reports
//                `reached`: the write sites whose BLOCK V8's precise coverage saw execute during the case's act (setup
//                excluded) — observed by the runtime, never declared by this file
//   enforcement  static: the bound in assignmentEligibility, and the store's trigger (counted at L1 only)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from 'node:inspector/promises';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, sha256, lineOf } from './lib/scan.mjs';
import { enclosingFunction, callersOf, harnessRunner } from './lib/flow.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const results = []; const unresolved = []; const discovered = [];
const files = sourceFiles(impl, 'src');
const texts = new Map(files.map((f) => [f, readFileSync(join(impl, f), 'utf8')]));
const lexed = new Map(files.map((f) => [f, lex(texts.get(f))]));
const treeDigest = sha256(files.map((f) => `${f}\n${sha256(texts.get(f))}`).join('\n'));

// ---------------------------------------------------------------- scope: the writes that create an active assignment
const writes = [];
for (const path of files) {
  const lx = lexed.get(path);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      if (w.table !== 'rev_assignment' || w.op === 'DELETE') continue;
      if (w.op === 'INSERT' || w.op === 'REPLACE') { writes.push({ path, at, offset: lit.offset, op: w.op }); continue; }
      const stmt = lit.text.slice(w.at);
      const set = stmt.split(/\bWHERE\b/i)[0];
      const to = /\bstatus\s*=\s*'(\w+)'/i.exec(set)?.[1] ?? null;
      if (!/\bstatus\s*=/.test(set)) continue;
      if (to === null) { unresolved.push({ path: at, why: `UPDATE rev_assignment sets a computed status: ${w.statement}` }); continue; }
      if (to === 'revoked') continue;                                        // revoking never creates an active one
      const where = stmt.split(/\bWHERE\b/i)[1] ?? '';
      const fixed = /\bstatus\s*=\s*'(\w+)'/.exec(where)?.[1] ?? null;
      const list = /\bstatus\s+IN\s*\(([^)]*)\)/i.exec(where)?.[1] ?? null;
      if (fixed && fixed !== 'revoked') continue;                           // active → active: the count is unchanged
      if (!fixed && list && !list.includes('revoked') && !list.includes('?')) continue;
      if (!fixed && list && list.includes('?')) { unresolved.push({ path: at, why: `UPDATE rev_assignment from a computed set of statuses: ${w.statement}` }); continue; }
      writes.push({ path, at, offset: lit.offset, op: 'UPDATE', note: fixed ? 'revoked → active' : 'the prior status is not fixed' });
    }
  }
  for (const s of nonLiteralSql(path, texts.get(path), lx)) if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` });
}
const entries = [];
for (const w of writes) {
  const fn = enclosingFunction(lexed.get(w.path).code, w.offset);
  w.fn = fn?.name ?? null;
  discovered.push(w.at);
  if (!fn) { unresolved.push({ path: w.at, why: 'the write lies in no named function, so its callers cannot be enumerated' }); continue; }
  const c = callersOf(fn.name, { files, texts, lexed, excludes: spec.boundary.excludes, definedIn: { path: w.path, at: fn.at + 'function '.length } });
  for (const e of c.entries) { entries.push({ ...e, reaches: w.at }); discovered.push(e.path); }
}
const scopePaths = [...new Set(discovered)].sort();
results.push({ check: 'assignment-scope', ran: 'completed', path: 'src/**', inputs: treeDigest, observed: { method: 'lexed literal SQL over src/** for writes creating an active rev_assignment; each write\'s function and every call of it', discovered: scopePaths, writes: writes.map(({ at, op, fn, note }) => ({ path: at, op, function: fn, ...(note ? { note } : {}) })), entries, unresolved } });

// ---------------------------------------------------------------- enforcement (static, L1 only): the bound and the store's trigger
{
  const path = 'src/contexts/peer-review/service.ts';
  const t = texts.get(path) ?? '';
  const rules = texts.get('src/contracts/review-rules.ts') ?? '';
  const bound = Number(/export const REVIEWERS_PER_PROPOSAL\s*=\s*(\d+)/.exec(rules)?.[1] ?? NaN);
  const guard = /active\.length\s*>=\s*REVIEWERS_PER_PROPOSAL\s*\)\s*\{\s*reasons\.push\(\{\s*code:\s*'panel_full'/.test(t);
  const checked = /function assignReviewer\([^)]*\)[^{]*\{\s*const e = assignmentEligibility\(deps, proposalId, reviewerId\);\s*if \(!e\.ok\)/.test(t);
  results.push({ check: 'panel-full-guard', ran: 'completed', path: `${path}:assignmentEligibility`, inputs: sha256(`${t}\n${rules}`), observed: { guarded: guard && checked, bound, parts: { guard, checkedBeforeWrite: checked } } });
  const schema = texts.get('src/platform/schema.ts') ?? '';
  const trig = /CREATE TRIGGER rev_assignment_at_most_three BEFORE INSERT ON rev_assignment\s+WHEN NEW\.status <> 'revoked'\s+AND \(SELECT COUNT\(\*\) FROM rev_assignment a WHERE a\.proposal_id = NEW\.proposal_id AND a\.status <> 'revoked'\) >= 3/.test(schema);
  results.push({ check: 'store-bound-trigger', ran: 'completed', path: 'src/platform/schema.ts:rev_assignment_at_most_three', inputs: sha256(schema), observed: { guarded: trig, bound: trig ? 3 : null } });
}

// ---------------------------------------------------------------- cases: the real route; what executed, observed by V8
const session = new Session(); session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const norm = (x) => x.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
const root = norm(impl).replace(/\/$/, '');
/** Block coverage since the last call (taking it resets the counters): per implementation file, its ranges. */
async function blocks() {
  const { result } = await session.post('Profiler.takePreciseCoverage');
  const by = new Map();
  for (const s of result) {
    const u = norm(decodeURIComponent(s.url.replace(/^file:\/\/\/?/, '')));
    if (!u.startsWith(`${root}/`)) continue;
    by.set(u.slice(root.length + 1), s.functions.flatMap((f) => f.ranges));
  }
  return by;
}
/** Did the block holding a write execute? The innermost range containing its offset decides. */
const executedAt = (by, w) => {
  const ranges = (by.get(w.path.toLowerCase()) ?? []).filter((r) => r.startOffset <= w.offset && w.offset < r.endOffset);
  if (!ranges.length) return false;
  return ranges.reduce((a, b) => (b.endOffset - b.startOffset < a.endOffset - a.startOffset ? b : a)).count > 0;
};
const scenario = harnessRunner(impl);
const ROUTE = entries.find((e) => e.path.startsWith('HTTP POST'))?.path ?? 'HTTP POST /api/proposals/:id/assignments';
const active = (h, id) => h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND status <> 'revoked'`, id).n;
const assign = (h, w, id, r) => h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: r.id });
async function caseRun(check, body) {
  let reached = [];
  // only the ACT is measured: setup runs the same services, and what setup executed is not what the case reached
  const act = async (fn) => { await blocks(); const r = await fn(); const by = await blocks(); reached = writes.filter((w) => executedAt(by, w)).map((w) => w.at).sort(); return r; };
  try {
    const observed = await scenario((h) => body(h, act));
    results.push({ check, ran: 'completed', path: ROUTE, reached, inputs: treeDigest, observed });
  } catch (e) { results.push({ check, ran: 'error', path: ROUTE, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
}
/** n reviewers assigned through the implementation's own service, as the harness does. */
async function withAssigned(h, n) {
  const w = h.world(); const id = await h.eligible(w);
  const { assignReviewer } = await import(new URL(`file:///${join(impl, 'src/contexts/peer-review/service.ts').replace(/\\/g, '/')}`).href);
  for (const r of w.r.slice(0, n)) h.tx(() => assignReviewer(h.deps, w.officer.id, id, r.id));
  return { w, id };
}
await caseRun('first-assigned', async (h, act) => {
  const { w, id } = await withAssigned(h, 0);
  const r = await act(() => assign(h, w, id, w.r[0]));
  return { refused: r.status >= 400, activeAfter: active(h, id) };
});
await caseRun('third-assigned', async (h, act) => {
  const { w, id } = await withAssigned(h, 2);
  const r = await act(() => assign(h, w, id, w.r[2]));
  return { refused: r.status >= 400, activeAfter: active(h, id) };
});
await caseRun('fourth-refused', async (h, act) => {
  const { w, id } = await withAssigned(h, 3);
  const r = await act(() => assign(h, w, id, w.r[3]));
  return { refused: r.status >= 400, activeAfter: active(h, id), code: r.body?.error?.code ?? null };
});
await caseRun('full-after-acceptance-refused', async (h, act) => {
  const { w, id } = await withAssigned(h, 3);
  // the three accept: an accepted assignment is still active, and still counts
  const { acceptAssignment } = await import(new URL(`file:///${join(impl, 'src/contexts/peer-review/service.ts').replace(/\\/g, '/')}`).href);
  for (const rv of w.r.slice(0, 3)) { const a = h.one(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, id, rv.id).id; h.tx(() => acceptAssignment(h.deps, rv.id, a)); }
  const r = await act(() => assign(h, w, id, w.r[3]));
  return { refused: r.status >= 400, activeAfter: active(h, id), accepted: h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND status = 'accepted'`, id).n };
});
await caseRun('revoked-frees-a-place', async (h, act) => {
  const { w, id } = await withAssigned(h, 3);
  const a = h.one(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0].id).id;
  const rv = await h.post(`/api/assignments/${a}/revoke`, w.officer, { reason: 'rubric 036: free a place' });
  const r = await act(() => assign(h, w, id, w.r[3]));
  return { revoked: rv.status < 400, refused: r.status >= 400, activeAfter: active(h, id) };
});
await caseRun('concurrent-third-and-fourth', async (h, act) => {
  const { w, id } = await withAssigned(h, 2);
  // two officers' requests in flight at once, against one process and one store
  const rs = await act(() => Promise.all([assign(h, w, id, w.r[2]), assign(h, w, id, w.r[3])]));
  return { admitted: rs.filter((r) => r.status < 400).length, activeAfter: active(h, id) };
});
await session.post('Profiler.stopPreciseCoverage'); session.disconnect();

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix', database: 'SQLite (better-sqlite3), an isolated file per case; manual clock' },
  results: results.sort((a, b) => (`${a.check}\0${a.path}` < `${b.check}\0${b.path}` ? -1 : 1)),
};
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'at-most-three-reviewers', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'AssignmentValidity', kind: 'adl:business-rule' }] },
  implementation: { commit, tree },
  expectation: { statement: `AssignmentValidity: "${spec.claim.clause}"`, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static scope and guard checks over src/**; the real HTTP route driven through the implementation\'s app, with V8 precise coverage observing which write sites executed',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: scopePaths, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-rubric/3)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the route ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
