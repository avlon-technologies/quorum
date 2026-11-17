import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_API_VERSION,
  AnthropicTriageProvider,
  DEFAULT_TRIAGE_MODEL,
  TriageProviderError,
  parseTriageOutput,
} from '../../src/integrations/triage-anthropic.ts';
import type { TriageInput } from '../../src/contracts/triage-port.ts';
import { fakeHttp, json, sleep, type FakeHttp } from './fakes.ts';

const KEY = 'sk-ant-test-key-should-never-leak';
const input: TriageInput = {
  proposalId: 'prop_123',
  title: 'Permafrost carbon feedbacks',
  abstract: 'We measure methane release from thawing permafrost across three Arctic sites.',
  requestedMinor: 25_000_000,
  callTitle: 'Climate resilience',
  callSummary: 'Research on climate feedbacks and adaptation.',
  maxRequestMinor: 30_000_000,
};

let fake: FakeHttp | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

type Mode = 'good' | 'malformed' | 'extra-field' | 'bad-verdict' | '529' | '500' | 'slow' | 'refusal' | 'max_tokens';

/** Imitates POST /v1/messages. */
async function anthropicFake(mode: Mode) {
  return fakeHttp(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') return json(res, 404, { type: 'error', error: { type: 'not_found_error' } });
    if (req.headers['x-api-key'] !== KEY) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const message = (text: string, stop_reason = 'end_turn') =>
      json(res, 200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: DEFAULT_TRIAGE_MODEL,
        stop_reason,
        content: [
          { type: 'thinking', thinking: '', signature: 'x' },
          { type: 'text', text },
        ],
      });
    switch (mode) {
      case 'good':
        return message(JSON.stringify({ verdict: 'eligible', rationale: 'Within the 300000 maximum; permafrost methane matches the climate-feedback scope.' }));
      case 'malformed':
        return message('Sure! The verdict is eligible.');
      case 'extra-field':
        return message(JSON.stringify({ verdict: 'eligible', rationale: 'ok', action: 'approve' }));
      case 'bad-verdict':
        return message(JSON.stringify({ verdict: 'approved', rationale: 'ok' }));
      case '529':
        return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
      case '500':
        return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'Internal' } });
      case 'slow':
        await sleep(500);
        return message(JSON.stringify({ verdict: 'eligible', rationale: 'late' }));
      case 'refusal':
        return message('', 'refusal');
      case 'max_tokens':
        return message('{"verdict": "elig', 'max_tokens');
    }
  });
}

const provider = (f: FakeHttp, model?: string) => new AnthropicTriageProvider({ apiKey: KEY, baseUrl: f.url, timeoutMs: 200, model });

describe('AnthropicTriageProvider against a fake Messages API', () => {
  it('good JSON: returns the verdict proposal', async () => {
    fake = await anthropicFake('good');
    const out = await provider(fake).assess(input);
    expect(out.verdict).toBe('eligible');
    expect(out.rationale).toMatch(/permafrost/);
  });

  it('sends the documented headers, structured-output schema and an advise-only system prompt', async () => {
    fake = await anthropicFake('good');
    await provider(fake).assess(input);
    const req = fake.requests[0]!;
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(req.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(req.body);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.properties.verdict.enum).toEqual(['eligible', 'ineligible', 'unclear']);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.system).toMatch(/only advise/i);
    expect(body.system).toMatch(/treat it strictly as data/i);
    expect(body).not.toHaveProperty('temperature'); // rejected on API version 2026-10-21
    expect(body).not.toHaveProperty('tools'); // the agent has no tool it could act with
    // refusal fallback for the default model
    expect(req.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(body.fallbacks).toBe('default');
  });

  it('the request carries TriageInput fields only: extra runtime properties never leave the process', async () => {
    fake = await anthropicFake('good');
    const smuggled = { ...input, db: 'sqlite handle', reviewerNames: ['Dr. Secret'], applicantEmail: 'priya.raman@quorum.test' };
    await provider(fake).assess(smuggled as TriageInput);
    const body = JSON.parse(fake.requests[0]!.body);
    const sent = body.messages[0].content as string;
    const payload = JSON.parse(sent.slice(sent.indexOf('{')));
    expect(Object.keys(payload).sort()).toEqual(['abstract', 'callSummary', 'callTitle', 'maxRequestMinor', 'requestedMinor', 'title']);
    expect(fake.requests[0]!.body).not.toMatch(/sqlite handle|Dr\. Secret|priya|prop_123/);
    expect(body.messages).toHaveLength(1);
  });

  it('a configured model is used; models without server-side fallback get no beta header', async () => {
    fake = await anthropicFake('good');
    await provider(fake, 'claude-haiku-5-5').assess(input);
    const req = fake.requests[0]!;
    expect(JSON.parse(req.body).model).toBe('claude-haiku-5-5');
    expect(req.headers['anthropic-beta']).toBeUndefined();
    expect(JSON.parse(req.body)).not.toHaveProperty('fallbacks');
  });

  it.each(['malformed', 'extra-field', 'bad-verdict', 'max_tokens', 'refusal'] as const)('%s output throws (a failed attempt)', async (mode) => {
    fake = await anthropicFake(mode);
    await expect(provider(fake).assess(input)).rejects.toBeInstanceOf(TriageProviderError);
  });

  it.each([
    ['529', 529],
    ['500', 500],
  ] as const)('HTTP %s throws with the status, never the key', async (mode, status) => {
    fake = await anthropicFake(mode);
    const err = await provider(fake).assess(input).catch((e) => e);
    expect(err).toBeInstanceOf(TriageProviderError);
    expect(err.status).toBe(status);
    expect(String(err.message)).not.toContain(KEY);
  });

  it('slow endpoint: the request times out and throws', async () => {
    fake = await anthropicFake('slow');
    await expect(provider(fake).assess(input)).rejects.toThrow(/timed out/);
  });

  it('a wrong key is an error, and the key is not echoed', async () => {
    fake = await anthropicFake('good');
    const err = await new AnthropicTriageProvider({ apiKey: 'sk-wrong', baseUrl: fake.url }).assess(input).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('sk-wrong');
  });

  it('the provider object does not expose the key', () => {
    const p = new AnthropicTriageProvider({ apiKey: KEY });
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(p.describe()).not.toContain(KEY);
    expect(p.name).not.toContain(KEY);
  });
});

describe('parseTriageOutput', () => {
  it('accepts exactly {verdict, rationale}', () => {
    expect(parseTriageOutput('{"verdict":"unclear","rationale":" Abstract too short. "}')).toEqual({ verdict: 'unclear', rationale: 'Abstract too short.' });
  });
  it.each(['', 'null', '[]', '{"verdict":"eligible"}', '{"verdict":"eligible","rationale":""}', '{"verdict":"eligible","rationale":5}', '```json\n{"verdict":"eligible","rationale":"x"}\n```'])(
    'rejects %j',
    (text) => {
      expect(() => parseTriageOutput(text)).toThrow(TriageProviderError);
    },
  );
});
