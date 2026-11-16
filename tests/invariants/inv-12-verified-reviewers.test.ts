import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-12 — only ORCID-verified reviewers hold assignments', () => {
  it('refuses assigning an unverified reviewer: 409 orcid_unverified, no assignment, no event', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.unverified.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'orcid_unverified', rule: 'INV-12' });
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment`).n).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses verifying an iD the registry does not know: 422 orcid_not_found, account stays unverified, no OrcidVerified', async () => {
    const w = h.world();
    const before = h.count('OrcidVerified');
    const r = await h.post('/api/me/orcid', w.unverified, { orcidId: '0000-0003-1415-9269' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'orcid_not_found', rule: 'INV-12' });
    expect(h.one(`SELECT orcid_status FROM idn_account WHERE id = ?`, w.unverified.id).orcid_status).toBe('unverified');
    expect(h.count('OrcidVerified')).toBe(before);
  });

  it('after a successful verification the same reviewer can be assigned', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const v = await h.post('/api/me/orcid', w.unverified, { orcidId: '0000-0002-1825-0097' });
    expect(v.status).toBe(200);
    expect((await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.unverified.id })).status).toBe(201);
  });
});
