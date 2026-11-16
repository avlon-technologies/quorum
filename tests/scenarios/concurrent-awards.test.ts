import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '../support/harness.ts';

const CHILD = fileURLToPath(new URL('../support/award-child.ts', import.meta.url));

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

function race(h: Harness, mode: 'decision' | 'commit', argSets: Array<[string, string]>): Promise<any[]> {
  const startAt = Date.now() + 1500;
  return Promise.all(
    argSets.map(
      ([a, b]) =>
        new Promise<any>((resolve, reject) => {
          const p = spawn(process.execPath, [CHILD, mode, h.dbFile, h.dir, h.clock.now().toISOString(), String(startAt), a, b], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (err += d));
          p.on('exit', (code) => {
            const line = out.trim().split('\n').pop();
            if (code !== 0 || !line) return reject(new Error(`child exited ${code}: ${err}`));
            resolve(JSON.parse(line));
          });
        }),
    ),
  );
}

describe('Concurrent awards near the budget limit (INV-9), separate processes and connections', () => {
  it('ten processes commit 40,000 each against a 300,000 envelope: exactly seven succeed, never over the envelope', async () => {
    const w = h.world({ envelope: 300_000, maxRequest: 150_000 });
    await h.settle();
    const results = await race(h, 'commit', Array.from({ length: 10 }, () => [w.callId, String(4_000_000)] as [string, string]));
    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);
    expect(results.filter((r) => r.outcome === 'committed')).toHaveLength(7);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(3);
    const b = h.one(`SELECT envelope_minor, committed_minor FROM adj_budget WHERE call_id = ?`, w.callId);
    expect(b.committed_minor).toBe(28_000_000);
    expect(b.committed_minor).toBeLessThanOrEqual(b.envelope_minor);
  }, 120_000);

  it('four chairs award four 100,000 proposals at once against 300,000: three awarded, one refused into reconsider, which then admits only a decline', async () => {
    const w = h.world({ envelope: 300_000, maxRequest: 100_000 });
    const applicants = [w.alice, w.bob, h.account('Cara Applicant', ['applicant']), h.account('Dev Applicant', ['applicant'])];
    const proposals: string[] = [];
    for (const a of applicants) proposals.push(await h.scored(w, w.r.slice(0, 3), a, { requested: 100_000 }));
    const results = await race(h, 'decision', proposals.map((p) => [w.chair.id, p] as [string, string]));
    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);
    expect(results.filter((r) => r.outcome === 'awarded')).toHaveLength(3);
    const refused = results.filter((r) => r.outcome === 'refused');
    expect(refused).toEqual([{ outcome: 'refused', code: 'envelope_exceeded', rule: 'INV-9' }]);

    await h.settle();
    const b = h.one(`SELECT envelope_minor, committed_minor FROM adj_budget WHERE call_id = ?`, w.callId);
    expect(b.committed_minor).toBe(b.envelope_minor);
    expect(h.count('ProposalAwarded')).toBe(3);
    const loser = h.one(`SELECT proposal_id FROM adj_case WHERE status = 'reconsider'`).proposal_id;
    expect(h.status(loser)).toBe('scored');

    const retry = await h.post(`/api/adjudications/${loser}/decision`, w.chair, { outcome: 'award', rationale: 'Trying to award it anyway.' });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({ code: 'envelope_exhausted', rule: 'INV-9' });
    const decline = await h.post(`/api/adjudications/${loser}/decision`, w.chair, { outcome: 'decline', rationale: 'The envelope is fully committed.' });
    expect(decline.status).toBe(200);
    await h.settle();
    expect(h.status(loser)).toBe('declined');
    // the portfolio projection agrees with the ledger
    expect(h.one(`SELECT awarded_minor FROM ovs_call WHERE call_id = ?`, w.callId).awarded_minor).toBe(b.committed_minor);
  }, 120_000);
});
