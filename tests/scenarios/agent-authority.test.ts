import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';
import { AGENT_ACTOR } from '../../src/platform/deps.ts';
import { rolesOf } from '../../src/contexts/identity/service.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

async function settleThroughRetries() {
  for (let i = 0; i < 6; i++) {
    await h.settle();
    h.clock.advance(10_000);
  }
  await h.settle();
}

describe('Agent authority (INV-10)', () => {
  it('the agent account holds no role and cannot sign in', async () => {
    h.world();
    h.agentAccount();
    expect(rolesOf(h.deps, AGENT_ACTOR)).toEqual([]);
    const r = await h.post('/api/session', null, { email: 'triage@agents.test', password: 'anything-at-all' });
    expect(r.status).toBe(401);
  });

  it('whatever the agent proposes, the proposal stays in screening until an officer decides', async () => {
    const w = h.world({ maxRequest: 100_000 });
    const likely = await h.submitted(w, w.alice, { requested: 100_000 });
    const unclear = await h.submitted(w, w.bob, { abstract: 'Too short to judge, but long enough to be submitted. '.repeat(5) });
    expect(h.one(`SELECT verdict FROM sub_triage WHERE proposal_id = ?`, likely).verdict).toBe('eligible');
    expect(h.one(`SELECT verdict FROM sub_triage WHERE proposal_id = ?`, unclear).verdict).toBe('unclear');
    expect(h.status(likely)).toBe('screening');
    expect(h.status(unclear)).toBe('screening');
  });

  it('provider failure: after bounded retries the verdict is recorded as absent and the officer still decides', async () => {
    const w = h.world();
    h.triage.failNext = 10;
    const id = await h.submitted(w);
    await settleThroughRetries();
    const t = h.one(`SELECT verdict, rationale FROM sub_triage WHERE proposal_id = ?`, id);
    expect(t.verdict).toBeNull();
    expect(t.rationale).toMatch(/could not assess/);
    expect(h.one(`SELECT attempts, status FROM sub_triage_job WHERE proposal_id = ?`, id)).toMatchObject({ attempts: 3, status: 'done' });
    expect(h.status(id)).toBe('screening');
    h.triage.failNext = 0;
    const r = await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'eligible', reason: '' });
    expect(r.status).toBe(200);
    expect(h.status(id)).toBe('eligible');
  });

  it('overriding the agent requires a reason: 422 reason_required without one, accepted with one', async () => {
    const w = h.world();
    const id = await h.submitted(w); // agent says eligible
    const bare = await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'ineligible', reason: '' });
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('reason_required');
    expect(h.status(id)).toBe('screening');
    const ok = await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'ineligible', reason: 'Outside the geographic scope of this call.' });
    expect(ok.status).toBe(200);
    expect(h.one(`SELECT agreed_with_agent FROM sub_screening WHERE proposal_id = ?`, id).agreed_with_agent).toBe(0);
  });
});
