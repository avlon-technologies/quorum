/**
 * Quorum server — `npm start`.
 *   PORT (default 3000), HOST (default 127.0.0.1), QUORUM_DATA_DIR (default ./data),
 *   QUORUM_DEMO=1 enables the demo clock control, QUORUM_ORCID=stub|http,
 *   QUORUM_TRIAGE=stub|anthropic, QUORUM_MAIL=file|smtp (see README "Production configuration").
 * On first start with an empty database it seeds the demo data, so `npm start` alone is enough.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { OffsetClock, systemClock } from './platform/clock.ts';
import { seedFile, DEMO_PASSWORD } from './seed.ts';
import { integrationsFromEnv } from './integrations/factory.ts';
import { installDefaultSinks } from './platform/alerts.ts';
import { pidFileFor } from './platform/backup.ts';
import { writeFileSync, rmSync } from 'node:fs';

const dataDir = process.env.QUORUM_DATA_DIR ?? 'data';
const dbFile = process.env.QUORUM_DB ?? join(dataDir, 'quorum.sqlite');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
// Demo mode (movable clock, seeded accounts with a shared password) is never available in production (review B1).
const demo = !production && process.env.QUORUM_DEMO !== '0';

async function main() {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbFile) && demo) {
    console.log(`[quorum] no database at ${dbFile}; seeding demo data…`);
    await seedFile(dbFile, { reset: false });
  }
  // Production adapters are chosen by QUORUM_ORCID / QUORUM_TRIAGE / QUORUM_MAIL; a selected adapter with
  // missing configuration fails startup here (never a silent fallback to a stub).
  const integrations = integrationsFromEnv();
  if (production && (integrations.describe.orcid.startsWith('stub') || integrations.describe.triage.startsWith('stub') || integrations.describe.mail.startsWith('file'))) {
    console.warn(`[quorum] WARNING: production is running with a local stand-in adapter (${JSON.stringify(integrations.describe)})`);
  }
  installDefaultSinks();
  const app = await createApp({
    dbFile,
    dataDir,
    demo,
    logger: process.env.LOG_LEVEL !== undefined,
    clock: demo ? new OffsetClock() : systemClock,
    orcid: integrations.orcid,
    triage: integrations.triage,
    mail: integrations.mail,
  });
  // The pid file lets an offline restore refuse while this server holds the database.
  writeFileSync(pidFileFor(dbFile), String(process.pid));
  const shutdown = async (signal: string) => {
    console.log(`[quorum] ${signal}: draining and closing`);
    await app.close();
    rmSync(pidFileFor(dbFile), { force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await app.http.listen({ port, host });
  const h = app.deps.bus.health();
  console.log(`[quorum] listening on http://${host}:${port}  (demo clock ${demo ? 'on' : 'off'})`);
  console.log(`[quorum] delivery: ${JSON.stringify(h)}`);
  console.log(`[quorum] integrations: orcid=${integrations.describe.orcid}; triage=${integrations.describe.triage}; mail=${integrations.describe.mail}`);
  if (integrations.missing.length) console.log(`[quorum] production adapters not configured: ${integrations.missing.join(', ')}`);
  if (demo) console.log(`[quorum] demo password for every seeded account: ${DEMO_PASSWORD}`);
}

main().catch((e) => {
  console.error('[quorum] startup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
