// Verifier for the claim `reviewstore-writers` (continuum-claim-spec/0, prompt 029): who writes ReviewStore?
//
// It OBSERVES and reports values; it judges nothing. Platform's claim-attestation evaluator decides, from the
// specification's criteria and these values, which sites pass, whether the scope is established and which level is
// earned. This module awards no level and writes the continuum-verification/0 code level as UNVERIFIED (informational).
//
//   node reviewstore-writers.mjs <declaration> <implementation> <result> <out> <commit> <tree> <attestation> <changeState>
//
// Method:
//   1. stores    continuum/evidence.json at the commit: each Resource's schema citation range → the tables it holds
//   2. writers   continuum/evidence.json: each module → the Service(s) its citations realise
//   3. writes    every SQL write statement in every string/template literal of every module under src/ (lexed, so
//                comments are not statements), its table resolved to a store
//   4. channels  every non-literal SQL argument (.prepare(x), db.exec(x)), resolved or reported unresolved;
//                every file/handle mechanism (fs writes, backup, ATTACH, child processes), excluded by the
//                specification with its reason, or reported unresolved
// The in-scope paths are the write sites whose table belongs to the claimed store.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFiles, lex, sqlWrites, storesOf, servicesOf, nonLiteralSql, mechanisms, excludedBy, sha256, lineOf } from './lib/scan.mjs';

const [declPath, impl, resultFile, , commit, tree, attestation, changeState] = process.argv.slice(2);
const decl = JSON.parse(readFileSync(declPath, 'utf8'));
const spec = decl.attestation;
const STORE = spec.claimName;                    // the qualified name the specification expects (the model says which writers)
const PREFIX = spec.scope.conventionPrefix;      // the documented table prefix of the store's context (cross-check only)
const evidence = JSON.parse(readFileSync(join(impl, 'continuum', 'evidence.json'), 'utf8'));
const { tableStore, created } = storesOf(impl, evidence);
const moduleServices = servicesOf(evidence);
const storeTables = [...tableStore].filter(([, s]) => s === STORE).map(([t]) => t).sort();

const results = []; const discovered = []; const unresolved = []; const excluded = []; const channels = [];
// a table of the context's prefix that no store citation covers could belong to the claimed store: unresolved
for (const c of created) if (c.table.startsWith(PREFIX) && !tableStore.has(c.table)) unresolved.push({ path: `${c.path}:${c.line}`, why: `table ${c.table} has the ${PREFIX}* prefix but no store's evidence citation covers it` });

const files = sourceFiles(impl, 'src');
for (const path of files) {
  const text = readFileSync(join(impl, path), 'utf8');
  const lx = lex(text);
  const digest = sha256(text);
  for (const lit of lx.literals) {
    for (const w of sqlWrites(lit)) {
      const at = `${path}:${lineOf(lit, w.at)}`;
      if (w.table === null) { unresolved.push({ path: at, why: `${w.op} with a computed table name: ${w.statement}` }); continue; }
      const store = tableStore.get(w.table) ?? null;
      if (store !== STORE) continue;
      discovered.push({ path: at, op: w.op, table: w.table });
      const svcs = moduleServices.get(path) ?? [];
      results.push({
        check: 'writer-declared', ran: 'completed', path: at, inputs: digest,
        observed: { store, table: w.table, op: w.op, statement: w.statement, module: path, ...(svcs.length === 1 ? { writer: { service: svcs[0] } } : {}), citedServices: svcs },
        detail: svcs.length === 1 ? `cited for ${svcs[0]}` : svcs.length ? `cited for several Services (${svcs.join(', ')}), so the writer is none of them in particular` : 'cited for no Service',
      });
    }
  }
  for (const s of nonLiteralSql(path, text, lx)) { channels.push(s); if (!s.resolved) unresolved.push({ path: s.path, why: `${s.form}: ${s.why}` }); }
  for (const m of mechanisms(path, lx)) {
    const x = excludedBy(spec.boundary.excludes, m);
    if (x) excluded.push({ path: m.path, form: m.form, call: m.call, because: x.what }); else unresolved.push({ path: m.path, why: `${m.form} ${m.call}: not excluded by the specification and not shown not to write the database — ${m.line}` });
  }
}
discovered.sort((a, b) => (a.path < b.path ? -1 : 1));
results.push({
  check: 'write-scope', ran: 'completed', path: 'src/**',
  inputs: sha256(files.map((f) => `${f}\n${sha256(readFileSync(join(impl, f)))}`).join('\n')),
  observed: { method: 'lexed literal SQL + non-literal SQL channels + file/handle mechanisms over src/**', files: files.length, storeTables, discovered: discovered.map((d) => d.path), sites: discovered, unresolved, excluded, channels },
});

const observation = {
  profile: 'continuum-claim-observation/0',
  spec: { id: spec.id, version: spec.version },
  boundTo: { commit, tree, attestation, spec: { id: spec.id, version: spec.version } },
  environment: { node: process.version, platform: process.platform === 'win32' ? 'win32' : 'posix' },
  results,
};
const established = unresolved.length === 0;
writeFileSync(resultFile, `${JSON.stringify({
  profile: 'continuum-verification-result/0',
  verifier: { name: 'reviewstore-writers', version: spec.version, digest: sha256(readFileSync(new URL(import.meta.url))) },
  model: { attestation, changeState, elements: [{ id: spec.claim.element, name: STORE, kind: 'Resource' }] },
  implementation: { commit, tree },
  expectation: { statement: `${STORE} is written only by the Service(s) the model declares as its writers`, source: `continuum-claim-spec/0 ${spec.id}@${spec.version}` },
  method: 'static enumeration of every write channel under src/ (see the attestation observation)',
  evidence: [{ ref: 'observation: attestation.results' }],
  coverage: { executed: results.length, covered: discovered.map((d) => d.path), uncovered: unresolved.map((u) => u.path) },
  levels: {
    code: { outcome: 'UNVERIFIED', reason: `informational claim attestation: the level is judged by the Host (continuum-claim-attestation/0); ${discovered.length} write site(s) observed, ${unresolved.length} unresolved channel(s)${established ? '' : ''}` },
    deployment: { outcome: 'UNVERIFIED', reason: 'not assessed: a static scan of the commit says nothing about a deployment' },
  },
  attestation: observation,
}, null, 2)}\n`);
