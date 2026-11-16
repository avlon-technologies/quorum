import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-2 — a proposal is submitted at most once', () => {
  it('refuses a second submission (new request): 409 already_submitted, one ProposalSubmitted only', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    expect((await h.post(`/api/proposals/${id}/submit`, w.alice)).status).toBe(200);
    await h.settle();
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'already_submitted', rule: 'INV-2' });
    expect(h.count('ProposalSubmitted')).toBe(1);
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses editing a submitted proposal: 409 not_a_draft, content unchanged', async () => {
    const w = h.world();
    const id = await h.submitted(w);
    const title = h.one(`SELECT title FROM sub_proposal WHERE id = ?`, id).title;
    const r = await h.req('PUT', `/api/proposals/${id}`, w.alice, { title: 'A sneaky late rewrite of the title', abstract: 'x', requested: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'not_a_draft', rule: 'INV-2' });
    expect(h.one(`SELECT title FROM sub_proposal WHERE id = ?`, id).title).toBe(title);
  });
});
