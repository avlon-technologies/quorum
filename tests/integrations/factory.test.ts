import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { IntegrationConfigError, integrationsFromEnv } from '../../src/integrations/factory.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'quorum-integrations-'));
const SECRETS = { ORCID_CLIENT_SECRET: 'orcid-secret-xyz', ANTHROPIC_API_KEY: 'sk-ant-secret-xyz', SMTP_PASS: 'smtp-secret-xyz' };
const FULL = {
  QUORUM_DATA_DIR: dataDir,
  QUORUM_ORCID: 'http',
  QUORUM_TRIAGE: 'anthropic',
  QUORUM_MAIL: 'smtp',
  ORCID_CLIENT_ID: 'APP-TEST',
  ORCID_BASE_URL: 'https://sandbox.orcid.org',
  QUORUM_TRIAGE_MODEL: 'claude-opus-5-5',
  SMTP_HOST: 'smtp.example.org',
  SMTP_PORT: '587',
  SMTP_USER: 'quorum',
  SMTP_FROM: 'Quorum <no-reply@quorum.test>',
  ...SECRETS,
};
const without = (k: keyof typeof FULL) => Object.fromEntries(Object.entries(FULL).filter(([key]) => key !== k));

describe('integrationsFromEnv', () => {
  it('defaults to stub / stub / file, and lists what the production adapters would need', () => {
    const i = integrationsFromEnv({ QUORUM_DATA_DIR: dataDir });
    expect(i.orcid.kind).toBe('stub');
    expect(i.triage.name).toMatch(/stub/);
    expect(i.mail.kind).toBe('stub-file');
    expect(i.describe.mail).toContain('mail-outbox.jsonl');
    expect(i.missing).toEqual([
      'ORCID_CLIENT_ID (orcid http)',
      'ORCID_CLIENT_SECRET (orcid http)',
      'ANTHROPIC_API_KEY (triage anthropic)',
      'SMTP_HOST (mail smtp)',
      'SMTP_FROM (mail smtp)',
    ]);
  });

  it('builds all three production adapters from a full configuration', () => {
    const i = integrationsFromEnv(FULL);
    expect(i.orcid.kind).toBe('http');
    expect(i.triage.name).toMatch(/anthropic claude-opus-5-5/);
    expect(i.mail.kind).toBe('smtp');
    expect(i.missing).toEqual([]);
    expect(i.describe.orcid).toContain('https://pub.sandbox.orcid.org/v3.0');
    expect(i.describe.mail).toContain('smtp.example.org:587');
  });

  it('never exposes a secret through describe, missing, JSON or inspect', () => {
    const i = integrationsFromEnv(FULL);
    const surfaces = [JSON.stringify(i.describe), JSON.stringify(i.missing), JSON.stringify(i), inspect(i, { depth: 10, showHidden: true })];
    for (const s of surfaces) for (const secret of Object.values(SECRETS)) expect(s).not.toContain(secret);
  });

  it.each([
    ['ORCID_CLIENT_SECRET', /QUORUM_ORCID=http needs ORCID_CLIENT_SECRET/],
    ['ORCID_CLIENT_ID', /QUORUM_ORCID=http needs ORCID_CLIENT_ID/],
    ['ANTHROPIC_API_KEY', /QUORUM_TRIAGE=anthropic needs ANTHROPIC_API_KEY/],
    ['SMTP_HOST', /QUORUM_MAIL=smtp needs SMTP_HOST/],
    ['SMTP_FROM', /QUORUM_MAIL=smtp needs SMTP_FROM/],
    ['SMTP_PASS', /QUORUM_MAIL=smtp needs SMTP_PASS/],
  ] as const)('a selected adapter missing %s fails startup (no silent stub)', (key, message) => {
    const err = (() => {
      try {
        integrationsFromEnv(without(key));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IntegrationConfigError);
    expect((err as Error).message).toMatch(message);
    for (const secret of Object.values(SECRETS)) expect((err as Error).message).not.toContain(secret);
  });

  it('missing configuration for an adapter that is not selected does not fail startup', () => {
    const i = integrationsFromEnv({ QUORUM_DATA_DIR: dataDir, QUORUM_ORCID: 'http', ORCID_CLIENT_ID: 'a', ORCID_CLIENT_SECRET: 'b' });
    expect(i.orcid.kind).toBe('http');
    expect(i.missing).toContain('ANTHROPIC_API_KEY (triage anthropic)');
  });

  it('rejects unknown selector values and invalid options for a selected adapter', () => {
    expect(() => integrationsFromEnv({ QUORUM_MAIL: 'sendmail' })).toThrow(/QUORUM_MAIL must be one of file\|smtp/);
    expect(() => integrationsFromEnv({ QUORUM_TRIAGE: 'openai' })).toThrow(IntegrationConfigError);
    expect(() => integrationsFromEnv({ ...FULL, SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
    expect(() => integrationsFromEnv({ ...FULL, SMTP_STARTTLS: 'maybe' })).toThrow(/SMTP_STARTTLS/);
    expect(() => integrationsFromEnv({ ...FULL, SMTP_FROM: 'not an address' })).toThrow(/QUORUM_MAIL=smtp/);
    expect(() => integrationsFromEnv({ ...FULL, QUORUM_TRIAGE_EFFORT: 'extreme' })).toThrow(/QUORUM_TRIAGE_EFFORT/);
    // ...but a bad option for an unselected adapter does not block a stub deployment
    expect(integrationsFromEnv({ QUORUM_DATA_DIR: dataDir, SMTP_PORT: 'abc' }).mail.kind).toBe('stub-file');
  });
});
