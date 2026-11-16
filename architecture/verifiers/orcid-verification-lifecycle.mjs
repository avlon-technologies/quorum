// Verifier for the claim `orcid-verification-lifecycle` (continuum-claim-spec/0, prompt 030): BDL state model
// OrcidVerification (#sm-q002) on Account.orcidStatus — its declared transitions (Verify: Unverified → Verified) are the
// complete set of permitted changes of the field (BDL §5.8 R-07). Separate from VerifiedReviewersOnly (r-q012), which
// is judged at AssignReviewer only.
//
// It OBSERVES and reports values; Platform's evaluator maps the stored values to states and decides.
//
//   scope        every literal SQL write that sets idn_account.orcid_status (an UPDATE that sets it, an INSERT that
//                lists it), the function it lies in, and every call of that function (routes named); a creation site
//                reached only from excluded callers is excluded; non-literal SQL must resolve
//   structural   per write: the prior value its WHERE fixes (or none: any), and the value it sets
//   cases        the real erasure route on a Verified reviewer who holds an assignment, and the real verification
//                route on an Unverified reviewer — the persisted before/after states read back
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, sha256, lineOf } from './lib/scan.mjs';
import { enclosingFunction, callersOf, harnessRunner } from './lib/flow.mjs';

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

// ---------------------------------------------------------------- enforcement: is there a constraint that keeps the field closed?
{
  const schema = texts.get('src/platform/schema.ts') ?? '';
  const trigger = new RegExp(`CREATE TRIGGER[\\s\\S]*?(?:UPDATE OF ${COLUMN}|UPDATE)[\\s\\S]*?ON ${TABLE}[\\s\\S]*?RAISE`, 'i').exec(schema);
  results.push({ check: 'closure-constraint', ran: 'completed', path: 'src/platform/schema.ts', inputs: sha256(schema), observed: { dominates: !!trigger, appliesTo: trigger ? discovered : [], constraint: trigger ? trigger[0].slice(0, 160) : null, detail: trigger ? 'a database trigger refuses undeclared changes' : `no constraint in the schema refuses an undeclared change of ${TABLE}.${COLUMN}; each write is on its own` } });
}

// ---------------------------------------------------------------- cases: the real routes, the persisted states
const scenario = harnessRunner(impl);
const status = (h, id) => h.one(`SELECT ${COLUMN} s FROM ${TABLE} WHERE id = ?`, id).s;
const heldBy = (h, id) => h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE reviewer_id = ? AND status IN (${[...HELD].map(() => '?').join(',')})`, id, ...HELD).n;
const roles = (h, id) => h.one(`SELECT COUNT(*) n FROM idn_role_grant WHERE account_id = ?`, id).n;
const covering = (route) => [...new Set(entries.filter((e) => e.path === route).map((e) => e.reaches))].sort();
const caseRun = async (check, route, body) => {
  try { results.push({ check, ran: 'completed', path: route, covers: covering(route), inputs: treeDigest, observed: await scenario(body) }); }
  catch (e) { results.push({ check, ran: 'error', path: route, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
};
const ERASE = entries.find((e) => /erase/.test(e.path))?.path ?? 'HTTP POST /api/operations/accounts/:id/erase';
const VERIFY = entries.find((e) => /orcid/.test(e.path))?.path ?? 'HTTP POST /api/me/orcid';
await caseRun('verified-reviewer-erased', ERASE, async (h) => {
  const w = h.world(); const id = await h.eligible(w);
  const a = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[0].id });
  await h.settle();
  const before = { orcidStatus: status(h, w.r[0].id), heldAssignments: heldBy(h, w.r[0].id), roleGrants: roles(h, w.r[0].id) };
  const e = await h.post(ERASE.replace(/^HTTP POST /, '').replace(':id', w.r[0].id), w.operator, { reason: 'attestation pilot: erasure of a verified reviewer holding an assignment' });
  await h.settle();
  const after = { orcidStatus: status(h, w.r[0].id), heldAssignments: heldBy(h, w.r[0].id), roleGrants: roles(h, w.r[0].id) };
  return { assignedHttpStatus: a.status, erasedHttpStatus: e.status, before, after, from: before.orcidStatus, to: after.orcidStatus };
});
await caseRun('unverified-reviewer-verifies', VERIFY, async (h) => {
  const w = h.world();
  const before = status(h, w.unverified.id);
  const r = await h.post(VERIFY.replace(/^HTTP POST /, ''), w.unverified, { orcidId: '0000-0002-1825-0097' });
  await h.settle();
  return { httpStatus: r.status, code: r.body?.error?.code ?? null, from: before, to: status(h, w.unverified.id) };
});

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix', database: 'SQLite (better-sqlite3), an isolated file per case; manual clock; stub ORCID registry' },
  results: results.sort((a, b) => (`${a.check}\0${a.path}` < `${b.check}\0${b.path}` ? -1 : 1)),
};
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'orcid-verification-lifecycle', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'OrcidVerification', kind: 'bdl:state-model' }] },
  implementation: { commit, tree },
  expectation: { statement: decl.expectation, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static enumeration of the field\'s writes, and the real routes driven through the implementation\'s app (see the attestation observation)',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: discovered, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-attestation/0)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the routes ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
