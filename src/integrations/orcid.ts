/**
 * ORCID adapter — realizes the dependency on ::Quorum.ORCID.OrcidPublicApi.LookupRecord.
 * Same contract for both implementations; which one runs is a binding (QUORUM_ORCID=stub|http).
 *
 * What a lookup proves: that an iD is registered in ORCID. It does NOT prove that the person who typed
 * it owns it. Ownership needs ORCID's 3-legged OAuth /authenticate flow, which is an owner decision.
 */
export type OrcidRecord = { orcidId: string; exists: boolean; name: string | null };

export interface OrcidClient {
  readonly kind: 'stub' | 'http';
  lookup(orcidId: string): Promise<OrcidRecord>;
}

/**
 * The registry could not answer (timeout, network error, 5xx, rejected credentials). Distinct from
 * "not found": the caller must surface it as "try again", never as "that iD does not exist".
 */
export class OrcidUnavailableError extends Error {
  override readonly name = 'OrcidUnavailableError';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** ISO 7064 MOD 11-2 check digit, as ORCID specifies. Format errors are validation (400), not lookups. */
export function isWellFormedOrcid(id: string): boolean {
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id)) return false;
  const digits = id.replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
  const result = (12 - (total % 11)) % 11;
  const check = result === 10 ? 'X' : String(result);
  return digits[15] === check;
}

/**
 * Deterministic local stub: a well-formed iD exists unless it is on the "not registered" list.
 * Seeded reviewers use real-format iDs; 0000-0002-9079-593X is ORCID's own documented example.
 */
export class StubOrcidClient implements OrcidClient {
  readonly kind = 'stub' as const;
  static readonly NOT_REGISTERED = new Set(['0000-0003-1415-9269']);
  async lookup(orcidId: string): Promise<OrcidRecord> {
    if (!isWellFormedOrcid(orcidId) || StubOrcidClient.NOT_REGISTERED.has(orcidId)) return { orcidId, exists: false, name: null };
    return { orcidId, exists: true, name: null };
  }
}

export type HttpOrcidConfig = {
  /** ORCID site, where the token endpoint lives: https://orcid.org (production) or https://sandbox.orcid.org. */
  baseUrl: string;
  /** Public API v3.0 root. Defaults to https://pub.<host of baseUrl>/v3.0. */
  apiUrl?: string;
  /** Public API client credentials (/read-public). Omit both only for anonymous access (low quota). */
  clientId?: string;
  clientSecret?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 5xx, 429, timeouts and network errors. */
  retries?: number;
  /** Base backoff between retries (doubled each time). */
  backoffMs?: number;
};

export const ORCID_PRODUCTION_BASE = 'https://orcid.org';

/** https://orcid.org -> https://pub.orcid.org/v3.0; https://sandbox.orcid.org -> https://pub.sandbox.orcid.org/v3.0 */
export function derivePublicApiUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//pub.${u.host}/v3.0`;
}

type Token = { value: string; expiresAt: number };

/**
 * Production adapter: ORCID Public API v3.0 record lookup, authenticated with a /read-public
 * client-credentials token (ORCID: "You need an access token to make API requests to the Public or
 * Member API"; anonymous use exists but has lower quotas). The token is long-lived (~20 years) and
 * cached in memory; a 401 on a record read drops it and fetches a fresh one once.
 */
export class HttpOrcidClient implements OrcidClient {
  readonly kind = 'http' as const;
  readonly #tokenUrl: string;
  readonly #apiUrl: string;
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #backoffMs: number;
  #token: Token | null = null;
  #tokenInFlight: Promise<string> | null = null;

  constructor(config: HttpOrcidConfig) {
    const base = config.baseUrl.replace(/\/+$/, '');
    this.#tokenUrl = `${base}/oauth/token`;
    this.#apiUrl = (config.apiUrl ?? derivePublicApiUrl(base)).replace(/\/+$/, '');
    if ((config.clientId === undefined) !== (config.clientSecret === undefined)) {
      throw new Error('HttpOrcidClient: give both clientId and clientSecret, or neither');
    }
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#timeoutMs = config.timeoutMs ?? 5000;
    this.#retries = config.retries ?? 2;
    this.#backoffMs = config.backoffMs ?? 250;
  }

  /** Where it points, for startup logs. Never includes the secret. */
  describe(): string {
    return `http ${this.#apiUrl} (${this.#clientId ? 'read-public token' : 'anonymous'})`;
  }

  async lookup(orcidId: string): Promise<OrcidRecord> {
    // Checksum validation is local and comes first: a malformed iD never reaches the network.
    if (!isWellFormedOrcid(orcidId)) return { orcidId, exists: false, name: null };

    let refreshedToken = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const headers: Record<string, string> = { accept: 'application/vnd.orcid+json' };
        const token = await this.#accessToken();
        if (token) headers.authorization = `Bearer ${token}`;
        res = await fetch(`${this.#apiUrl}/${encodeURIComponent(orcidId)}/record`, {
          headers,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (e) {
        if (e instanceof OrcidUnavailableError) throw e; // token failures are already classified
        if (attempt < this.#retries) {
          await this.#sleep(attempt);
          continue;
        }
        throw new OrcidUnavailableError(`ORCID registry unreachable: ${describeFetchError(e)}`);
      }

      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as OrcidRecordJson | null;
        if (!body) throw new OrcidUnavailableError('ORCID registry answered with an unreadable record', 200);
        const path = body['orcid-identifier']?.path;
        if (path && path !== orcidId) throw new OrcidUnavailableError('ORCID registry answered for a different iD', 200);
        return { orcidId, exists: true, name: nameOf(body) };
      }
      await res.body?.cancel().catch(() => undefined);
      // 404: no such record. 409/410: deactivated, locked or deprecated (merged) — not a verifiable iD.
      if (res.status === 404 || res.status === 409 || res.status === 410) return { orcidId, exists: false, name: null };
      if (res.status === 401 && this.#clientId && !refreshedToken) {
        this.#token = null;
        refreshedToken = true;
        continue;
      }
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempt < this.#retries) {
        await this.#sleep(attempt);
        continue;
      }
      throw new OrcidUnavailableError(`ORCID registry answered HTTP ${res.status}`, res.status);
    }
  }

  async #accessToken(): Promise<string | null> {
    if (!this.#clientId || !this.#clientSecret) return null;
    if (this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;
    // One token request at a time, shared by concurrent lookups.
    this.#tokenInFlight ??= this.#fetchToken().finally(() => {
      this.#tokenInFlight = null;
    });
    return this.#tokenInFlight;
  }

  async #fetchToken(): Promise<string> {
    const form = new URLSearchParams({
      client_id: this.#clientId!,
      client_secret: this.#clientSecret!,
      grant_type: 'client_credentials',
      scope: '/read-public',
    });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.#tokenUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (e) {
        if (attempt < this.#retries) {
          await this.#sleep(attempt);
          continue;
        }
        throw new OrcidUnavailableError(`ORCID token endpoint unreachable: ${describeFetchError(e)}`);
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
        if (!body || typeof body.access_token !== 'string' || !body.access_token) {
          throw new OrcidUnavailableError('ORCID token endpoint answered without an access token', res.status);
        }
        const ttlSec = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
        // Refresh a minute early; cap so Date arithmetic stays sane for the ~20-year tokens ORCID issues.
        const ttlMs = Math.min(ttlSec * 1000, 365 * 24 * 3600 * 1000) - 60_000;
        this.#token = { value: body.access_token, expiresAt: Date.now() + Math.max(ttlMs, 0) };
        return body.access_token;
      }
      await res.body?.cancel().catch(() => undefined);
      if ((res.status >= 500 || res.status === 429) && attempt < this.#retries) {
        await this.#sleep(attempt);
        continue;
      }
      // 400/401 here means the client credentials are wrong: a configuration fault, surfaced as unavailable.
      throw new OrcidUnavailableError(
        res.status === 400 || res.status === 401
          ? `ORCID rejected the client credentials (HTTP ${res.status}); check ORCID_CLIENT_ID / ORCID_CLIENT_SECRET`
          : `ORCID token endpoint answered HTTP ${res.status}`,
        res.status,
      );
    }
  }

  #sleep(attempt: number): Promise<void> {
    return new Promise((r) => setTimeout(r, this.#backoffMs * 2 ** attempt));
  }
}

type OrcidRecordJson = {
  'orcid-identifier'?: { path?: string };
  person?: { name?: { 'given-names'?: { value?: string } | null; 'family-name'?: { value?: string } | null; 'credit-name'?: { value?: string } | null } | null };
};

function nameOf(body: OrcidRecordJson): string | null {
  const n = body.person?.name;
  if (!n) return null; // the researcher may keep the name private
  const credit = n['credit-name']?.value?.trim();
  if (credit) return credit;
  const full = `${n['given-names']?.value ?? ''} ${n['family-name']?.value ?? ''}`.trim();
  return full || null;
}

function describeFetchError(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timed out';
  return e instanceof Error ? e.message : String(e);
}

type Env = Record<string, string | undefined>;

/** Reads the HTTP adapter's configuration. `missing` names required variables that are not set. */
export function orcidHttpConfigFromEnv(env: Env): { config: HttpOrcidConfig; missing: string[] } {
  const missing: string[] = [];
  const clientId = env.ORCID_CLIENT_ID?.trim() || undefined;
  const clientSecret = env.ORCID_CLIENT_SECRET?.trim() || undefined;
  if (!clientId) missing.push('ORCID_CLIENT_ID');
  if (!clientSecret) missing.push('ORCID_CLIENT_SECRET');
  const apiUrl = env.ORCID_API_URL?.trim() || env.QUORUM_ORCID_BASE?.trim() || undefined;
  const timeout = Number(env.ORCID_TIMEOUT_MS);
  return {
    config: {
      baseUrl: env.ORCID_BASE_URL?.trim() || ORCID_PRODUCTION_BASE,
      apiUrl,
      clientId,
      clientSecret,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    },
    missing,
  };
}

/**
 * Kept for src/app.ts. Selecting `http` without credentials throws; it never falls back to the stub.
 * Prefer integrationsFromEnv() in ./factory.ts.
 */
export function orcidFromEnv(env: Env = process.env): OrcidClient {
  const mode = env.QUORUM_ORCID ?? 'stub';
  if (mode === 'stub') return new StubOrcidClient();
  if (mode !== 'http') throw new Error(`QUORUM_ORCID must be "stub" or "http", got "${mode}"`);
  const { config, missing } = orcidHttpConfigFromEnv(env);
  if (missing.length) throw new Error(`QUORUM_ORCID=http needs ${missing.join(', ')}`);
  return new HttpOrcidClient(config);
}
