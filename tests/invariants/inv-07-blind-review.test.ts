import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-7 — no other review is visible until your own is submitted', () => {
  it('a reviewer who has not submitted sees no peer review, even when two peers have submitted', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    h.review(w, id, w.r[1]!);
    await h.settle();
    const r = await h.get(`/api/proposals/${id}/reviews`, w.r[2]!);
    expect(r.status).toBe(200);
    expect(r.body.visible).toBe(false);
    expect(r.body.reviews).toEqual([]);
    expect(r.body.lockedReason).toMatch(/INV-7/);
    expect(JSON.stringify(r.body)).not.toMatch(/well-justified/); // no comment text leaks
  });

  it('a reviewer not on the panel cannot read the reviews at all: 404', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    const r = await h.get(`/api/proposals/${id}/reviews`, w.r[4]!);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('notifications never carry scores or review text to reviewers', async () => {
    const w = h.world();
    await h.scored(w);
    const msgs = h.all(`SELECT body FROM ntf_message WHERE recipient IN (?, ?, ?)`, w.r[0]!.id, w.r[1]!.id, w.r[2]!.id);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.body).not.toMatch(/well-justified|mean/);
  });
});
