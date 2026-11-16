import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

const comment = 'A careful, well-justified proposal with a credible plan.';

describe('INV-6 — every criterion scored 1–5 before submission', () => {
  async function setup() {
    const w = h.world({ criteria: 3 });
    const id = await h.underReview(w);
    const a = h.assignment(id, w.r[0]!);
    expect((await h.post(`/api/assignments/${a}/accept`, w.r[0]!)).status).toBe(200);
    return { w, id, a };
  }

  it('refuses a review missing a criterion: 422 incomplete_review naming the gap, nothing stored, no event', async () => {
    const { w, a } = await setup();
    const before = h.totalEvents();
    const r = await h.post(`/api/assignments/${a}/review`, w.r[0]!, { scores: { c1: 4, c2: 5 }, comment, attestsNoConflict: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'incomplete_review', rule: 'INV-6' });
    expect(r.body.error.fields.map((f: any) => f.field)).toEqual(['scores.c3']);
    expect(h.one(`SELECT status FROM rev_assignment WHERE id = ?`, a).status).toBe('accepted');
    expect(h.one(`SELECT COUNT(*) n FROM rev_score`).n).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses out-of-range scores (0 and 6): 422 incomplete_review', async () => {
    const { w, a } = await setup();
    const r = await h.post(`/api/assignments/${a}/review`, w.r[0]!, { scores: { c1: 0, c2: 6, c3: 3 }, comment, attestsNoConflict: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'incomplete_review', rule: 'INV-6' });
    expect(r.body.error.fields.map((f: any) => f.field).sort()).toEqual(['scores.c1', 'scores.c2']);
    expect(h.count('ReviewSubmitted')).toBe(0);
  });

  it('refuses a non-integer score at the schema boundary: 400 validation_failed', async () => {
    const { w, a } = await setup();
    const r = await h.post(`/api/assignments/${a}/review`, w.r[0]!, { scores: { c1: 2.5, c2: 3, c3: 3 }, comment, attestsNoConflict: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(h.count('ReviewSubmitted')).toBe(0);
  });
});
