/**
 * Identity — realizes ::Quorum.ResearchFunding.Identity.AccountService.
 * The single writer of idn_* (AccountStore). Roles are read here on every request (ADR-012).
 */
import type { Deps } from '../../platform/deps.ts';
import type { Principal } from '../../platform/http.ts';
import { hashPassword, verifyPassword } from '../../platform/auth.ts';
import { newId } from '../../platform/ids.ts';
import { DomainError, conflict, unprocessable, badRequest, notFound } from '../../platform/errors.ts';
import { isWellFormedOrcid, type OrcidRecord } from '../../integrations/orcid.ts';
import type { Role, OrcidVerifiedData, ReviewerStanding } from '../../contracts/model.generated.ts';

type AccountRow = {
  id: string;
  kind: 'person' | 'agent';
  email: string;
  name: string;
  institution: string;
  password_hash: string | null;
  orcid_id: string | null;
  orcid_status: 'unverified' | 'verified';
};

const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function rolesOf(deps: Deps, accountId: string): Role[] {
  return (deps.db.prepare(`SELECT role FROM idn_role_grant WHERE account_id = ? ORDER BY role`).all(accountId) as { role: Role }[]).map((r) => r.role);
}

export function loadPrincipal(deps: Deps, accountId: string): Principal | null {
  const a = deps.db.prepare(`SELECT * FROM idn_account WHERE id = ?`).get(accountId) as AccountRow | undefined;
  if (!a) return null;
  return {
    accountId: a.id,
    kind: a.kind,
    name: a.name,
    email: a.email,
    institution: a.institution,
    roles: rolesOf(deps, a.id),
    orcidStatus: a.orcid_status,
  };
}

export function accountOrcid(deps: Deps, accountId: string): string | null {
  const a = deps.db.prepare(`SELECT orcid_id FROM idn_account WHERE id = ?`).get(accountId) as { orcid_id: string | null } | undefined;
  return a?.orcid_id ?? null;
}

export function authenticate(deps: Deps, email: string, password: string): string | null {
  const a = deps.db.prepare(`SELECT * FROM idn_account WHERE email = ? AND kind = 'person'`).get(email.trim()) as AccountRow | undefined;
  // Always run the hash comparison so timing does not reveal whether the email exists.
  const ok = verifyPassword(password, a?.password_hash ?? DUMMY_HASH);
  return a && ok ? a.id : null;
}

/** Command RegisterApplicant: self-registration grants the Applicant role only. */
export function registerApplicant(deps: Deps, input: { email: string; name: string; institution: string; password: string }): { accountId: string } {
  const email = input.email.trim().toLowerCase();
  const exists = deps.db.prepare(`SELECT 1 FROM idn_account WHERE email = ?`).get(email);
  if (exists) throw conflict('email_taken', 'An account with this email already exists. Sign in instead.');
  const id = newId();
  const now = deps.clock.now().toISOString();
  deps.db
    .prepare(`INSERT INTO idn_account (id, kind, email, name, institution, password_hash, created_at) VALUES (?, 'person', ?, ?, ?, ?, ?)`)
    .run(id, email, input.name.trim(), input.institution.trim(), hashPassword(input.password), now);
  deps.db.prepare(`INSERT INTO idn_role_grant (account_id, role, granted_at, granted_by) VALUES (?, 'applicant', ?, 'self-registration')`).run(id, now);
  return { accountId: id };
}

/** Phase 1 of VerifyOrcid (outside the transaction): ask the registry through the adapter. */
export async function lookupOrcid(deps: Deps, orcidId: string): Promise<OrcidRecord> {
  if (!isWellFormedOrcid(orcidId)) {
    throw badRequest('That is not a valid ORCID iD.', [
      { field: 'orcidId', message: 'Use the 16-character form 0000-0000-0000-000X; the last character is a checksum.' },
    ]);
  }
  try {
    return await deps.orcid.lookup(orcidId);
  } catch {
    throw new DomainError(503, 'orcid_unavailable', 'The ORCID registry could not be reached. Nothing was changed; try again in a minute.');
  }
}

/** Phase 2 of VerifyOrcid (inside the transaction): unverified -> verified, the only ORCID transition. */
export function recordOrcidVerification(deps: Deps, accountId: string, orcidId: string, exists: boolean): { orcidStatus: 'verified'; orcidId: string } {
  if (!exists) {
    throw unprocessable('orcid_not_found', 'The ORCID registry has no record for that iD. Check it on orcid.org and try again.', {
      fields: [{ field: 'orcidId', message: 'Not found in the ORCID registry.' }],
      rule: 'INV-12',
    });
  }
  const a = deps.db.prepare(`SELECT * FROM idn_account WHERE id = ?`).get(accountId) as AccountRow | undefined;
  if (!a) throw notFound('Account');
  if (a.orcid_status === 'verified') {
    if (a.orcid_id === orcidId) return { orcidStatus: 'verified', orcidId };
    throw conflict('orcid_already_verified', 'Your account is already verified with a different ORCID iD. Contact a program officer to change it.');
  }
  const taken = deps.db.prepare(`SELECT 1 FROM idn_account WHERE orcid_id = ? AND id <> ? AND orcid_status = 'verified'`).get(orcidId, accountId);
  if (taken) throw conflict('orcid_in_use', 'That ORCID iD is already verified on another account.');
  const now = deps.clock.now().toISOString();
  const r = deps.db
    .prepare(`UPDATE idn_account SET orcid_id = ?, orcid_status = 'verified', orcid_verified_at = ? WHERE id = ? AND orcid_status = 'unverified'`)
    .run(orcidId, now, accountId);
  if (r.changes === 1) {
    const payload: OrcidVerifiedData = { accountId, orcidId, at: now };
    deps.bus.publish('OrcidVerified', `account:${accountId}`, payload, accountId);
  }
  return { orcidStatus: 'verified', orcidId };
}

/** IdentityApi.GetReviewerStanding — called synchronously inside PeerReview's assignment transaction (ADR-003). */
export function getReviewerStanding(deps: Deps, accountId: string): ReviewerStanding & { name: string; exists: boolean } {
  const a = deps.db.prepare(`SELECT * FROM idn_account WHERE id = ?`).get(accountId) as AccountRow | undefined;
  if (!a) return { accountId, isReviewer: false, orcid: 'unverified', institution: '', name: '', exists: false };
  return {
    accountId,
    isReviewer: rolesOf(deps, accountId).includes('reviewer'),
    orcid: a.orcid_status,
    institution: a.institution,
    name: a.name,
    exists: true,
  };
}

export function listReviewers(deps: Deps) {
  return deps.db
    .prepare(
      `SELECT a.id, a.name, a.email, a.institution, a.orcid_id AS orcidId, a.orcid_status AS orcidStatus
         FROM idn_account a JOIN idn_role_grant g ON g.account_id = a.id AND g.role = 'reviewer' ORDER BY a.name`,
    )
    .all() as Array<{ id: string; name: string; email: string; institution: string; orcidId: string | null; orcidStatus: 'unverified' | 'verified' }>;
}

export function accountNames(deps: Deps, ids: string[]): Map<string, { name: string; institution: string }> {
  const m = new Map<string, { name: string; institution: string }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return m;
  const rows = deps.db
    .prepare(`SELECT id, name, institution FROM idn_account WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ id: string; name: string; institution: string }>;
  for (const r of rows) m.set(r.id, { name: r.name, institution: r.institution });
  return m;
}

/** Administrative provisioning (seed only; who grants roles is BDL `unspecified RoleAdministration`). */
export function provisionAccount(
  deps: Deps,
  a: {
    id?: string;
    kind?: 'person' | 'agent';
    email: string;
    name: string;
    institution: string;
    password?: string;
    roles: Role[];
    orcidId?: string;
    orcidVerified?: boolean;
  },
): string {
  const id = a.id ?? newId();
  const now = deps.clock.now().toISOString();
  deps.db
    .prepare(
      `INSERT INTO idn_account (id, kind, email, name, institution, password_hash, orcid_id, orcid_status, orcid_verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      a.kind ?? 'person',
      a.email.toLowerCase(),
      a.name,
      a.institution,
      a.password ? hashPassword(a.password) : null,
      a.orcidId ?? null,
      a.orcidVerified ? 'verified' : 'unverified',
      a.orcidVerified ? now : null,
      now,
    );
  for (const r of a.roles) {
    deps.db.prepare(`INSERT INTO idn_role_grant (account_id, role, granted_at, granted_by) VALUES (?, ?, ?, 'provisioning')`).run(id, r, now);
  }
  return id;
}

export function revokeRole(deps: Deps, accountId: string, role: Role): void {
  deps.db.prepare(`DELETE FROM idn_role_grant WHERE account_id = ? AND role = ?`).run(accountId, role);
}
