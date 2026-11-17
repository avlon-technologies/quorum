import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, type User, type World } from '../support/harness.ts';

/**
 * INV-11 matrix: every role against every privileged surface. A route refuses with 401 (no or bad
 * session), 403 (role not granted — rule INV-11) or 404 (resource outside the caller's scope).
 */
let h: Harness;
let w: World;
let ids: { draft: string; scored: string; underReview: string; assignment: string };

beforeAll(async () => {
  h = await Harness.create();
  w = h.world();
  ids = {
    draft: h.draft(w, w.alice),
    underReview: await h.underReview(w, w.r.slice(0, 3), w.bob),
    scored: await h.scored(w, w.r.slice(1, 4), w.alice),
    assignment: '',
  };
  ids.assignment = h.assignment(ids.underReview, w.r[0]!);
});
afterAll(async () => h.close());

type Who = 'anon' | 'applicant' | 'reviewer' | 'officer' | 'chair';
const as = (who: Who): User | null =>
  ({ anon: null, applicant: w.alice, reviewer: w.r[4]!, officer: w.officer, chair: w.chair })[who];

const call = { title: 'A new call', summary: 'Summary of a new call for proposals that is long enough.', deadline: '2030-01-01T00:00:00Z', envelope: 10, maxRequest: 10, criteria: [{ name: 'Merit', guidance: '' }] };

type Row = { name: string; method: 'GET' | 'POST'; url: () => string; body?: unknown; expect: Record<Who, number> };
const matrix: Row[] = [
  { name: 'officer workspace', method: 'GET', url: () => '/api/workspace/officer', expect: { anon: 401, applicant: 403, reviewer: 403, officer: 200, chair: 403 } },
  { name: 'portfolio', method: 'GET', url: () => '/api/portfolio', expect: { anon: 401, applicant: 403, reviewer: 403, officer: 200, chair: 200 } },
  { name: 'publish call', method: 'POST', url: () => '/api/calls', body: call, expect: { anon: 401, applicant: 403, reviewer: 403, officer: 201, chair: 403 } },
  {
    name: 'record panel decision',
    method: 'POST',
    url: () => `/api/adjudications/${ids.scored}/decision`,
    body: { outcome: 'decline', rationale: 'Matrix probe — not a real decision.' },
    expect: { anon: 401, applicant: 403, reviewer: 403, officer: 403, chair: 200 },
  },
  {
    name: 'assign reviewer',
    method: 'POST',
    url: () => `/api/proposals/${ids.underReview}/assignments`,
    body: { reviewerId: '00000000-0000' },
    expect: { anon: 401, applicant: 403, reviewer: 403, officer: 422, chair: 403 }, // officer passes the role gate; the id is not a reviewer
  },
  { name: 'screen a proposal', method: 'POST', url: () => `/api/proposals/${ids.scored}/screening`, body: { outcome: 'eligible', reason: '' }, expect: { anon: 401, applicant: 403, reviewer: 403, officer: 409, chair: 403 } },
  { name: "read another applicant's draft", method: 'GET', url: () => `/api/proposals/${ids.draft}`, expect: { anon: 401, applicant: 200, reviewer: 404, officer: 200, chair: 200 } },
  { name: 'read a proposal you do not review', method: 'GET', url: () => `/api/proposals/${ids.underReview}`, expect: { anon: 401, applicant: 404, reviewer: 404, officer: 200, chair: 200 } },
  { name: "read another reviewer's assignment", method: 'GET', url: () => `/api/assignments/${ids.assignment}`, expect: { anon: 401, applicant: 403, reviewer: 404, officer: 403, chair: 403 } },
  {
    name: "submit another reviewer's review",
    method: 'POST',
    url: () => `/api/assignments/${ids.assignment}/review`,
    body: { scores: { c1: 3 }, comment: 'x', attestsNoConflict: true },
    expect: { anon: 401, applicant: 403, reviewer: 404, officer: 403, chair: 403 },
  },
  { name: 'retry a parked delivery', method: 'POST', url: () => '/api/operations/deliveries/retry', body: { consumer: 'abc', messageId: '00000000-0000' }, expect: { anon: 401, applicant: 403, reviewer: 403, officer: 403, chair: 403 } }, // operator-only since review B5; operator: production-readiness.test.ts
];

describe('Cross-role access matrix (INV-11)', () => {
  for (const row of matrix) {
    for (const who of ['anon', 'applicant', 'reviewer', 'chair', 'officer'] as Who[]) {
      it(`${row.name} as ${who} -> ${row.expect[who]}`, async () => {
        const before = h.totalEvents();
        const r = row.method === 'GET' ? await h.get(row.url(), as(who)) : await h.post(row.url(), as(who), row.body);
        expect(r.status, JSON.stringify(r.body)).toBe(row.expect[who]);
        if (r.status === 403) expect(r.body.error).toMatchObject({ code: 'forbidden', rule: 'INV-11' });
        if (r.status === 401 || r.status === 403 || r.status === 404) expect(h.totalEvents()).toBe(before);
      });
    }
  }

  it('a forged token is refused: 401', async () => {
    const r = await h.get('/api/me', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bogus');
    expect(r.status).toBe(401);
  });

  it('an expired token (8h) is refused: 401', async () => {
    const t = await h.mintToken(w.officer.id);
    expect((await h.get('/api/me', t)).status).toBe(200);
    h.clock.advance(8 * 3600_000 + 1000);
    expect((await h.get('/api/me', t)).status).toBe(401);
  });
});
