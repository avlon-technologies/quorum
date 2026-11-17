/**
 * ADR-023 — account erasure clears ORCID verification and releases the erased reviewer's outstanding work.
 *
 *   BDL sm-q002  ClearOnErasure (t-q003): Verified → Unverified, triggered only by EraseAccount. No
 *                verification act leaves Verified.
 *   BDL ac-q027  RevokeOnErasure / obligation ReleaseErasedReviewersWork (o-q005): every assigned, accepted or
 *                overdue assignment of the erased account is revoked, its pending review voided, and the place
 *                reopens for the officer's ordinary AssignReviewer. Completed reviews and history are kept.
 *   r-q012       unchanged: eligibility at assignment time only.
 *
 * Every erasure goes through the real operator route; the cleanup runs as AssignmentService's reaction to
 * AccountErased through the real outbox dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, DAY_MS, type World, type User } from '../support/harness.ts';
import { sweepOverdue } from '../../src/contexts/peer-review/review-deadline.ts';
import { acceptAssignment, releaseErasedReviewersWork } from '../../src/contexts/peer-review/service.ts';
import { REVOKED_ON_ERASURE } from '../../src/contracts/review-rules.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => {
  h.deps.bus.faultInjector = undefined;
  await h.close();
});

const REASON = 'Data subject request #318: reviewer asked to be forgotten.';

async function drainWithRetries(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    h.clock.advance(61_000);
    await h.settle();
  }
}

const erase = (w: World, who: User) => h.post(`/api/operations/accounts/${who.id}/erase`, w.operator, { reason: REASON });
const orcidOf = (u: User) => h.one<{ orcid_status: string; orcid_id: string | null }>(`SELECT orcid_status, orcid_id FROM idn_account WHERE id = ?`, u.id);
const assignmentOf = (proposalId: string, u: User) =>
  h.one<{ id: string; status: string; revoke_reason: string | null }>(`SELECT id, status, revoke_reason FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, proposalId, u.id);
const outstanding = (u: User) => h.one<{ n: number }>(`SELECT COUNT(*) n FROM rev_assignment WHERE reviewer_id = ? AND status IN ('assigned','accepted','overdue')`, u.id).n;

/**
 * The erased reviewer r0 holds one assignment in each state:
 *   pOverdue   r0 overdue    (with r1, r2)
 *   pAssigned  r0 assigned   (with r3, r4)
 *   pAccepted  r0 accepted   (with r1, r3)
 *   pDone      r0 completed  (with r2, r4) — a submitted review that counts, proposal still under review
 */
async function reviewerWithEveryKindOfWork(w: World) {
  const [r0, r1, r2, r3, r4] = w.r as [User, User, User, User, User];
  const pOverdue = await h.underReview(w, [r0, r1, r2], w.alice);
  h.clock.advance(22 * DAY_MS);
  expect(sweepOverdue(h.deps)).toBe(3);
  await h.settle();
  const pAssigned = await h.underReview(w, [r0, r3, r4], w.bob);
  const pAccepted = await h.underReview(w, [r0, r1, r3], w.alice);
  h.tx(() => acceptAssignment(h.deps, r0.id, assignmentOf(pAccepted, r0).id));
  const pDone = await h.underReview(w, [r0, r2, r4], w.bob);
  h.review(w, pDone, r0);
  await h.settle();
  expect(assignmentOf(pOverdue, r0).status).toBe('overdue');
  expect(assignmentOf(pAssigned, r0).status).toBe('assigned');
  expect(assignmentOf(pAccepted, r0).status).toBe('accepted');
  expect(assignmentOf(pDone, r0).status).toBe('completed');
  return { r0, r1, r2, r3, r4, pOverdue, pAssigned, pAccepted, pDone };
}

describe('ADR-023: erasing a reviewer through the operator route', () => {
  it('clears ORCID verification (Verified → Unverified) in the erasing transaction', async () => {
    const w = h.world();
    const r0 = w.r[0]!;
    expect(orcidOf(r0).orcid_status).toBe('verified');
    const r = await erase(w, r0);
    expect(r.status).toBe(200);
    expect(r.body.erased).toBe(true);
    // before any reaction is delivered: the field changed with the erasure itself
    expect(orcidOf(r0)).toEqual({ orcid_status: 'unverified', orcid_id: null });
    expect(h.one(`SELECT orcid_verified_at FROM idn_account WHERE id = ?`, r0.id).orcid_verified_at).toBeNull();
    expect(h.count('AccountErased', { accountId: r0.id })).toBe(1);
  });

  it('closes every outstanding assignment, keeps the completed review and the whole assignment history', async () => {
    const w = h.world({ deadlineDays: 90 });
    const s = await reviewerWithEveryKindOfWork(w);
    const before = {
      assignments: h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE reviewer_id = ?`, s.r0.id).n,
      reviews: h.one(`SELECT COUNT(*) n FROM rev_review WHERE reviewer_id = ?`, s.r0.id).n,
      scores: h.one(`SELECT COUNT(*) n FROM rev_score sc JOIN rev_review r ON r.id = sc.review_id WHERE r.reviewer_id = ?`, s.r0.id).n,
      done: h.one(`SELECT id, status, comment, submitted_at FROM rev_review WHERE proposal_id = ? AND reviewer_id = ?`, s.pDone, s.r0.id),
    };
    expect(before.assignments).toBe(4);

    expect((await erase(w, s.r0)).status).toBe(200);
    await h.settle();

    // outstanding work is closed through the ordinary revocation
    expect(outstanding(s.r0)).toBe(0);
    for (const p of [s.pOverdue, s.pAssigned, s.pAccepted]) {
      expect(assignmentOf(p, s.r0)).toMatchObject({ status: 'revoked', revoke_reason: REVOKED_ON_ERASURE });
      const rv = h.one(`SELECT status, voided_at FROM rev_review WHERE proposal_id = ? AND reviewer_id = ?`, p, s.r0.id);
      expect(rv.status).toBe('pending');
      expect(rv.voided_at).not.toBeNull();
    }
    expect(h.count('AssignmentRevoked', { reviewerId: s.r0.id })).toBe(3);

    // the completed review is untouched and still counts
    expect(assignmentOf(s.pDone, s.r0).status).toBe('completed');
    const done = h.one(`SELECT id, status, comment, submitted_at, voided_at FROM rev_review WHERE proposal_id = ? AND reviewer_id = ?`, s.pDone, s.r0.id);
    expect(done).toMatchObject({ ...before.done, voided_at: null });
    const peers = await h.get(`/api/proposals/${s.pDone}/reviews`, w.officer);
    expect(peers.status).toBe(200);
    expect(peers.body.reviews.map((r: { reviewId: string }) => r.reviewId)).toContain(before.done.id);

    // history is kept: nothing deleted
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE reviewer_id = ?`, s.r0.id).n).toBe(before.assignments);
    expect(h.one(`SELECT COUNT(*) n FROM rev_review WHERE reviewer_id = ?`, s.r0.id).n).toBe(before.reviews);
    expect(h.one(`SELECT COUNT(*) n FROM rev_score sc JOIN rev_review r ON r.id = sc.review_id WHERE r.reviewer_id = ?`, s.r0.id).n).toBe(before.scores);
    const listed = await h.get(`/api/proposals/${s.pAssigned}/assignments`, w.officer);
    expect(listed.body.assignments.find((a: { reviewer_id: string }) => a.reviewer_id === s.r0.id)).toMatchObject({ status: 'revoked' });
    // the audit trail records each revocation
    expect(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE event = 'AssignmentRevoked' AND instr(COALESCE(reason, ''), ?) > 0`, REVOKED_ON_ERASURE).n).toBe(3);
  });

  it('makes the work available for reassignment through the ordinary AssignReviewer route, and tells the officers', async () => {
    const w = h.world({ deadlineDays: 90 });
    const s = await reviewerWithEveryKindOfWork(w);
    const extra = h.account('Rhea Replacement', ['reviewer'], { verified: true });
    // before: every panel is full
    for (const p of [s.pOverdue, s.pAssigned, s.pAccepted]) {
      const full = await h.post(`/api/proposals/${p}/assignments`, w.officer, { reviewerId: extra.id });
      expect(full.status).toBe(409);
      expect(full.body.error.code).toBe('panel_full');
    }

    expect((await erase(w, s.r0)).status).toBe(200);
    await h.settle();

    for (const p of [s.pOverdue, s.pAssigned, s.pAccepted]) {
      const ok = await h.post(`/api/proposals/${p}/assignments`, w.officer, { reviewerId: extra.id });
      expect(ok.status).toBe(201);
      expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND status <> 'revoked'`, p).n).toBe(3);
    }
    // the completed review's proposal had no place to release
    const none = await h.post(`/api/proposals/${s.pDone}/assignments`, w.officer, { reviewerId: extra.id });
    expect(none.body.error?.code).toBe('panel_full');
    // and the erased account itself can never be put back
    const back = await h.post(`/api/proposals/${s.pAssigned}/assignments`, w.officer, { reviewerId: s.r0.id });
    expect(back.status).toBeGreaterThanOrEqual(400);

    // officers are asked for a replacement; nothing is ever written to the erased account
    expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE recipient = 'role:programOfficer' AND subject LIKE 'Replacement reviewer needed:%'`).n).toBe(3);
    expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE recipient = ?`, s.r0.id).n).toBe(0);
  });

  it('the cleanup is safe to retry: a failed reaction rolls back and is redelivered; repeats change nothing', async () => {
    const w = h.world({ deadlineDays: 90 });
    const r0 = w.r[0]!;
    const p = await h.underReview(w, [r0, w.r[1]!, w.r[2]!]);
    let failing = true;
    h.deps.bus.faultInjector = (c, e) => {
      if (failing && c === 'peer-review.assignment-service' && e.type === 'AccountErased') throw new Error('peer-review outage (injected)');
    };
    expect((await erase(w, r0)).status).toBe(200);
    await h.settle();
    // the failed delivery rolled back with its effect: still outstanding, nothing published
    expect(assignmentOf(p, r0).status).toBe('assigned');
    expect(h.count('AssignmentRevoked')).toBe(0);
    failing = false;
    await drainWithRetries();
    expect(assignmentOf(p, r0).status).toBe('revoked');
    expect(h.count('AssignmentRevoked', { reviewerId: r0.id })).toBe(1);
    expect(h.one(`SELECT status FROM evt_delivery d JOIN evt_outbox o ON o.message_id = d.message_id WHERE d.consumer = 'peer-review.assignment-service' AND o.type = 'AccountErased'`).status).toBe('delivered');

    // a repeated cleanup (redelivery) and a repeated erasure request change nothing
    const events = h.totalEvents();
    expect(h.tx(() => releaseErasedReviewersWork(h.deps, r0.id))).toBe(0);
    const again = await erase(w, r0);
    expect(again.status).toBe(200);
    expect(again.body.erased).toBe(false);
    await h.settle();
    expect(h.totalEvents()).toBe(events);
    expect(h.count('AssignmentRevoked', { reviewerId: r0.id })).toBe(1);
    expect(orcidOf(r0).orcid_status).toBe('unverified');
  });

  it('erasing an unverified reviewer makes no ORCID transition', async () => {
    const w = h.world();
    expect(orcidOf(w.unverified).orcid_status).toBe('unverified');
    expect((await erase(w, w.unverified)).status).toBe(200);
    expect(orcidOf(w.unverified).orcid_status).toBe('unverified');
  });
});

describe('ADR-023: the ordinary verification workflow still never leaves Verified', () => {
  it('a verified reviewer cannot re-verify with another iD; the same iD is a no-op; the status stays Verified', async () => {
    const w = h.world();
    const r0 = w.r[0]!;
    const { orcid_id: mine } = orcidOf(r0);
    const verifiedEvents = h.count('OrcidVerified');

    const other = await h.post('/api/me/orcid', r0, { orcidId: '0000-0002-1825-0097' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('orcid_already_verified');
    expect(orcidOf(r0)).toEqual({ orcid_status: 'verified', orcid_id: mine });

    const unknown = await h.post('/api/me/orcid', r0, { orcidId: '0000-0003-1415-9269' }); // the registry has no record
    expect(unknown.status).toBe(422);
    expect(orcidOf(r0)).toEqual({ orcid_status: 'verified', orcid_id: mine });

    const same = await h.post('/api/me/orcid', r0, { orcidId: mine });
    expect(same.status).toBe(200);
    expect(orcidOf(r0)).toEqual({ orcid_status: 'verified', orcid_id: mine });
    expect(h.count('OrcidVerified')).toBe(verifiedEvents);
  });

  it('the erased account cannot use the verification route to become Verified again', async () => {
    const w = h.world();
    const r0 = w.r[0]!;
    const token = await h.token(r0);
    expect((await erase(w, r0)).status).toBe(200);
    const r = await h.post('/api/me/orcid', token, { orcidId: '0000-0002-1825-0097' });
    expect(r.status).toBe(401);
    expect(orcidOf(r0).orcid_status).toBe('unverified');
  });
});
