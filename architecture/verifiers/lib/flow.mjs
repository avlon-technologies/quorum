// Shared, lexical control-flow helpers for the claim verifiers (prompt 030). They read code shape; they never judge.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { excludedBy } from './scan.mjs';

/** The innermost `function NAME(` whose body contains offset, with its body range (code is the lexed text). */
export function enclosingFunction(code, offset) {
  let best = null;
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    let i = m.index + m[0].length; let depth = 1;
    while (i < code.length && depth) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++; }
    // a return-type annotation (`): { a: T } | U {`) has braces of its own: the body is the brace that ends its line
    if (/^\s*:/.test(code.slice(i, i + 40))) { const eol = /\{[ \t]*\r?\n/.exec(code.slice(i)); if (eol) i += eol.index; }
    while (i < code.length && code[i] !== '{') i++;
    const open = i; depth = 0;
    for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}') { depth--; if (!depth) break; } }
    if (open < offset && offset < i && (!best || open > best.open)) best = { name: m[1], open, close: i, at: m.index };
  }
  return best;
}

/** The body text before `offset`, with every nested block blanked: what runs unconditionally at the top level. */
export function topLevelBefore(code, fn, offset) {
  const body = code.slice(fn.open + 1, offset);
  let depth = 0; let top = '';
  for (const ch of body) { if (ch === '{') { depth++; top += ' '; continue; } if (ch === '}') { depth--; top += ' '; continue; } top += depth === 0 ? ch : ' '; }
  return { body, top };
}

/**
 * Every call of `fnName` in the files: an entry point. An HTTP route registration (h.command / h.query with url and
 * method) is named `HTTP METHOD url`, with the `access` it declares; a call the specification excludes is listed apart.
 */
export function callersOf(fnName, { files, texts, lexed, excludes, definedIn }) {
  const entries = []; const excluded = [];
  for (const path of files) {
    const { code: c, lineAt } = lexed.get(path);
    for (const m of c.matchAll(new RegExp(`\\b${fnName}\\s*\\(`, 'g'))) {
      if (/function\s+$/.test(c.slice(Math.max(0, m.index - 12), m.index))) continue;            // its definition
      if (/import\s*\{[^}]*$/.test(c.slice(Math.max(0, m.index - 200), m.index))) continue;       // an import list
      if (path === definedIn?.path && m.index === definedIn.at) continue;
      const site = { path: `${path}:${lineAt(m.index)}`, form: 'call', call: fnName };
      const x = excludedBy(excludes, site);
      if (x) { excluded.push({ ...site, because: x.what }); continue; }
      const raw = texts.get(path).slice(Math.max(0, m.index - 700), m.index);
      const before = c.slice(Math.max(0, m.index - 700), m.index);
      const url = [...raw.matchAll(/url:\s*'([^']+)'/g)].pop()?.[1];
      const method = [...raw.matchAll(/method:\s*'([A-Z]+)'/g)].pop()?.[1];
      const access = [...raw.matchAll(/access:\s*(\[[^\]]*\]|'[^']*')/g)].pop()?.[1] ?? null;
      const isRoute = !!(url && method && /h\.(command|query)\s*\(/.test(before));
      entries.push({
        path: isRoute ? `HTTP ${method} ${url}` : site.path, site: site.path, through: fnName,
        ...(isRoute ? { access: access?.startsWith('[') ? [...access.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : access ? access.replace(/'/g, '') : null } : {}),
      });
    }
  }
  return { entries, excluded };
}

/** Run one case in a fresh instance of the implementation's own test harness (isolated SQLite, manual clock). */
export function harnessRunner(impl) {
  const url = pathToFileURL(join(impl, 'tests', 'support', 'harness.ts')).href;
  return async (fn) => {
    const { Harness } = await import(url);
    const h = await Harness.create();
    try { return await fn(h); } finally { await h.close(); }
  };
}
