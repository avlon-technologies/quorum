import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { createHash } from 'node:crypto';
import { DomainError, envelope, badRequest, forbidden, unauthenticated, type FieldError } from './errors.ts';
import type { Db } from './db.ts';
import type { Clock } from './clock.ts';
import type { TokenService } from './auth.ts';
import type { Role } from '../contracts/model.generated.ts';
import type { RateLimiter } from './rate-limit.ts';
import { recordRequest } from './metrics.ts';

export type Principal = {
  accountId: string;
  kind: 'person' | 'agent';
  name: string;
  email: string;
  institution: string;
  roles: Role[];
  orcidStatus: 'unverified' | 'verified';
};

/**
 * Every /api route declares its access (NFR-3, INV-11). A route without a declaration fails
 * startup — deny by default is enforced at build time of the server, not by convention.
 *   public            no token needed (sign-in, registration, health)
 *   authenticated     any signed-in account
 *   Role[]            the account must hold at least one of these roles (read from the DB per request)
 */
export type Access = 'public' | 'authenticated' | Role[];

/**
 * A refusal whose consequences must still be committed (e.g. a refused award moves the case to
 * 'reconsider'). Returned from inside ctx.tx: the transaction commits, the client gets the error.
 */
export class CommittedRefusal {
  readonly error: DomainError;
  constructor(error: DomainError) {
    this.error = error;
  }
}

export type CommandContext = {
  principal: Principal;
  /**
   * Run the command's effect in ONE write transaction together with its idempotency record
   * (decision D8). Must be called exactly once per command.
   */
  tx: <T>(fn: () => T) => T;
};

type RouteSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  access: Access;
  /** human-readable model element realized, e.g. '::Quorum…Submission.SubmitProposal' */
  realizes?: string;
  body?: object;
  querystring?: object;
  params?: object;
};

/** Body/params/query are validated by the route's JSON schema before the handler runs. */
export type ApiRequest = FastifyRequest & { body: any; params: any; query: any };

export type Http = {
  query: <T>(spec: RouteSpec, handler: (req: ApiRequest, principal: Principal | null) => Promise<T> | T) => void;
  command: <T>(spec: RouteSpec, handler: (req: ApiRequest, ctx: CommandContext) => Promise<T> | T, status?: number) => void;
};

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    realizes?: string;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type PrincipalLoader = (accountId: string) => Principal | null;

export function installHttp(
  app: FastifyInstance,
  deps: { db: Db; clock: Clock; tokens: TokenService; loadPrincipal: PrincipalLoader; limiter: RateLimiter },
): Http {
  const { db, clock, tokens, loadPrincipal, limiter } = deps;

  app.decorateRequest('principal', null);

  // Deny by default: refuse to start if any API route lacks an access declaration.
  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.url.startsWith('/api/')) return;
    const access = (route.config as { access?: Access } | undefined)?.access;
    if (access === undefined) throw new Error(`Route ${route.method} ${route.url} declares no access policy; refusing to start (NFR-3).`);
  });

  // Authentication + role check, before validation so an anonymous caller learns nothing about shapes.
  app.addHook('onRequest', async (req) => {
    const access = req.routeOptions.config?.access;
    if (access === undefined || access === 'public') return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const accountId = token ? await tokens.verify(token) : null;
    if (!accountId) throw unauthenticated(token ? 'Your session has expired. Sign in again.' : 'Sign in to continue.');
    const principal = loadPrincipal(accountId);
    if (!principal) throw unauthenticated('This account no longer exists. Sign in again.');
    req.principal = principal;
    if (access === 'authenticated') return;
    if (!access.some((r) => principal.roles.includes(r))) {
      throw forbidden(`This action needs the ${access.map(roleLabel).join(' or ')} role, which your account has not been granted.`);
    }
  });

  // Rate limiting, after authentication so a signed-in account is limited as itself, not by its address.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const who = req.principal ? `acct:${req.principal.accountId}` : `ip:${req.ip}`;
    const c = limiter.config;
    const wait = write ? limiter.hit(`w:${who}`, c.writesPerMin, 60_000) : limiter.hit(`r:${who}`, c.readsPerMin, 60_000);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      throw new DomainError(429, 'rate_limited', `Too many requests. Wait ${wait} seconds and try again.`);
    }
  });

  // Metrics: route pattern, never the raw URL.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? (req.url.startsWith('/api/') ? 'unmatched' : 'static');
    recordRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const e = toDomainError(err);
    if (e.status >= 500) req.log.error({ err }, 'unhandled error');
    reply.status(e.status).send(envelope(e, String(req.id)));
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.status(404).send(envelope(new DomainError(404, 'not_found', `No API operation at ${req.method} ${req.url.split('?')[0]}.`), String(req.id)));
    } else {
      reply.sendFile('index.html');
    }
  });

  const schemaOf = (spec: RouteSpec) => {
    const s: Record<string, object> = {};
    if (spec.body) s.body = spec.body;
    if (spec.querystring) s.querystring = spec.querystring;
    if (spec.params) s.params = spec.params;
    return s;
  };

  return {
    query(spec, handler) {
      app.route({
        method: spec.method,
        url: spec.url,
        schema: schemaOf(spec),
        config: { access: spec.access, realizes: spec.realizes ?? '' },
        handler: async (req) => handler(req, req.principal),
      });
    },
    command(spec, handler, status = 200) {
      app.route({
        method: spec.method,
        url: spec.url,
        schema: schemaOf(spec),
        config: { access: spec.access, realizes: spec.realizes ?? '' },
        handler: async (req, reply) => {
          const principal = req.principal;
          const key = req.headers['idempotency-key'];
          if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
            throw badRequest('Every change must carry an Idempotency-Key header (8–200 characters) so a retried request is not applied twice.', [
              { field: 'Idempotency-Key', message: 'Required header.' },
            ]);
          }
          const actor = principal?.accountId ?? `anon:${req.ip}`;
          const route = `${spec.method} ${spec.url}`;
          const hash = createHash('sha256').update(route).update(JSON.stringify(req.params ?? {})).update(JSON.stringify(req.body ?? {})).digest('hex');
          const replayed = lookup(db, actor, key, hash);
          if (replayed) {
            reply.header('Idempotent-Replay', 'true');
            return reply.status(replayed.status).send(replayed.body);
          }
          let used = false;
          let result: unknown;
          let replayedInTx: { status: number; body: unknown } | null = null;
          const ctx: CommandContext = {
            principal: principal!,
            tx: <T>(fn: () => T): T => {
              if (used) throw new Error('CommandContext.tx called twice');
              used = true;
              return db
                .transaction(() => {
                  // re-check under the write lock: a concurrent duplicate may have committed meanwhile
                  const again = lookup(db, actor, key, hash);
                  if (again) {
                    replayedInTx = again;
                    return again.body as T;
                  }
                  const r = fn();
                  const [code, body] = r instanceof CommittedRefusal ? [r.error.status, envelope(r.error, String(req.id))] : [status, r ?? null];
                  db.prepare(
                    `INSERT INTO cmd_log (actor_id, idempotency_key, route, request_hash, status_code, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  ).run(actor, key, route, hash, code, JSON.stringify(body), clock.now().toISOString());
                  return r;
                })
                .immediate();
            },
          };
          result = await handler(req, ctx);
          if (!used) throw new Error(`command ${route} completed without calling ctx.tx — its effect was not logged`);
          if (replayedInTx) {
            reply.header('Idempotent-Replay', 'true');
            return reply.status((replayedInTx as { status: number }).status).send((replayedInTx as { body: unknown }).body);
          }
          if (result instanceof CommittedRefusal) return reply.status(result.error.status).send(envelope(result.error, String(req.id)));
          return reply.status(status).send(result ?? null);
        },
      });
    },
  };
}

function lookup(db: Db, actor: string, key: string, hash: string): { status: number; body: unknown } | null {
  const row = db.prepare(`SELECT request_hash, status_code, response FROM cmd_log WHERE actor_id = ? AND idempotency_key = ?`).get(actor, key) as
    | { request_hash: string; status_code: number; response: string }
    | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) {
    throw new DomainError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Generate a new key for a new action.');
  }
  return { status: row.status_code, body: JSON.parse(row.response) };
}

export function roleLabel(r: Role): string {
  return { applicant: 'Applicant', reviewer: 'Reviewer', programOfficer: 'Program Officer', panelChair: 'Panel Chair', operator: 'Operator' }[r];
}

function toDomainError(err: unknown): DomainError {
  if (err instanceof DomainError) return err;
  const e = err as { validation?: Array<{ instancePath?: string; message?: string; params?: { missingProperty?: string } }>; validationContext?: string; statusCode?: number; code?: string; message?: string };
  if (e && Array.isArray(e.validation)) {
    const fields: FieldError[] = e.validation.map((v) => {
      const path = (v.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
      const field = v.params?.missingProperty ? (path ? `${path}.${v.params.missingProperty}` : v.params.missingProperty) : path || e.validationContext || 'body';
      return { field, message: humanize(v.message ?? 'is invalid') };
    });
    return badRequest('Some fields need attention.', fields);
  }
  if (e?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || e?.statusCode === 400) {
    return badRequest('The request body must be valid JSON.');
  }
  if (e?.statusCode === 413) return new DomainError(413, 'payload_too_large', 'The request is too large.');
  if (typeof e?.message === 'string' && e.message.startsWith('INV-3')) {
    return new DomainError(409, 'conflict_of_interest', 'This reviewer has a declared conflict with this proposal and cannot be assigned.', { rule: 'INV-3' });
  }
  return new DomainError(500, 'internal_error', 'Something went wrong on our side. The action was not applied; try again, and contact support with the request id if it persists.');
}

function humanize(m: string): string {
  if (m.startsWith('must have required property')) return 'Required.';
  if (m.startsWith('must NOT have fewer than')) return m.replace('must NOT have fewer than', 'Must have at least').replace('characters', 'characters.');
  if (m.startsWith('must NOT have more than')) return m.replace('must NOT have more than', 'Must have at most').replace('characters', 'characters.');
  return m.charAt(0).toUpperCase() + m.slice(1) + (m.endsWith('.') ? '' : '.');
}
