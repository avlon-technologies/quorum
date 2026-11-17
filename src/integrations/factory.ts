/**
 * Selects Quorum's three external integrations from the environment.
 *
 *   QUORUM_ORCID  = stub | http        (default stub)
 *   QUORUM_TRIAGE = stub | anthropic   (default stub)
 *   QUORUM_MAIL   = file | smtp        (default file)
 *
 * `missing` lists, for every production adapter, the required variables that are not set (so a
 * stub deployment can see what it would need to switch). If a SELECTED adapter is missing anything,
 * integrationsFromEnv throws IntegrationConfigError: it never falls back to a stub silently.
 * Nothing here returns or logs a secret: `describe` carries endpoints and modes only.
 */
import { join } from 'node:path';
import { HttpOrcidClient, StubOrcidClient, orcidHttpConfigFromEnv, type OrcidClient } from './orcid.ts';
import { StubTriageProvider, type TriageProvider } from './triage-provider.ts';
import { AnthropicTriageProvider, anthropicTriageConfigFromEnv } from './triage-anthropic.ts';
import { FileMailTransport, type MailTransport } from './mail.ts';
import { SmtpMailTransport, smtpConfigFromEnv } from './smtp.ts';

type Env = Record<string, string | undefined>;

export type Integrations = {
  orcid: OrcidClient;
  triage: TriageProvider;
  mail: MailTransport;
  describe: { orcid: string; triage: string; mail: string };
  /** `VAR (adapter)` for each required variable a production adapter lacks, selected or not. */
  missing: string[];
};

export class IntegrationConfigError extends Error {
  override readonly name = 'IntegrationConfigError';
  readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.missing = missing;
  }
}

function choose<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new IntegrationConfigError(`${name} must be one of ${allowed.join('|')}, got "${env[name]}"`);
  }
  return raw as T;
}

function guard<T>(label: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof IntegrationConfigError) throw e;
    throw new IntegrationConfigError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function integrationsFromEnv(env: Env = process.env): Integrations {
  const orcidMode = choose(env, 'QUORUM_ORCID', ['stub', 'http'] as const, 'stub');
  const triageMode = choose(env, 'QUORUM_TRIAGE', ['stub', 'anthropic'] as const, 'stub');
  const mailMode = choose(env, 'QUORUM_MAIL', ['file', 'smtp'] as const, 'file');

  const orcidCfg = guard('QUORUM_ORCID=http', () => orcidHttpConfigFromEnv(env));
  // Option parsing (ports, booleans, enums) fails loudly only for a selected adapter.
  const triageCfg = triageMode === 'anthropic' ? guard('QUORUM_TRIAGE=anthropic', () => anthropicTriageConfigFromEnv(env)) : safe(() => anthropicTriageConfigFromEnv(env));
  const smtpCfg = mailMode === 'smtp' ? guard('QUORUM_MAIL=smtp', () => smtpConfigFromEnv(env)) : safe(() => smtpConfigFromEnv(env));

  const missing = [
    ...orcidCfg.missing.map((v) => `${v} (orcid http)`),
    ...(triageCfg?.missing ?? (env.ANTHROPIC_API_KEY?.trim() ? [] : ['ANTHROPIC_API_KEY'])).map((v) => `${v} (triage anthropic)`),
    ...(smtpCfg?.missing ?? ['SMTP_HOST', 'SMTP_FROM']).map((v) => `${v} (mail smtp)`),
  ];

  const selectedMissing: string[] = [];
  if (orcidMode === 'http') selectedMissing.push(...orcidCfg.missing.map((v) => `QUORUM_ORCID=http needs ${v}`));
  if (triageMode === 'anthropic' && triageCfg) selectedMissing.push(...triageCfg.missing.map((v) => `QUORUM_TRIAGE=anthropic needs ${v}`));
  if (mailMode === 'smtp' && smtpCfg) selectedMissing.push(...smtpCfg.missing.map((v) => `QUORUM_MAIL=smtp needs ${v}`));
  if (selectedMissing.length) {
    throw new IntegrationConfigError(`Integration configuration incomplete: ${selectedMissing.join('; ')}`, selectedMissing);
  }

  let orcid: OrcidClient;
  let orcidDesc: string;
  if (orcidMode === 'http') {
    const c = guard('QUORUM_ORCID=http', () => new HttpOrcidClient(orcidCfg.config));
    orcid = c;
    orcidDesc = c.describe();
  } else {
    orcid = new StubOrcidClient();
    orcidDesc = 'stub (accepts any checksum-valid iD; no registry call)';
  }

  let triage: TriageProvider;
  let triageDesc: string;
  if (triageMode === 'anthropic') {
    const p = guard('QUORUM_TRIAGE=anthropic', () => new AnthropicTriageProvider(triageCfg!.config));
    triage = p;
    triageDesc = p.describe();
  } else {
    triage = new StubTriageProvider();
    triageDesc = `stub (${triage.name})`;
  }

  let mail: MailTransport;
  let mailDesc: string;
  if (mailMode === 'smtp') {
    const t = guard('QUORUM_MAIL=smtp', () => new SmtpMailTransport(smtpCfg!.config));
    mail = t;
    mailDesc = t.describe();
  } else {
    const file = join(env.QUORUM_DATA_DIR ?? 'data', 'mail-outbox.jsonl');
    mail = new FileMailTransport(file);
    mailDesc = `file ${file} (no mail leaves this machine)`;
  }

  return { orcid, triage, mail, describe: { orcid: orcidDesc, triage: triageDesc, mail: mailDesc }, missing };
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}
