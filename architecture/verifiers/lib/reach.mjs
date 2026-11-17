// What a case REACHED, observed by the runtime (rubric continuum-claim-rubric/3). V8 precise BLOCK coverage is taken
// around the act alone, so a case's setup — which runs the same services — is never counted as reached.
// node: builtins only.
//
// Reading V8's block ranges. Inside a function, V8 reports a range for each branch (an if's body, a `? :` arm) and, after
// a statement that can leave early (throw, return), a CONTINUATION: the count of everything that follows it. A
// continuation is recorded as a start position only and reported as ending where the next range begins, so code after
// that next range is no longer inside it, although its count still governs. Taking "the innermost range containing
// the offset" therefore over-reports: code that follows a `? :` after an early throw reads as executed when the
// function threw long before. `countAt` restores the count: within the innermost range, the last continuation that
// starts before the offset decides. A range is a continuation when it starts right after a statement or block ends
// (`;` or `}`), or when it starts at a branch but runs past that branch's own end (V8 merged the branch with the
// continuation that follows it, their counts being equal).
import { Session } from 'node:inspector/promises';

const norm = (x) => x.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** The offset just past the statement or block that starts at `start` (code: comments and literal contents blanked). */
function syntacticEnd(code, start) {
  let i = start; while (i < code.length && /\s/.test(code[i])) i++;
  let depth = 0;
  const block = code[i] === '{';
  for (; i < code.length; i++) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { depth--; if (depth < 0) return i; if (block && depth === 0) return i + 1; }
    else if (ch === ';' && depth === 0 && !block) return i + 1;
  }
  return code.length;
}
function isContinuation(code, r) {
  let p = r.startOffset - 1; while (p >= 0 && /\s/.test(code[p])) p--;
  if (p >= 0 && (code[p] === ';' || code[p] === '}')) return true;
  return r.endOffset > syntacticEnd(code, r.startOffset);
}
/** How many times the code at `offset` ran, from one function's ranges; null when no range holds the offset. */
export function countAt(ranges, offset, code) {
  const holding = ranges.filter((r) => r.startOffset <= offset && offset < r.endOffset);
  if (!holding.length) return null;
  const inner = holding.reduce((a, b) => (b.endOffset - b.startOffset < a.endOffset - a.startOffset ? b : a));
  let count = inner.count;
  const before = ranges.filter((r) => r !== inner && inner.startOffset <= r.startOffset && r.endOffset <= offset && r.endOffset <= inner.endOffset).sort((a, b) => a.startOffset - b.startOffset);
  for (const r of before) if (isContinuation(code, r)) count = r.count;
  return count;
}

/**
 * Start precise coverage for the implementation at `impl`; `codeOf(path)` gives a file's lexed code. Returns
 * { act, stop }. A site is { path, offset, at } and may carry `within: [start, end]` — the span of a call's arguments:
 * such a site is also reached when a function literal written inside that span ran, since only the handler the call
 * built can have invoked it (a handler built by a factory call, `Event: factory(…, () => …)`, runs no code at the call).
 */
export async function reachObserver(impl, codeOf) {
  const session = new Session(); session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const root = norm(impl).replace(/\/$/, '');
  /** Coverage since the last call (taking it resets the counters): per implementation file, its functions' ranges. */
  async function taken() {
    const { result } = await session.post('Profiler.takePreciseCoverage');
    const by = new Map();
    for (const s of result) {
      const u = norm(decodeURIComponent(s.url.replace(/^file:\/\/\/?/, '')));
      if (!u.startsWith(`${root}/`)) continue;
      by.set(u.slice(root.length + 1), s.functions.map((f) => f.ranges));
    }
    return by;
  }
  const ran = (by, site) => {
    const fns = by.get(site.path.toLowerCase()) ?? [];
    const code = codeOf(site.path);
    // the innermost function holding the site decides
    const holding = fns.filter((r) => r[0].startOffset <= site.offset && site.offset < r[0].endOffset);
    if (holding.length) {
      const fn = holding.reduce((a, b) => (b[0].endOffset - b[0].startOffset < a[0].endOffset - a[0].startOffset ? b : a));
      if ((countAt(fn, site.offset, code) ?? 0) > 0) return true;
    }
    if (site.within) return fns.some((r) => site.within[0] <= r[0].startOffset && r[0].endOffset <= site.within[1] && r[0].count > 0);
    return false;
  };
  return {
    /** Run `fn` as the act; returns { value, reached }: the `at` of every site that ran during it. */
    async act(fn, sites) {
      await taken();
      const value = await fn();
      const by = await taken();
      return { value, reached: [...new Set(sites.filter((s) => ran(by, s)).map((s) => s.at))].sort() };
    },
    async stop() { await session.post('Profiler.stopPreciseCoverage'); session.disconnect(); },
  };
}
