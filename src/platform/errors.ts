/**
 * The one error envelope (NFR-10). Every refusal a client sees is a DomainError with a stable code,
 * a human message that says what to do next, and optional field-level details (NFR-7).
 */
export type FieldError = { field: string; message: string };

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[] | undefined;
  readonly rule: string | undefined;
  constructor(status: number, code: string, message: string, opts: { fields?: FieldError[]; rule?: string } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.rule = opts.rule;
  }
}

export const badRequest = (message: string, fields?: FieldError[]) =>
  new DomainError(400, 'validation_failed', message, fields ? { fields } : {});
export const unauthenticated = (message = 'Sign in to continue.') => new DomainError(401, 'unauthenticated', message);
export const forbidden = (message: string, rule = 'INV-11') => new DomainError(403, 'forbidden', message, { rule });
export const notFound = (what: string) => new DomainError(404, 'not_found', `${what} was not found, or you do not have access to it.`);
export const conflict = (code: string, message: string, rule?: string) =>
  new DomainError(409, code, message, rule ? { rule } : {});
export const unprocessable = (code: string, message: string, opts: { fields?: FieldError[]; rule?: string } = {}) =>
  new DomainError(422, code, message, opts);

export type ErrorEnvelope = {
  error: { code: string; message: string; rule?: string; fields?: FieldError[]; requestId: string };
};

export function envelope(e: DomainError, requestId: string): ErrorEnvelope {
  const body: ErrorEnvelope['error'] = { code: e.code, message: e.message, requestId };
  if (e.rule) body.rule = e.rule;
  if (e.fields && e.fields.length) body.fields = e.fields;
  return { error: body };
}
