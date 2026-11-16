/**
 * A separate OS process with its OWN SQLite connection, used to race awards against the same
 * database file (INV-9). argv: mode dbFile dataDir clockIso startAtMs ...args
 *   mode=decision  args: chairId proposalId
 *   mode=commit    args: callId amountMinor
 * Prints one JSON line with the outcome.
 */
import { createDeps } from '../../src/app.ts';
import { ManualClock } from '../../src/platform/clock.ts';
import { CommittedRefusal } from '../../src/platform/http.ts';
import { recordDecision, commitAward } from '../../src/contexts/adjudication/service.ts';

const [mode, dbFile, dataDir, clockIso, startAt, a, b] = process.argv.slice(2) as string[];
const deps = createDeps({ dbFile, dataDir, clock: new ManualClock(clockIso) });

// barrier: all children start their write at (nearly) the same instant
while (Date.now() < Number(startAt)) {
  /* spin */
}

let out: unknown;
try {
  if (mode === 'decision') {
    const r = deps.db
      .transaction(() => recordDecision(deps, a!, b!, { outcome: 'award', rationale: 'Concurrent award attempt in a race test.' }))
      .immediate();
    out = r instanceof CommittedRefusal ? { outcome: 'refused', code: r.error.code, rule: r.error.rule } : { outcome: 'awarded' };
  } else {
    const r = commitAward(deps, a!, Number(b));
    out = { outcome: r.committed ? 'committed' : 'refused', remainingMinor: r.remainingMinor };
  }
} catch (e) {
  out = { outcome: 'error', message: e instanceof Error ? e.message : String(e) };
}
deps.bus.stop();
deps.db.close();
process.stdout.write(JSON.stringify(out) + '\n');
