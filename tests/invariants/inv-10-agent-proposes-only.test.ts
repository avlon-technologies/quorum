import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';
import { AGENT_ACTOR } from '../../src/platform/deps.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-10 — the triage agent proposes; it never moves a proposal out of screening', () => {
  it('an agent verdict leaves the proposal in screening; the agent published only TriageProposed', async () => {
    const w = h.world();
    h.agentAccount();
    const id = await h.submitted(w);
    expect(h.one(`SELECT verdict FROM sub_triage WHERE proposal_id = ?`, id).verdict).toBe('eligible');
    expect(h.status(id)).toBe('screening');
    const byAgent = h.all(`SELECT DISTINCT type FROM evt_outbox WHERE actor_id = ?`, AGENT_ACTOR).map((r) => r.type);
    expect(byAgent).toEqual(['TriageProposed']);
    expect(h.count('ProposalEligible') + h.count('ProposalIneligible')).toBe(0);
  });

  it('the agent account holds no role, so the screening command refuses it: 403 forbidden, still screening, no event', async () => {
    const w = h.world();
    h.agentAccount();
    const id = await h.submitted(w);
    const token = await h.mintToken(AGENT_ACTOR);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/screening`, token, { outcome: 'ineligible', reason: 'The agent tries to screen this out.' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'forbidden', rule: 'INV-11' });
    expect(h.status(id)).toBe('screening');
    expect(h.totalEvents()).toBe(before);
  });

  it('a screening decision on a proposal not in screening is refused: 409 not_in_screening', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const r = await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'ineligible', reason: 'Changing my mind after the fact.' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'not_in_screening', rule: 'INV-10' });
    expect(h.status(id)).toBe('eligible');
  });
});
