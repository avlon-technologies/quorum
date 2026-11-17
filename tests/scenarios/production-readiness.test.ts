/**
 * Production-readiness behaviour added in this release, each tied to the gap it closes:
 *   B7  INV-5 enforced by the database under concurrent writers
 *   B3  decision escalation publishes DecisionEscalated once and notifies the officers
 *   B4  refused awards and integrity holds are audited transitions
 *   B5  per-account read state; operator-only operations; no conflicts against unknown ids
 *   B6  a parked delivery can be skipped with a reason (where safe), and parking raises an alert
 *   erasure, rate limiting, monitoring endpoints, backup and restore
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, DAY_MS, PASSWORD, ABSTRACT } from '../support/harness.ts';
import { onAlert } from '../../src/platform/alerts.ts';
import { RateLimiter } from '../../src/platform/rate-limit.ts';
import { backupTo, restoreFrom, verifyBackup, pidFileFor } from '../../src/platform/backup.ts';
import { openDb } from '../../src/platform/db.ts';
import { createApp } from '../../src/app.ts';
import { ManualClock } from '../../src/platform/clock.ts';
import { StubOrcidClient } from '../../src/integrations/orcid.ts';
import { StubTriageProvider } from '../../src/integrations/triage-provider.ts';
import { FileMailTransport } from '../../src/integrations/mail.ts';

const CHILD = fileURLToPath(new URL('../support/award-child.ts', import.meta.url));

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => {
  h.deps.bus.faultInjector = undefined;
  await h.close();
});

function race(argSets: string[][]): Promise<any[]> {
  const startAt = Date.now() + 1500;
  return Promise.all(
    argSets.map(
      (args) =>
        new Promise<any>((resolve, reject) => {
          const p = spawn(process.execPath, [CHILD, 'assign', h.dbFile, h.dir, h.clock.now().toISOString(), String(startAt), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (err += d));
          p.on('exit', (code) => {
            const line = out.trim().split('\n').pop();
            if (code !== 0 || !line) return reject(new Error(`child exited ${code}: ${err}`));
            resolve(JSON.parse(line));
          });
        }),
    ),
  );
}

describe('B7: at most three active reviewers, enforced by the database', () => {
  it('six processes assign six different reviewers at once: exactly three succeed', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const reviewers = [...w.r, w.sam];
    const results = await race(reviewers.map((r) => [w.officer.id, id, r.id]));
    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);
    expect(results.filter((r) => r.outcome === 'assigned')).toHaveLength(3);
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ? AND status <> 'revoked'`, id).n).toBe(3);
  }, 120_000);

  it('a fourth live assignment written directly, bypassing the service check, is refused by the trigger', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    expect(() =>
      h.db
        .prepare(`INSERT INTO rev_assignment (id, proposal_id, reviewer_id, status, due_at, assigned_by, assigned_at) VALUES ('x-4th', ?, ?, 'assigned', ?, ?, ?)`)
        .run(id, w.r[4]!.id, w.deadline, w.officer.id, h.clock.now().toISOString()),
    ).toThrow(/INV-5/);
    const revoked = h.one(`SELECT id FROM rev_assignment WHERE proposal_id = ? LIMIT 1`, id).id;
    h.db.prepare(`UPDATE rev_assignment SET status = 'revoked' WHERE id = ?`).run(revoked);
    expect(() => h.db.prepare(`UPDATE rev_assignment SET status = 'assigned' WHERE id = ?`).run(revoked)).toThrow(/INV-5/);
  });
});

describe('B3/B4: escalation, refusal and hold are events, notified and audited', () => {
  it('a decision past due publishes DecisionEscalated exactly once, notifies officers and decides nothing', async () => {
    const w = h.world();
    const id = await h.scored(w);
    h.clock.advance(15 * DAY_MS);
    await h.settle();
    h.clock.advance(10 * DAY_MS);
    await h.settle();
    expect(h.count('DecisionEscalated', { proposalId: id })).toBe(1);
    expect(h.one(`SELECT status FROM adj_case WHERE proposal_id = ?`, id).status).toBe('awaitingDecision');
    expect(h.status(id)).toBe('scored');
    const n = h.one(`SELECT recipient, subject FROM ntf_message WHERE kind = 'decision-overdue'`);
    expect(n.recipient).toBe('role:programOfficer');
    expect(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE proposal_id = ? AND event = 'DecisionEscalated'`, id).n).toBe(1);
  });

  it('a refused award publishes AwardRefused, which reaches the audit trail and the officers', async () => {
    const w = h.world({ envelope: 150_000, maxRequest: 150_000 });
    const a = await h.scored(w, w.r.slice(0, 3), w.alice, { requested: 100_000 });
    const b = await h.scored(w, w.r.slice(0, 3), w.bob, { requested: 100_000 });
    expect((await h.post(`/api/adjudications/${a}/decision`, w.chair, { outcome: 'award', rationale: 'Strongest proposal in the round.' })).status).toBe(200);
    const r = await h.post(`/api/adjudications/${b}/decision`, w.chair, { outcome: 'award', rationale: 'Also very strong in the round.' });
    expect(r.status).toBe(409);
    await h.settle();
    expect(h.count('AwardRefused', { proposalId: b })).toBe(1);
    expect(h.one(`SELECT summary FROM ovs_audit WHERE proposal_id = ? AND event = 'AwardRefused'`, b).summary).toMatch(/refused/);
    expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE kind = 'award-refused'`).n).toBe(1);
  });

  it('an integrity hold publishes AwardHeld once and is audited', async () => {
    const w = h.world();
    const id = await h.scored(w);
    expect((await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reason: 'I co-authored with the applicant last year.' })).status).toBe(201);
    await h.settle();
    expect(h.count('AwardHeld', { proposalId: id })).toBe(1);
    expect(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE proposal_id = ? AND event = 'AwardHeld'`, id).n).toBe(1);
  });
});

describe('B5: notifications, operations and conflicts', () => {
  it('one officer reading a role-addressed notification does not mark it read for another officer', async () => {
    const w = h.world();
    const other = h.account('Otto Officer', ['programOfficer']);
    await h.submitted(w);
    expect((await h.post('/api/notifications/read', w.officer, {})).status).toBe(200);
    const mine = (await h.get('/api/notifications', w.officer)).body;
    const theirs = (await h.get('/api/notifications', other)).body;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m: any) => m.readAt)).toBe(true);
    expect(theirs.every((m: any) => m.readAt === null)).toBe(true);
  });

  it('an officer cannot declare a conflict for a proposal or reviewer that does not exist', async () => {
    const w = h.world();
    const id = await h.eligible(w);
    const ghostProposal = await h.post('/api/conflicts', w.officer, { proposalId: '00000000-0000-0000-0000-000000000000', reviewerId: w.r[0]!.id, reason: 'Probe for a missing proposal.' });
    expect(ghostProposal.status).toBe(404);
    const ghostReviewer = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: '00000000-0000-0000-0000-000000000000', reason: 'Probe for a missing reviewer.' });
    expect(ghostReviewer.status).toBe(404);
    expect(h.one(`SELECT COUNT(*) n FROM rev_conflict`).n).toBe(0);
  });

  it('operations are the operator’s: officers and chairs are refused', async () => {
    const w = h.world();
    for (const u of [w.officer, w.chair]) expect((await h.get('/api/operations/health', u)).status).toBe(403);
    const r = await h.get('/api/operations/health', w.operator);
    expect(r.status).toBe(200);
    expect(r.body.delivery).toMatchObject({ pending: expect.any(Number), skipped: 0 });
  });
});

describe('B6: repeatedly failing deliveries', () => {
  async function parkNotification(w: ReturnType<Harness['world']>) {
    const consumer = 'notification.notification-service';
    let failing = true;
    h.deps.bus.faultInjector = (c) => {
      if (failing && c === consumer) throw new Error('SMTP relay rejected the template');
    };
    const alerts: any[] = [];
    const off = onAlert((a) => alerts.push(a));
    const id = await h.submitted(w);
    for (let i = 0; i < 8; i++) {
      h.clock.advance(61_000);
      await h.settle();
    }
    off();
    const msg = h.one(`SELECT message_id FROM evt_outbox WHERE type = 'ProposalSubmitted'`).message_id;
    return { consumer, msg, id, alerts, stop: () => (failing = false) };
  }

  it('parking raises one alert carrying ids and no personal data', async () => {
    const w = h.world();
    const { alerts, msg } = await parkNotification(w);
    const parked = alerts.filter((a) => a.kind === 'delivery_parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ consumer: 'notification.notification-service', messageId: msg, type: 'ProposalSubmitted', attempts: 5 });
    expect(JSON.stringify(parked[0])).not.toContain(w.alice.name);
  });

  it('an operator skips a poison delivery with a reason; the partition is released and the act is recorded', async () => {
    const w = h.world();
    const { consumer, msg, id, stop } = await parkNotification(w);
    stop(); // the template is fixed for new events; the poison one is skipped rather than replayed
    expect((await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'eligible', reason: '' })).status).toBe(200);
    await h.settle();
    const short = await h.post('/api/operations/deliveries/skip', w.operator, { consumer, messageId: msg, reason: 'short' });
    expect(short.status).toBe(400);
    const r = await h.post('/api/operations/deliveries/skip', w.operator, { consumer, messageId: msg, reason: 'Template bug; the applicant was told by phone.' });
    expect(r.status).toBe(200);
    await h.settle();
    expect(h.one(`SELECT status FROM evt_delivery WHERE consumer = ? AND message_id = ?`, consumer, msg).status).toBe('skipped');
    expect(h.one(`SELECT COUNT(*) n FROM evt_delivery WHERE status NOT IN ('delivered','skipped')`).n).toBe(0);
    // A skip drops the event's whole effect, including the notification replica later events rely on: the
    // applicant's "eligible" notice cannot be addressed. This is why skipping needs a reason, and why the
    // operator page says so before confirming (docs/OPERATIONS.md).
    expect(h.all(`SELECT kind FROM ntf_message WHERE recipient = ?`, w.alice.id).map((x) => x.kind)).toEqual([]);
    expect(h.one(`SELECT actor_id, action, reason FROM ops_action WHERE action = 'skip-delivery'`)).toMatchObject({ actor_id: w.operator.id, reason: 'Template bug; the applicant was told by phone.' });
    expect(() => h.db.prepare(`DELETE FROM ops_action`).run()).toThrow(/append-only/);
  });

  it('a delivery whose effect guards an invariant can never be skipped', async () => {
    const w = h.world();
    const consumer = 'adjudication.adjudication-service';
    h.deps.bus.faultInjector = (c) => {
      if (c === consumer) throw new Error('ledger write failed');
    };
    const id = await h.scored(w);
    await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reason: 'Disclosed after scoring for the test.' });
    for (let i = 0; i < 8; i++) {
      h.clock.advance(61_000);
      await h.settle();
    }
    const parked = h.deps.bus.health().failed.find((f: any) => f.consumer === consumer);
    expect(parked).toMatchObject({ skippable: false });
    const r = await h.post('/api/operations/deliveries/skip', w.operator, { consumer, messageId: parked!.messageId, reason: 'Trying to skip an integrity input.' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('skip_forbidden');
  });
});

describe('Erasure', () => {
  it('erases an applicant’s personal data everywhere it is held, keeps business records, and survives a rebuild', async () => {
    const w = h.world();
    const draft = await h.post('/api/proposals', w.alice, { callId: w.callId, title: 'Erasure probe proposal', abstract: ABSTRACT, requested: 50_000 });
    expect(draft.status).toBe(201);
    const id = await h.scored(w);
    const pii = [w.alice.name, w.alice.email];
    const leaks = () =>
      pii.flatMap((v) =>
        [
          ['idn_account', `SELECT COUNT(*) n FROM idn_account WHERE name = ? OR email = ?`],
          ['evt_outbox', `SELECT COUNT(*) n FROM evt_outbox WHERE instr(payload, ?) > 0 OR instr(payload, ?) > 0`],
          ['ntf_message', `SELECT COUNT(*) n FROM ntf_message WHERE instr(body, ?) > 0 OR instr(subject, ?) > 0`],
          ['ovs_proposal', `SELECT COUNT(*) n FROM ovs_proposal WHERE instr(applicant_name, ?) > 0 OR instr(title, ?) > 0`],
          ['ovs_audit', `SELECT COUNT(*) n FROM ovs_audit WHERE instr(summary, ?) > 0 OR instr(COALESCE(reason, ''), ?) > 0`],
          ['cmd_log', `SELECT COUNT(*) n FROM cmd_log WHERE instr(response, ?) > 0 OR instr(response, ?) > 0`],
        ]
          .filter(([, sql]) => h.one(sql!, v, v).n > 0)
          .map(([t]) => `${t}:${v}`),
      );
    expect(leaks().length).toBeGreaterThan(0); // the probe would see the data if it were there

    const refused = await h.post(`/api/operations/accounts/${w.alice.id}/erase`, w.officer, { reason: 'Data subject request #42 received by email.' });
    expect(refused.status).toBe(403);
    const r = await h.post(`/api/operations/accounts/${w.alice.id}/erase`, w.operator, { reason: 'Data subject request #42 received by email.' });
    expect(r.status).toBe(200);
    expect(r.body.erased).toBe(true);
    await h.settle();
    expect(leaks()).toEqual([]);

    // business records remain, referenced by id
    expect(h.status(id)).toBe('scored');
    expect(h.one(`SELECT COUNT(*) n FROM sub_proposal WHERE applicant_id = ?`, w.alice.id).n).toBe(2);
    // the account can no longer act
    expect((await h.get('/api/me', await tokenOf(w.alice))).status).toBe(401);
    expect((await h.req('POST', '/api/session', null, { email: w.alice.email, password: PASSWORD })).status).toBe(401);
    // a rebuild from the redacted log gives the same erased projection
    expect((await h.post('/api/operations/rebuild-projections', w.operator, {})).status).toBe(200);
    await h.settle();
    expect(leaks()).toEqual([]);
    expect(h.one(`SELECT applicant_name FROM ovs_proposal WHERE proposal_id = ?`, id).applicant_name).toBe('[erased]');
    // idempotent, audited, and an operator cannot erase themselves
    expect((await h.post(`/api/operations/accounts/${w.alice.id}/erase`, w.operator, { reason: 'Second request for the same subject.' })).body.erased).toBe(false);
    expect(h.one(`SELECT COUNT(*) n FROM ops_action WHERE action = 'erase-account' AND subject = ?`, w.alice.id).n).toBe(1);
    expect((await h.post(`/api/operations/accounts/${w.operator.id}/erase`, w.operator, { reason: 'Operator trying to erase self.' })).status).toBe(409);
  });

  it('erasing a reviewer removes their ORCID iD from the event log and the audit trail', async () => {
    const w = h.world();
    await h.scored(w);
    const orcid = h.one(`SELECT orcid_id FROM idn_account WHERE id = ?`, w.r[0]!.id).orcid_id as string;
    expect(h.one(`SELECT COUNT(*) n FROM evt_outbox WHERE instr(payload, ?) > 0`, orcid).n).toBeGreaterThan(0);
    expect((await h.post(`/api/operations/accounts/${w.r[0]!.id}/erase`, w.operator, { reason: 'Reviewer asked to be forgotten.' })).status).toBe(200);
    await h.settle();
    expect(h.one(`SELECT COUNT(*) n FROM evt_outbox WHERE instr(payload, ?) > 0`, orcid).n).toBe(0);
    expect(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE instr(summary, ?) > 0`, orcid).n).toBe(0);
    expect(h.one(`SELECT COUNT(*) n FROM rev_review WHERE reviewer_id = ?`, w.r[0]!.id).n).toBe(1);
  });
});

async function tokenOf(u: { email: string }) {
  const r = await h.req('POST', '/api/session', null, { email: u.email, password: PASSWORD });
  return r.body.token as string;
}

describe('Rate limiting', () => {
  it('sign-in failures are throttled per address and email; a correct password is refused while locked', async () => {
    const w = h.world();
    for (let i = 0; i < 10; i++) expect((await h.req('POST', '/api/session', null, { email: w.bob.email, password: 'wrong-password' })).status).toBe(401);
    const locked = await h.req('POST', '/api/session', null, { email: w.bob.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('too_many_attempts');
    // another account from the same address is unaffected
    expect((await h.req('POST', '/api/session', null, { email: w.alice.email, password: PASSWORD })).status).toBe(200);
  });

  it('writes beyond the per-account limit get 429 with Retry-After, and nothing is applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-rl-'));
    const app = await createApp({
      dbFile: join(dir, 'q.sqlite'),
      dataDir: dir,
      clock: new ManualClock('2026-03-02T09:00:00Z'),
      orcid: new StubOrcidClient(),
      triage: new StubTriageProvider(),
      mail: new FileMailTransport(join(dir, 'mail.jsonl')),
      workers: false,
      rateLimit: { enabled: true, signinPerIdentity: 10, signinPerIp: 50, signinWindowMs: 900_000, writesPerMin: 3, readsPerMin: 100 },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await app.http.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: { 'content-type': 'application/json', 'idempotency-key': `rl-probe-${i}-xxxx` },
          payload: JSON.stringify({ email: `rl${i}@test.quorum`, name: 'Rate Probe', institution: 'Test University', password: 'a-long-enough-password' }),
        });
        codes.push(r.statusCode);
        if (r.statusCode === 429) expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(codes).toEqual([201, 201, 201, 429, 429]);
      expect((app.deps.db.prepare(`SELECT COUNT(*) n FROM idn_account`).get() as { n: number }).n).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('the limiter forgets expired windows', () => {
    let t = 0;
    const l = new RateLimiter({ enabled: true, signinPerIdentity: 1, signinPerIp: 1, signinWindowMs: 1000, writesPerMin: 1, readsPerMin: 1 }, () => t);
    expect(l.hit('k', 1, 1000)).toBe(0);
    expect(l.hit('k', 1, 1000)).toBeGreaterThan(0);
    t = 61_000;
    l.sweep();
    expect(l.size).toBe(0);
    expect(l.hit('k', 1, 1000)).toBe(0);
  });
});

describe('Monitoring', () => {
  it('liveness, readiness and Prometheus metrics', async () => {
    const w = h.world();
    await h.submitted(w);
    expect((await h.get('/healthz', null)).body).toEqual({ status: 'alive' });
    const ready = await h.get('/readyz', null);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', schemaVersion: 2 });
    const m = await h.app.http.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' });
    expect(m.statusCode).toBe(200);
    for (const name of ['quorum_deliveries_parked', 'quorum_delivery_oldest_pending_age_seconds', 'quorum_last_backup_age_seconds', 'quorum_http_requests_total', 'quorum_db_bytes']) {
      expect(m.body).toContain(name);
    }
    expect(m.body).not.toContain(w.alice.email);
    const remote = await h.app.http.inject({ method: 'GET', url: '/metrics', remoteAddress: '203.0.113.9' });
    expect(remote.statusCode).toBe(403);
  });
});

describe('Backup and restore', () => {
  it('an online backup taken while serving restores to exactly that point, and restore refuses while a server holds the file', async () => {
    const w = h.world();
    const before = await h.submitted(w);
    const r = await h.post('/api/operations/backup', w.operator, {});
    expect(r.status).toBe(200);
    expect(verifyBackup(r.body.file)).toMatchObject({ ok: true, integrity: 'ok', schemaVersion: 2 });
    const after = await h.submitted(w, w.bob); // committed after the backup: the recovery point excludes it

    // a live server holds the database: restore must refuse
    writeFileSync(pidFileFor(h.dbFile), String(process.pid));
    expect(() => restoreFrom(r.body.file, h.dbFile)).toThrow(/stop it before restoring/);

    // restore into a fresh location (the offline procedure), then start a server on it
    const dir = mkdtempSync(join(tmpdir(), 'quorum-restore-'));
    const target = join(dir, 'quorum.sqlite');
    const res = restoreFrom(r.body.file, target);
    expect(res.schemaVersion).toBe(2);
    const app = await createApp({ dbFile: target, dataDir: dir, clock: h.clock, orcid: new StubOrcidClient(), triage: new StubTriageProvider(), mail: new FileMailTransport(join(dir, 'm.jsonl')), workers: false });
    try {
      await app.settle();
      const ids = (app.deps.db.prepare(`SELECT id FROM sub_proposal`).all() as Array<{ id: string }>).map((x) => x.id);
      expect(ids).toContain(before);
      expect(ids).not.toContain(after);
      expect((app.deps.db.prepare(`SELECT COUNT(*) n FROM evt_delivery WHERE status NOT IN ('delivered','skipped')`).get() as { n: number }).n).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('a corrupted backup is refused before anything is touched', async () => {
    const w = h.world();
    await h.submitted(w);
    const b = await backupTo(h.db, join(h.dir, 'bk'));
    writeFileSync(b.file, 'not a database');
    const target = join(h.dir, 'restore-target.sqlite');
    expect(() => restoreFrom(b.file, target)).toThrow(/unverified backup/);
    expect(existsSync(target)).toBe(false);
    const db = openDb(join(h.dir, 'other.sqlite'));
    db.close();
  });
});
