/**
 * The ReviewDeadline workflow — realizes ::Quorum.ResearchFunding.PeerReview.ReviewDeadline. It invokes
 * AssignmentService's ReviewApi.MarkOverdue (markOverdue in ./service.ts), the only writer of the Overdue
 * status (ADR-016), and publishes ReviewOverdue.
 */
import type { Deps } from '../../platform/deps.ts';
import { PLATFORM_ACTOR } from '../../platform/deps.ts';
import type { AssignmentData } from '../../contracts/model.generated.ts';
import { markOverdue, assignmentPayload, type AssignmentRow } from './service.ts';

/**
 * ReviewDeadline workflow realization: the stored due_at is authoritative; this sweeper re-reads it on
 * every run (and after a restart), so no timer is ever lost. Each assignment in its own transaction.
 */
export function sweepOverdue(deps: Deps): number {
  const now = deps.clock.now().toISOString();
  const due = deps.db.prepare(`SELECT * FROM rev_assignment WHERE status IN ('assigned','accepted') AND due_at <= ? ORDER BY due_at`).all(now) as AssignmentRow[];
  let n = 0;
  for (const a of due) {
    deps.db
      .transaction(() => {
        if (!markOverdue(deps, a.id)) return; // invoke mark
        const payload: AssignmentData = {
          ...assignmentPayload(deps, a, PLATFORM_ACTOR, 'the review period elapsed without a submitted review'),
          at: a.due_at,
        };
        deps.bus.publish('ReviewOverdue', `proposal:${a.proposal_id}`, payload, PLATFORM_ACTOR); // publish overdue
        n++;
      })
      .immediate();
  }
  return n;
}
