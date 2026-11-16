/**
 * Submission — realizes ::Quorum.ResearchFunding.Submission.ProposalService.
 * THE single writer of Proposal.status (ADR-001). Every transition is a conditional update on the
 * expected prior status; a late event against a status that has moved on is a logged no-op.
 */
import type { Deps } from '../../platform/deps.ts';
import { PLATFORM_ACTOR, toDecimal } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import { newId } from '../../platform/ids.ts';
import { conflict, notFound, unprocessable, type FieldError } from '../../platform/errors.ts';
import { getCallStatus } from '../calls/api.ts';
import type {
  ProposalStatus,
  ProposalSubmittedData,
  ProposalTransition,
  EligibleData,
  ScoredData,
  ReviewersAssignedData,
  FullyReviewedData,
  DecisionData,
} from '../../contracts/model.generated.ts';

export type ProposalRow = {
  id: string;
  number: number;
  call_id: string;
  applicant_id: string;
  title: string;
  abstract: string;
  requested_minor: number;
  status: ProposalStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  status_reason: string | null;
};

export const WITHDRAWABLE: ProposalStatus[] = ['draft', 'submitted', 'screening', 'eligible', 'underReview'];
export const ref = (n: number) => `Q-${String(n).padStart(4, '0')}`;

export function getRow(deps: Deps, id: string): ProposalRow | undefined {
  return deps.db.prepare(`SELECT * FROM sub_proposal WHERE id = ?`).get(id) as ProposalRow | undefined;
}

/** Resolve a proposal the caller may act on as applicant: someone else's is reported as not found (INV-11). */
function ownProposal(deps: Deps, applicantId: string, id: string): ProposalRow {
  const p = getRow(deps, id);
  if (!p || p.applicant_id !== applicantId) throw notFound('Proposal');
  return p;
}

/**
 * The one place a status changes. Returns false (and changes nothing) if the proposal is not in
 * `from` — the conditional update is what makes racing events and commands safe.
 */
function transition(deps: Deps, p: ProposalRow, from: ProposalStatus[], to: ProposalStatus, reason: string | null): boolean {
  const now = deps.clock.now().toISOString();
  const r = deps.db
    .prepare(
      `UPDATE sub_proposal SET status = ?, status_reason = ?, updated_at = ? ${to === 'submitted' ? ', submitted_at = ?' : ''}
        WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
    )
    .run(...[to, reason, now, ...(to === 'submitted' ? [now] : []), p.id, ...from]);
  return r.changes === 1;
}

function transitionPayload(deps: Deps, p: ProposalRow, from: ProposalStatus, to: ProposalStatus, actorId: string, reason: string): ProposalTransition {
  return { proposalId: p.id, callId: p.call_id, fromStatus: from, toStatus: to, actorId, reason, at: deps.clock.now().toISOString() };
}

// ------------------------------------------------------------------ commands

type DraftInput = { callId: string; title: string; abstract: string; requested: number };

/** Command SaveDraft (Applicant): create. */
export function createDraft(deps: Deps, applicantId: string, input: DraftInput): ProposalRow {
  const call = getCallStatus(deps, input.callId);
  if (!call) throw unprocessable('unknown_call', 'Choose an open call.', { fields: [{ field: 'callId', message: 'No such call.' }] });
  if (call.status !== 'open') throw conflict('call_closed', 'This call is closed and no longer accepts proposals.', 'INV-1');
  const id = newId();
  const now = deps.clock.now().toISOString();
  const number = ((deps.db.prepare(`SELECT MAX(number) m FROM sub_proposal`).get() as { m: number | null }).m ?? 400) + 1;
  deps.db
    .prepare(
      `INSERT INTO sub_proposal (id, number, call_id, applicant_id, title, abstract, requested_minor, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(id, number, input.callId, applicantId, input.title.trim(), input.abstract.trim(), Math.round(input.requested * 100), now, now);
  return getRow(deps, id)!;
}

/** Command SaveDraft (Applicant): update. Only a draft can be edited (INV-2). */
export function updateDraft(deps: Deps, applicantId: string, id: string, input: Omit<DraftInput, 'callId'>): ProposalRow {
  const p = ownProposal(deps, applicantId, id);
  if (p.status !== 'draft') throw conflict('not_a_draft', `${ref(p.number)} has been submitted and can no longer be edited.`, 'INV-2');
  deps.db
    .prepare(`UPDATE sub_proposal SET title = ?, abstract = ?, requested_minor = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
    .run(input.title.trim(), input.abstract.trim(), Math.round(input.requested * 100), deps.clock.now().toISOString(), id);
  return getRow(deps, id)!;
}

/** What a proposal must satisfy to be submitted, reported field by field (NFR-7). */
export function submissionProblems(p: ProposalRow, maxRequestMinor: number): FieldError[] {
  const f: FieldError[] = [];
  if (p.title.trim().length < 10) f.push({ field: 'title', message: 'Give the proposal a title of at least 10 characters.' });
  if (p.abstract.trim().length < 200) f.push({ field: 'abstract', message: `The abstract needs at least 200 characters (it has ${p.abstract.trim().length}).` });
  if (p.requested_minor <= 0) f.push({ field: 'requested', message: 'Enter the amount you are requesting.' });
  else if (p.requested_minor > maxRequestMinor) {
    f.push({ field: 'requested', message: `The call allows at most ${toDecimal(maxRequestMinor)} per proposal.` });
  }
  return f;
}

/**
 * Command SubmitProposal (Applicant). INV-1: the call is open and now < deadline, read from the call
 * store inside this transaction (ADR-003). INV-2: only a draft moves to submitted, exactly once.
 */
export function submitProposal(deps: Deps, applicant: { accountId: string; name: string }, id: string): ProposalRow {
  const p = ownProposal(deps, applicant.accountId, id);
  if (p.status !== 'draft') {
    throw conflict('already_submitted', `${ref(p.number)} was already submitted${p.submitted_at ? ` on ${p.submitted_at.slice(0, 10)}` : ''}. A proposal can be submitted only once.`, 'INV-2');
  }
  const call = getCallStatus(deps, p.call_id);
  if (!call || call.status !== 'open') throw conflict('call_closed', 'This call has been closed by the funding body; it no longer accepts submissions.', 'INV-1');
  const now = deps.clock.now();
  if (now.getTime() >= new Date(call.deadline).getTime()) {
    throw conflict('deadline_passed', `The deadline for this call passed at ${call.deadline}. Late submissions are not accepted.`, 'INV-1');
  }
  const problems = submissionProblems(p, call.maxRequestMinor);
  if (problems.length) throw unprocessable('incomplete_proposal', 'The proposal is not ready to submit.', { fields: problems });
  if (!transition(deps, p, ['draft'], 'submitted', null)) throw conflict('already_submitted', 'This proposal was submitted a moment ago.', 'INV-2');
  const payload: ProposalSubmittedData = {
    proposalId: p.id,
    callId: p.call_id,
    applicantId: p.applicant_id,
    applicantName: applicant.name,
    title: p.title,
    requested: toDecimal(p.requested_minor),
    at: now.toISOString(),
  };
  deps.bus.publish('ProposalSubmitted', `proposal:${p.id}`, { ...payload, number: p.number }, applicant.accountId);
  return getRow(deps, id)!;
}

/** Command WithdrawProposal (Applicant): from any state before scored. Terminal. */
export function withdrawProposal(deps: Deps, applicantId: string, id: string, reason: string): ProposalRow {
  const p = ownProposal(deps, applicantId, id);
  if (!WITHDRAWABLE.includes(p.status)) {
    throw conflict('not_withdrawable', `${ref(p.number)} is ${p.status} and can no longer be withdrawn; withdrawal is possible only before scoring.`);
  }
  if (!transition(deps, p, WITHDRAWABLE, 'withdrawn', reason)) throw conflict('not_withdrawable', 'The proposal changed state a moment ago; reload and try again.');
  deps.bus.publish('ProposalWithdrawn', `proposal:${p.id}`, transitionPayload(deps, p, p.status, 'withdrawn', applicantId, reason), applicantId);
  return getRow(deps, id)!;
}

/**
 * Command ConfirmEligibility (ProgramOfficer) — the human decision that moves a proposal out of
 * screening (INV-10). The agent's verdict is advice; disagreeing with it requires a reason.
 */
export function confirmEligibility(deps: Deps, officerId: string, id: string, outcome: 'eligible' | 'ineligible', reason: string): ProposalRow {
  const p = getRow(deps, id);
  if (!p) throw notFound('Proposal');
  if (p.status !== 'screening') {
    throw conflict('not_in_screening', `${ref(p.number)} is ${p.status}; only a proposal in screening can be screened.`, 'INV-10');
  }
  const triage = deps.db.prepare(`SELECT verdict FROM sub_triage WHERE proposal_id = ?`).get(id) as { verdict: string | null } | undefined;
  const agreed = triage?.verdict ? (triage.verdict === outcome ? 1 : 0) : null;
  if ((outcome === 'ineligible' || agreed === 0) && reason.trim().length < 10) {
    throw unprocessable('reason_required', 'Explain this decision: screening a proposal out, or overriding the triage agent, needs a reason the applicant can be given.', {
      fields: [{ field: 'reason', message: 'At least 10 characters.' }],
    });
  }
  const now = deps.clock.now().toISOString();
  if (!transition(deps, p, ['screening'], outcome, reason || null)) throw conflict('not_in_screening', 'The proposal changed state a moment ago; reload and try again.');
  deps.db
    .prepare(`INSERT INTO sub_screening (proposal_id, outcome, agreed_with_agent, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, outcome, agreed, reason, officerId, now);
  if (outcome === 'eligible') {
    const payload: EligibleData = { proposalId: p.id, callId: p.call_id, applicantId: p.applicant_id, actorId: officerId, reason, at: now };
    deps.bus.publish('ProposalEligible', `proposal:${p.id}`, payload, officerId);
  } else {
    deps.bus.publish('ProposalIneligible', `proposal:${p.id}`, transitionPayload(deps, p, 'screening', 'ineligible', officerId, reason), officerId);
  }
  return getRow(deps, id)!;
}

// ------------------------------------------------------------------ reactions (the ADL `on X -> …` of ProposalService)

function react(deps: Deps, e: StoredEvent, proposalId: string, from: ProposalStatus[], to: ProposalStatus, reason: string, publish: (p: ProposalRow) => void) {
  const p = getRow(deps, proposalId);
  if (!p) return;
  if (!transition(deps, p, from, to, reason)) {
    // A late or duplicate event against a status that has moved on: recorded, never applied (ADR-001).
    console.info(`[submission] ${e.type} ${e.messageId} ignored: ${ref(p.number)} is ${p.status}, expected ${from.join('|')}`);
    return;
  }
  publish({ ...p, status: from.includes(p.status) ? p.status : from[0]! });
}

export function submissionConsumer(deps: Deps): Consumer {
  return {
    name: 'submission.proposal-service',
    realizes: '::Quorum.ResearchFunding.Submission.ProposalService',
    handles: {
      // on ProposalSubmitted -> independent ProposalEnteredScreening  (screening never waits for the agent: ADR-011)
      ProposalSubmitted: (_db, e: StoredEvent<ProposalSubmittedData>) =>
        react(deps, e, e.payload.proposalId, ['submitted'], 'screening', 'automatic intake', (p) =>
          deps.bus.publish('ProposalEnteredScreening', `proposal:${p.id}`, transitionPayload(deps, p, 'submitted', 'screening', PLATFORM_ACTOR, 'Submitted proposals enter screening automatically.'), PLATFORM_ACTOR, e.messageId),
        ),
      // on ReviewersAssigned -> independent ProposalUnderReview (a replacement third reviewer is a no-op)
      ReviewersAssigned: (_db, e: StoredEvent<ReviewersAssignedData>) =>
        react(deps, e, e.payload.proposalId, ['eligible'], 'underReview', 'three reviewers assigned', (p) =>
          deps.bus.publish('ProposalUnderReview', `proposal:${p.id}`, transitionPayload(deps, p, 'eligible', 'underReview', PLATFORM_ACTOR, 'Three reviewers are assigned.'), PLATFORM_ACTOR, e.messageId),
        ),
      // on ProposalFullyReviewed -> independent ProposalScored (INV-5: only PeerReview's completion ledger publishes it)
      ProposalFullyReviewed: (_db, e: StoredEvent<FullyReviewedData>) =>
        react(deps, e, e.payload.proposalId, ['underReview'], 'scored', `mean score ${e.payload.meanScore}`, (p) => {
          const payload: ScoredData & { number: number } = {
            proposalId: p.id,
            callId: p.call_id,
            title: p.title,
            requested: toDecimal(p.requested_minor),
            meanScore: e.payload.meanScore,
            at: deps.clock.now().toISOString(),
            number: p.number,
          };
          deps.bus.publish('ProposalScored', `proposal:${p.id}`, payload, PLATFORM_ACTOR, e.messageId);
        }),
      // on ProposalAwarded / ProposalDeclined -> none
      ProposalAwarded: (_db, e: StoredEvent<DecisionData>) => react(deps, e, e.payload.proposalId, ['scored'], 'awarded', e.payload.rationale, () => {}),
      ProposalDeclined: (_db, e: StoredEvent<DecisionData>) => react(deps, e, e.payload.proposalId, ['scored'], 'declined', e.payload.rationale, () => {}),
    },
  };
}

// ------------------------------------------------------------------ queries

export type ProposalView = {
  id: string;
  reference: string;
  number: number;
  callId: string;
  applicantId: string;
  title: string;
  abstract: string;
  requestedMinor: number;
  status: ProposalStatus;
  statusReason: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  triage: { verdict: string | null; rationale: string; provider: string; recordedAt: string } | null;
  screening: { outcome: string; agreedWithAgent: boolean | null; reason: string; decidedBy: string; decidedAt: string } | null;
};

export function toView(deps: Deps, p: ProposalRow): ProposalView {
  const t = deps.db.prepare(`SELECT verdict, rationale, provider, recorded_at FROM sub_triage WHERE proposal_id = ?`).get(p.id) as
    | { verdict: string | null; rationale: string; provider: string; recorded_at: string }
    | undefined;
  const s = deps.db.prepare(`SELECT * FROM sub_screening WHERE proposal_id = ?`).get(p.id) as
    | { outcome: string; agreed_with_agent: number | null; reason: string; decided_by: string; decided_at: string }
    | undefined;
  return {
    id: p.id,
    reference: ref(p.number),
    number: p.number,
    callId: p.call_id,
    applicantId: p.applicant_id,
    title: p.title,
    abstract: p.abstract,
    requestedMinor: p.requested_minor,
    status: p.status,
    statusReason: p.status_reason,
    submittedAt: p.submitted_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    triage: t ? { verdict: t.verdict, rationale: t.rationale, provider: t.provider, recordedAt: t.recorded_at } : null,
    screening: s
      ? { outcome: s.outcome, agreedWithAgent: s.agreed_with_agent === null ? null : s.agreed_with_agent === 1, reason: s.reason, decidedBy: s.decided_by, decidedAt: s.decided_at }
      : null,
  };
}

export function listProposals(deps: Deps, filter: { applicantId?: string; status?: ProposalStatus[]; callId?: string; ids?: string[] } = {}): ProposalView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.applicantId) (where.push('applicant_id = ?'), args.push(filter.applicantId));
  if (filter.callId) (where.push('call_id = ?'), args.push(filter.callId));
  if (filter.status?.length) (where.push(`status IN (${filter.status.map(() => '?').join(',')})`), args.push(...filter.status));
  if (filter.ids) {
    if (filter.ids.length === 0) return [];
    where.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
    args.push(...filter.ids);
  }
  if (!filter.applicantId) where.push(`status <> 'draft'`); // drafts are private to their applicant
  const rows = deps.db.prepare(`SELECT * FROM sub_proposal ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY number DESC`).all(...args) as ProposalRow[];
  return rows.map((r) => toView(deps, r));
}

export function getProposal(deps: Deps, id: string): ProposalView | null {
  const p = getRow(deps, id);
  return p ? toView(deps, p) : null;
}

/**
 * The call context the ProposalReader tool shows the triage agent, read through ProposalService's declared
 * dependency on CallApi.GetCallStatus — the Triage workflow itself declares no dependency on Calls.
 */
export function callContextFor(deps: Deps, callId: string) {
  return getCallStatus(deps, callId);
}
