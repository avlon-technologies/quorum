import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, DAY_MS } from '../support/harness.ts';
import { closeCall } from '../../src/contexts/calls/service.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-1 — submit only while the call is open and before its deadline', () => {
  it('refuses a submission after the deadline: 409 deadline_passed, nothing changes, no event', async () => {
    const w = h.world({ deadlineDays: 10 });
    const id = h.draft(w, w.alice);
    h.clock.advance(11 * DAY_MS);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'deadline_passed', rule: 'INV-1' });
    expect(h.status(id)).toBe('draft');
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses a submission to a closed call: 409 call_closed, nothing changes, no event', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    h.tx(() => closeCall(h.deps, w.officer.id, w.callId, 'Closed early by the funder.'));
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'call_closed', rule: 'INV-1' });
    expect(h.status(id)).toBe('draft');
    expect(h.count('ProposalSubmitted')).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });
});
