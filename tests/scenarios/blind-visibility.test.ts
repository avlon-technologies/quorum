import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('Premature visibility of reviews (INV-7)', () => {
  it('locked before your own submission, anonymized peers after; officers and chairs see everything', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    h.review(w, id, w.r[1]!);
    await h.settle();

    const locked = await h.get(`/api/proposals/${id}/reviews`, w.r[2]!);
    expect(locked.body).toMatchObject({ visible: false, reviews: [] });

    h.review(w, id, w.r[2]!, 5);
    await h.settle();
    const open = await h.get(`/api/proposals/${id}/reviews`, w.r[2]!);
    expect(open.body.visible).toBe(true);
    expect(open.body.reviews).toHaveLength(3);
    const labels = open.body.reviews.map((r: any) => r.label);
    expect(labels).toContain('Your review');
    for (const r of open.body.reviews) {
      expect(r.reviewerId).toBeNull();
      expect(r.reviewerName).toBeNull();
    }
    expect(JSON.stringify(open.body)).not.toContain(w.r[0]!.id);

    for (const staff of [w.officer, w.chair]) {
      const all = await h.get(`/api/proposals/${id}/reviews`, staff);
      expect(all.body.visible).toBe(true);
      expect(all.body.reviews.map((r: any) => r.reviewerName).sort()).toEqual(['Reviewer 1', 'Reviewer 2', 'Reviewer 3']);
    }
  });

  it('a reviewer cannot see triage advice or screening notes on the proposal they review', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const r = await h.get(`/api/proposals/${id}`, w.r[0]!);
    expect(r.status).toBe(200);
    expect(r.body.triage).toBeNull();
    expect(r.body.screening).toBeNull();
  });
});
