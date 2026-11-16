/**
 * ORCID adapter — realizes the dependency on ::Quorum.ORCID.OrcidPublicApi.LookupRecord.
 * Same contract for both implementations; which one runs is a binding (QUORUM_ORCID=stub|http).
 */
export type OrcidRecord = { orcidId: string; exists: boolean; name: string | null };

export interface OrcidClient {
  readonly kind: 'stub' | 'http';
  lookup(orcidId: string): Promise<OrcidRecord>;
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

/** Production adapter: ORCID public API v3.0, read-public. A 404 means the iD is not registered. */
export class HttpOrcidClient implements OrcidClient {
  readonly kind = 'http' as const;
  readonly #base: string;
  readonly #timeoutMs: number;
  constructor(base = process.env.QUORUM_ORCID_BASE ?? 'https://pub.orcid.org/v3.0', timeoutMs = 5000) {
    this.#base = base;
    this.#timeoutMs = timeoutMs;
  }
  async lookup(orcidId: string): Promise<OrcidRecord> {
    const res = await fetch(`${this.#base}/${encodeURIComponent(orcidId)}/person`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (res.status === 404) return { orcidId, exists: false, name: null };
    if (!res.ok) throw new Error(`ORCID registry answered HTTP ${res.status}`);
    const body = (await res.json()) as { name?: { 'given-names'?: { value?: string }; 'family-name'?: { value?: string } } };
    const given = body.name?.['given-names']?.value ?? '';
    const family = body.name?.['family-name']?.value ?? '';
    return { orcidId, exists: true, name: `${given} ${family}`.trim() || null };
  }
}

export function orcidFromEnv(): OrcidClient {
  return process.env.QUORUM_ORCID === 'http' ? new HttpOrcidClient() : new StubOrcidClient();
}
