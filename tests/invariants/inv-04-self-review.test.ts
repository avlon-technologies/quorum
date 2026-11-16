import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-4 — an applicant is never assigned to review their own proposal', () => {
  it('refuses assigning the applicant (who is also a verified reviewer): 409 self_review, no assignment, no event', async () => {
    const w = h.world();
    const id = await h.eligible(w, w.sam);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.sam.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'self_review', rule: 'INV-4' });
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ?`, id).n).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });

  it('the candidate list marks the applicant as ineligible for the same reason', async () => {
    const w = h.world();
    const id = await h.eligible(w, w.sam);
    const r = await h.get(`/api/proposals/${id}/reviewer-candidates`, w.officer);
    expect(r.status).toBe(200);
    const sam = r.body.find((c: any) => c.id === w.sam.id);
    expect(sam.eligibility.ok).toBe(false);
    expect(sam.eligibility.reasons.map((x: any) => x.rule)).toContain('INV-4');
  });
});
