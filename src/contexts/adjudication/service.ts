/**
 * Adjudication — realizes ::Quorum.ResearchFunding.Adjudication.AdjudicationService and the
 * PanelDecision workflow. Single writer of adj_* (AdjudicationStore). Never reads review or proposal
 * tables: everything it needs arrives in CallPublished and ProposalScored (ADR-006).
 *
 *   PanelDecision v1 — triggeredBy ProposalScored, unique-by proposalId  -> adj_case row
 *     human-task decide (assign PanelChair, escalation P14D, no expiry)  -> recordDecision()
 *     decision isAward
 *       invoke commit (CommitAward: one conditional write, INV-9)         -> commitAward()
 *       decision committed -> publish awarded | human-task reconsider (admits only a decline)
 *     invoke decline (RecordDecline) -> publish declined
 */
import type { Deps } from '../../platform/deps.ts';
import { toDecimal } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import { CommittedRefusal } from '../../platform/http.ts';
import { conflict, notFound, unprocessable } from '../../platform/errors.ts';
import type { CallPublishedData, ConflictDeclaredData, DecisionData, AwardResult, AwardRefusedData, AwardHeldData } from '../../contracts/model.generated.ts';

export type CaseRow = {
  proposal_id: string;
  call_id: string;
  title: string;
  requested_minor: number;
  mean_score: number;
  status: 'awaitingDecision' | 'reconsider' | 'decided';
  integrity_hold: string | null;
  opened_at: string;
  decision_due: string;
  escalated_at: string | null;
};

export type Budget = { callId: string; envelopeMinor: number; committedMinor: number; remainingMinor: number };

export function budgetOf(deps: Deps, callId: string): Budget | null {
  const b = deps.db.prepare(`SELECT * FROM adj_budget WHERE call_id = ?`).get(callId) as { call_id: string; envelope_minor: number; committed_minor: number } | undefined;
  return b ? { callId: b.call_id, envelopeMinor: b.envelope_minor, committedMinor: b.committed_minor, remainingMinor: b.envelope_minor - b.committed_minor } : null;
}

/**
 * DecisionApi.CommitAward — INV-9's enforcement point. ONE conditional write: it succeeds only if
 * committed + amount <= envelope, atomically, whatever other connection or process is awarding.
 * The CHECK constraint on adj_budget is the second line of defence.
 */
export function commitAward(deps: Deps, callId: string, amountMinor: number): AwardResult & { remainingMinor: number } {
  const r = deps.db
    .prepare(`UPDATE adj_budget SET committed_minor = committed_minor + ? WHERE call_id = ? AND committed_minor + ? <= envelope_minor`)
    .run(amountMinor, callId, amountMinor);
  const b = budgetOf(deps, callId)!;
  return { committed: r.changes === 1, remaining: toDecimal(b.remainingMinor), remainingMinor: b.remainingMinor };
}

/**
 * The chair's human task (decide, or reconsider after a refused award). INV-8: the route admits only
 * the panelChair role; here, a decision exists only for a proposal with an open case — which exists
 * only once the proposal is scored — and only once.
 */
export function recordDecision(
  deps: Deps,
  chairId: string,
  proposalId: string,
  input: { outcome: 'award' | 'decline'; rationale: string },
): { decision: DecisionData; budget: Budget } | CommittedRefusal {
  const c = deps.db.prepare(`SELECT * FROM adj_case WHERE proposal_id = ?`).get(proposalId) as CaseRow | undefined;
  if (!c) throw conflict('not_scored', 'This proposal is not scored yet. A panel decision can be recorded only once three reviews are in and it is scored.', 'INV-8');
  if (c.status === 'decided') throw conflict('already_decided', 'A panel decision is already recorded for this proposal. Decisions are final.', 'INV-8');
  if (input.rationale.trim().length < 20) {
    throw unprocessable('rationale_required', 'Record the panel\'s rationale: it is sent to the applicant and kept in the audit trail.', {
      fields: [{ field: 'rationale', message: 'At least 20 characters.' }],
    });
  }
  const now = deps.clock.now().toISOString();
  if (input.outcome === 'award') {
    // Fail closed (architect review A2): an award waits until every event about this proposal has reached
    // Adjudication's consumers, so a ConflictDeclared still in flight (retrying or parked) cannot be raced.
    const inFlight = (deps.db
      .prepare(`SELECT COUNT(*) n FROM evt_delivery WHERE partition_key = ? AND consumer LIKE 'adjudication.%' AND status <> 'delivered'`)
      .get(`proposal:${proposalId}`) as { n: number }).n;
    if (inFlight > 0) throw conflict('integrity_pending', 'Recent activity on this proposal is still being processed. Try the award again in a moment.', 'INV-3');
    if (c.status === 'reconsider') {
      throw conflict('envelope_exhausted', 'This award was already refused because the envelope cannot fund it, and the envelope never grows. Record a decline.', 'INV-9');
    }
    if (c.integrity_hold) throw conflict('integrity_hold', `The award is on hold: ${c.integrity_hold}. Under the current rules the only remaining outcome is a decline; how a hold is released is an open owner decision (ADR-005).`, 'INV-3');
    const result = commitAward(deps, c.call_id, c.requested_minor); // invoke commit
    if (!result.committed) {
      // decision committed -> default: human-task reconsider. The state change is committed with the refusal.
      deps.db.prepare(`UPDATE adj_case SET status = 'reconsider' WHERE proposal_id = ? AND status = 'awaitingDecision'`).run(proposalId);
      // publish refused -> reconsider (review B4): the refusal is an audited transition
      const refused: AwardRefusedData = { proposalId, callId: c.call_id, requested: toDecimal(c.requested_minor), actorId: chairId, at: now };
      deps.bus.publish('AwardRefused', `proposal:${proposalId}`, refused, chairId);
      const b = budgetOf(deps, c.call_id)!;
      return new CommittedRefusal(
        conflict(
          'envelope_exceeded',
          `Awarding ${toDecimal(c.requested_minor)} would exceed the call's budget envelope: only ${toDecimal(b.remainingMinor)} remains. Nothing was committed; the only remaining outcome is a decline.`,
          'INV-9',
        ),
      );
    }
  }
  const amountMinor = input.outcome === 'award' ? c.requested_minor : 0;
  const ok = deps.db.prepare(`UPDATE adj_case SET status = 'decided' WHERE proposal_id = ? AND status IN ('awaitingDecision','reconsider')`).run(proposalId);
  if (ok.changes !== 1) throw conflict('already_decided', 'A panel decision was recorded a moment ago.', 'INV-8');
  deps.db
    .prepare(`INSERT INTO adj_decision (proposal_id, call_id, outcome, amount_minor, rationale, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(proposalId, c.call_id, input.outcome, amountMinor, input.rationale.trim(), chairId, now);
  const decision: DecisionData = {
    proposalId,
    callId: c.call_id,
    outcome: input.outcome,
    amount: toDecimal(amountMinor),
    actorId: chairId,
    rationale: input.rationale.trim(),
    at: now,
  };
  deps.bus.publish(input.outcome === 'award' ? 'ProposalAwarded' : 'ProposalDeclined', `proposal:${proposalId}`, decision, chairId);
  return { decision, budget: budgetOf(deps, c.call_id)! };
}

export function adjudicationConsumer(deps: Deps): Consumer {
  return {
    name: 'adjudication.adjudication-service',
    realizes: '::Quorum.ResearchFunding.Adjudication.AdjudicationService',
    handles: {
      // on CallPublished -> none: the ledger row; the envelope is fixed from now on
      CallPublished: (db, e: StoredEvent<CallPublishedData>) => {
        db.prepare(`INSERT OR IGNORE INTO adj_budget (call_id, envelope_minor, committed_minor) VALUES (?, ?, 0)`).run(e.payload.callId, Math.round(Number(e.payload.envelope) * 100));
      },
      // on ConflictDeclared -> none: a conflict disclosed after scoring holds the award (ADR-005)
      ConflictDeclared: (db, e: StoredEvent<ConflictDeclaredData>) => {
        if (!e.payload.heldAward) return;
        // remembered even if the case does not exist yet (architect review A2: the hold could be lost)
        db.prepare(`INSERT OR IGNORE INTO adj_pending_hold (proposal_id, reason) VALUES (?, ?)`).run(e.payload.proposalId, `a reviewer declared a conflict after scoring (${e.payload.reason})`);
        const reason = `a reviewer declared a conflict after scoring (${e.payload.reason})`;
        const placed = db.prepare(`UPDATE adj_case SET integrity_hold = ? WHERE proposal_id = ? AND status <> 'decided' AND integrity_hold IS NULL`).run(reason, e.payload.proposalId);
        if (placed.changes === 1) {
          const p: AwardHeldData = { proposalId: e.payload.proposalId, reason, at: e.occurredAt };
          deps.bus.publish('AwardHeld', `proposal:${e.payload.proposalId}`, p, 'quorum-platform');
        }
      },
    },
  };
}

export type CaseView = {
  proposalId: string;
  callId: string;
  title: string;
  requestedMinor: number;
  meanScore: number;
  status: CaseRow['status'];
  integrityHold: string | null;
  openedAt: string;
  decisionDue: string;
  overdue: boolean;
  decision: { outcome: 'award' | 'decline'; amountMinor: number; rationale: string; decidedBy: string; decidedAt: string } | null;
  budget: Budget | null;
};

export function caseView(deps: Deps, c: CaseRow): CaseView {
  const d = deps.db.prepare(`SELECT * FROM adj_decision WHERE proposal_id = ?`).get(c.proposal_id) as
    | { outcome: 'award' | 'decline'; amount_minor: number; rationale: string; decided_by: string; decided_at: string }
    | undefined;
  return {
    proposalId: c.proposal_id,
    callId: c.call_id,
    title: c.title,
    requestedMinor: c.requested_minor,
    meanScore: c.mean_score,
    status: c.status,
    integrityHold: c.integrity_hold,
    openedAt: c.opened_at,
    decisionDue: c.decision_due,
    overdue: c.status !== 'decided' && deps.clock.now().getTime() >= new Date(c.decision_due).getTime(),
    decision: d ? { outcome: d.outcome, amountMinor: d.amount_minor, rationale: d.rationale, decidedBy: d.decided_by, decidedAt: d.decided_at } : null,
    budget: budgetOf(deps, c.call_id),
  };
}

export function listCases(deps: Deps, opts: { open?: boolean } = {}): CaseView[] {
  const rows = deps.db
    .prepare(`SELECT * FROM adj_case ${opts.open ? `WHERE status <> 'decided'` : ''} ORDER BY CASE status WHEN 'decided' THEN 1 ELSE 0 END, mean_score DESC`)
    .all() as CaseRow[];
  return rows.map((r) => caseView(deps, r));
}

export function getCase(deps: Deps, proposalId: string): CaseView {
  const c = deps.db.prepare(`SELECT * FROM adj_case WHERE proposal_id = ?`).get(proposalId) as CaseRow | undefined;
  if (!c) throw notFound('Adjudication case');
  return caseView(deps, c);
}
