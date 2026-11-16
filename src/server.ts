/**
 * Quorum server — `npm start`.
 *   PORT (default 3000), HOST (default 127.0.0.1), QUORUM_DATA_DIR (default ./data),
 *   QUORUM_DEMO=1 enables the demo clock control, QUORUM_ORCID=stub|http.
 * On first start with an empty database it seeds the demo data, so `npm start` alone is enough.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { OffsetClock, systemClock } from './platform/clock.ts';
import { seedFile, DEMO_PASSWORD } from './seed.ts';

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
  const app = await createApp({ dbFile, dataDir, demo, logger: process.env.LOG_LEVEL !== undefined, clock: demo ? new OffsetClock() : systemClock });
  const shutdown = async (signal: string) => {
    console.log(`[quorum] ${signal}: draining and closing`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await app.http.listen({ port, host });
  const h = app.deps.bus.health();
  console.log(`[quorum] listening on http://${host}:${port}  (demo clock ${demo ? 'on' : 'off'})`);
  console.log(`[quorum] delivery: ${JSON.stringify(h)}`);
  if (demo) console.log(`[quorum] demo password for every seeded account: ${DEMO_PASSWORD}`);
}

main().catch((e) => {
  console.error('[quorum] startup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
