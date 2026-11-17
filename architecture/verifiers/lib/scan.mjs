// The assessor's source scanner for the claim-attestation pilot (prompt 029). node: builtins only, so it runs under
// `continuum conformance report`'s verifier import guard. Deterministic: files and findings are sorted.
//
// It LEXES TypeScript/JavaScript just far enough to separate code from comments and literals: a SQL keyword inside a
// comment is not a statement, and a `.prepare(` inside a string is not a call. It is not a parser. What it cannot follow
// it reports as UNRESOLVED, never as absent.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Every *.ts / *.mjs / *.js file under dir, repository-relative with forward slashes, sorted. */
export function sourceFiles(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue; }
      if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(join(root, dir));
  return out.sort();
}

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * Lex one module. Returns { code, literals }: `code` is the text with every comment and every literal's CONTENT replaced
 * by spaces (newlines kept, so offsets and lines are unchanged); `literals` lists each string/template literal with its
 * offset, line and text (a template's `${…}` replaced by \u0000) and whether it holds an expression.
 */
export function lex(text) {
  const code = text.split('');
  const literals = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' '; };
  const lineAt = (() => { const starts = [0]; for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1); return (o) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= o) lo = m; else hi = m - 1; } return lo + 1; }; })();
  let i = 0; let prev = '';
  const n = text.length;
  function template(start) {
    // at text[start] === '`'; returns the index after the closing backtick
    let j = start + 1; let s = ''; let dynamic = false;
    while (j < n && text[j] !== '`') {
      if (text[j] === '\\') { s += text.slice(j, j + 2); j += 2; continue; }
      if (text[j] === '$' && text[j + 1] === '{') {
        dynamic = true; s += '\u0000';
        const end = expression(j + 2);
        j = end; continue;
      }
      s += text[j]; j++;
    }
    literals.push({ offset: start, line: lineAt(start), kind: 'template', text: s, dynamic });
    blank(start + 1, j);
    return j + 1;
  }
  function expression(j) {
    // inside ${ … }: until the matching }, honouring nested strings, templates and braces
    let depth = 1;
    while (j < n && depth > 0) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) return j + 1; }
      else if (c === '`') { j = template(j); continue; }
      else if (c === '"' || c === "'") { j = quoted(j); continue; }
      j++;
    }
    return j;
  }
  function quoted(start) {
    const q = text[start]; let j = start + 1; let s = '';
    while (j < n && text[j] !== q && text[j] !== '\n') { if (text[j] === '\\') { s += text.slice(j, j + 2); j += 2; continue; } s += text[j]; j++; }
    literals.push({ offset: start, line: lineAt(start), kind: 'string', text: s, dynamic: false });
    blank(start + 1, j);
    return j + 1;
  }
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") { i = quoted(i); prev = 'lit'; continue; }
    if (c === '`') { i = template(i); prev = 'lit'; continue; }
    if (c === '/' && (REGEX_PREV.has(prev) || /^(return|typeof|case|in|of|delete|void|throw)$/.test(prev))) {
      // a regex literal: skip to the closing slash, honouring classes and escapes
      let j = i + 1; let cls = false;
      while (j < n && text[j] !== '\n') { const d = text[j]; if (d === '\\') { j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++; }
      blank(i + 1, j); i = j + 1; while (i < n && /[a-z]/i.test(text[i])) i++; prev = 'lit'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$#]/.test(c)) { let j = i; while (j < n && /[\w$#]/.test(text[j])) j++; prev = text.slice(i, j); i = j; continue; }
    if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(text[i])) i++; prev = '0'; continue; }
    prev = c; i++;
  }
  return { code: code.join(''), literals, lineAt };
}

// ---------------------------------------------------------------- SQL writes inside literals

const WRITE = [
  { op: 'INSERT', re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\u0000|[A-Za-z_]\w*)/gi },
  { op: 'REPLACE', re: /\bREPLACE\s+INTO\s+(\u0000|[A-Za-z_]\w*)/gi },
  { op: 'UPDATE', re: /\bUPDATE\s+(?:OR\s+\w+\s+)?(\u0000|[A-Za-z_]\w*)\s+SET\b/gi },
  { op: 'DELETE', re: /\bDELETE\s+FROM\s+(\u0000|[A-Za-z_]\w*)/gi },
];
/** Every SQL write statement in one literal: { op, table | null (computed), offsetInLiteral, statement }. */
export function sqlWrites(lit) {
  const out = [];
  for (const { op, re } of WRITE) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(lit.text))) out.push({ op, table: m[1] === '\u0000' ? null : m[1].toLowerCase(), at: m.index, statement: lit.text.slice(m.index, m.index + 160).replace(/\s+/g, ' ').replace(/\u0000/g, '${…}').trim() });
  }
  return out.sort((a, b) => a.at - b.at);
}
const lineOf = (lit, at) => lit.line + (lit.text.slice(0, at).match(/\n/g)?.length ?? 0);

/**
 * The tables each store holds, from continuum/evidence.json: a Resource citing `schema.ts:a-b` holds every table whose
 * CREATE TABLE starts on a line in [a, b]. Returns { tableStore: Map, created: [{ table, line, path }] }.
 */
export function storesOf(root, evidence) {
  const tableStore = new Map(); const created = [];
  const ranges = [];
  for (const e of Object.values(evidence.elements ?? {})) {
    if (e.kind !== 'Resource') continue;
    for (const c of e.citations ?? []) {
      const m = /^(.+?):(\d+)-(\d+)$/.exec(String(typeof c === 'string' ? c : c.ref));
      if (m) ranges.push({ path: m[1], a: Number(m[2]), b: Number(m[3]), store: e.name });
    }
  }
  for (const path of [...new Set(ranges.map((r) => r.path))].sort()) {
    const text = readFileSync(join(root, path), 'utf8');
    const { literals } = lex(text);
    for (const lit of literals) {
      const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/gi; let m;
      while ((m = re.exec(lit.text))) {
        const line = lineOf(lit, m.index); const table = m[1].toLowerCase();
        created.push({ table, line, path });
        const r = ranges.find((x) => x.path === path && line >= x.a && line <= x.b);
        if (r) tableStore.set(table, r.store);
      }
    }
  }
  return { tableStore, created: created.sort((x, y) => x.line - y.line) };
}

/** Which Service each cited module realises: a Service's own citation, or that of an element nested inside it. */
export function servicesOf(evidence) {
  const services = Object.values(evidence.elements ?? {}).filter((e) => e.kind === 'Service').map((e) => e.name);
  const owner = (name) => services.filter((s) => name === s || name.startsWith(`${s}.`)).sort((a, b) => b.length - a.length)[0] ?? null;
  const byModule = new Map();
  for (const e of Object.values(evidence.elements ?? {})) {
    const svc = owner(e.name); if (!svc) continue;
    for (const c of e.citations ?? []) {
      const p = String(typeof c === 'string' ? c : c.ref).replace(/:\d+(-\d+)?$/, '');
      byModule.set(p, [...new Set([...(byModule.get(p) ?? []), svc])].sort());
    }
  }
  return byModule;
}

/**
 * Every place a module hands SQL that is NOT a literal to the database (`.prepare(x)`, `db.exec(x)`), resolved where the
 * scanner can show what x is, else unresolved. Two resolutions only:
 *   param   x is a parameter of a local arrow function `const f = (x…) =>`, and every call f(…) in the module passes a
 *           literal (all literals are scanned anyway)
 *   migrations  x is bound from MIGRATIONS[…], imported from the schema module (whose literals are scanned)
 */
export function nonLiteralSql(path, text, { code, lineAt }) {
  const out = [];
  const re = /([\w$#.]*)\.(prepare|exec)\s*\(\s*/g; let m;
  while ((m = re.exec(code))) {
    const receiver = m[1]; const method = m[2]; const argAt = m.index + m[0].length;
    if (method === 'exec' && !/(^|\.)#?db$/.test(receiver)) continue;   // RegExp.prototype.exec and friends are not SQL
    if (['"', "'", '`'].includes(text[argAt])) continue;                // a literal: scanned with the literals
    const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(argAt))?.[0] ?? null;
    const at = `${path}:${lineAt(m.index)}`;
    if (!id) { out.push({ path: at, form: `${receiver}.${method}(…)`, resolved: false, why: 'the SQL argument is an expression the scanner does not follow' }); continue; }
    const arrow = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(\\s*${id}\\b[^)]*\\)\\s*(?::[^=]+)?=>`).exec(code);
    if (arrow) {
      const fn = arrow[1];
      const calls = [...code.matchAll(new RegExp(`\\b${fn}\\s*\\(`, 'g'))].filter((c) => c.index !== arrow.index + arrow[0].indexOf(fn));
      const nonLiteral = calls.filter((c) => !['"', "'", '`'].includes(text[c.index + c[0].length]));
      if (calls.length && !nonLiteral.length) { out.push({ path: at, form: `${receiver}.${method}(${id})`, resolved: true, why: `${id} is the parameter of ${fn}, and all ${calls.length} call(s) of ${fn} pass a literal (scanned)` }); continue; }
    }
    if (new RegExp(`\\b${id}\\s*=\\s*MIGRATIONS\\s*\\[`).test(code) && /import\s*\{[^}]*\bMIGRATIONS\b[^}]*\}\s*from\s*['"]\.\/schema\.ts['"]/.test(text)) {
      out.push({ path: at, form: `${receiver}.${method}(${id})`, resolved: true, why: `${id} is an entry of MIGRATIONS from ./schema.ts, whose literals are scanned` }); continue;
    }
    out.push({ path: at, form: `${receiver}.${method}(${id})`, resolved: false, why: `the scanner cannot show what ${id} holds` });
  }
  return out;
}

/** File- and handle-level mechanisms that can change a database without a SQL statement. */
const MECHANISMS = [
  { form: 'fs-write', re: /\b(writeFileSync|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync|cpSync|createWriteStream|writeFile|rename|unlink|rm|copyFile)\s*\(/g },
  { form: 'sqlite-backup', re: /\.backup\s*\(/g },
  { form: 'sqlite-handle-extension', re: /\.(loadExtension|function|aggregate|table)\s*\(/g },
  { form: 'child-process', re: /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g },
];
export function mechanisms(path, { code, lineAt, literals }) {
  const out = [];
  for (const { form, re } of MECHANISMS) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(code))) {
      if (form === 'child-process' && /\.\s*$/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue;   // a method, e.g. re.exec(
      const lineText = code.split('\n')[lineAt(m.index) - 1].trim();
      out.push({ path: `${path}:${lineAt(m.index)}`, form, call: m[0].replace(/\s*\($/, ''), line: lineText.slice(0, 140) });
    }
  }
  for (const lit of literals) if (/\bATTACH\s+DATABASE\b/i.test(lit.text)) out.push({ path: `${path}:${lit.line}`, form: 'sqlite-attach', call: 'ATTACH DATABASE', line: lit.text.slice(0, 140) });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Does a declared exclusion match a site? An exclusion names an exact path prefix (file or file:line) and a form. */
export const excludedBy = (excludes, site) => (excludes ?? []).find((x) => (x.match ?? []).some((m) => (site.path === m.path || site.path.startsWith(`${m.path}:`)) && (!m.form || m.form === site.form) && (!m.call || m.call === site.call)));

export { lineOf };
