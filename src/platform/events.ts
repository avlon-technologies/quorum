import type { Db } from './db.ts';
import type { Clock } from './clock.ts';
import { newId } from './ids.ts';
import { CONTINUUM_MESSAGES } from '../contracts/model.generated.ts';

/**
 * Durable event delivery (NFR-5, decision D7) — the realization the binding names `sqlite-outbox`.
 *
 * - publish() appends to evt_outbox and fans out one evt_delivery row per subscribed consumer, in the
 *   caller's transaction: an event exists if and only if the state change that caused it committed.
 * - Event identity is message_id (UUID); evt_outbox.seq is a global order. The partition key is the
 *   proposal (or call / account) the event is about, so delivery is ordered per proposal across publishers.
 * - The dispatcher hands each consumer its deliveries in seq order within a partition, and never
 *   delivers a later event while an earlier one for the same consumer+partition is undelivered.
 * - A consumer's effect and its delivery mark commit in ONE transaction, so an interrupted delivery
 *   rolls back whole and is redelivered; a replay is a no-op (at-least-once in, exactly-once effect).
 * - A delivery that throws is retried with backoff; after MAX_ATTEMPTS it is parked as 'failed' and
 *   its partition is held for that consumer until an operator retries it or, where that is safe, skips
 *   it with a recorded reason (ordering over liveness; review B6). Parking raises an alert.
 * - Skipping is refused for consumers whose effects guard an invariant (SKIP_FORBIDDEN): the proposal
 *   state machine, review completion and adjudication (budget ledger, integrity holds). For those, the
 *   only recovery is to fix the cause and retry.
 */

export type EventType = keyof typeof CONTINUUM_MESSAGES;

export type StoredEvent<P = unknown> = {
  seq: number;
  messageId: string;
  type: string;
  partitionKey: string;
  payload: P;
  actorId: string;
  occurredAt: string;
  causationId: string | null;
};

export type Handler = (db: Db, event: StoredEvent<any>) => void;

export type Consumer = {
  /** stable consumer name, e.g. 'submission.proposal-service' */
  name: string;
  /** model element realized, for traceability */
  realizes: string;
  handles: Partial<Record<EventType, Handler>>;
};

export const MAX_ATTEMPTS = 5;
/** Consumers whose deliveries may never be skipped: skipping would silently lose an invariant's input. */
export const SKIP_FORBIDDEN = /^(submission|peer-review|adjudication)\./;
/** Statuses that no longer hold a partition. */
const SETTLED = `('delivered','skipped')`;
export type DeliveryAlert = { kind: 'delivery_parked'; consumer: string; messageId: string; type: string; attempts: number; lastError: string };
const backoffMs = (attempt: number) => Math.min(60_000, 500 * 2 ** (attempt - 1));

export class EventBus {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #consumers = new Map<string, Consumer>();
  #subscribers = new Map<string, string[]>();
  #draining = false;
  #kickPending = false;
  #timer: NodeJS.Timeout | undefined;
  /** Test hook: called inside the delivery transaction after the handler ran, before the mark. */
  faultInjector: ((consumer: string, event: StoredEvent) => void) | undefined;
  /** Observers notified after each committed delivery batch (used to kick follow-on work). */
  readonly afterDrain: Array<() => void> = [];
  /** Observers told when a delivery is parked (alerting). Must not throw. */
  readonly onAlert: Array<(a: DeliveryAlert) => void> = [];

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  register(consumer: Consumer): void {
    if (this.#consumers.has(consumer.name)) throw new Error(`consumer ${consumer.name} registered twice`);
    for (const type of Object.keys(consumer.handles)) {
      if (!(type in CONTINUUM_MESSAGES) || CONTINUUM_MESSAGES[type as EventType].kind !== 'Event') {
        throw new Error(`consumer ${consumer.name} subscribes to ${type}, which the model does not declare as an Event`);
      }
      const list = this.#subscribers.get(type) ?? [];
      list.push(consumer.name);
      this.#subscribers.set(type, list);
    }
    this.#consumers.set(consumer.name, consumer);
  }

  subscribersOf(type: string): string[] {
    return this.#subscribers.get(type) ?? [];
  }

  consumers(): Consumer[] {
    return [...this.#consumers.values()];
  }

  /** Append an event. MUST be called inside the transaction that made the state change. */
  publish<P>(type: EventType, partitionKey: string, payload: P, actorId: string, causationId: string | null = null): string {
    if (!this.#db.inTransaction) throw new Error(`publish(${type}) outside a transaction — the event would not be atomic with its cause`);
    if (CONTINUUM_MESSAGES[type].kind !== 'Event') throw new Error(`${type} is not an Event in the model`);
    const messageId = newId();
    const now = this.#clock.now().toISOString();
    const info = this.#db
      .prepare(
        `INSERT INTO evt_outbox (message_id, type, partition_key, payload, actor_id, occurred_at, causation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, type, partitionKey, JSON.stringify(payload), actorId, now, causationId);
    const seq = Number(info.lastInsertRowid);
    const ins = this.#db.prepare(
      `INSERT INTO evt_delivery (consumer, message_id, seq, partition_key, status, next_attempt_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    for (const consumer of this.subscribersOf(type)) ins.run(consumer, messageId, seq, partitionKey, now);
    this.kick();
    return messageId;
  }

  /** Schedule a drain soon (after the current transaction commits). */
  kick(): void {
    if (this.#kickPending) return;
    this.#kickPending = true;
    setImmediate(() => {
      this.#kickPending = false;
      if (!this.#db.open) return; // the process closed the database (shutdown, end of seed): nothing to do
      try {
        this.drain();
      } catch (e) {
        console.error('[dispatcher] drain failed', e);
      }
    });
  }

  /** Start the background poller that picks up retries whose backoff has elapsed. */
  start(intervalMs = 1000): void {
    this.stop();
    this.#timer = setInterval(() => this.kick(), intervalMs);
    this.#timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Deliver everything that is due, in order. Returns the number of deliveries committed. */
  drain(maxRounds = 1000): number {
    if (this.#draining) return 0;
    this.#draining = true;
    let delivered = 0;
    try {
      for (let round = 0; round < maxRounds; round++) {
        const due = this.#dueDeliveries();
        if (due.length === 0) break;
        let progressed = 0;
        for (const d of due) {
          if (this.#deliverOne(d.consumer, d.message_id)) progressed++;
        }
        delivered += progressed;
        if (progressed === 0) break;
      }
    } finally {
      this.#draining = false;
    }
    if (delivered > 0) for (const f of this.afterDrain) f();
    return delivered;
  }

  #dueDeliveries(): Array<{ consumer: string; message_id: string }> {
    const now = this.#clock.now().toISOString();
    return this.#db
      .prepare(
        `SELECT d.consumer, d.message_id FROM evt_delivery d
          WHERE d.status = 'pending' AND d.next_attempt_at <= ?
            AND NOT EXISTS (SELECT 1 FROM evt_delivery e
                             WHERE e.consumer = d.consumer AND e.partition_key = d.partition_key
                               AND e.seq < d.seq AND e.status NOT IN ${SETTLED})
          ORDER BY d.seq LIMIT 200`,
      )
      .all(now) as Array<{ consumer: string; message_id: string }>;
  }

  #deliverOne(consumerName: string, messageId: string): boolean {
    const consumer = this.#consumers.get(consumerName);
    const row = this.#db.prepare(`SELECT * FROM evt_outbox WHERE message_id = ?`).get(messageId) as any;
    const event: StoredEvent = {
      seq: row.seq,
      messageId: row.message_id,
      type: row.type,
      partitionKey: row.partition_key,
      payload: JSON.parse(row.payload),
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
      causationId: row.causation_id,
    };
    const now = this.#clock.now().toISOString();
    try {
      this.#db
        .transaction(() => {
          // re-check inside the write lock: another process may have delivered it already
          const st = this.#db
            .prepare(`SELECT status FROM evt_delivery WHERE consumer = ? AND message_id = ?`)
            .get(consumerName, messageId) as { status: string } | undefined;
          if (!st || st.status !== 'pending') return;
          if (!consumer) throw new Error(`no consumer named ${consumerName} is registered in this build`);
          const handler = consumer.handles[event.type as EventType];
          if (handler) handler(this.#db, event);
          this.faultInjector?.(consumerName, event);
          this.#db
            .prepare(`UPDATE evt_delivery SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE consumer = ? AND message_id = ?`)
            .run(now, consumerName, messageId);
        })
        .immediate();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const cur = this.#db
        .prepare(`SELECT attempts FROM evt_delivery WHERE consumer = ? AND message_id = ?`)
        .get(consumerName, messageId) as { attempts: number };
      const attempts = cur.attempts + 1;
      const parked = attempts >= MAX_ATTEMPTS;
      const next = new Date(this.#clock.now().getTime() + backoffMs(attempts)).toISOString();
      this.#db
        .prepare(`UPDATE evt_delivery SET attempts = ?, last_error = ?, next_attempt_at = ?, status = ? WHERE consumer = ? AND message_id = ?`)
        .run(attempts, message.slice(0, 500), next, parked ? 'failed' : 'pending', consumerName, messageId);
      console.warn(`[dispatcher] ${consumerName} failed on ${event.type} ${messageId} (attempt ${attempts}${parked ? ', parked' : ''}): ${message}`);
      if (parked) {
        const alert: DeliveryAlert = { kind: 'delivery_parked', consumer: consumerName, messageId, type: event.type, attempts, lastError: message.slice(0, 500) };
        for (const f of this.onAlert) {
          try {
            f(alert);
          } catch {
            /* alerting never breaks delivery */
          }
        }
      }
      return false;
    }
  }

  /** Operator action: put a parked delivery back in the queue. */
  retry(consumer: string, messageId: string): boolean {
    const r = this.#db
      .prepare(`UPDATE evt_delivery SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE consumer = ? AND message_id = ? AND status = 'failed'`)
      .run(this.#clock.now().toISOString(), consumer, messageId);
    this.kick();
    return r.changes === 1;
  }

  /**
   * Operator action: settle a parked delivery WITHOUT applying it, releasing its partition. Refused for
   * consumers in SKIP_FORBIDDEN. The caller records who and why (ops_action) in the same transaction.
   */
  skip(consumer: string, messageId: string, reason: string): 'skipped' | 'not_parked' | 'forbidden' {
    if (SKIP_FORBIDDEN.test(consumer)) return 'forbidden';
    const r = this.#db
      .prepare(`UPDATE evt_delivery SET status = 'skipped', last_error = ? WHERE consumer = ? AND message_id = ? AND status = 'failed'`)
      .run(`skipped by operator: ${reason}`.slice(0, 500), consumer, messageId);
    if (r.changes === 1) this.kick();
    return r.changes === 1 ? 'skipped' : 'not_parked';
  }

  /**
   * Erasure support: replace every occurrence of the given personal values in retained event payloads
   * with a fixed marker. Runs in the caller's transaction. Returns the number of events rewritten.
   * The event log stays replayable: projections rebuilt from it carry the marker, as the live ones do.
   */
  redact(values: string[], marker = '[erased]'): number {
    const vals = values.filter((v) => v && v.length >= 3);
    if (vals.length === 0) return 0;
    const where = vals.map(() => `payload LIKE ?`).join(' OR ');
    const rows = this.#db
      .prepare(`SELECT message_id, payload FROM evt_outbox WHERE ${where}`)
      .all(...vals.map((v) => `%${v.replace(/[%_]/g, '')}%`)) as Array<{ message_id: string; payload: string }>;
    const upd = this.#db.prepare(`UPDATE evt_outbox SET payload = ? WHERE message_id = ?`);
    let n = 0;
    for (const r of rows) {
      const scrub = (x: unknown): unknown =>
        typeof x === 'string' ? vals.reduce((acc, v) => acc.split(v).join(marker), x)
        : Array.isArray(x) ? x.map(scrub)
        : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v)]))
        : x;
      const next = JSON.stringify(scrub(JSON.parse(r.payload)));
      if (next !== r.payload) {
        upd.run(next, r.message_id);
        n++;
      }
    }
    return n;
  }

  /**
   * Replay: re-deliver the whole retained log to one consumer (used to rebuild a projection).
   * The caller resets the consumer's own state in the same transaction.
   */
  replay(consumer: string, reset: (db: Db) => void): number {
    const c = this.#consumers.get(consumer);
    if (!c) throw new Error(`unknown consumer ${consumer}`);
    const types = Object.keys(c.handles);
    const now = this.#clock.now().toISOString();
    let n = 0;
    this.#db
      .transaction(() => {
        reset(this.#db);
        this.#db.prepare(`DELETE FROM evt_delivery WHERE consumer = ?`).run(consumer);
        const rows = this.#db
          .prepare(`SELECT message_id, seq, partition_key FROM evt_outbox WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY seq`)
          .all(...types) as Array<{ message_id: string; seq: number; partition_key: string }>;
        const ins = this.#db.prepare(
          `INSERT INTO evt_delivery (consumer, message_id, seq, partition_key, status, next_attempt_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
        );
        for (const r of rows) ins.run(consumer, r.message_id, r.seq, r.partition_key, now);
        n = rows.length;
      })
      .immediate();
    this.drain();
    return n;
  }

  /** Delivery health for the operations view. */
  health() {
    const oldest = this.#db.prepare(`SELECT MIN(o.occurred_at) t FROM evt_delivery d JOIN evt_outbox o ON o.message_id = d.message_id WHERE d.status = 'pending'`).get() as { t: string | null };
    return {
      pending: (this.#db.prepare(`SELECT COUNT(*) n FROM evt_delivery WHERE status = 'pending'`).get() as { n: number }).n,
      skipped: (this.#db.prepare(`SELECT COUNT(*) n FROM evt_delivery WHERE status = 'skipped'`).get() as { n: number }).n,
      oldestPendingAgeSeconds: oldest.t ? Math.max(0, Math.round((this.#clock.now().getTime() - new Date(oldest.t).getTime()) / 1000)) : 0,
      failed: this.#db
        .prepare(
          `SELECT d.consumer, d.message_id AS messageId, o.type, d.partition_key AS partitionKey, d.attempts, d.last_error AS lastError, o.occurred_at AS occurredAt
             FROM evt_delivery d JOIN evt_outbox o ON o.message_id = d.message_id WHERE d.status = 'failed' ORDER BY d.seq`,
        )
        .all()
        .map((f: any) => ({ ...f, skippable: !SKIP_FORBIDDEN.test(f.consumer) })),
    };
  }
}
