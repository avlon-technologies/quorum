/**
 * The Triage workflow — realizes ::Quorum.ResearchFunding.Submission.Triage and runs the agent
 * ::Quorum.ResearchFunding.Submission.EligibilityTriage.
 *
 *   triggeredBy ProposalSubmitted  -> a durable instance row (sub_triage_job), in the delivery transaction
 *   agent-task assess              -> TriageRunner calls the provider OUTSIDE any transaction, giving it only
 *                                     the ProposalReader tool (a frozen, read-only snapshot)
 *     policy[retry "bounded"; on-fail=continue]  -> 3 attempts, then the verdict is recorded as absent
 *   invoke record                  -> ScreeningApi.RecordTriageProposal (writes sub_triage only)
 *   publish proposed               -> TriageProposed
 *
 * INV-10 / ADR-011: nothing here changes sub_proposal.status. The agent never receives `deps`, a
 * database handle, or any command function — it cannot move a proposal anywhere.
 */
import type { Deps } from '../../platform/deps.ts';
import { AGENT_ACTOR } from '../../platform/deps.ts';
import type { Consumer, StoredEvent } from '../../platform/events.ts';
import type { ProposalSubmittedData, TriageProposedData, TriageVerdict } from '../../contracts/model.generated.ts';
import type { TriageInput, TriageProvider } from '../../contracts/triage-port.ts';
import { getRow, callContextFor } from './service.ts';

export const TRIAGE_MAX_ATTEMPTS = 3;
export const TRIAGE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`triage provider timed out after ${ms} ms`)), ms);
    t.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export function triageConsumer(deps: Deps): Consumer {
  return {
    name: 'submission.triage-workflow',
    realizes: '::Quorum.ResearchFunding.Submission.Triage',
    handles: {
      // trigger … unique-by payload.proposalId
      ProposalSubmitted: (db, e: StoredEvent<ProposalSubmittedData>) => {
        db.prepare(`INSERT OR IGNORE INTO sub_triage_job (proposal_id, status, next_attempt_at) VALUES (?, 'pending', ?)`).run(
          e.payload.proposalId,
          deps.clock.now().toISOString(),
        );
      },
    },
  };
}

/** The ProposalReader tool: a read-only snapshot. This is everything the agent can see. */
export function proposalReader(deps: Deps, proposalId: string): TriageInput | null {
  const p = getRow(deps, proposalId);
  if (!p) return null;
  const call = callContextFor(deps, p.call_id);
  if (!call) return null;
  return Object.freeze({
    proposalId: p.id,
    title: p.title,
    abstract: p.abstract,
    requestedMinor: p.requested_minor,
    callTitle: call.title,
    callSummary: call.summary,
    maxRequestMinor: call.maxRequestMinor,
  });
}

/** ScreeningApi.RecordTriageProposal — the only write the workflow performs. Never touches status. */
export function recordTriageProposal(deps: Deps, proposalId: string, verdict: TriageVerdict | null, rationale: string, provider: string): boolean {
  const r = deps.db
    .prepare(`INSERT INTO sub_triage (proposal_id, verdict, rationale, provider, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(proposal_id) DO NOTHING`)
    .run(proposalId, verdict?.verdict ?? null, verdict?.rationale ?? rationale, provider, deps.clock.now().toISOString());
  if (r.changes === 1) {
    const payload: TriageProposedData = { proposalId, verdict };
    deps.bus.publish('TriageProposed', `proposal:${proposalId}`, payload, AGENT_ACTOR);
  }
  return r.changes === 1;
}

export class TriageRunner {
  readonly #deps: Deps;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  constructor(deps: Deps) {
    this.#deps = deps;
  }

  start(intervalMs = 1000): void {
    this.#timer = setInterval(() => void this.runOnce(), intervalMs);
    this.#timer.unref();
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Run every due instance once. Returns how many instances completed. */
  async runOnce(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let done = 0;
    try {
      const { db, clock } = this.#deps;
      const due = db
        .prepare(`SELECT proposal_id, attempts FROM sub_triage_job WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20`)
        .all(clock.now().toISOString()) as Array<{ proposal_id: string; attempts: number }>;
      for (const job of due) if (await this.#runInstance(job.proposal_id, job.attempts, this.#deps.triage)) done++;
    } finally {
      this.#running = false;
    }
    return done;
  }

  async #runInstance(proposalId: string, attempts: number, provider: TriageProvider): Promise<boolean> {
    const { db, clock } = this.#deps;
    const input = proposalReader(this.#deps, proposalId);
    let verdict: TriageVerdict | null = null;
    let failure: string | null = null;
    if (input) {
      try {
        const out = await withTimeout(provider.assess(input), TRIAGE_TIMEOUT_MS); // agent-task assess
        // the agent output is data: anything outside the declared verdict shape is a failed attempt (architect review B2)
        if (!out || !['eligible', 'ineligible', 'unclear'].includes(out.verdict) || typeof out.rationale !== 'string') throw new Error('malformed triage output');
        verdict = { verdict: out.verdict, rationale: out.rationale.slice(0, 2000) };
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
    } else {
      failure = 'proposal not found';
    }
    const tries = attempts + 1;
    if (failure && tries < TRIAGE_MAX_ATTEMPTS) {
      const next = new Date(clock.now().getTime() + 2000 * tries).toISOString();
      db.prepare(`UPDATE sub_triage_job SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE proposal_id = ?`).run(tries, failure, next, proposalId);
      return false;
    }
    // on-fail=continue: after the last attempt the verdict is recorded as absent and the officer screens without it.
    db.transaction(() => {
      recordTriageProposal(
        this.#deps,
        proposalId,
        verdict,
        failure ? `The triage agent could not assess this proposal (${failure}). Screen it manually.` : '',
        provider.name,
      );
      db.prepare(`UPDATE sub_triage_job SET status = 'done', attempts = ?, last_error = ? WHERE proposal_id = ?`).run(tries, failure, proposalId);
    }).immediate();
    return true;
  }
}
