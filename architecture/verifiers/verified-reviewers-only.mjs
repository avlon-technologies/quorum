// Verifier for the claim `verified-reviewers-only` (continuum-claim-spec/0, prompt 029): BDL rule VerifiedReviewersOnly
// (#r-q012) — on AssignReviewer, when the assigned reviewer's ORCID status is not Verified, the assignment is not made.
//
// It OBSERVES and reports values; it judges nothing. Platform's claim-attestation evaluator decides every pass, the
// scope and the level. This module writes the continuum-verification/0 code level as UNVERIFIED (informational).
//
//   node verified-reviewers-only.mjs <declaration> <implementation> <result> <out> <commit> <tree> <attestation> <changeState>
//
//   scope        every write that makes a reviewer HOLD an assignment (INSERT INTO rev_assignment, or an UPDATE that
//                moves a status from not-held into held), the function each lies in, and every call of that function
//                in src/ — an HTTP route is named by its method and URL; a call the specification excludes is listed
//   cases        drive the real HTTP route through the implementation's app (Fastify inject, an isolated SQLite file)
//                with an unverified and a verified reviewer, and read the resulting rev_assignment state
//   enforcement  the guard sits on every path to the write: the write's function calls assignmentEligibility and
//                throws when it is not ok, at the top level of its body, before the write and with no return between
//   correspondence  the guard refuses when the ASSIGNED reviewer's orcid status is not 'verified', reading
//                idn_account.orcid_status, whose CHECK admits exactly the two values of BDL's OrcidStatus
//   outside the boundary (reported, never counted): what erasure does to a reviewer who holds an assignment
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceFiles, lex, sqlWrites, nonLiteralSql, excludedBy, sha256, lineOf } from './lib/scan.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const HELD = new Set(spec.scope.held);            // assignment statuses in which a reviewer holds it
const results = []; const unresolved = []; const excluded = []; const discovered = [];
const files = sourceFiles(impl, 'src');
const texts = new Map(files.map((f) => [f, readFileSync(join(impl, f), 'utf8')]));
const lexed = new Map(files.map((f) => [f, lex(texts.get(f))]));
const treeDigest = sha256(files.map((f) => `${f}\n${sha256(texts.get(f))}`).join('\n'));

// ---------------------------------------------------------------- the model's condition, from the business model at the baseline
const bdl = readFileSync(spec.scope.businessModel, 'utf8');
const ruleText = new RegExp(`rule\\s+\\w+\\s+#${spec.claim.element}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(bdl)?.[1] ?? '';
const modelCondition = /\bcondition\s+(.+)/.exec(ruleText)?.[1]?.trim() ?? null;

// ---------------------------------------------------------------- scope: the writes that make an assignment held
/** The innermost `function NAME(` whose body contains offset, with its body range. */
function enclosingFunction(code, offset) {
  let best = null;
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    // the body: the first `{` at paren depth 0 after the parameter list, matched to its `}`
    let i = m.index + m[0].length; let depth = 1;
    while (i < code.length && depth) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++; }
    while (i < code.length && code[i] !== '{') i++;
    const open = i; depth = 0;
    for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}') { depth--; if (!depth) break; } }
    if (open < offset && offset < i && (!best || open > best.open)) best = { name: m[1], open, close: i, at: m.index };
  }
  return best;
}
const writes = [];
for (const path of files) {
  const lx = lexed.get(path);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      if (w.table !== 'rev_assignment') continue;
      if (w.op === 'DELETE') continue;                                    // removing an assignment never makes one held
      if (w.op === 'INSERT' || w.op === 'REPLACE') { writes.push({ path, at, offset: lit.offset, op: w.op, statement: w.statement }); continue; }
      // UPDATE: in scope only when it can move a not-held status into a held one
      const stmt = lit.text.slice(w.at);
      const to = /SET\s+[^;]*?\bstatus\s*=\s*'(\w+)'/i.exec(stmt)?.[1] ?? null;
      if (!/\bstatus\s*=/.test(stmt.split(/\bWHERE\b/i)[0])) continue;   // does not set status
      if (to === null) { unresolved.push({ path: at, why: `UPDATE rev_assignment sets a computed status: ${w.statement}` }); continue; }
      if (!HELD.has(to)) continue;
      const where = stmt.split(/\bWHERE\b/i)[1] ?? '';
      const from = /\bstatus\s*=\s*'(\w+)'/.exec(where)?.[1] ? [/\bstatus\s*=\s*'(\w+)'/.exec(where)[1]] : /\bstatus\s+IN\s*\(([^)]*)\)/i.exec(where)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, '')) ?? null;
      if (!from || from.some((s) => s === '\u0000' || !/^\w+$/.test(s))) { writes.push({ path, at, offset: lit.offset, op: 'UPDATE', statement: w.statement, note: 'the prior status is not fixed by the statement' }); continue; }
      if (from.some((s) => !HELD.has(s))) writes.push({ path, at, offset: lit.offset, op: 'UPDATE', statement: w.statement, note: `moves ${from.filter((s) => !HELD.has(s)).join(', ')} into ${to}` });
    }
  }
  for (const s of nonLiteralSql(path, texts.get(path), lx)) if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` });
}
// each write's function, and every call of that function: an entry point into the write
const entries = [];
for (const w of writes) {
  const { code } = lexed.get(w.path);
  const fn = enclosingFunction(code, w.offset);
  w.fn = fn?.name ?? null;
  discovered.push(w.at);
  if (!fn) { unresolved.push({ path: w.at, why: 'the write lies in no named function, so its callers cannot be enumerated' }); continue; }
  for (const path of files) {
    const { code: c, lineAt } = lexed.get(path);
    for (const m of c.matchAll(new RegExp(`\\b${fn.name}\\s*\\(`, 'g'))) {
      if (path === w.path && m.index === code.indexOf(`function ${fn.name}`) + 'function '.length) continue;   // its definition
      if (/function\s+$/.test(c.slice(Math.max(0, m.index - 12), m.index))) continue;
      if (/import\s*\{[^}]*$/.test(c.slice(Math.max(0, m.index - 200), m.index)) && !c.slice(m.index - 200, m.index).includes('}')) continue;
      const site = { path: `${path}:${lineAt(m.index)}`, form: 'call', call: fn.name };
      const x = excludedBy(spec.boundary.excludes, site);
      if (x) { excluded.push({ ...site, because: x.what }); continue; }
      // an HTTP route: the nearest preceding url/method in the same registration
      const before = c.slice(Math.max(0, m.index - 600), m.index);
      const url = [...texts.get(path).slice(Math.max(0, m.index - 600), m.index).matchAll(/url:\s*'([^']+)'/g)].pop()?.[1];
      const method = [...texts.get(path).slice(Math.max(0, m.index - 600), m.index).matchAll(/method:\s*'([A-Z]+)'/g)].pop()?.[1];
      const name = url && method && /h\.(command|query)\s*\(/.test(before) ? `HTTP ${method} ${url}` : site.path;
      entries.push({ path: name, site: site.path, reaches: w.at, through: fn.name });
    }
  }
}
for (const e of entries) discovered.push(e.path);
const scopePaths = [...new Set(discovered)].sort();
results.push({ check: 'held-assignment-scope', ran: 'completed', path: 'src/**', inputs: treeDigest, observed: { method: 'lexed literal SQL over src/** for writes that make an assignment held; each write\'s function and every call of it', discovered: scopePaths, writes: writes.map(({ at, op, statement, fn, note }) => ({ path: at, op, statement, function: fn, ...(note ? { note } : {}) })), entries, unresolved, excluded } });

// ---------------------------------------------------------------- enforcement: the guard dominates every write
for (const w of writes) {
  const { code } = lexed.get(w.path);
  const fn = enclosingFunction(code, w.offset);
  if (!fn) continue;
  const body = code.slice(fn.open + 1, w.offset);
  // top-level statements only: depth 0 inside the body
  let depth = 0; let top = '';
  for (const ch of body) { if (ch === '{') { depth++; top += ' '; continue; } if (ch === '}') { depth--; top += ' '; continue; } top += depth === 0 ? ch : ' '; }
  const call = /const\s+(\w+)\s*=\s*assignmentEligibility\s*\(/.exec(body);
  const guardAt = call ? body.indexOf(`if (!${call[1]}.ok)`) : -1;
  const guardBlock = guardAt >= 0 ? body.slice(guardAt, body.indexOf('}', body.indexOf('throw', guardAt)) + 1) : '';
  const dominates = !!call && top.includes(`const ${call[1]} = assignmentEligibility`) && guardAt >= 0 && /\bthrow\b/.test(guardBlock) && !/\breturn\b/.test(top.slice(0, top.length));
  results.push({
    check: 'guard-dominates-writes', ran: 'completed', path: `${w.path}:${fn.name}`, inputs: sha256(texts.get(w.path)),
    observed: { dominates, constraint: 'assignmentEligibility', write: w.at, appliesTo: dominates ? scopePaths.filter((p) => p === w.at || entries.some((e) => e.path === p && e.reaches === w.at)) : [], detail: dominates ? `${fn.name} calls assignmentEligibility and throws when it is not ok, at the top level of its body, before ${w.at}, with no return between` : `${fn.name} does not show the guard on every path to ${w.at}` },
  });
}

// ---------------------------------------------------------------- correspondence: the guard implements the model's condition
{
  const path = 'src/contexts/peer-review/service.ts';
  const text = texts.get(path) ?? '';
  const { code } = lexed.get(path) ?? { code: '' };
  const start = code.indexOf('function assignmentEligibility(');
  // the function whose definition starts here: its body is the first top-level brace after the parameter list
  const fn = start >= 0 ? enclosingFunction(code, code.indexOf('{', code.indexOf(')', start)) + 1) : null;
  const src = fn ? text.slice(fn.at, fn.close + 1) : '';
  const params = /assignmentEligibility\s*\(([^)]*)\)/.exec(src)?.[1]?.split(',').map((p) => p.trim().split(':')[0].trim()) ?? [];
  const standingOf = /const\s+(\w+)\s*=\s*getReviewerStanding\s*\(\s*deps\s*,\s*(\w+)\s*\)/.exec(src);
  const subjectParam = standingOf?.[2] ?? null;
  // assignReviewer passes ITS reviewerId — the reviewer the INSERT records — as that parameter
  const assign = writes.find((w) => w.fn === 'assignReviewer');
  const call = /assignmentEligibility\s*\(\s*deps\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(text);
  const insertsReviewer = /INSERT INTO rev_assignment \(id, proposal_id, reviewer_id/.test(text) && /a\.reviewer_id/.test(text) && /reviewer_id:\s*reviewerId/.test(text);
  const subjectIsReviewer = !!(subjectParam && params.indexOf(subjectParam) === 2 && call && call[2] === 'reviewerId' && insertsReviewer && assign);
  const sv = standingOf?.[1];
  const guard = sv ? new RegExp(`if\\s*\\(\\s*!${sv}\\.exists\\s*\\|\\|\\s*!${sv}\\.isReviewer\\s*\\)\\s*\\{\\s*reasons\\.push\\([\\s\\S]*?\\}\\s*else\\s+if\\s*\\(\\s*${sv}\\.orcid\\s*!==\\s*'verified'\\s*\\)\\s*\\{\\s*reasons\\.push\\(`).exec(src) : null;
  const okOnlyWithoutReasons = /return\s*\{\s*ok:\s*reasons\.length\s*===\s*0/.test(src);
  const idn = texts.get('src/contexts/identity/service.ts') ?? '';
  const readsStatus = /function getReviewerStanding[\s\S]*?SELECT \* FROM idn_account WHERE id = \?[\s\S]*?orcid:\s*a\.orcid_status/.test(idn);
  const schema = texts.get('src/platform/schema.ts') ?? '';
  const domain = /orcid_status\s+TEXT NOT NULL DEFAULT 'unverified' CHECK \(orcid_status IN \('unverified','verified'\)\)/.test(schema);
  const refuses = !!guard && okOnlyWithoutReasons;
  results.push({
    check: 'guard-implements-condition', ran: 'completed', path: `${path}:assignmentEligibility`, inputs: sha256(`${text}\n${idn}\n${schema}`),
    observed: {
      modelCondition,
      conditionSubject: subjectIsReviewer ? 'reviewer' : 'other',
      refusesWhenConditionHolds: refuses && readsStatus && domain,
      guard: guard ? guard[0].replace(/\s+/g, ' ').slice(0, 200) : null,
      parts: { subjectIsReviewer, guardFound: !!guard, okOnlyWithoutReasons, readsStatus, domainIsExactlyTheEnum: domain },
      valueMapping: { Verified: 'verified', Unverified: 'unverified' },
    },
  });
}

// ---------------------------------------------------------------- cases: the real route, the resulting state
const harnessUrl = pathToFileURL(join(impl, 'tests', 'support', 'harness.ts')).href;
async function scenario(fn) {
  const { Harness } = await import(harnessUrl);
  const h = await Harness.create();
  try { return await fn(h); } finally { await h.close(); }
}
const held = (h, proposalId, reviewerId) => h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ? AND status IN (${[...HELD].map(() => '?').join(',')})`, proposalId, reviewerId, ...HELD).n > 0;
const route = entries.find((e) => e.path.startsWith('HTTP POST'))?.path ?? 'HTTP POST /api/proposals/:id/assignments';
const caseRun = async (check, body) => {
  // a case covers the entry it drove and the writes THAT entry reaches — never every discovered path (review 029)
  try { results.push({ check, ran: 'completed', path: route, covers: [...new Set(entries.filter((e) => e.path === route).map((e) => e.reaches))].sort(), inputs: treeDigest, observed: await scenario(body) }); }
  catch (e) { results.push({ check, ran: 'error', path: route, inputs: treeDigest, detail: String(e?.message ?? e).split('\n')[0] }); }
};
await caseRun('unverified-reviewer-refused', async (h) => {
  const w = h.world(); const id = await h.eligible(w);
  const before = h.one(`SELECT orcid_status s FROM idn_account WHERE id = ?`, w.unverified.id).s;
  const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.unverified.id });
  return { reviewerOrcidStatus: before, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, heldAfter: held(h, id, w.unverified.id) };
});
await caseRun('verified-reviewer-assigned', async (h) => {
  const w = h.world(); const id = await h.eligible(w);
  const before = h.one(`SELECT orcid_status s FROM idn_account WHERE id = ?`, w.r[0].id).s;
  const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[0].id });
  return { reviewerOrcidStatus: before, httpStatus: r.status, refused: r.status >= 400, code: r.body?.error?.code ?? null, heldAfter: held(h, id, w.r[0].id) };
});

// ---------------------------------------------------------------- outside the boundary: erasure of a reviewer who holds an assignment
const outOfBoundary = [];
try {
  outOfBoundary.push({ path: 'HTTP POST /api/operations/accounts/:id/erase', note: 'EraseAccount is not AssignReviewer, so it is outside r-q012\'s declared scope; reported against the Account lifecycle (sm-q002: Verified is terminal)', observed: await scenario(async (h) => {
    const w = h.world(); const id = await h.eligible(w);
    const a = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[0].id });
    const e = await h.post(`/api/operations/accounts/${w.r[0].id}/erase`, w.operator, { reason: 'attestation pilot: erasure of a reviewer holding an assignment' });
    return { assigned: a.status, erased: e.status, orcidStatusAfter: h.one(`SELECT orcid_status s FROM idn_account WHERE id = ?`, w.r[0].id).s, stillHeld: held(h, id, w.r[0].id) };
  }) });
} catch (e) { outOfBoundary.push({ path: 'HTTP POST /api/operations/accounts/:id/erase', note: 'could not be exercised', error: String(e?.message ?? e).split('\n')[0] }); }

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix', database: 'SQLite (better-sqlite3), an isolated file per case; manual clock' },
  results: results.sort((a, b) => (`${a.check}\0${a.path}` < `${b.check}\0${b.path}` ? -1 : 1)),
  outOfBoundary,
};
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'verified-reviewers-only', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: 'VerifiedReviewersOnly', kind: 'bdl:rule' }] },
  implementation: { commit, tree },
  expectation: { statement: 'On AssignReviewer, a reviewer whose ORCID status is not Verified is not assigned (BDL r-q012)', source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static scope and guard checks over src/**, and the real HTTP route driven through the implementation\'s app (see the attestation observation)',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: scopePaths, uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: 'informational claim attestation: the level is judged by the Host (continuum-claim-attestation/0)' },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: the route ran in-process against an isolated database, not a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
