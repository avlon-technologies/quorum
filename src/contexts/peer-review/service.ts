/**
 * PeerReview — realizes ::Quorum.ResearchFunding.PeerReview.AssignmentService (single writer of the
 * ReviewStore: rev_case, rev_conflict, rev_assignment, rev_review, rev_score, rev_call_criteria).
 * ReviewCompletion (completion.ts) is the only writer of rev_completion (CompletionLedger).
 */
import type { Deps } from '../../platform/deps.ts';
import { PLATFORM_ACTOR } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import { newId } from '../../platform/ids.ts';
import { DAY_MS } from '../../platform/clock.ts';
import { conflict, forbidden, notFound, unprocessable, type FieldError } from '../../platform/errors.ts';
import { getReviewerStanding } from '../identity/api.ts';
import { REVIEWERS_PER_PROPOSAL, REVOKED_ON_ERASURE } from '../../contracts/review-rules.ts';
import type {
  AssignmentStatus,
  AssignmentData,
  ReviewersAssignedData,
  ReviewSubmittedData,
  ConflictDeclaredData,
  CallPublishedData,
  EligibleData,
  ProposalTransition,
  AccountErasedData,
} from '../../contracts/model.generated.ts';

export type AssignmentRow = {
  id: string;
  proposal_id: string;
  reviewer_id: string;
  status: AssignmentStatus;
  due_at: string;
  assigned_by: string;
  assigned_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  overdue_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
};
type CaseRow = { proposal_id: string; call_id: string | null; applicant_id: string | null; status: 'open' | 'withdrawn' };
type ReviewRow = { id: string; assignment_id: string; proposal_id: string; reviewer_id: string; status: 'pending' | 'submitted'; comment: string | null; submitted_at: string | null; voided_at: string | null };

export const ACTIVE: AssignmentStatus[] = ['assigned', 'accepted', 'overdue', 'completed'];
export { REVIEWERS_PER_PROPOSAL };

const getAssignment = (deps: Deps, id: string) => deps.db.prepare(`SELECT * FROM rev_assignment WHERE id = ?`).get(id) as AssignmentRow | undefined;
const getCase = (deps: Deps, proposalId: string) => deps.db.prepare(`SELECT * FROM rev_case WHERE proposal_id = ?`).get(proposalId) as CaseRow | undefined;
const activeAssignments = (deps: Deps, proposalId: string) =>
  deps.db.prepare(`SELECT * FROM rev_assignment WHERE proposal_id = ? AND status <> 'revoked' ORDER BY assigned_at`).all(proposalId) as AssignmentRow[];

export function assignmentPayload(deps: Deps, a: AssignmentRow, actorId: string, reason: string): AssignmentData {
  return { assignmentId: a.id, proposalId: a.proposal_id, reviewerId: a.reviewer_id, dueAt: a.due_at, actorId, reason, at: deps.clock.now().toISOString() };
}

/** Revoke one assignment and void its review if not yet counted. Publishes AssignmentRevoked. */
function revoke(deps: Deps, a: AssignmentRow, actorId: string, reason: string, opts: { voidSubmitted: boolean }): boolean {
  const now = deps.clock.now().toISOString();
  const from: AssignmentStatus[] = opts.voidSubmitted ? ['assigned', 'accepted', 'overdue', 'completed'] : ['assigned', 'accepted', 'overdue'];
  const r = deps.db
    .prepare(`UPDATE rev_assignment SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
    .run(now, reason, a.id, ...from);
  if (r.changes !== 1) return false;
  deps.db.prepare(`UPDATE rev_review SET voided_at = ?, void_reason = ? WHERE assignment_id = ? AND voided_at IS NULL`).run(now, reason, a.id);
  deps.bus.publish('AssignmentRevoked', `proposal:${a.proposal_id}`, assignmentPayload(deps, a, actorId, reason), actorId);
  return true;
}

// ------------------------------------------------------------------ assignment validity (business-rule AssignmentValidity)

export type Eligibility = { ok: boolean; reasons: Array<{ code: string; rule: string; message: string }> };

/**
 * Every rule an assignment must satisfy, evaluated in one place so the officer's candidate list and
 * the AssignReviewer command can never disagree. Must run inside the assigning transaction.
 */
export function assignmentEligibility(deps: Deps, proposalId: string, reviewerId: string): Eligibility {
  const reasons: Eligibility['reasons'] = [];
  const c = getCase(deps, proposalId);
  if (!c || c.status !== 'open') {
    reasons.push({ code: 'not_assignable', rule: 'ADR-004', message: 'The proposal is not open for assignment: it must be confirmed eligible and not withdrawn.' });
  }
  const standing = getReviewerStanding(deps, reviewerId); // IdentityApi.GetReviewerStanding, same transaction (ADR-003)
  if (!standing.exists || !standing.isReviewer) {
    reasons.push({ code: 'not_a_reviewer', rule: 'INV-11', message: 'This account does not hold the Reviewer role.' });
  } else if (standing.orcid !== 'verified') {
    reasons.push({ code: 'orcid_unverified', rule: 'INV-12', message: 'Their ORCID iD is not verified yet. They can verify it from their workspace.' });
  }
  if (c?.applicant_id === reviewerId) reasons.push({ code: 'self_review', rule: 'INV-4', message: 'They are the applicant of this proposal.' });
  const conflicted = deps.db.prepare(`SELECT reason FROM rev_conflict WHERE reviewer_id = ? AND proposal_id = ?`).get(reviewerId, proposalId) as { reason: string } | undefined;
  if (conflicted) reasons.push({ code: 'conflict_of_interest', rule: 'INV-3', message: `They declared a conflict: ${conflicted.reason}` });
  const active = activeAssignments(deps, proposalId);
  if (active.some((a) => a.reviewer_id === reviewerId)) reasons.push({ code: 'already_assigned', rule: 'INV-5', message: 'They are already assigned to this proposal.' });
  else if (active.length > REVIEWERS_PER_PROPOSAL) {
    reasons.push({ code: 'panel_full', rule: 'INV-5', message: `This proposal already has ${REVIEWERS_PER_PROPOSAL} active reviewers. Revoke one to replace them.` });
  }
  return { ok: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ commands

/** Command AssignReviewer (ProgramOfficer). INV-3, INV-4, INV-11, INV-12, at most three active. */
export function assignReviewer(deps: Deps, officerId: string, proposalId: string, reviewerId: string): AssignmentRow {
  const e = assignmentEligibility(deps, proposalId, reviewerId);
  if (!e.ok) {
    const first = e.reasons[0]!;
    const status = first.code === 'not_a_reviewer' ? 422 : 409;
    throw Object.assign(
      status === 422 ? unprocessable(first.code, first.message, { rule: first.rule }) : conflict(first.code, first.message, first.rule),
      {},
    );
  }
  const now = deps.clock.now();
  const a: AssignmentRow = {
    id: newId(),
    proposal_id: proposalId,
    reviewer_id: reviewerId,
    status: 'assigned',
    due_at: new Date(now.getTime() + deps.config.reviewPeriodDays * DAY_MS).toISOString(),
    assigned_by: officerId,
    assigned_at: now.toISOString(),
    accepted_at: null,
    completed_at: null,
    overdue_at: null,
    revoked_at: null,
    revoke_reason: null,
  };
  deps.db
    .prepare(`INSERT INTO rev_assignment (id, proposal_id, reviewer_id, status, due_at, assigned_by, assigned_at) VALUES (?, ?, ?, 'assigned', ?, ?, ?)`)
    .run(a.id, a.proposal_id, a.reviewer_id, a.due_at, a.assigned_by, a.assigned_at);
  deps.db.prepare(`INSERT INTO rev_review (id, assignment_id, proposal_id, reviewer_id, status) VALUES (?, ?, ?, ?, 'pending')`).run(newId(), a.id, proposalId, reviewerId);
  deps.bus.publish('ReviewerAssigned', `proposal:${proposalId}`, assignmentPayload(deps, a, officerId, 'assigned by a program officer'), officerId);
  const count = activeAssignments(deps, proposalId).length;
  if (count === REVIEWERS_PER_PROPOSAL) {
    const c = getCase(deps, proposalId)!;
    const payload: ReviewersAssignedData = { proposalId, callId: c.call_id ?? '', reviewerCount: count, at: now.toISOString() };
    deps.bus.publish('ReviewersAssigned', `proposal:${proposalId}`, payload, officerId);
  }
  return a;
}

/** Resolve an assignment the caller holds as reviewer; anyone else's is not found (INV-11). */
function ownAssignment(deps: Deps, reviewerId: string, id: string): AssignmentRow {
  const a = getAssignment(deps, id);
  if (!a || a.reviewer_id !== reviewerId) throw notFound('Assignment');
  return a;
}

/** Read access for the reviewer: a revoked assignment (e.g. after a conflict) no longer exposes the proposal (INV-11). */
function visibleAssignment(deps: Deps, reviewerId: string, id: string): AssignmentRow {
  const a = ownAssignment(deps, reviewerId, id);
  if (a.status === 'revoked') throw notFound('Assignment');
  return a;
}

/** Command AcceptAssignment (Reviewer, own): assigned -> accepted, attesting no conflict. */
export function acceptAssignment(deps: Deps, reviewerId: string, id: string): AssignmentRow {
  const a = ownAssignment(deps, reviewerId, id);
  if (a.status === 'accepted') return a;
  if (a.status !== 'assigned') throw conflict('not_acceptable', `This assignment is ${a.status} and cannot be accepted.`);
  const now = deps.clock.now().toISOString();
  deps.db.prepare(`UPDATE rev_assignment SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'assigned'`).run(now, id);
  deps.bus.publish('AssignmentAccepted', `proposal:${a.proposal_id}`, assignmentPayload(deps, a, reviewerId, 'accepted; reviewer attests no conflict'), reviewerId);
  return getAssignment(deps, id)!;
}

/** Command RevokeAssignment (ProgramOfficer): until the review is submitted. */
export function revokeAssignment(deps: Deps, officerId: string, id: string, reason: string): AssignmentRow {
  const a = getAssignment(deps, id);
  if (!a) throw notFound('Assignment');
  if (a.status === 'revoked') return a;
  if (a.status === 'completed') throw conflict('review_submitted', 'The review for this assignment is already submitted and counts; it cannot be revoked.');
  revoke(deps, a, officerId, reason, { voidSubmitted: false });
  return getAssignment(deps, id)!;
}

/**
 * Command DeclareConflict — by the reviewer for themself (only on proposals they are assigned to),
 * or by a program officer on a reviewer's behalf. ADR-005: revokes any live assignment in this same
 * transaction; voids a submitted review before scoring; after scoring, holds the award.
 */
export function declareConflict(
  deps: Deps,
  actor: { accountId: string; isOfficer: boolean },
  input: { reviewerId: string; proposalId: string; reason: string },
): ConflictDeclaredData {
  if (!actor.isOfficer && input.reviewerId !== actor.accountId) throw forbidden('Reviewers can declare conflicts only for themselves.');
  const pair = deps.db.prepare(`SELECT * FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ? AND status <> 'revoked'`).get(input.proposalId, input.reviewerId) as
    | AssignmentRow
    | undefined;
  if (!actor.isOfficer && !pair) throw notFound('Assignment');
  // review B5: an officer can no longer record a conflict against a proposal or reviewer that does not exist
  if (!getCase(deps, input.proposalId)) throw notFound('Proposal');
  if (actor.isOfficer && !getReviewerStanding(deps, input.reviewerId).exists) throw notFound('Reviewer');
  const now = deps.clock.now().toISOString();
  const existing = deps.db.prepare(`SELECT 1 FROM rev_conflict WHERE reviewer_id = ? AND proposal_id = ?`).get(input.reviewerId, input.proposalId);
  if (!existing) {
    deps.db
      .prepare(`INSERT INTO rev_conflict (reviewer_id, proposal_id, reason, declared_by, declared_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.reviewerId, input.proposalId, input.reason, actor.accountId, now);
  }
  let revokedAssignment: string | null = null;
  let heldAward = false;
  if (pair) {
    const scored = !!deps.db.prepare(`SELECT 1 FROM rev_completion WHERE proposal_id = ?`).get(input.proposalId);
    if (pair.status === 'completed' && scored) {
      heldAward = true; // the review already counted toward a scored proposal: hold the award (ADR-005)
    } else if (revoke(deps, pair, actor.accountId, `conflict of interest declared: ${input.reason}`, { voidSubmitted: true })) {
      revokedAssignment = pair.id;
    }
  }
  const payload: ConflictDeclaredData = {
    reviewerId: input.reviewerId,
    proposalId: input.proposalId,
    reason: input.reason,
    actorId: actor.accountId,
    revokedAssignment,
    heldAward,
    at: now,
  };
  if (!existing || revokedAssignment || heldAward) deps.bus.publish('ConflictDeclared', `proposal:${input.proposalId}`, payload, actor.accountId);
  return payload;
}

/**
 * Command SubmitReview (Reviewer, own accepted/overdue assignment). INV-6: every published criterion
 * scored exactly once, each an integer 1–5; plus the no-conflict attestation (ADR-009).
 */
export function submitReview(
  deps: Deps,
  reviewerId: string,
  assignmentId: string,
  input: { scores: Record<string, number>; comment: string; attestsNoConflict: boolean },
): ReviewSubmittedData {
  const a = ownAssignment(deps, reviewerId, assignmentId);
  if (a.status === 'completed') throw conflict('already_submitted', 'You have already submitted this review. Submitted reviews are final.');
  if (a.status === 'revoked') throw conflict('assignment_revoked', 'This assignment was revoked, so it no longer accepts a review.');
  if (a.status === 'assigned') throw conflict('not_accepted', 'Accept the assignment (confirming you have no conflict) before submitting your review.');
  const c = getCase(deps, a.proposal_id)!;
  const criteria = deps.db.prepare(`SELECT id, name FROM rev_call_criteria WHERE call_id = ? ORDER BY position`).all(c.call_id) as Array<{ id: string; name: string }>;
  if (criteria.length === 0) throw conflict('criteria_unavailable', "This call's scoring criteria have not reached the review service yet. Try again in a moment.", 'INV-6');
  const fields: FieldError[] = [];
  for (const cr of criteria) {
    const v = input.scores[cr.id];
    if (v === undefined || v === null) fields.push({ field: `scores.${cr.id}`, message: `Score "${cr.name}" from 1 to 5.` });
    else if (!Number.isInteger(v) || v < 1 || v > 5) fields.push({ field: `scores.${cr.id}`, message: `"${cr.name}" must be a whole number from 1 to 5.` });
  }
  for (const k of Object.keys(input.scores)) {
    if (!criteria.some((cr) => cr.id === k)) fields.push({ field: `scores.${k}`, message: 'This is not a criterion of this call.' });
  }
  if (input.comment.trim().length < 30) fields.push({ field: 'comment', message: 'Write at least 30 characters of justification for the panel.' });
  if (!input.attestsNoConflict) fields.push({ field: 'attestsNoConflict', message: 'Confirm you have no conflict of interest, or declare one instead.' });
  if (fields.length) throw unprocessable('incomplete_review', 'The review cannot be submitted yet: every criterion needs a score.', { fields, rule: 'INV-6' });

  const review = deps.db.prepare(`SELECT * FROM rev_review WHERE assignment_id = ?`).get(a.id) as ReviewRow;
  const now = deps.clock.now().toISOString();
  const r = deps.db.prepare(`UPDATE rev_assignment SET status = 'completed', completed_at = ? WHERE id = ? AND status IN ('accepted','overdue')`).run(now, a.id);
  if (r.changes !== 1) throw conflict('already_submitted', 'This review was submitted a moment ago.');
  deps.db.prepare(`UPDATE rev_review SET status = 'submitted', comment = ?, submitted_at = ? WHERE id = ? AND status = 'pending'`).run(input.comment.trim(), now, review.id);
  const ins = deps.db.prepare(`INSERT INTO rev_score (review_id, criterion_id, score) VALUES (?, ?, ?)`);
  for (const cr of criteria) ins.run(review.id, cr.id, input.scores[cr.id]);
  const payload: ReviewSubmittedData = { reviewId: review.id, assignmentId: a.id, proposalId: a.proposal_id, reviewerId, at: now };
  deps.bus.publish('ReviewSubmitted', `proposal:${a.proposal_id}`, payload, reviewerId);
  return payload;
}

/**
 * ReviewApi.MarkOverdue — the only writer of the Overdue status (ADR-016), invoked by the
 * ReviewDeadline workflow's realization (the sweeper below), which then publishes ReviewOverdue.
 */
export function markOverdue(deps: Deps, assignmentId: string): boolean {
  const now = deps.clock.now().toISOString();
  const r = deps.db
    .prepare(`UPDATE rev_assignment SET status = 'overdue', overdue_at = ? WHERE id = ? AND status IN ('assigned','accepted') AND due_at <= ?`)
    .run(now, assignmentId, now);
  return r.changes === 1;
}

// ------------------------------------------------------------------ reactions

export function peerReviewConsumer(deps: Deps): Consumer {
  return {
    name: 'peer-review.assignment-service',
    realizes: '::Quorum.ResearchFunding.PeerReview.AssignmentService',
    handles: {
      // on CallPublished -> none: snapshot the criteria (fixed once the call opens)
      CallPublished: (db, e: StoredEvent<CallPublishedData & { guidance?: string[] }>) => {
        const ins = db.prepare(`INSERT OR IGNORE INTO rev_call_criteria (call_id, id, position, name, guidance) VALUES (?, ?, ?, ?, ?)`);
        e.payload.criteria.forEach((c, i) => ins.run(e.payload.callId, c.criterionId, i + 1, c.name, e.payload.guidance?.[i] ?? ''));
      },
      // on ProposalEligible -> none: the proposal becomes assignable
      ProposalEligible: (db, e: StoredEvent<EligibleData>) => {
        db.prepare(
          `INSERT INTO rev_case (proposal_id, call_id, applicant_id, status, opened_at) VALUES (?, ?, ?, 'open', ?)
           ON CONFLICT (proposal_id) DO UPDATE SET call_id = excluded.call_id, applicant_id = excluded.applicant_id`,
        ).run(e.payload.proposalId, e.payload.callId, e.payload.applicantId, e.occurredAt);
      },
      // on ProposalWithdrawn -> AssignmentRevoked
      ProposalWithdrawn: (db, e: StoredEvent<ProposalTransition>) => {
        db.prepare(
          `INSERT INTO rev_case (proposal_id, call_id, applicant_id, status, opened_at) VALUES (?, ?, NULL, 'withdrawn', ?)
           ON CONFLICT (proposal_id) DO UPDATE SET status = 'withdrawn'`,
        ).run(e.payload.proposalId, e.payload.callId, e.occurredAt);
        for (const a of activeAssignments(deps, e.payload.proposalId)) {
          if (a.status !== 'completed') revoke(deps, a, PLATFORM_ACTOR, 'the proposal was withdrawn by its applicant', { voidSubmitted: false });
        }
      },
      // on AccountErased -> AssignmentRevoked (ADR-023, BDL RevokeOnErasure / obligation ReleaseErasedReviewersWork)
      AccountErased: (_db, e: StoredEvent<AccountErasedData>) => {
        releaseErasedReviewersWork(deps, e.payload.accountId);
      },
    },
  };
}

/**
 * ADR-023: an erased account holds no outstanding work. Revokes every assigned, accepted or overdue
 * assignment of the reviewer through the same revoke() the withdrawal and conflict paths use (conditional
 * update, pending review voided, AssignmentRevoked published), so each proposal's place reopens for the
 * officer's ordinary AssignReviewer. Completed assignments and their reviews are business records and are
 * never touched; nor is any row deleted. Safe to retry: a second run finds nothing outstanding.
 */
export function releaseErasedReviewersWork(deps: Deps, reviewerId: string): number {
  const outstanding = deps.db
    .prepare(`SELECT * FROM rev_assignment WHERE reviewer_id = ? AND status IN ('assigned','accepted','overdue') ORDER BY assigned_at`)
    .all(reviewerId) as AssignmentRow[];
  let n = 0;
  for (const a of outstanding) if (revoke(deps, a, PLATFORM_ACTOR, REVOKED_ON_ERASURE, { voidSubmitted: false })) n++;
  return n;
}

// ------------------------------------------------------------------ queries

export type PeerReviewView = {
  proposalId: string;
  visible: boolean;
  lockedReason: string | null;
  criteria: Array<{ id: string; name: string; guidance: string }>;
  reviews: Array<{ reviewId: string; label: string; reviewerId: string | null; reviewerName: string | null; own: boolean; submittedAt: string; comment: string; scores: Record<string, number>; mean: number }>;
};

/**
 * ReviewApi.GetPeerReviews — INV-7 is enforced HERE, in the query, not in the UI. A reviewer gets
 * nothing about other reviews until their own review of the proposal is submitted. Officers and
 * chairs see every counted review with reviewer names; reviewers see peers as "Reviewer B".
 */
export function getPeerReviews(deps: Deps, viewer: { accountId: string; canSeeAll: boolean }, proposalId: string, names: (ids: string[]) => Map<string, { name: string }>): PeerReviewView {
  const c = getCase(deps, proposalId);
  const criteria = c?.call_id
    ? (deps.db.prepare(`SELECT id, name, guidance FROM rev_call_criteria WHERE call_id = ? ORDER BY position`).all(c.call_id) as PeerReviewView['criteria'])
    : [];
  if (!viewer.canSeeAll) {
    const mine = deps.db.prepare(`SELECT * FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ? AND status <> 'revoked'`).get(proposalId, viewer.accountId) as
      | AssignmentRow
      | undefined;
    if (!mine) throw notFound('Proposal');
    if (mine.status !== 'completed') {
      return { proposalId, visible: false, lockedReason: 'Other reviews stay hidden until you submit your own (INV-7).', criteria, reviews: [] };
    }
  }
  const rows = deps.db
    .prepare(
      `SELECT r.* FROM rev_review r JOIN rev_assignment a ON a.id = r.assignment_id
        WHERE r.proposal_id = ? AND r.status = 'submitted' AND r.voided_at IS NULL AND a.status <> 'revoked' ORDER BY r.submitted_at`,
    )
    .all(proposalId) as ReviewRow[];
  const nm = viewer.canSeeAll ? names(rows.map((r) => r.reviewer_id)) : new Map();
  const reviews = rows.map((r, i) => {
    const scores = Object.fromEntries(
      (deps.db.prepare(`SELECT criterion_id, score FROM rev_score WHERE review_id = ?`).all(r.id) as Array<{ criterion_id: string; score: number }>).map((s) => [s.criterion_id, s.score]),
    );
    const vals = Object.values(scores) as number[];
    const own = r.reviewer_id === viewer.accountId;
    return {
      reviewId: r.id,
      label: own ? 'Your review' : `Reviewer ${String.fromCharCode(65 + i)}`,
      reviewerId: viewer.canSeeAll ? r.reviewer_id : null,
      reviewerName: viewer.canSeeAll ? (nm.get(r.reviewer_id)?.name ?? null) : null,
      own,
      submittedAt: r.submitted_at!,
      comment: r.comment ?? '',
      scores,
      mean: vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0,
    };
  });
  return { proposalId, visible: true, lockedReason: null, criteria, reviews };
}

export function assignmentsForReviewer(deps: Deps, reviewerId: string) {
  return deps.db.prepare(`SELECT * FROM rev_assignment WHERE reviewer_id = ? ORDER BY CASE status WHEN 'revoked' THEN 1 ELSE 0 END, due_at`).all(reviewerId) as AssignmentRow[];
}

export function assignmentsForProposal(deps: Deps, proposalId: string) {
  return deps.db.prepare(`SELECT * FROM rev_assignment WHERE proposal_id = ? ORDER BY assigned_at`).all(proposalId) as AssignmentRow[];
}

export function assignmentDetail(deps: Deps, reviewerId: string, id: string) {
  const a = visibleAssignment(deps, reviewerId, id);
  const c = getCase(deps, a.proposal_id);
  const criteria = c?.call_id ? (deps.db.prepare(`SELECT id, name, guidance FROM rev_call_criteria WHERE call_id = ? ORDER BY position`).all(c.call_id) as PeerReviewView['criteria']) : [];
  const review = deps.db.prepare(`SELECT * FROM rev_review WHERE assignment_id = ?`).get(a.id) as ReviewRow | undefined;
  const scores = review
    ? Object.fromEntries((deps.db.prepare(`SELECT criterion_id, score FROM rev_score WHERE review_id = ?`).all(review.id) as Array<{ criterion_id: string; score: number }>).map((s) => [s.criterion_id, s.score]))
    : {};
  return { assignment: a, criteria, review: review ? { id: review.id, status: review.status, comment: review.comment, submittedAt: review.submitted_at, scores } : null };
}

export function conflictsForProposal(deps: Deps, proposalId: string) {
  return deps.db.prepare(`SELECT reviewer_id AS reviewerId, reason, declared_by AS declaredBy, declared_at AS declaredAt FROM rev_conflict WHERE proposal_id = ?`).all(proposalId) as Array<{
    reviewerId: string;
    reason: string;
    declaredBy: string;
    declaredAt: string;
  }>;
}

export function overdueAssignments(deps: Deps) {
  return deps.db.prepare(`SELECT * FROM rev_assignment WHERE status = 'overdue' ORDER BY due_at`).all() as AssignmentRow[];
}

export function openCases(deps: Deps) {
  return deps.db
    .prepare(
      `SELECT c.proposal_id AS proposalId,
              (SELECT COUNT(*) FROM rev_assignment a WHERE a.proposal_id = c.proposal_id AND a.status <> 'revoked') AS active,
              (SELECT COUNT(*) FROM rev_assignment a WHERE a.proposal_id = c.proposal_id AND a.status = 'completed') AS completed
         FROM rev_case c WHERE c.status = 'open'`,
    )
    .all() as Array<{ proposalId: string; active: number; completed: number }>;
}
