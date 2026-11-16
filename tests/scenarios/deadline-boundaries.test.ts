import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';
import { closeCall } from '../../src/contexts/calls/service.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('Deadline boundaries (INV-1)', () => {
  it('accepts a submission 1 ms before the deadline', async () => {
    const w = h.world({ deadlineDays: 5 });
    const id = h.draft(w, w.alice);
    h.clock.set(new Date(new Date(w.deadline).getTime() - 1));
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('submitted');
    expect(h.count('ProposalSubmitted')).toBe(1);
  });

  it('refuses a submission at exactly the deadline instant', async () => {
    const w = h.world({ deadlineDays: 5 });
    const id = h.draft(w, w.alice);
    h.clock.set(w.deadline);
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'deadline_passed', rule: 'INV-1' });
    expect(h.status(id)).toBe('draft');
  });

  it('refuses a submission after the call is closed, even well before the deadline', async () => {
    const w = h.world({ deadlineDays: 5 });
    const id = h.draft(w, w.alice);
    h.tx(() => closeCall(h.deps, w.officer.id, w.callId, 'Withdrawn by the funder.'));
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'call_closed', rule: 'INV-1' });
  });

  it('refuses starting a new draft on a closed call', async () => {
    const w = h.world({ deadlineDays: 5 });
    h.tx(() => closeCall(h.deps, w.officer.id, w.callId, 'Withdrawn by the funder.'));
    const r = await h.post('/api/proposals', w.alice, { callId: w.callId, title: 'Late idea', abstract: '', requested: 0 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'call_closed', rule: 'INV-1' });
  });
});
