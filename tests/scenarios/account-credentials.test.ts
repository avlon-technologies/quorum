import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, PASSWORD } from '../support/harness.ts';
import { provisionAccount } from '../../src/contexts/identity/service.ts';
import { hashPassword, verifyPassword } from '../../src/platform/auth.ts';

// The harness seeds its accounts with one hash of the test password per process (tests/support/harness.ts,
// seededHash). These tests are what that leaves unexercised by seeding, exercised directly: an account that is
// provisioned or registered WITH a password gets its own salted scrypt hash, made by the production code, and
// signing in verifies against it.

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

const stored = (email: string): string | null => h.one<{ password_hash: string | null }>(`SELECT password_hash FROM idn_account WHERE email = ?`, email).password_hash;
const signIn = (email: string, password: string) => h.req('POST', '/api/session', null, { email, password });

describe('account credentials — provisioning and registration hash the password, and sign-in verifies it', () => {
  it('hashPassword salts every hash: one password, two different stored values, each verifying only that password', () => {
    const a = hashPassword('a-password-of-some-length');
    const b = hashPassword('a-password-of-some-length');
    expect(a).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('a-password-of-some-length');
    for (const x of [a, b]) {
      expect(verifyPassword('a-password-of-some-length', x)).toBe(true);
      expect(verifyPassword('a-password-of-some-lengtH', x)).toBe(false);
    }
    expect(verifyPassword('a-password-of-some-length', null)).toBe(false);
    expect(verifyPassword('a-password-of-some-length', 'plain$text')).toBe(false);
  });

  it('provisionAccount with a password stores its own salted hash per account, and each account signs in with its own password only', async () => {
    const one = 'first-provisioned-password';
    const two = 'second-provisioned-password';
    h.tx(() => provisionAccount(h.deps, { email: 'p1@test.quorum', name: 'Provisioned One', institution: 'Test University', password: one, roles: ['applicant'] }));
    h.tx(() => provisionAccount(h.deps, { email: 'p2@test.quorum', name: 'Provisioned Two', institution: 'Test University', password: two, roles: ['applicant'] }));
    h.tx(() => provisionAccount(h.deps, { email: 'p3@test.quorum', name: 'Provisioned Three', institution: 'Test University', password: one, roles: ['applicant'] }));
    const [h1, h2, h3] = ['p1@test.quorum', 'p2@test.quorum', 'p3@test.quorum'].map(stored) as [string | null, string | null, string | null];
    for (const x of [h1, h2, h3]) expect(x).toMatch(/^scrypt\$/);
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(h1).not.toBe(h3); // the same password, hashed again with another salt
    expect(verifyPassword(one, h1)).toBe(true);
    expect(verifyPassword(one, h2)).toBe(false);
    expect((await signIn('p1@test.quorum', one)).status).toBe(200);
    expect((await signIn('p2@test.quorum', two)).status).toBe(200);
    expect((await signIn('p3@test.quorum', one)).status).toBe(200);
    expect((await signIn('p1@test.quorum', two)).status).toBe(401);
    expect((await signIn('p2@test.quorum', one)).status).toBe(401);
  });

  it('an account provisioned without a password has no hash and cannot sign in with any', async () => {
    h.tx(() => provisionAccount(h.deps, { email: 'nopw@test.quorum', name: 'No Password', institution: 'Test University', roles: ['applicant'] }));
    expect(stored('nopw@test.quorum')).toBeNull();
    expect((await signIn('nopw@test.quorum', PASSWORD)).status).toBe(401);
    expect((await signIn('nopw@test.quorum', '')).status).not.toBe(200);
  });

  it('self-registration through the API hashes the chosen password, and sign-in verifies it', async () => {
    const chosen = 'a-long-enough-password';
    const r = await h.req('POST', '/api/accounts', null, { email: 'self@test.quorum', name: 'Self Registered', institution: 'Test University', password: chosen }, 'account-credentials-self-registration');
    expect(r.status).toBe(201);
    const hash = stored('self@test.quorum');
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(chosen);
    expect(verifyPassword(chosen, hash)).toBe(true);
    expect((await signIn('self@test.quorum', chosen)).status).toBe(200);
    expect((await signIn('self@test.quorum', `${chosen}x`)).status).toBe(401);
  });

  it('seeded accounts share one stored hash, made by the production hashPassword, and sign in through the real session route', async () => {
    const w = h.world();
    const seeded = [w.officer, w.chair, w.alice, w.bob, ...w.r].map((u) => stored(u.email));
    const shared = seeded[0] ?? null;
    expect(new Set(seeded).size).toBe(1);
    expect(shared).toMatch(/^scrypt\$/);
    expect(verifyPassword(PASSWORD, shared)).toBe(true);
    expect((await signIn(w.alice.email, PASSWORD)).status).toBe(200);
    expect((await signIn(w.alice.email, 'not-the-password')).status).toBe(401);
    // another application instance has its own database and its own accounts: nothing but the hash value is shared
    const other = await Harness.create();
    try {
      const v = other.world();
      expect(other.one<{ n: number }>(`SELECT COUNT(*) AS n FROM idn_account WHERE email = ?`, w.alice.email).n).toBe(0);
      expect(h.one<{ n: number }>(`SELECT COUNT(*) AS n FROM idn_account WHERE email = ?`, v.alice.email).n).toBe(0);
      expect((await other.req('POST', '/api/session', null, { email: v.alice.email, password: PASSWORD })).status).toBe(200);
    } finally { await other.close(); }
  });
});
