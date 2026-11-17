import { afterEach, describe, expect, it } from 'vitest';
import { HttpOrcidClient, OrcidUnavailableError, derivePublicApiUrl, orcidFromEnv } from '../../src/integrations/orcid.ts';
import { fakeHttp, json, sleep, type FakeHttp } from './fakes.ts';

const FOUND = '0000-0002-1825-0097'; // ORCID's documented example (Josiah Carberry)
const MISSING = '0000-0003-1415-9269';
const BROKEN = '0000-0002-9079-593X';
const SLOW = '0000-0002-1694-233X';
const FLAKY = '0000-0001-5109-3700';
const SECRET = 'orcid-secret-should-never-leak';

let fake: FakeHttp | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

/** Imitates orcid.org/oauth/token and pub.orcid.org/v3.0/{id}/record. */
async function orcidFake(opts: { tokenStatus?: number; tokenForRecord?: () => string } = {}) {
  let flakyCalls = 0;
  let issued = 0;
  const f = await fakeHttp(async (req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      if (opts.tokenStatus) return json(res, opts.tokenStatus, { error: 'invalid_client' });
      const form = new URLSearchParams(req.body);
      if (form.get('client_id') !== 'APP-TEST' || form.get('client_secret') !== SECRET) return json(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') !== 'client_credentials' || form.get('scope') !== '/read-public') return json(res, 400, { error: 'invalid_request' });
      issued++;
      return json(res, 200, { access_token: `tok-${issued}`, token_type: 'bearer', expires_in: 631138518, scope: '/read-public' });
    }
    const m = /^\/v3\.0\/([^/]+)\/record$/.exec(req.url);
    if (req.method !== 'GET' || !m) return json(res, 400, {});
    const expected = opts.tokenForRecord?.() ?? `tok-${issued}`;
    if (req.headers.authorization !== `Bearer ${expected}`) return json(res, 401, { error: 'invalid_token' });
    const id = decodeURIComponent(m[1]!);
    if (id === FOUND) {
      return json(res, 200, {
        'orcid-identifier': { path: FOUND },
        person: { name: { 'given-names': { value: 'Josiah' }, 'family-name': { value: 'Carberry' }, 'credit-name': null } },
      });
    }
    if (id === MISSING) return json(res, 404, { 'response-code': 404 });
    if (id === BROKEN) return json(res, 500, { error: 'boom' });
    if (id === SLOW) {
      await sleep(400);
      return json(res, 200, { 'orcid-identifier': { path: SLOW } });
    }
    if (id === FLAKY) {
      flakyCalls++;
      if (flakyCalls === 1) return json(res, 503, {});
      return json(res, 200, { 'orcid-identifier': { path: FLAKY }, person: { name: null } });
    }
    return json(res, 404, {});
  });
  return f;
}

const client = (f: FakeHttp, extra: Partial<ConstructorParameters<typeof HttpOrcidClient>[0]> = {}) =>
  new HttpOrcidClient({ baseUrl: f.url, apiUrl: `${f.url}/v3.0`, clientId: 'APP-TEST', clientSecret: SECRET, timeoutMs: 150, retries: 2, backoffMs: 5, ...extra });

const records = (f: FakeHttp) => f.requests.filter((r) => r.url.includes('/record'));
const tokens = (f: FakeHttp) => f.requests.filter((r) => r.url === '/oauth/token');

describe('HttpOrcidClient against a fake ORCID registry', () => {
  it('200: the iD exists, with the public name', async () => {
    fake = await orcidFake();
    const r = await client(fake).lookup(FOUND);
    expect(r).toEqual({ orcidId: FOUND, exists: true, name: 'Josiah Carberry' });
    expect(records(fake)[0]!.headers.accept).toBe('application/vnd.orcid+json');
  });

  it('a private name is null, not an error', async () => {
    fake = await orcidFake();
    expect(await client(fake).lookup(FLAKY)).toEqual({ orcidId: FLAKY, exists: true, name: null });
  });

  it('404: not found (exists false), no retry', async () => {
    fake = await orcidFake();
    expect(await client(fake).lookup(MISSING)).toEqual({ orcidId: MISSING, exists: false, name: null });
    expect(records(fake)).toHaveLength(1);
  });

  it('500: retries a bounded number of times, then throws OrcidUnavailableError (not "not found")', async () => {
    fake = await orcidFake();
    const err = await client(fake).lookup(BROKEN).catch((e) => e);
    expect(err).toBeInstanceOf(OrcidUnavailableError);
    expect(err.status).toBe(500);
    expect(records(fake)).toHaveLength(3); // 1 + 2 retries
  });

  it('a transient 503 is retried and the lookup succeeds', async () => {
    fake = await orcidFake();
    expect((await client(fake).lookup(FLAKY)).exists).toBe(true);
    expect(records(fake)).toHaveLength(2);
  });

  it('slow registry: times out and throws OrcidUnavailableError', async () => {
    fake = await orcidFake();
    const started = Date.now();
    const err = await client(fake, { retries: 1 }).lookup(SLOW).catch((e) => e);
    expect(err).toBeInstanceOf(OrcidUnavailableError);
    expect(err.message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('checksum validation is local: a malformed iD makes no network call', async () => {
    fake = await orcidFake();
    expect(await client(fake).lookup('0000-0002-1825-0098')).toEqual({ orcidId: '0000-0002-1825-0098', exists: false, name: null });
    expect(await client(fake).lookup('not-an-orcid')).toMatchObject({ exists: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('requests a /read-public client-credentials token once and caches it', async () => {
    fake = await orcidFake();
    const c = client(fake);
    await Promise.all([c.lookup(FOUND), c.lookup(MISSING)]);
    await c.lookup(FOUND);
    expect(tokens(fake)).toHaveLength(1);
    expect(records(fake).every((r) => r.headers.authorization === 'Bearer tok-1')).toBe(true);
  });

  it('a 401 on a record drops the cached token and fetches a new one once', async () => {
    let accept = 'tok-1';
    fake = await orcidFake({ tokenForRecord: () => accept });
    const c = client(fake);
    await c.lookup(FOUND);
    accept = 'tok-2'; // the registry revoked tok-1
    expect((await c.lookup(FOUND)).exists).toBe(true);
    expect(tokens(fake)).toHaveLength(2);
  });

  it('rejected client credentials surface as unavailable, without the secret in the message', async () => {
    fake = await orcidFake({ tokenStatus: 401 });
    const err = await client(fake).lookup(FOUND).catch((e) => e);
    expect(err).toBeInstanceOf(OrcidUnavailableError);
    expect(err.message).toMatch(/ORCID_CLIENT_ID/);
    expect(err.message).not.toContain(SECRET);
    expect(records(fake)).toHaveLength(0);
  });

  it('unreachable registry: unavailable', async () => {
    const c = new HttpOrcidClient({ baseUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9/v3.0', timeoutMs: 200, retries: 0 });
    await expect(c.lookup(FOUND)).rejects.toBeInstanceOf(OrcidUnavailableError);
  });

  it('derives the public API host from the site base', () => {
    expect(derivePublicApiUrl('https://orcid.org')).toBe('https://pub.orcid.org/v3.0');
    expect(derivePublicApiUrl('https://sandbox.orcid.org/')).toBe('https://pub.sandbox.orcid.org/v3.0');
  });

  it('orcidFromEnv: http without credentials throws instead of falling back to the stub', () => {
    expect(() => orcidFromEnv({ QUORUM_ORCID: 'http' })).toThrow(/ORCID_CLIENT_ID, ORCID_CLIENT_SECRET/);
    expect(orcidFromEnv({}).kind).toBe('stub');
    expect(orcidFromEnv({ QUORUM_ORCID: 'http', ORCID_CLIENT_ID: 'a', ORCID_CLIENT_SECRET: 'b' }).kind).toBe('http');
  });
});
