import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';
import { revokeRole } from '../../src/contexts/identity/service.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-11 — act only in a granted role, only on resources in scope', () => {
  it('an applicant cannot publish a call: 403 forbidden, no call, no event', async () => {
    const w = h.world();
    const before = h.totalEvents();
    const r = await h.post('/api/calls', w.alice, {
      title: 'My own private call',
      summary: 'An applicant trying to publish a funding call for themselves.',
      deadline: '2030-01-01T00:00:00Z',
      envelope: 1000,
      maxRequest: 1000,
      criteria: [{ name: 'Merit', guidance: '' }],
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'forbidden', rule: 'INV-11' });
    expect(h.one(`SELECT COUNT(*) n FROM cal_call`).n).toBe(1);
    expect(h.totalEvents()).toBe(before);
  });

  it("another applicant's proposal does not exist for you: 404 on read, edit and submit, nothing changes", async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    expect((await h.get(`/api/proposals/${id}`, w.bob)).status).toBe(404);
    const put = await h.req('PUT', `/api/proposals/${id}`, w.bob, { title: 'Hijacked title for this draft', abstract: 'x', requested: 1 });
    expect(put.status).toBe(404);
    const sub = await h.post(`/api/proposals/${id}/submit`, w.bob);
    expect(sub.status).toBe(404);
    expect(h.status(id)).toBe('draft');
    expect(h.one(`SELECT title FROM sub_proposal WHERE id = ?`, id).title).not.toMatch(/Hijacked/);
  });

  it('a revoked role stops working on the next request (roles are read per request, not from the token)', async () => {
    const w = h.world();
    expect((await h.get('/api/workspace/officer', w.officer)).status).toBe(200);
    h.tx(() => revokeRole(h.deps, w.officer.id, 'programOfficer'));
    const r = await h.get('/api/workspace/officer', w.officer);
    expect(r.status).toBe(403);
    expect(r.body.error.rule).toBe('INV-11');
  });
});
