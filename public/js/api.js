// API client. Every command carries an Idempotency-Key; a retried action reuses its key, so a
// double-click or a retry after a dropped connection can never apply twice.
const TOKEN_KEY = 'quorum.token';

export const session = {
  me: null,
  get token() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(v) {
    try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message ?? `Something went wrong (HTTP ${status}).`);
    this.status = status;
    this.code = e.code ?? 'unknown';
    this.rule = e.rule ?? null;
    this.fields = e.fields ?? [];
    this.requestId = e.requestId ?? null;
  }
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = opts.key ?? newKey();
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Quorum could not be reached. Check your connection and try again — what you entered is still here.' } });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/session') {
    session.token = null;
    onUnauthorized();
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body, opts) => api('POST', path, body, opts);
export const put = (path, body, opts) => api('PUT', path, body, opts);
