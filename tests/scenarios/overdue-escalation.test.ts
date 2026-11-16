import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, DAY_MS } from '../support/harness.ts';
import { sweepOverdue } from '../../src/contexts/peer-review/review-deadline.ts';
import { sweepEscalations } from '../../src/contexts/adjudication/panel-decision.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('Overdue reviews (P21D) and chair escalation (P14D)', () => {
  it('marks an assignment overdue exactly at its due date, exactly once; a late review is still accepted', async () => {
    const w = h.world({ deadlineDays: 60 });
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    await h.settle();
    const due = new Date(h.one(`SELECT due_at FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[1]!.id).due_at);

    h.clock.set(new Date(due.getTime() - 1));
    expect(sweepOverdue(h.deps)).toBe(0);
    h.clock.set(due);
    expect(sweepOverdue(h.deps)).toBe(2);
    expect(sweepOverdue(h.deps)).toBe(0);
    await h.settle();
    expect(h.count('ReviewOverdue')).toBe(2);
    expect(h.all(`SELECT status FROM rev_assignment WHERE proposal_id = ? ORDER BY status`, id).map((r) => r.status)).toEqual(['completed', 'overdue', 'overdue']);
    // the completed reviewer is never chased
    expect(h.count('ReviewOverdue', { reviewerId: w.r[0]!.id })).toBe(0);
    // officer and reviewer are told
    expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE kind = 'overdue'`).n).toBe(4);

    h.clock.advance(3 * DAY_MS);
    const a = h.assignment(id, w.r[1]!);
    const late = await h.post(`/api/assignments/${a}/review`, w.r[1]!, { scores: h.scores(w, 4), comment: 'Late but complete and carefully considered review.', attestsNoConflict: true });
    expect(late.status).toBe(200);
    expect(h.one(`SELECT status FROM rev_assignment WHERE id = ?`, a).status).toBe('completed');
    await h.settle();
    expect(h.count('ReviewOverdue')).toBe(2);
  });

  it('a chair decision pending 14 days escalates (escalated_at) and is never decided automatically', async () => {
    const w = h.world({ deadlineDays: 60 });
    const id = await h.scored(w);
    const due = new Date(h.one(`SELECT decision_due FROM adj_case WHERE proposal_id = ?`, id).decision_due);
    h.clock.set(new Date(due.getTime() - 1));
    expect(sweepEscalations(h.deps)).toBe(0);
    h.clock.set(due);
    expect(sweepEscalations(h.deps)).toBe(1);
    expect(sweepEscalations(h.deps)).toBe(0);
    h.clock.advance(30 * DAY_MS);
    await h.settle();
    const c = h.one(`SELECT status, escalated_at FROM adj_case WHERE proposal_id = ?`, id);
    expect(c.status).toBe('awaitingDecision');
    expect(c.escalated_at).toBeTruthy();
    expect(h.one(`SELECT COUNT(*) n FROM adj_decision`).n).toBe(0);
    expect(h.count('ProposalAwarded') + h.count('ProposalDeclined')).toBe(0);
    expect(h.status(id)).toBe('scored');
    const ws = await h.get('/api/workspace/officer', w.officer);
    expect(ws.body.decisionsOverdue.map((x: any) => x.proposalId)).toContain(id);
  });
});
