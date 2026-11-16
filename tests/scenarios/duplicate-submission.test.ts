import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('Duplicate submission and idempotency', () => {
  it('a retried request with the same Idempotency-Key replays the original response and publishes nothing new', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    const key = 'submit-retry-0001';
    const first = await h.post(`/api/proposals/${id}/submit`, w.alice, {}, key);
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const again = await h.post(`/api/proposals/${id}/submit`, w.alice, {}, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(h.count('ProposalSubmitted')).toBe(1);
  });

  it('a second submission with a new key is a new request and is refused: 409 already_submitted (INV-2)', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    await h.post(`/api/proposals/${id}/submit`, w.alice, {}, 'submit-0001-aaaa');
    const r = await h.post(`/api/proposals/${id}/submit`, w.alice, {}, 'submit-0002-bbbb');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'already_submitted', rule: 'INV-2' });
    expect(h.count('ProposalSubmitted')).toBe(1);
  });

  it('reusing a key for a different request is refused: 422 idempotency_key_reused, nothing applied', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    await h.post(`/api/proposals/${id}/submit`, w.alice, {}, 'shared-key-0001');
    const r = await h.post(`/api/proposals/${id}/withdraw`, w.alice, { reason: 'Changed our plans.' }, 'shared-key-0001');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reused');
    expect(h.status(id)).not.toBe('withdrawn');
    expect(h.count('ProposalWithdrawn')).toBe(0);
  });

  it('a command without an Idempotency-Key is refused: 400 validation_failed', async () => {
    const w = h.world();
    const id = h.draft(w, w.alice);
    const token = await h.token(w.alice);
    const r = await h.app.http.inject({ method: 'POST', url: `/api/proposals/${id}/submit`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('validation_failed');
    expect(h.status(id)).toBe('draft');
  });
});
