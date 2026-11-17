// Verifier for the claim `orcid-verification-lifecycle` (continuum-claim-spec/0, rubric continuum-claim-rubric/3; first
// written for prompt 030, 2.0.0 for ADR-023): BDL
// state model OrcidVerification (#sm-q002) on Account.orcidStatus — its declared transitions (Verify: Unverified →
// Verified by VerifyOrcid; ClearOnErasure: Verified → Unverified by EraseAccount) are the complete set of permitted
// changes of the field (BDL §5.8 R-07). Separate from VerifiedReviewersOnly (r-q012), judged at AssignReviewer only.
//
// The evaluator judges a transition by its states. Which act realizes it is observed here, per write and per route:
// the restriction that only erasure sets Unverified, and that verification never leaves Verified, is reported as
// values (function, entry points, prior value, persisted states) for the Host's `equals` criteria.
//
// It OBSERVES and reports values; Platform's evaluator maps the stored values to states and decides.
//
//   scope        every literal SQL write that sets idn_account.orcid_status (an UPDATE that sets it, an INSERT that
//                lists it), the function it lies in, and every call of that function (routes named); a creation site
//                reached only from excluded callers is excluded; non-literal SQL must resolve
//   structural   per write: the prior value its WHERE fixes (or none: any), and the value it sets
//   trigger      per write: the function holding it and its entry points (who may cause the transition)
//   cases        the real erasure route on a Verified reviewer who holds an assignment, and again on the account
//                already erased; the real verification route on an Unverified reviewer (a registered iD, and one the
//                registry does not know) and on a Verified one (other iD, unknown iD, own iD) — the persisted states
//                read back. Every case reports `reached`: the in-scope writes whose block V8's precise coverage saw
//                execute during the act alone (setup excluded) — observed by the runtime, never declared here
//   outside the levels (reported, never counted): whether the store itself refuses an undeclared change
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, sha256, lineOf } from './lib/scan.mjs';
import { enclosingFunction, callersOf, harnessRunner } from './lib/flow.mjs';
import { reachObserver } from './lib/reach.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const TABLE = spec.scope.table; const COLUMN = spec.scope.column;
const HELD = new Set(spec.scope.held);
const results = []; const unresolved = []; const excluded = [];
const files = sourceFiles(impl, 'src');
const texts = new Map(files.map((f) => [f, readFileSync(join(impl, f), 'utf8')]));
const lexed = new Map(files.map((f) => [f, lex(texts.get(f))]));
const treeDigest = sha256(files.map((f) => `${f}\n${sha256(texts.get(f))}`).join('\n'));

// ---------------------------------------------------------------- scope
const sites = [];
for (const path of files) {
  const lx = lexed.get(path);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      if (w.table !== TABLE) continue;
      const stmt = lit.text.slice(w.at);
      const [head, where = ''] = stmt.split(/\bWHERE\b/i);
      if (w.op === 'UPDATE') {
        if (!new RegExp(`\\b${COLUMN}\\s*=`, 'i').test(head)) continue;
        const to = new RegExp(`\\b${COLUMN}\\s*=\\s*'(\\w+)'`, 'i').exec(head)?.[1] ?? null;
        const from = new RegExp(`\\b${COLUMN}\\s*=\\s*'(\\w+)'`, 'i').exec(where)?.[1] ?? null;
        if (to === null) { unresolved.push({ path: at, why: `UPDATE ${TABLE} sets ${COLUMN} from a parameter: ${w.statement}` }); continue; }
        sites.push({ path, at, offset: lit.offset, op: 'UPDATE', observed: { from, to, creates: false } });
      } else if (w.op === 'INSERT' || w.op === 'REPLACE') {
        if (!new RegExp(`\\b${COLUMN}\\b`).test(head.split(/\bVALUES\b/i)[0])) continue;   // the column default applies
        sites.push({ path, at, offset: lit.offset, op: w.op, observed: { creates: true, to: null } });
      }
    }
  }
  for (const s of nonLiteralSql(path, texts.get(path), lx)) if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` });
}
const entries = [];
for (const s of sites) {
  const fn = enclosingFunction(lexed.get(s.path).code, s.offset);
  s.fn = fn?.name ?? null;
  if (!fn) { unresolved.push({ path: s.at, why: 'the write lies in no named function' }); continue; }
  const r = callersOf(fn.name, { files, texts, lexed, excludes: spec.boundary.excludes, definedIn: { path: s.path, at: fn.at } });
  s.entries = r.entries; s.excludedCallers = r.excluded;
  excluded.push(...r.excluded);
  for (const e of r.entries) entries.push({ ...e, reaches: s.at });
}
// a site every caller of which is excluded never runs in the deployable: excluded with the callers named
const inScope = sites.filter((s) => s.fn && (s.entries.length || !s.excludedCallers.length));
for (const s of sites.filter((x) => x.fn && !inScope.includes(x))) excluded.push({ path: s.at, form: 'write', because: `every call of ${s.fn} is excluded: ${s.excludedCallers.map((c) => c.path).join(', ')}` });
// a creation whose value is computed cannot be mapped to a state: unresolved
for (const s of inScope.filter((x) => x.observed.creates)) unresolved.push({ path: s.at, why: `a new ${TABLE} row's ${COLUMN} is computed at the call` });
const discovered = [...new Set([...inScope.map((s) => s.at), ...entries.filter((e) => inScope.some((s) => s.at === e.reaches)).map((e) => e.path)])].sort();
results.push({ check: 'status-write-scope', ran: 'completed', path: 'src/**', inputs: treeDigest, observed: {
  method: `lexed literal SQL over src/** for writes that set ${TABLE}.${COLUMN}; each write's function and every call of it`,
  discovered, sites: sites.map(({ at, op, fn, observed }) => ({ path: at, op, function: fn, ...observed })), entries, unresolved, excluded,
} });

// ---------------------------------------------------------------- structural: each write's transition, as the code states it
for (const s of inScope.filter((x) => !x.observed.creates)) {
  results.push({ check: 'write-admitted', ran: 'completed', path: s.at, inputs: sha256(texts.get(s.path)), observed: { ...s.observed, function: s.fn } });
}

// ---------------------------------------------------------------- trigger: which act each state-setting write realizes
// Every in-scope write that sets a state is reported under the check for that state, whatever function it lies in, so a
// write setting Unverified outside erasure (or Verified outside verification) is judged — and fails — rather than skipped.
for (const s of inScope.filter((x) => !x.observed.creates)) {
  const entryPoints = [...new Set(s.entries.map((e) => e.path))].sort();
  const observed = { function: s.fn, entryPoints, from: s.observed.from, to: s.observed.to };
  const check = s.observed.to === 'unverified' ? 'unverified-set-only-by-erasure' : s.observed.to === 'verified' ? 'verified-set-only-by-verification' : null;
  if (check) results.push({ check, ran: 'completed', path: s.at, inputs: sha256(texts.get(s.path)), observed });
}

// ---------------------------------------------------------------- reported, not judged: does the store itself keep the field closed?
const schema = texts.get('src/platform/schema.ts') ?? '';
const trigger = new RegExp(`CREATE TRIGGER[\\s\\S]*?(?:UPDATE OF ${COLUMN}|UPDATE)[\\s\\S]*?ON ${TABLE}[\\s\\S]*?RAISE`, 'i').exec(schema);
const storeConstraint = { path: 'src/platform/schema.ts', present: !!trigger, constraint: trigger ? trigger[0].slice(0, 160) : null, note: trigger ? 'a database trigger refuses undeclared changes' : `no constraint in the schema refuses an undeclared change of ${TABLE}.${COLUMN}: the closure rests on the application's writes, each checked here` };

// ---------------------------------------------------------------- cases: the real routes, the persisted states
const scenario = harnessRunner(impl);
const status = (h, id) => h.one(`SELECT ${COLUMN} s FROM ${TABLE} WHERE id = ?`, id).s;
const heldBy = (h, id) => h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE reviewer_id = ? AND status IN (${[...HELD].map(() => '?').join(',')})`, id, ...HELD).n;
const roles = (h, id) => h.one(`SELECT COUNT(*) n FROM idn_role_grant WHERE account_id = ?`, id).n;
const observer = await reachObserver(impl, (path) => lexed.get(path).code);
// one run of a case may be judged by several checks (each its own criterion over the same observed values)
const caseRun = async (checks, route, body) => {
  const ids = [checks].flat();
  let reached = [];
  // only the ACT is measured — the request and the delivery of the events it published — never the setup
  const act = async (h, fn) => { const r = await observer.act(async () => { const v = await fn(); await h.settle(); return v; }, inScope); reached = r.reached; return r.value; };
  try { const observed = await scenario((h) => body(h, (fn) => act(h, fn))); for (const check of ids) results.push({ check, ran: 'completed', path: route, reached, inputs: treeDigest, observed }); }
  catch (e) { for (const check of ids) results.push({ check, ran: 'error', path: route, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
};
const ERASE = entries.find((e) => /erase/.test(e.path))?.path ?? 'HTTP POST /api/operations/accounts/:id/erase';
const VERIFY = entries.find((e) => /orcid/.test(e.path))?.path ?? 'HTTP POST /api/me/orcid';
const eraseUrl = (id) => ERASE.replace(/^HTTP POST /, '').replace(':id', id);
const verifyUrl = VERIFY.replace(/^HTTP POST /, '');
const REGISTERED = '0000-0002-1825-0097'; const NOT_REGISTERED = '0000-0003-1415-9269';   // the stub registry has no record of the second
await caseRun(['verified-reviewer-erased', 'erasure-clears-verification'], ERASE, async (h, act) => {
  const w = h.world(); const id = await h.eligible(w);
  const a = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[0].id });
  await h.settle();
  const before = { orcidStatus: status(h, w.r[0].id), heldAssignments: heldBy(h, w.r[0].id), roleGrants: roles(h, w.r[0].id) };
  const e = await act(() => h.post(eraseUrl(w.r[0].id), w.operator, { reason: 'attestation pilot: erasure of a verified reviewer holding an assignment' }));
  const after = { orcidStatus: status(h, w.r[0].id), heldAssignments: heldBy(h, w.r[0].id), roleGrants: roles(h, w.r[0].id) };
  return { assignedHttpStatus: a.status, erasedHttpStatus: e.status, before, after, from: before.orcidStatus, to: after.orcidStatus, heldAssignmentsAfter: after.heldAssignments };
});
// the edge of ClearOnErasure: the account is already erased, so there is nothing left to clear
await caseRun('erased-again-no-change', ERASE, async (h, act) => {
  const w = h.world();
  const first = await h.post(eraseUrl(w.r[0].id), w.operator, { reason: 'attestation pilot: first erasure' });
  await h.settle();
  const from = status(h, w.r[0].id);
  const e = await act(() => h.post(eraseUrl(w.r[0].id), w.operator, { reason: 'attestation pilot: erasure of an erased account' }));
  return { firstHttpStatus: first.status, httpStatus: e.status, erasedAgain: e.body?.erased ?? null, from, to: status(h, w.r[0].id) };
});
await caseRun('unverified-reviewer-verifies', VERIFY, async (h, act) => {
  const w = h.world();
  const before = status(h, w.unverified.id);
  const r = await act(() => h.post(verifyUrl, w.unverified, { orcidId: REGISTERED }));
  return { httpStatus: r.status, code: r.body?.error?.code ?? null, from: before, to: status(h, w.unverified.id) };
});
// the edge of Verify: verification is attempted and not achieved, so no transition is taken
await caseRun('unregistered-id-stays-unverified', VERIFY, async (h, act) => {
  const w = h.world();
  const before = status(h, w.unverified.id);
  const published = () => h.one(`SELECT COUNT(*) n FROM evt_outbox WHERE type = 'OrcidVerified'`).n;
  const published0 = published();
  const r = await act(() => h.post(verifyUrl, w.unverified, { orcidId: NOT_REGISTERED }));
  return { httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, from: before, to: status(h, w.unverified.id), orcidVerifiedPublished: published() - published0 };
});
await caseRun('verification-never-leaves-verified', VERIFY, async (h, act) => {
  const w = h.world(); const r = w.r[0];
  const from = status(h, r.id);
  const own = h.one(`SELECT orcid_id o FROM ${TABLE} WHERE id = ?`, r.id).o;
  const published = () => h.one(`SELECT COUNT(*) n FROM evt_outbox WHERE type = 'OrcidVerified'`).n;
  const published0 = published();
  const o = await act(async () => {
    const other = await h.post(verifyUrl, r, { orcidId: REGISTERED }); const afterOtherId = status(h, r.id);
    const unknown = await h.post(verifyUrl, r, { orcidId: NOT_REGISTERED }); const afterUnknownId = status(h, r.id);
    const same = await h.post(verifyUrl, r, { orcidId: own }); const afterSameId = status(h, r.id);
    return { other, unknown, same, afterOtherId, afterUnknownId, afterSameId };
  });
  return {
    from, to: o.afterSameId, afterOtherId: o.afterOtherId, afterUnknownId: o.afterUnknownId, afterSameId: o.afterSameId,
    otherIdHttpStatus: o.other.status, otherIdCode: o.other.body?.error?.code ?? null,
    unknownIdHttpStatus: o.unknown.status, unknownIdCode: o.unknown.body?.error?.code ?? null,
    sameIdHttpStatus: o.same.status, orcidVerifiedPublished: published() - published0,
  };
});
await observer.stop();

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix', database: 'SQLite (better-sqlite3), an isolated file per case; manual clock; stub ORCID registry' },
  results: results.sort((a, b) => (`${a.check}\0${a.path}` < `${b.check}\0${b.path}` ? -1 : 1)),
  outOfBoundary: [{ ...storeConstraint, note: `reported only, never counted: ${storeConstraint.note}` }],
};
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'orcid-verification-lifecycle', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'OrcidVerification', kind: 'bdl:state-model' }] },
  implementation: { commit, tree },
  expectation: { statement: decl.expectation, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static enumeration of the field\'s writes; the real routes driven through the implementation\'s app, with V8 precise coverage observing which writes executed',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: discovered, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-rubric/3)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the routes ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
