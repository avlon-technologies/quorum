import type { Db } from './db.ts';
import type { Clock } from './clock.ts';
import type { EventBus } from './events.ts';
import type { OrcidClient } from '../integrations/orcid.ts';
import type { TriageProvider } from '../contracts/triage-port.ts';
import type { MailTransport } from '../integrations/mail.ts';

/** What every context is given. Contexts never receive each other's stores — only each other's api modules. */
export type Deps = {
  db: Db;
  clock: Clock;
  bus: EventBus;
  orcid: OrcidClient;
  triage: TriageProvider;
  mail: MailTransport;
  config: {
    reviewPeriodDays: number;
    decisionPeriodDays: number;
    demo: boolean;
  };
};

/** The platform's own principal for automated acts (BDL actor QuorumPlatform). Never the agent's. */
export const PLATFORM_ACTOR = 'quorum-platform';
/** The triage agent's principal (BDL actor EligibilityTriage). It holds no roles. */
export const AGENT_ACTOR = 'agent:eligibility-triage';

export const toDecimal = (minor: number): string => (minor / 100).toFixed(2);
export const fromDecimal = (d: string | number): number => Math.round(Number(d) * 100);
