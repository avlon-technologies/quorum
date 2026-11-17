/**
 * Oversight — realizes ::Quorum.ResearchFunding.Oversight.PortfolioProjector, the only producer of
 * the Portfolio and AuditTrail read models. Fed by events only; never reads a write-side store (J8,
 * ADR-013). Idempotent: ovs_audit is keyed by message id, and row updates are guarded by last_seq,
 * so redelivery and full replay give the same projection.
 */
import type { Deps } from '../../platform/deps.ts';
import type { Db } from '../../platform/db.ts';
import type { Consumer, Handler, StoredEvent, EventType } from '../../platform/events.ts';

const minor = (d: string | number) => Math.round(Number(d) * 100);
/** Human-readable money for audit summaries; the event itself keeps the exact decimal. */
const cad = (d: string | number) => `$${Number(d).toLocaleString('en-CA', { maximumFractionDigits: 2 })}`;

function audit(db: Db, e: StoredEvent<any>, summary: string, reason: string | null = null) {
  const p = e.payload ?? {};
  db.prepare(
    `INSERT OR IGNORE INTO ovs_audit (seq, message_id, at, event, proposal_id, call_id, subject_id, actor_id, summary, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.seq, e.messageId, e.occurredAt, e.type, p.proposalId ?? null, p.callId ?? null, p.assignmentId ?? p.accountId ?? p.reviewerId ?? null, e.actorId, summary, reason);
}

function setProposal(db: Db, e: StoredEvent<any>, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  db.prepare(`UPDATE ovs_proposal SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, last_seq = ? WHERE proposal_id = ? AND last_seq < ?`).run(
    ...cols.map((c) => set[c]),
    e.occurredAt,
    e.seq,
    e.payload.proposalId,
    e.seq,
  );
}

/**
 * Reviews that count, derived from events alone (ADR-013): ReviewSubmitted for an assignment that has
 * no later AssignmentRevoked. Recomputed, not incremented, so redelivery and replay are idempotent.
 */
function recountReviews(db: Db, e: StoredEvent<any>) {
  db.prepare(
    `UPDATE ovs_proposal SET reviews_submitted = (
        SELECT COUNT(*) FROM ovs_audit s WHERE s.proposal_id = ? AND s.event = 'ReviewSubmitted'
           AND NOT EXISTS (SELECT 1 FROM ovs_audit r WHERE r.proposal_id = s.proposal_id AND r.event = 'AssignmentRevoked' AND r.subject_id = s.subject_id)),
        updated_at = ?, last_seq = MAX(last_seq, ?)
      WHERE proposal_id = ?`,
  ).run(e.payload.proposalId, e.occurredAt, e.seq, e.payload.proposalId);
}

const status = (to: string, summary: (e: StoredEvent<any>) => string, reason?: (e: StoredEvent<any>) => string | null): Handler => (db, e) => {
  setProposal(db, e, { status: to });
  audit(db, e, summary(e), reason ? reason(e) : (e.payload.reason ?? null));
};

export const PROJECTED: EventType[] = [
  'CallPublished', 'CallClosed', 'OrcidVerified', 'ProposalSubmitted', 'ProposalEnteredScreening', 'TriageProposed', 'ProposalEligible', 'ProposalIneligible',
  'ProposalUnderReview', 'ProposalScored', 'ProposalWithdrawn', 'ConflictDeclared', 'ReviewerAssigned', 'AssignmentAccepted', 'AssignmentRevoked',
  'ReviewSubmitted', 'ReviewOverdue', 'ProposalFullyReviewed', 'ProposalAwarded', 'ProposalDeclined',
  'AwardRefused', 'AwardHeld', 'DecisionEscalated', 'AccountErased',
];

export function projectorConsumer(_deps: Deps): Consumer {
  return {
    name: 'oversight.portfolio-projector',
    realizes: '::Quorum.ResearchFunding.Oversight.PortfolioProjector',
    handles: {
      CallPublished: (db, e) => {
        db.prepare(`INSERT OR IGNORE INTO ovs_call (call_id, title, deadline, status, envelope_minor, awarded_minor, last_seq) VALUES (?, ?, ?, 'open', ?, 0, ?)`).run(
          e.payload.callId, e.payload.title, e.payload.deadline, minor(e.payload.envelope), e.seq,
        );
        audit(db, e, `Call “${e.payload.title}” published with an envelope of ${cad(e.payload.envelope)}`);
      },
      CallClosed: (db, e) => {
        db.prepare(`UPDATE ovs_call SET status = 'closed', last_seq = ? WHERE call_id = ? AND last_seq < ?`).run(e.seq, e.payload.callId, e.seq);
        audit(db, e, 'Call closed', e.payload.reason);
      },
      OrcidVerified: (db, e) => audit(db, e, `ORCID iD ${e.payload.orcidId} verified`),
      ProposalSubmitted: (db, e) => {
        db.prepare(
          `INSERT OR IGNORE INTO ovs_proposal (proposal_id, call_id, title, applicant_name, status, requested_minor, submitted_at, updated_at, last_seq)
           VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
        ).run(e.payload.proposalId, e.payload.callId, e.payload.title, e.payload.applicantName, minor(e.payload.requested), e.payload.at, e.occurredAt, e.seq);
        audit(db, e, `Submitted by ${e.payload.applicantName}, requesting ${cad(e.payload.requested)}`);
      },
      ProposalEnteredScreening: status('screening', () => 'Entered eligibility screening'),
      TriageProposed: (db, e) =>
        audit(db, e, e.payload.verdict ? `Triage agent proposed “${e.payload.verdict.verdict}” (advisory)` : 'Triage agent could not assess; manual screening', e.payload.verdict?.rationale ?? null),
      ProposalEligible: status('eligible', () => 'Confirmed eligible by a program officer'),
      ProposalIneligible: status('ineligible', () => 'Screened out as ineligible by a program officer'),
      ProposalUnderReview: status('underReview', () => 'Under review — three reviewers assigned'),
      ProposalScored: (db, e) => {
        setProposal(db, e, { status: 'scored', mean_score: Number(e.payload.meanScore) });
        audit(db, e, `Scored — mean ${e.payload.meanScore} across three reviews`);
      },
      ProposalWithdrawn: status('withdrawn', () => 'Withdrawn by the applicant'),
      ConflictDeclared: (db, e) =>
        audit(db, e, `Conflict of interest declared${e.payload.revokedAssignment ? ' — assignment revoked' : ''}${e.payload.heldAward ? ' — award held' : ''}`, e.payload.reason),
      ReviewerAssigned: (db, e) => audit(db, e, `Reviewer assigned, due ${String(e.payload.dueAt).slice(0, 10)}`),
      AssignmentAccepted: (db, e) => audit(db, e, 'Reviewer accepted the assignment (no conflict attested)'),
      AssignmentRevoked: (db, e) => {
        audit(db, e, 'Assignment revoked', e.payload.reason);
        recountReviews(db, e); // a revoked assignment's submitted review is voided and no longer counts
      },
      ReviewSubmitted: (db, e) => {
        audit(db, e, 'A review was submitted');
        recountReviews(db, e);
      },
      ReviewOverdue: (db, e) => audit(db, e, `A review became overdue (due ${String(e.payload.dueAt).slice(0, 10)})`),
      ProposalFullyReviewed: (db, e) => audit(db, e, `Three reviews complete (mean ${e.payload.meanScore})`),
      ProposalAwarded: (db, e) => {
        setProposal(db, e, { status: 'awarded', awarded_minor: minor(e.payload.amount) });
        // recomputed, never incremented: awards arrive from many proposal partitions in no global order (architect review A1)
        db.prepare(`UPDATE ovs_call SET awarded_minor = (SELECT COALESCE(SUM(awarded_minor), 0) FROM ovs_proposal WHERE call_id = ? AND status = 'awarded') WHERE call_id = ?`).run(e.payload.callId, e.payload.callId);
        audit(db, e, `Awarded ${cad(e.payload.amount)} by the panel chair`, e.payload.rationale);
      },
      ProposalDeclined: status('declined', () => 'Declined by the panel chair', (e) => e.payload.rationale),
      // review B4: transitions that were previously unaudited
      AwardRefused: (db, e) => audit(db, e, `Award of ${cad(e.payload.requested)} refused: the envelope cannot fund it. Only a decline remains.`),
      AwardHeld: (db, e) => audit(db, e, 'Award placed on integrity hold', e.payload.reason),
      DecisionEscalated: (db, e) => audit(db, e, `Panel decision overdue (due ${String(e.payload.dueAt).slice(0, 10)}); program officers notified`),
      // Erasure: the projection carries the same marker a replay of the redacted log would produce
      AccountErased: (db, e) => {
        const id = e.payload.accountId;
        db.prepare(`UPDATE ovs_proposal SET applicant_name = '[erased]' WHERE proposal_id IN (SELECT proposal_id FROM ovs_audit WHERE event = 'ProposalSubmitted' AND actor_id = ?)`).run(id);
        db.prepare(
          `UPDATE ovs_audit SET summary = 'Submitted by [erased]' || substr(summary, instr(summary, ', requesting')) WHERE event = 'ProposalSubmitted' AND actor_id = ? AND instr(summary, ', requesting') > 0`,
        ).run(id);
        db.prepare(`UPDATE ovs_audit SET summary = 'ORCID iD [erased] verified' WHERE event = 'OrcidVerified' AND subject_id = ?`).run(id);
        audit(db, e, 'Personal data erased on request');
      },
    },
  };
}

/** Reset for a full replay: the projection is a pure function of the retained event log. */
export function resetProjection(db: Db): void {
  db.exec(`DELETE FROM ovs_audit; DELETE FROM ovs_proposal; DELETE FROM ovs_call;`);
}

// ------------------------------------------------------------------ PortfolioApi

export function getPortfolio(deps: Deps, callId?: string) {
  const calls = deps.db.prepare(`SELECT * FROM ovs_call ${callId ? 'WHERE call_id = ?' : ''} ORDER BY deadline DESC`).all(...(callId ? [callId] : [])) as Array<{
    call_id: string;
    title: string;
    deadline: string;
    status: string;
    envelope_minor: number;
    awarded_minor: number;
  }>;
  return calls.map((c) => {
    const rows = deps.db.prepare(`SELECT * FROM ovs_proposal WHERE call_id = ? ORDER BY COALESCE(mean_score, -1) DESC, submitted_at`).all(c.call_id) as Array<{
      proposal_id: string;
      title: string;
      applicant_name: string;
      status: string;
      requested_minor: number;
      reviews_submitted: number;
      mean_score: number | null;
      awarded_minor: number | null;
      submitted_at: string;
      updated_at: string;
    }>;
    return {
      callId: c.call_id,
      title: c.title,
      deadline: c.deadline,
      status: c.status,
      envelopeMinor: c.envelope_minor,
      committedMinor: c.awarded_minor,
      remainingMinor: c.envelope_minor - c.awarded_minor,
      proposals: rows.map((r) => ({
        proposalId: r.proposal_id,
        title: r.title,
        applicantName: r.applicant_name,
        status: r.status,
        requestedMinor: r.requested_minor,
        reviewsSubmitted: r.reviews_submitted,
        reviewsRequired: 3,
        meanScore: r.mean_score,
        awardedMinor: r.awarded_minor,
        submittedAt: r.submitted_at,
        updatedAt: r.updated_at,
      })),
    };
  });
}

export function getTimeline(deps: Deps, proposalId: string) {
  return deps.db
    .prepare(`SELECT seq, at, event, actor_id AS actorId, summary, reason FROM ovs_audit WHERE proposal_id = ? ORDER BY seq`)
    .all(proposalId) as Array<{ seq: number; at: string; event: string; actorId: string; summary: string; reason: string | null }>;
}

export function recentActivity(deps: Deps, limit = 40) {
  return deps.db
    .prepare(`SELECT seq, at, event, proposal_id AS proposalId, call_id AS callId, actor_id AS actorId, summary, reason FROM ovs_audit ORDER BY seq DESC LIMIT ?`)
    .all(limit);
}
