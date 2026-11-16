import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import type { Clock } from './clock.ts';

/** NFR-2: HS256 bearer tokens, 8-hour expiry. Roles are NOT trusted from the token (decision D12). */
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * The signing secret: QUORUM_JWT_SECRET if set, else a random secret generated once and kept
 * beside the database (so tokens survive restarts but never leave the machine).
 */
export function loadSecret(dataDir: string): Uint8Array {
  const env = process.env.QUORUM_JWT_SECRET;
  if (env) {
    if (env.length < 32) throw new Error('QUORUM_JWT_SECRET must be at least 32 characters.');
    return new TextEncoder().encode(env);
  }
  const file = `${dataDir}/jwt-secret`;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(48).toString('base64'), { mode: 0o600 });
  }
  return new TextEncoder().encode(readFileSync(file, 'utf8').trim());
}

export class TokenService {
  readonly #secret: Uint8Array;
  readonly #clock: Clock;
  constructor(secret: Uint8Array, clock: Clock) {
    this.#secret = secret;
    this.#clock = clock;
  }

  async issue(accountId: string): Promise<{ token: string; expiresAt: string }> {
    const iat = Math.floor(this.#clock.now().getTime() / 1000);
    const exp = iat + TOKEN_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(accountId)
      .setIssuer('quorum')
      .setAudience('quorum-api')
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.#secret);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Returns the account id, or null if the token is missing, forged or expired. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.#secret, {
        algorithms: ['HS256'],
        issuer: 'quorum',
        audience: 'quorum-api',
        currentDate: this.#clock.now(),
      });
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
