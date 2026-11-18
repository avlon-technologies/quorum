/**
 * Test harness: one isolated Quorum per test (temp data dir, own SQLite file, manual clock, no
 * background workers). HTTP goes through Fastify's inject; background work is driven explicitly
 * with settle(), so every test is deterministic.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../../src/app.ts';
import { ManualClock, DAY_MS } from '../../src/platform/clock.ts';
import { AGENT_ACTOR } from '../../src/platform/deps.ts';
import { TokenService, loadSecret, hashPassword } from '../../src/platform/auth.ts';
import { StubOrcidClient } from '../../src/integrations/orcid.ts';
import { StubTriageProvider } from '../../src/integrations/triage-provider.ts';
import { FileMailTransport } from '../../src/integrations/mail.ts';
import { provisionAccount, recordOrcidVerification } from '../../src/contexts/identity/service.ts';
import { publishCall } from '../../src/contexts/calls/service.ts';
import { createDraft, submitProposal, confirmEligibility } from '../../src/contexts/submission/service.ts';
import { assignReviewer, acceptAssignment, submitReview } from '../../src/contexts/peer-review/service.ts';
import type { Role } from '../../src/contracts/model.generated.ts';

export { DAY_MS };
export const PASSWORD = 'correct-horse-battery';

/**
 * The stored hash every SEEDED account signs in with: PASSWORD, hashed ONCE per process by the production
 * hashPassword, and reused.
 *
 * Why: scrypt is slow on purpose. A world() seeds twelve accounts, and hashing PASSWORD twelve times over was
 * 60–66% of the time of every acceptance scenario and every claim verifier run (measured 2026-11-18), for twelve
 * hashes of the same known test password. Nothing a seeded account is used for depends on its hash differing from
 * another seeded account's.
 *
 * What is unchanged: the hash is made by the real hashPassword; every sign-in still goes through POST /api/session
 * and the real verifyPassword; every Harness has its own database; production code is not touched. That an account
 * provisioned or registered WITH a password gets its own salted hash is what tests/scenarios/account-credentials.test.ts
 * is for — it does not use this.
 */
let seededPasswordHash: string | undefined;
const seededHash = (): string => (seededPasswordHash ??= hashPassword(PASSWORD));
export const START = '2026-03-02T09:00:00.000Z';
export const ABSTRACT =
  'Northern communities face rapid climate change. This project builds community-operated monitoring of permafrost thaw and wildfire smoke, ' +
  'co-designed with four hamlets, validated against field observations, and handed over with training so resilience decisions are made months ahead of failure. ' +
  'It strengthens climate resilience in northern and remote communities through partnership and open data, and publishes a maintenance playbook ' +
  'that other communities can adopt without specialist staff.';

/** A valid ORCID iD (ISO 7064 MOD 11-2 check digit) derived from n. */
export function orcidFor(n: number): string {
  const base = `0000000${String(1000_0000 + n).slice(-8)}`.slice(-15);
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(base[i])) * 2;
  const r = (12 - (total % 11)) % 11;
  const d = base + (r === 10 ? 'X' : String(r));
  return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12)}`;
}

export type Res = { status: number; body: any; headers: Record<string, unknown> };
export type User = { id: string; email: string; name: string };

export type World = {
  officer: User;
  operator: User; // platform operator: no business role
  chair: User;
  alice: User; // applicant
  bob: User; // applicant
  sam: User; // applicant AND verified reviewer (INV-4)
  r: User[]; // five verified reviewers
  unverified: User; // reviewer without verified ORCID (INV-12)
  callId: string;
  deadline: string;
};

export class Harness {
  readonly dir: string;
  readonly dbFile: string;
  readonly clock: ManualClock;
  readonly triage = new StubTriageProvider();
  readonly mail: FileMailTransport;
  app!: App;
  #tokens = new Map<string, { token: string; at: number }>();
  #orcidN = 1;

  constructor(start: string = START) {
    this.dir = mkdtempSync(join(tmpdir(), 'quorum-test-'));
    this.dbFile = join(this.dir, 'quorum.sqlite');
    this.clock = new ManualClock(start);
    this.mail = new FileMailTransport(join(this.dir, 'mail.jsonl'));
  }

  static async create(start?: string): Promise<Harness> {
    const h = new Harness(start);
    h.app = await createApp({
      dbFile: h.dbFile,
      dataDir: h.dir,
      clock: h.clock,
      orcid: new StubOrcidClient(),
      triage: h.triage,
      mail: h.mail,
      workers: false,
      demo: false,
      sessionClock: h.clock, // tests exercise token expiry against the manual clock
    });
    return h;
  }

  get deps() {
    return this.app.deps;
  }
  get db() {
    return this.app.deps.db;
  }

  async close(): Promise<void> {
    await this.app.close();
    await new Promise((r) => setImmediate(r));
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly; the OS temp dir is cleaned eventually */
    }
  }

  /** Run a service function in one write transaction, as the HTTP layer does. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  async settle(): Promise<void> {
    await this.app.settle();
  }

  // ------------------------------------------------------------------ observation helpers
  count(type: string, where: Record<string, string> = {}): number {
    const conds = Object.keys(where).map((k) => `json_extract(payload, '$.${k}') = ?`);
    const sql = `SELECT COUNT(*) n FROM evt_outbox WHERE type = ?${conds.map((c) => ` AND ${c}`).join('')}`;
    return (this.db.prepare(sql).get(type, ...Object.values(where)) as { n: number }).n;
  }
  totalEvents(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM evt_outbox`).get() as { n: number }).n;
  }
  one<T = any>(sql: string, ...args: unknown[]): T {
    return this.db.prepare(sql).get(...args) as T;
  }
  all<T = any>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  status(proposalId: string): string {
    return this.one<{ status: string }>(`SELECT status FROM sub_proposal WHERE id = ?`, proposalId).status;
  }

  // ------------------------------------------------------------------ accounts and HTTP
  account(name: string, roles: Role[], opts: { verified?: boolean; institution?: string } = {}): User {
    const email = `${name.toLowerCase().replace(/[^a-z]/g, '')}-${randomUUID().slice(0, 6)}@test.quorum`;
    // provisioned by the real service with no password, then given the one hash of PASSWORD (seededHash, above)
    const hash = seededHash();
    const id = this.tx(() => {
      const made = provisionAccount(this.deps, { email, name, institution: opts.institution ?? 'Test University', roles });
      this.db.prepare(`UPDATE idn_account SET password_hash = ? WHERE id = ?`).run(hash, made);
      return made;
    });
    if (opts.verified) {
      const orcid = orcidFor(this.#orcidN++);
      this.tx(() => recordOrcidVerification(this.deps, id, orcid, true));
    }
    return { id, email, name };
  }

  /** Provision the agent account exactly as the seed does: no password, no roles. */
  agentAccount(): User {
    this.tx(() =>
      provisionAccount(this.deps, { id: AGENT_ACTOR, kind: 'agent', email: 'triage@agents.test', name: 'Eligibility triage agent', institution: 'Quorum', roles: [] }),
    );
    return { id: AGENT_ACTOR, email: 'triage@agents.test', name: 'agent' };
  }

  /** Mint a token directly with the server's own secret (for accounts that cannot sign in, e.g. the agent). */
  async mintToken(accountId: string): Promise<string> {
    return (await new TokenService(loadSecret(this.dir), this.clock).issue(accountId)).token;
  }

  async token(u: User): Promise<string> {
    const now = this.clock.now().getTime();
    const c = this.#tokens.get(u.id);
    if (c && now - c.at < 6 * 3600_000 && now >= c.at) return c.token;
    const r = await this.req('POST', '/api/session', null, { email: u.email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed for ${u.email}: ${r.status} ${JSON.stringify(r.body)}`);
    this.#tokens.set(u.id, { token: r.body.token, at: now });
    return r.body.token;
  }

  async req(method: string, url: string, auth: User | string | null, body?: unknown, idemKey?: string): Promise<Res> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${typeof auth === 'string' ? auth : await this.token(auth)}`;
    if (method !== 'GET') headers['idempotency-key'] = idemKey ?? randomUUID();
    if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
    const r = await this.app.http.inject({ method: method as 'GET', url, headers, payload: body === undefined || body === null ? undefined : JSON.stringify(body) });
    let parsed: unknown = null;
    try {
      parsed = r.body ? JSON.parse(r.body) : null;
    } catch {
      parsed = r.body;
    }
    return { status: r.statusCode, body: parsed, headers: r.headers as Record<string, unknown> };
  }
  get(url: string, as: User | string | null) {
    return this.req('GET', url, as);
  }
  post(url: string, as: User | string | null, body: unknown = {}, key?: string) {
    return this.req('POST', url, as, body, key);
  }

  // ------------------------------------------------------------------ world building (through the real services)
  world(opts: { envelope?: number; maxRequest?: number; criteria?: number; deadlineDays?: number } = {}): World {
    const officer = this.account('Olivia Officer', ['programOfficer']);
    const chair = this.account('Chris Chair', ['panelChair']);
    const operator = this.account('Owen Operator', ['operator']);
    const alice = this.account('Alice Applicant', ['applicant']);
    const bob = this.account('Bob Applicant', ['applicant']);
    const sam = this.account('Sam Both', ['applicant', 'reviewer'], { verified: true });
    const r = [1, 2, 3, 4, 5].map((i) => this.account(`Reviewer ${i}`, ['reviewer'], { verified: true }));
    const unverified = this.account('Uma Unverified', ['reviewer']);
    const deadline = new Date(this.clock.now().getTime() + (opts.deadlineDays ?? 30) * DAY_MS).toISOString();
    const n = opts.criteria ?? 3;
    const call = this.tx(() =>
      publishCall(this.deps, officer.id, {
        title: 'Climate Resilience in Northern Communities',
        summary: 'Research that helps northern and remote communities anticipate and withstand climate-driven hazards such as permafrost thaw and wildfire smoke.',
        deadline,
        envelope: opts.envelope ?? 300_000,
        maxRequest: opts.maxRequest ?? 150_000,
        criteria: Array.from({ length: n }, (_, i) => ({ name: `Criterion ${i + 1}`, guidance: `Guidance ${i + 1}` })),
      }),
    );
    return { officer, operator, chair, alice, bob, sam, r, unverified, callId: call.id, deadline };
  }

  draft(w: World, applicant: User, opts: { requested?: number; abstract?: string; title?: string } = {}): string {
    return this.tx(() =>
      createDraft(this.deps, applicant.id, {
        callId: w.callId,
        title: opts.title ?? 'Community early warning for permafrost thaw',
        abstract: opts.abstract ?? ABSTRACT,
        requested: opts.requested ?? 100_000,
      }),
    ).id;
  }

  async submitted(w: World, applicant: User = w.alice, opts: { requested?: number; abstract?: string } = {}): Promise<string> {
    const id = this.draft(w, applicant, opts);
    this.tx(() => submitProposal(this.deps, { accountId: applicant.id, name: applicant.name }, id));
    await this.settle();
    return id;
  }

  async eligible(w: World, applicant: User = w.alice, opts: { requested?: number } = {}): Promise<string> {
    const id = await this.submitted(w, applicant, opts);
    this.tx(() => confirmEligibility(this.deps, w.officer.id, id, 'eligible', 'In scope and complete.'));
    await this.settle();
    return id;
  }

  assignment(proposalId: string, reviewer: User): string {
    return this.one<{ id: string }>(`SELECT id FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ? AND status <> 'revoked'`, proposalId, reviewer.id).id;
  }

  async underReview(w: World, reviewers: User[] = w.r.slice(0, 3), applicant: User = w.alice, opts: { requested?: number } = {}): Promise<string> {
    const id = await this.eligible(w, applicant, opts);
    for (const rv of reviewers) this.tx(() => assignReviewer(this.deps, w.officer.id, id, rv.id));
    await this.settle();
    return id;
  }

  scores(w: World, v = 4): Record<string, number> {
    const n = (this.one<{ n: number }>(`SELECT COUNT(*) n FROM cal_criterion WHERE call_id = ?`, w.callId)).n;
    return Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, v]));
  }

  review(w: World, proposalId: string, reviewer: User, v = 4): void {
    const a = this.assignment(proposalId, reviewer);
    const st = this.one<{ status: string }>(`SELECT status FROM rev_assignment WHERE id = ?`, a).status;
    if (st === 'assigned') this.tx(() => acceptAssignment(this.deps, reviewer.id, a));
    this.tx(() =>
      submitReview(this.deps, reviewer.id, a, {
        scores: this.scores(w, v),
        comment: 'A careful, well-justified proposal with a credible plan and a strong team.',
        attestsNoConflict: true,
      }),
    );
  }

  async scored(w: World, reviewers: User[] = w.r.slice(0, 3), applicant: User = w.alice, opts: { requested?: number } = {}): Promise<string> {
    const id = await this.underReview(w, reviewers, applicant, opts);
    for (const rv of reviewers) this.review(w, id, rv);
    await this.settle();
    return id;
  }
}
