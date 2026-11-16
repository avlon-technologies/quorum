/**
 * ReviewCompletion — realizes ::Quorum.ResearchFunding.PeerReview.ReviewCompletion (the aggregation).
 * Reads the ReviewStore, writes only rev_completion (CompletionLedger), whose primary key makes
 * ProposalFullyReviewed publish at most once per proposal (INV-5).
 *
 *   on ReviewSubmitted -> independent ProposalFullyReviewed   correlate payload.proposalId
 */
import type { Deps } from '../../platform/deps.ts';
import { PLATFORM_ACTOR } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import type { ReviewSubmittedData, FullyReviewedData } from '../../contracts/model.generated.ts';
import { REVIEWERS_PER_PROPOSAL } from '../../contracts/review-rules.ts';

/** Submitted, non-voided reviews on non-revoked assignments — the only reviews that count. */
export function countedReviews(deps: Deps, proposalId: string): Array<{ id: string; mean: number }> {
  return deps.db
    .prepare(
      `SELECT r.id, AVG(s.score) AS mean
         FROM rev_review r
         JOIN rev_assignment a ON a.id = r.assignment_id
         JOIN rev_score s ON s.review_id = r.id
        WHERE r.proposal_id = ? AND r.status = 'submitted' AND r.voided_at IS NULL AND a.status = 'completed'
        GROUP BY r.id ORDER BY r.submitted_at`,
    )
    .all(proposalId) as Array<{ id: string; mean: number }>;
}

export function completionConsumer(deps: Deps): Consumer {
  return {
    name: 'peer-review.review-completion',
    realizes: '::Quorum.ResearchFunding.PeerReview.ReviewCompletion',
    handles: {
      ReviewSubmitted: (db, e: StoredEvent<ReviewSubmittedData>) => {
        const proposalId = e.payload.proposalId;
        if (db.prepare(`SELECT 1 FROM rev_completion WHERE proposal_id = ?`).get(proposalId)) return; // already complete: no-op
        const counted = countedReviews(deps, proposalId);
        if (counted.length !== REVIEWERS_PER_PROPOSAL) return; // INV-5: exactly three, no fewer
        const mean = counted.reduce((s, r) => s + r.mean, 0) / counted.length;
        const meanScore = mean.toFixed(2);
        const now = deps.clock.now().toISOString();
        db.prepare(`INSERT INTO rev_completion (proposal_id, mean_score, review_ids, completed_at) VALUES (?, ?, ?, ?)`).run(
          proposalId,
          Number(meanScore),
          JSON.stringify(counted.map((r) => r.id)),
          now,
        );
        const payload: FullyReviewedData = { proposalId, meanScore, reviewIds: counted.map((r) => r.id), at: now };
        deps.bus.publish('ProposalFullyReviewed', `proposal:${proposalId}`, payload, PLATFORM_ACTOR, e.messageId);
      },
    },
  };
}
