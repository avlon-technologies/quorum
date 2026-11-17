/**
 * Notification — realizes ::Quorum.ResearchFunding.Notification.NotificationService.
 * Single writer of ntf_* (OutboundMessageStore: the brief's OutboxMessage, queued -> delivered | failed).
 * Unique (event_id, recipient) makes a redelivered event a no-op. NoScoresToReviewers: no message
 * built here ever carries scores or review comments.
 */
import { raise } from '../../platform/alerts.ts';
import type { Deps } from '../../platform/deps.ts';
import type { Consumer, Handler, StoredEvent } from '../../platform/events.ts';
import { newId } from '../../platform/ids.ts';
import type { Role } from '../../contracts/model.generated.ts';

const MAX_ATTEMPTS = 5;
type Recipient = { account: string } | { role: Role };
const key = (r: Recipient) => ('account' in r ? r.account : `role:${r.role}`);

function enqueue(deps: Deps, e: StoredEvent, to: Recipient[], kind: string, subject: string, body: string, link: string | null) {
  const ins = deps.db.prepare(
    `INSERT OR IGNORE INTO ntf_message (id, event_id, recipient, kind, subject, body, link, created_at, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  );
  for (const r of to) ins.run(newId(), e.messageId, key(r), kind, subject, body, link, e.occurredAt, deps.clock.now().toISOString());
}

function proposal(deps: Deps, id: string) {
  return deps.db.prepare(`SELECT * FROM ntf_proposal WHERE proposal_id = ?`).get(id) as { proposal_id: string; applicant_id: string; title: string } | undefined;
}

const qref = (n: unknown) => (typeof n === 'number' ? `Q-${String(n).padStart(4, '0')}` : 'Your proposal');

export function notificationConsumer(deps: Deps): Consumer {
  const on = (h: (e: StoredEvent<any>) => void): Handler => (_db, e) => h(e);
  return {
    name: 'notification.notification-service',
    realizes: '::Quorum.ResearchFunding.Notification.NotificationService',
    handles: {
      ProposalSubmitted: on((e) => {
        deps.db.prepare(`INSERT OR IGNORE INTO ntf_proposal (proposal_id, applicant_id, title) VALUES (?, ?, ?)`).run(e.payload.proposalId, e.payload.applicantId, e.payload.title);
        enqueue(deps, e, [{ account: e.payload.applicantId }], 'submitted', `${qref(e.payload.number)} received`, `We received “${e.payload.title}”. It is now in eligibility screening.`, `#/proposals/${e.payload.proposalId}`);
        enqueue(deps, e, [{ role: 'programOfficer' }], 'submitted', `New submission: ${qref(e.payload.number)}`, `“${e.payload.title}” was submitted by ${e.payload.applicantName}.`, `#/officer/proposals/${e.payload.proposalId}`);
      }),
      TriageProposed: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        const v = e.payload.verdict?.verdict ?? 'no verdict';
        enqueue(deps, e, [{ role: 'programOfficer' }], 'triage', `Ready to screen: ${p?.title ?? 'a proposal'}`, `The triage agent proposes: ${v}. Confirm or override it.`, `#/officer/proposals/${e.payload.proposalId}`);
      }),
      ProposalEligible: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        if (p) enqueue(deps, e, [{ account: p.applicant_id }], 'eligible', 'Your proposal passed eligibility screening', `“${p.title}” is eligible and will be sent to three independent reviewers.`, `#/proposals/${p.proposal_id}`);
      }),
      ProposalIneligible: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        if (p) enqueue(deps, e, [{ account: p.applicant_id }], 'ineligible', 'Your proposal was screened out', `“${p.title}” is not eligible for this call. Reason: ${e.payload.reason}`, `#/proposals/${p.proposal_id}`);
      }),
      ReviewerAssigned: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ account: e.payload.reviewerId }], 'assigned', 'New review assignment', `You were asked to review “${p?.title ?? 'a proposal'}”. Due ${e.payload.dueAt.slice(0, 10)}.`, `#/reviewer/assignments/${e.payload.assignmentId}`);
      }),
      AssignmentRevoked: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ account: e.payload.reviewerId }], 'revoked', 'Assignment withdrawn', `Your assignment to “${p?.title ?? 'a proposal'}” was withdrawn: ${e.payload.reason}.`, null);
      }),
      ReviewOverdue: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ account: e.payload.reviewerId }], 'overdue', 'Your review is overdue', `Your review of “${p?.title ?? 'a proposal'}” was due ${e.payload.dueAt.slice(0, 10)}. Please submit it as soon as you can.`, `#/reviewer/assignments/${e.payload.assignmentId}`);
        enqueue(deps, e, [{ role: 'programOfficer' }], 'overdue', `Overdue review: ${p?.title ?? 'a proposal'}`, `A review due ${e.payload.dueAt.slice(0, 10)} has not been submitted. Chase the reviewer or replace them.`, `#/officer/proposals/${e.payload.proposalId}`);
      }),
      ProposalScored: on((e) => {
        enqueue(deps, e, [{ role: 'panelChair' }], 'scored', `Ready for decision: ${qref(e.payload.number)}`, `“${e.payload.title}” has three reviews (mean ${e.payload.meanScore}) and awaits the panel's decision.`, `#/chair/decisions/${e.payload.proposalId}`);
      }),
      ProposalAwarded: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        if (p) enqueue(deps, e, [{ account: p.applicant_id }], 'awarded', 'Funding awarded', `The panel awarded “${p.title}” ${e.payload.amount}. ${e.payload.rationale}`, `#/proposals/${p.proposal_id}`);
      }),
      ProposalDeclined: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        if (p) enqueue(deps, e, [{ account: p.applicant_id }], 'declined', 'Panel decision', `The panel did not fund “${p.title}”. ${e.payload.rationale}`, `#/proposals/${p.proposal_id}`);
      }),
      // J7 escalation (review B3): the program officers are told; nothing is decided by timeout
      DecisionEscalated: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ role: 'programOfficer' }], 'decision-overdue', `Decision overdue: ${p?.title ?? 'a proposal'}`, `The panel decision on “${p?.title ?? 'a proposal'}” was due ${e.payload.dueAt.slice(0, 10)} and has not been recorded. Follow up with the panel chair. Quorum never decides by timeout.`, `#/officer/proposals/${e.payload.proposalId}`);
      }),
      AwardRefused: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ role: 'programOfficer' }], 'award-refused', `Award refused: ${p?.title ?? 'a proposal'}`, `An award of ${e.payload.requested} on “${p?.title ?? 'a proposal'}” was refused because the call's envelope cannot fund it. Nothing was committed; the chair can only record a decline.`, `#/officer/proposals/${e.payload.proposalId}`);
      }),
      AwardHeld: on((e) => {
        const p = proposal(deps, e.payload.proposalId);
        enqueue(deps, e, [{ role: 'programOfficer' }, { role: 'panelChair' }], 'award-held', `Award on hold: ${p?.title ?? 'a proposal'}`, `The award on “${p?.title ?? 'a proposal'}” is on hold: ${e.payload.reason}.`, `#/chair/decisions/${e.payload.proposalId}`);
      }),
      // Erasure: messages addressed to the account are deleted (one-year retention, not a business record),
      // its queued mail is never sent, and its name is scrubbed from officers' submission notices.
      AccountErased: on((e) => {
        const id = e.payload.accountId;
        deps.db.prepare(`DELETE FROM ntf_read WHERE account_id = ? OR message_id IN (SELECT id FROM ntf_message WHERE recipient = ?)`).run(id, id);
        deps.db.prepare(`DELETE FROM ntf_message WHERE recipient = ?`).run(id);
        deps.db
          .prepare(
            `UPDATE ntf_message SET body = substr(body, 1, instr(body, ' was submitted by ') - 1) || ' was submitted by [erased].'
              WHERE kind = 'submitted' AND recipient LIKE 'role:%' AND instr(body, ' was submitted by ') > 0
                AND link IN (SELECT '#/officer/proposals/' || proposal_id FROM ntf_proposal WHERE applicant_id = ?)`,
          )
          .run(id);
      }),
    },
  };
}

/** The drain job: hand queued messages to the mail transport, at least once, with retry. */
export async function drainOutbound(deps: Deps, recipientEmail: (recipient: string) => string): Promise<number> {
  const now = deps.clock.now().toISOString();
  const due = deps.db.prepare(`SELECT * FROM ntf_message WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT 50`).all(now) as Array<{
    id: string;
    recipient: string;
    subject: string;
    body: string;
    attempts: number;
  }>;
  let delivered = 0;
  for (const m of due) {
    try {
      await deps.mail.send({ id: m.id, to: recipientEmail(m.recipient), subject: m.subject, body: m.body });
      deps.db.prepare(`UPDATE ntf_message SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(deps.clock.now().toISOString(), m.id);
      delivered++;
    } catch (e) {
      const attempts = m.attempts + 1;
      const next = new Date(deps.clock.now().getTime() + 1000 * 2 ** attempts).toISOString();
      deps.db
        .prepare(`UPDATE ntf_message SET attempts = ?, last_error = ?, next_attempt_at = ?, status = ? WHERE id = ?`)
        .run(attempts, e instanceof Error ? e.message : String(e), next, attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', m.id);
      if (attempts >= MAX_ATTEMPTS) raise({ kind: 'mail_failed', messageId: m.id, attempts, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  return delivered;
}

export function inbox(deps: Deps, accountId: string, roles: Role[], limit = 50) {
  const keys = [accountId, ...roles.map((r) => `role:${r}`)];
  return deps.db
    .prepare(
      `SELECT m.id, m.kind, m.subject, m.body, m.link, m.created_at AS createdAt, r.read_at AS readAt, m.status FROM ntf_message m
         LEFT JOIN ntf_read r ON r.message_id = m.id AND r.account_id = ?
        WHERE m.recipient IN (${keys.map(() => '?').join(',')}) ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(accountId, ...keys, limit);
}

export function markRead(deps: Deps, accountId: string, roles: Role[]): number {
  const keys = [accountId, ...roles.map((r) => `role:${r}`)];
  // per-account read state (review B5): reading a role-addressed message marks it read for this account only
  return deps.db
    .prepare(
      `INSERT OR IGNORE INTO ntf_read (message_id, account_id, read_at)
       SELECT id, ?, ? FROM ntf_message WHERE recipient IN (${keys.map(() => '?').join(',')})`,
    )
    .run(accountId, deps.clock.now().toISOString(), ...keys).changes;
}

export function outboundHealth(deps: Deps) {
  return deps.db.prepare(`SELECT status, COUNT(*) AS n FROM ntf_message GROUP BY status`).all() as Array<{ status: string; n: number }>;
}
