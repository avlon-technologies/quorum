/**
 * Rate limiting (production gap closed this release). In-memory fixed windows, which is correct for the
 * deployment the SQLite decision implies: ONE server process (docs/evidence/sqlite-viability.md). A
 * second instance would need a shared store; that is the same trigger that ends SQLite's viability.
 *
 * Policies (defaults; each overridable by environment):
 *   sign-in failures   10 per 15 min per (ip, email) and 50 per 15 min per ip   QUORUM_RL_SIGNIN_*
 *   commands (writes)  120 per minute per account (or per ip when anonymous)   QUORUM_RL_WRITES_PER_MIN
 *   queries (reads)    600 per minute per account (or per ip when anonymous)   QUORUM_RL_READS_PER_MIN
 * QUORUM_RATE_LIMIT=0 disables limiting (load measurement only; never in production).
 */
export type RateLimitConfig = {
  enabled: boolean;
  signinPerIdentity: number;
  signinPerIp: number;
  signinWindowMs: number;
  writesPerMin: number;
  readsPerMin: number;
};

export function rateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    enabled: env.QUORUM_RATE_LIMIT !== '0',
    signinPerIdentity: n('QUORUM_RL_SIGNIN_PER_IDENTITY', 10),
    signinPerIp: n('QUORUM_RL_SIGNIN_PER_IP', 50),
    signinWindowMs: n('QUORUM_RL_SIGNIN_WINDOW_MIN', 15) * 60_000,
    writesPerMin: n('QUORUM_RL_WRITES_PER_MIN', 120),
    readsPerMin: n('QUORUM_RL_READS_PER_MIN', 600),
  };
}

export class RateLimiter {
  readonly config: RateLimitConfig;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();
  limited = 0;

  constructor(config: RateLimitConfig, now: () => number = Date.now) {
    this.config = config;
    this.#now = now;
  }

  /** Count one hit; returns 0 when allowed, otherwise the seconds until the window resets. */
  hit(key: string, limit: number, windowMs: number): number {
    if (!this.config.enabled) return 0;
    const t = this.#now();
    let w = this.#windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      this.#windows.set(key, w);
    }
    w.count++;
    if (w.count <= limit) return 0;
    this.limited++;
    return Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
  }

  /** Seconds to wait if the key is already over its limit, without counting a hit. */
  blocked(key: string, limit: number, windowMs: number): number {
    if (!this.config.enabled) return 0;
    const w = this.#windows.get(key);
    const t = this.#now();
    if (!w || t - w.start >= windowMs || w.count < limit) return 0;
    this.limited++;
    return Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
  }

  /** Drop expired windows; called periodically so memory stays bounded. */
  sweep(): void {
    const t = this.#now();
    const max = Math.max(this.config.signinWindowMs, 60_000);
    for (const [k, w] of this.#windows) if (t - w.start >= max) this.#windows.delete(k);
  }

  get size(): number {
    return this.#windows.size;
  }
}
