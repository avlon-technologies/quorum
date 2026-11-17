/**
 * The PanelDecision workflow — realizes ::Quorum.ResearchFunding.Adjudication.PanelDecision: its trigger
 * (one case per scored proposal) and its human task's escalation clause. The decide / commit / decline /
 * reconsider steps are the chair's human task: the decision route (src/api/routes.ts) invokes
 * AdjudicationService's DecisionApi (recordDecision → commitAward in ./service.ts) when the task completes.
 */
import type { Deps } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import { DAY_MS } from '../../platform/clock.ts';
import type { ScoredData, DecisionEscalatedData, AwardHeldData } from '../../contracts/model.generated.ts';

/** The PanelDecision workflow's trigger: one instance per scored proposal (unique-by proposalId). */
export function panelDecisionWorkflow(deps: Deps): Consumer {
  return {
    name: 'adjudication.panel-decision-workflow',
    realizes: '::Quorum.ResearchFunding.Adjudication.PanelDecision',
    handles: {
      ProposalScored: (db, e: StoredEvent<ScoredData>) => {
        const opened = new Date(e.occurredAt);
        db.prepare(
          `INSERT OR IGNORE INTO adj_case (proposal_id, call_id, title, requested_minor, mean_score, status, opened_at, decision_due)
           VALUES (?, ?, ?, ?, ?, 'awaitingDecision', ?, ?)`,
        ).run(
          e.payload.proposalId,
          e.payload.callId,
          e.payload.title,
          Math.round(Number(e.payload.requested) * 100),
          Number(e.payload.meanScore),
          e.occurredAt,
          new Date(opened.getTime() + deps.config.decisionPeriodDays * DAY_MS).toISOString(),
        );
        // a conflict disclosed before the case existed is waiting in adj_pending_hold (architect review A2)
        const held = db.prepare(`SELECT reason FROM adj_pending_hold WHERE proposal_id = ?`).get(e.payload.proposalId) as { reason: string } | undefined;
        if (held && db.prepare(`UPDATE adj_case SET integrity_hold = ? WHERE proposal_id = ? AND integrity_hold IS NULL`).run(held.reason, e.payload.proposalId).changes === 1) {
          const p: AwardHeldData = { proposalId: e.payload.proposalId, reason: held.reason, at: e.occurredAt };
          deps.bus.publish('AwardHeld', `proposal:${e.payload.proposalId}`, p, 'quorum-platform');
        }
      },
    },
  };
}

/**
 * The human task's escalation clause: after P14D the program officer is told — DecisionEscalated, at most
 * once per case (the escalated_at stamp is the guard, written in the same transaction). Nothing is decided
 * by timeout (ADR-010). Closes review B3.
 */
export function sweepEscalations(deps: Deps): number {
  const now = deps.clock.now().toISOString();
  return deps.db
    .transaction(() => {
      const due = deps.db
        .prepare(`SELECT proposal_id, call_id, decision_due FROM adj_case WHERE status IN ('awaitingDecision','reconsider') AND decision_due <= ? AND escalated_at IS NULL`)
        .all(now) as Array<{ proposal_id: string; call_id: string; decision_due: string }>;
      let n = 0;
      for (const c of due) {
        const r = deps.db.prepare(`UPDATE adj_case SET escalated_at = ? WHERE proposal_id = ? AND escalated_at IS NULL`).run(now, c.proposal_id);
        if (r.changes !== 1) continue;
        const payload: DecisionEscalatedData = { proposalId: c.proposal_id, callId: c.call_id, dueAt: c.decision_due, at: now };
        deps.bus.publish('DecisionEscalated', `proposal:${c.proposal_id}`, payload, 'quorum-platform');
        n++;
      }
      return n;
    })
    .immediate();
}
