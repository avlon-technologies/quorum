import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-3 — a conflicted reviewer can never hold an assignment', () => {
  it('refuses assigning a reviewer with a declared conflict: 409 conflict_of_interest, no assignment, no event', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const d = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Co-author within the last three years.' });
    expect(d.status).toBe(201);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[0]!.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'conflict_of_interest', rule: 'INV-3' });
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ?`, id).n).toBe(0);
    expect(h.count('ReviewerAssigned')).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });

  it('the database refuses a conflicted assignment even if the service check were bypassed (trigger)', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Same department as the applicant.' });
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO rev_assignment (id, proposal_id, reviewer_id, status, due_at, assigned_by, assigned_at) VALUES ('x-1', ?, ?, 'assigned', '2030-01-01', ?, '2026-01-01')`,
        )
        .run(id, w.r[0]!.id, w.officer.id),
    ).toThrow(/INV-3/);
  });

  it('a conflict declared on a live assignment revokes it in the same transaction', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const r = await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reason: 'I supervised the applicant during their PhD.' });
    expect(r.status).toBe(201);
    expect(r.body.revokedAssignment).toBeTruthy();
    expect(h.all(`SELECT status FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0]!.id).map((x) => x.status)).toEqual(['revoked']);
  });
});
