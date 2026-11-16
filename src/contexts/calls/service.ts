/**
 * Calls — realizes ::Quorum.ResearchFunding.Calls.CallService. Single writer of cal_* (CallStore).
 * The envelope and criteria are immutable once a call is open (ADR-006; enforced by DB triggers too).
 */
import type { Deps } from '../../platform/deps.ts';
import { toDecimal } from '../../platform/deps.ts';
import { newId } from '../../platform/ids.ts';
import { conflict, notFound, unprocessable } from '../../platform/errors.ts';
import type { CallPublishedData, CallClosedData, CallStatusView } from '../../contracts/model.generated.ts';

export type CallRow = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  deadline: string;
  envelope_minor: number;
  max_request_minor: number;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
};

export type CriterionRow = { id: string; position: number; name: string; guidance: string };

export type CallView = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  deadline: string;
  envelopeMinor: number;
  maxRequestMinor: number;
  status: 'open' | 'closed';
  acceptingSubmissions: boolean;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  criteria: CriterionRow[];
};

function view(deps: Deps, c: CallRow): CallView {
  const criteria = deps.db.prepare(`SELECT id, position, name, guidance FROM cal_criterion WHERE call_id = ? ORDER BY position`).all(c.id) as CriterionRow[];
  return {
    id: c.id,
    reference: c.reference,
    title: c.title,
    summary: c.summary,
    deadline: c.deadline,
    envelopeMinor: c.envelope_minor,
    maxRequestMinor: c.max_request_minor,
    status: c.status,
    acceptingSubmissions: c.status === 'open' && deps.clock.now().getTime() < new Date(c.deadline).getTime(),
    openedAt: c.opened_at,
    closedAt: c.closed_at,
    closeReason: c.close_reason,
    criteria,
  };
}

export function listCalls(deps: Deps, opts: { onlyOpen?: boolean } = {}): CallView[] {
  const rows = deps.db.prepare(`SELECT * FROM cal_call ${opts.onlyOpen ? `WHERE status = 'open'` : ''} ORDER BY deadline`).all() as CallRow[];
  return rows.map((r) => view(deps, r));
}

export function getCall(deps: Deps, id: string): CallView {
  const c = deps.db.prepare(`SELECT * FROM cal_call WHERE id = ?`).get(id) as CallRow | undefined;
  if (!c) throw notFound('Call');
  return view(deps, c);
}

/** Command PublishCall (ProgramOfficer). */
export function publishCall(
  deps: Deps,
  actorId: string,
  input: { title: string; summary: string; deadline: string; envelope: number; maxRequest: number; criteria: Array<{ name: string; guidance: string }> },
): CallView {
  const now = deps.clock.now();
  const deadline = new Date(input.deadline);
  const fields = [];
  if (Number.isNaN(deadline.getTime())) fields.push({ field: 'deadline', message: 'Enter a valid date and time.' });
  else if (deadline.getTime() <= now.getTime()) fields.push({ field: 'deadline', message: 'The deadline must be in the future.' });
  if (input.maxRequest > input.envelope) fields.push({ field: 'maxRequest', message: 'The per-proposal maximum cannot exceed the budget envelope.' });
  const names = input.criteria.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) fields.push({ field: 'criteria', message: 'Each criterion needs a distinct name.' });
  if (fields.length) throw unprocessable('invalid_call', 'The call cannot be published yet.', { fields });

  const id = newId();
  const year = deadline.getUTCFullYear();
  const n = (deps.db.prepare(`SELECT COUNT(*) n FROM cal_call`).get() as { n: number }).n + 1;
  const reference = `QF-${year}-${String(n).padStart(2, '0')}`;
  const at = now.toISOString();
  const envelopeMinor = Math.round(input.envelope * 100);
  const maxMinor = Math.round(input.maxRequest * 100);
  deps.db
    .prepare(
      `INSERT INTO cal_call (id, reference, title, summary, deadline, envelope_minor, max_request_minor, status, opened_at, opened_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(id, reference, input.title.trim(), input.summary.trim(), deadline.toISOString(), envelopeMinor, maxMinor, at, actorId);
  const ins = deps.db.prepare(`INSERT INTO cal_criterion (call_id, id, position, name, guidance) VALUES (?, ?, ?, ?, ?)`);
  input.criteria.forEach((c, i) => ins.run(id, `c${i + 1}`, i + 1, c.name.trim(), c.guidance.trim()));
  const payload: CallPublishedData & { reference: string; guidance: string[] } = {
    callId: id,
    title: input.title.trim(),
    deadline: deadline.toISOString(),
    envelope: toDecimal(envelopeMinor),
    criteria: input.criteria.map((c, i) => ({ criterionId: `c${i + 1}`, name: c.name.trim() })),
    guidance: input.criteria.map((c) => c.guidance.trim()),
    reference,
    actorId,
    at,
  };
  deps.bus.publish('CallPublished', `call:${id}`, payload, actorId);
  return getCall(deps, id);
}

/** Command CloseCall (ProgramOfficer). Closing is terminal; submissions are refused from now on (INV-1). */
export function closeCall(deps: Deps, actorId: string, callId: string, reason: string): CallView {
  const c = deps.db.prepare(`SELECT * FROM cal_call WHERE id = ?`).get(callId) as CallRow | undefined;
  if (!c) throw notFound('Call');
  if (c.status === 'closed') throw conflict('call_already_closed', `Call ${c.reference} is already closed.`);
  const at = deps.clock.now().toISOString();
  const r = deps.db.prepare(`UPDATE cal_call SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ? AND status = 'open'`).run(at, actorId, reason, callId);
  if (r.changes === 1) {
    const payload: CallClosedData = { callId, actorId, reason, at };
    deps.bus.publish('CallClosed', `call:${callId}`, payload, actorId);
  }
  return getCall(deps, callId);
}

/** CallApi.GetCallStatus — invoked by Submission inside the submit transaction (ADR-003). */
export function getCallStatus(deps: Deps, callId: string): (CallStatusView & { title: string; summary: string; maxRequestMinor: number; reference: string }) | null {
  const c = deps.db.prepare(`SELECT * FROM cal_call WHERE id = ?`).get(callId) as CallRow | undefined;
  if (!c) return null;
  const criteria = (deps.db.prepare(`SELECT id, name FROM cal_criterion WHERE call_id = ? ORDER BY position`).all(callId) as Array<{ id: string; name: string }>).map(
    (r) => ({ criterionId: r.id, name: r.name }),
  );
  return {
    callId: c.id,
    status: c.status,
    deadline: c.deadline,
    maxRequest: toDecimal(c.max_request_minor),
    maxRequestMinor: c.max_request_minor,
    criteria,
    title: c.title,
    summary: c.summary,
    reference: c.reference,
  };
}
