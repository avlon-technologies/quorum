/**
 * SMTP mail transport — a small, dependency-free SMTP submission client (RFC 5321 / 6409) for one job:
 * deliver one plain-text message per call to a relay. One connection per message, closed with QUIT.
 *
 * - Implicit TLS (SMTP_SECURE=true, usually port 465) or STARTTLS (default "required" otherwise).
 * - AUTH PLAIN or LOGIN, and only over an encrypted connection.
 * - Every reply is awaited with a timeout; any failure throws, so the notification drain retries.
 * - Headers are built here, never from raw input: CR/LF in an address or subject is rejected
 *   (header injection), the subject is RFC 2047 encoded, and the body is base64 UTF-8.
 */
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { MailTransport, OutboundMail } from './mail.ts';

export type StarttlsMode = 'required' | 'opportunistic' | 'off';

export type SmtpConfig = {
  host: string;
  port?: number;
  /** Implicit TLS from the first byte (port 465). */
  secure?: boolean;
  /** Only when secure is false. Default "required": refuse to send if the server cannot upgrade. */
  starttls?: StarttlsMode;
  user?: string;
  pass?: string;
  /** Header From, e.g. `Quorum <no-reply@example.org>`; the envelope sender is the address inside. */
  from: string;
  /** Per-reply timeout (connect, greeting, each command). */
  timeoutMs?: number;
  /** Name sent in EHLO. */
  clientName?: string;
  /** Extra TLS options (e.g. a private CA). Certificates are verified by default. */
  tls?: ConnectionOptions;
};

export class SmtpError extends Error {
  override readonly name = 'SmtpError';
  /** SMTP reply code, or null for connection-level failures. */
  readonly code: number | null;
  /** 5xx: the server refused permanently. The drain still retries up to its limit, then parks it. */
  readonly permanent: boolean;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
    this.permanent = code !== null && code >= 500;
  }
}

type Reply = { code: number; lines: string[] };

const ADDRESS = /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/;
const HAS_CRLF = /[\r\n]/;

/** `Name <a@b.c>` or `a@b.c` -> `a@b.c`; throws on anything else. */
export function envelopeAddress(header: string): string {
  if (HAS_CRLF.test(header)) throw new SmtpError('address contains a line break');
  const m = /<([^<>]+)>\s*$/.exec(header);
  const addr = (m ? m[1]! : header).trim();
  if (!ADDRESS.test(addr)) throw new SmtpError(`not a valid email address: ${JSON.stringify(addr)}`);
  return addr;
}

function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

/** RFC 5322 message, CRLF line endings, not yet dot-stuffed. */
export function buildMessage(mail: OutboundMail, from: string, now = new Date()): string {
  if (HAS_CRLF.test(mail.subject)) throw new SmtpError('subject contains a line break');
  if (HAS_CRLF.test(mail.id) || /[<>\s]/.test(mail.id)) throw new SmtpError('message id is not header-safe');
  const to = envelopeAddress(mail.to);
  const fromAddr = envelopeAddress(from);
  const domain = fromAddr.split('@')[1]!;
  const body = mail.body.replace(/\r\n|\r|\n/g, '\r\n');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    // Stable per outbound message: a redelivery after a lost acknowledgement carries the same Message-ID.
    `Message-ID: <${mail.id}@${domain}>`,
    `X-Quorum-Message-Id: ${mail.id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}`;
}

/** Reads SMTP replies (possibly multi-line) from whichever socket is current. */
class SmtpSession {
  #socket: Socket;
  #buf = '';
  #lines: string[] = [];
  #waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  #failure: Error | null = null;
  readonly #timeoutMs: number;
  readonly #onData = (chunk: Buffer) => this.#ingest(chunk.toString('latin1'));
  readonly #onError = (e: Error) => this.#fail(new SmtpError(`SMTP connection error: ${e.message}`));
  readonly #onClose = () => this.#fail(new SmtpError('SMTP connection closed by the server'));

  constructor(socket: Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#attach(socket);
  }

  get encrypted(): boolean {
    return (this.#socket as TLSSocket).encrypted === true;
  }

  #attach(s: Socket) {
    s.on('data', this.#onData);
    s.on('error', this.#onError);
    s.on('close', this.#onClose);
  }
  #detach(s: Socket) {
    s.off('data', this.#onData);
    s.off('error', this.#onError);
    s.off('close', this.#onClose);
  }

  #ingest(text: string) {
    this.#buf += text;
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      this.#lines.push(this.#buf.slice(0, i).replace(/\r$/, ''));
      this.#buf = this.#buf.slice(i + 1);
    }
    this.#deliver();
  }

  #deliver() {
    if (!this.#waiter) return;
    // A reply ends at the line whose 4th character is a space (or which is just the code).
    const end = this.#lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const lines = this.#lines.splice(0, end + 1);
    const code = Number(lines[0]!.slice(0, 3));
    const w = this.#waiter;
    this.#waiter = null;
    clearTimeout(w.timer);
    w.resolve({ code, lines: lines.map((l) => l.slice(4)) });
  }

  #fail(e: Error) {
    this.#failure ??= e;
    const w = this.#waiter;
    if (w) {
      this.#waiter = null;
      clearTimeout(w.timer);
      w.reject(this.#failure);
    }
  }

  read(what: string): Promise<Reply> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new SmtpError(`SMTP timed out after ${this.#timeoutMs} ms waiting for ${what}`));
        this.#socket.destroy();
      }, this.#timeoutMs);
      this.#waiter = { resolve, reject, timer };
      this.#deliver();
    });
  }

  write(data: string) {
    this.#socket.write(data, 'utf8');
  }

  /** Sends a command and expects one of the given codes. `label` replaces the command text in errors. */
  async command(line: string, expect: number[], label = line.split(' ')[0]!): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.expect(label, expect);
  }

  async expect(label: string, codes: number[]): Promise<Reply> {
    const r = await this.read(label);
    if (!codes.includes(r.code)) throw new SmtpError(`SMTP ${label} refused: ${r.code} ${r.lines.join(' ').slice(0, 200)}`, r.code);
    return r;
  }

  async upgrade(options: ConnectionOptions): Promise<void> {
    if (this.#lines.length || this.#buf) throw new SmtpError('SMTP server sent data before the TLS handshake'); // STARTTLS response injection
    const plain = this.#socket;
    this.#detach(plain);
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.destroy();
        reject(new SmtpError(`SMTP TLS handshake timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      const s = tlsConnect({ ...options, socket: plain }, () => {
        clearTimeout(timer);
        s.off('error', onErr);
        resolve(s);
      });
      const onErr = (e: Error) => {
        clearTimeout(timer);
        reject(new SmtpError(`SMTP TLS handshake failed: ${e.message}`));
      };
      s.once('error', onErr);
    });
    this.#socket = secure;
    this.#attach(secure);
  }

  close() {
    this.#detach(this.#socket);
    this.#socket.on('error', () => undefined);
    this.#socket.destroy();
  }
}

function capabilities(r: Reply): Map<string, string> {
  const caps = new Map<string, string>();
  for (const line of r.lines.slice(1)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k) caps.set(k.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return caps;
}

export class SmtpMailTransport implements MailTransport {
  readonly kind = 'smtp';
  readonly #host: string;
  readonly #port: number;
  readonly #secure: boolean;
  readonly #starttls: StarttlsMode;
  readonly #user: string | undefined;
  readonly #pass: string | undefined;
  readonly #from: string;
  readonly #envelopeFrom: string;
  readonly #timeoutMs: number;
  readonly #clientName: string;
  readonly #tls: ConnectionOptions;

  constructor(c: SmtpConfig) {
    if (!c.host) throw new Error('SmtpMailTransport: host is required');
    if ((c.user === undefined) !== (c.pass === undefined)) throw new Error('SmtpMailTransport: give both user and pass, or neither');
    this.#host = c.host;
    this.#secure = c.secure ?? false;
    this.#port = c.port ?? (this.#secure ? 465 : 587);
    this.#starttls = this.#secure ? 'off' : (c.starttls ?? 'required');
    this.#user = c.user;
    this.#pass = c.pass;
    if (HAS_CRLF.test(c.from)) throw new Error('SmtpMailTransport: from contains a line break');
    this.#from = c.from;
    this.#envelopeFrom = envelopeAddress(c.from);
    this.#timeoutMs = c.timeoutMs ?? 15_000;
    this.#clientName = c.clientName ?? 'quorum.localdomain';
    // SNI only for host names (RFC 6066); the certificate is still checked against an IP host.
    this.#tls = { host: c.host, ...(isIP(c.host) ? {} : { servername: c.host }), ...c.tls };
  }

  describe(): string {
    const security = this.#secure ? 'implicit TLS' : `STARTTLS ${this.#starttls}`;
    return `smtp ${this.#host}:${this.#port} (${security}, ${this.#user ? 'auth' : 'no auth'}, from ${this.#envelopeFrom})`;
  }

  async send(mail: OutboundMail): Promise<void> {
    const message = buildMessage(mail, this.#from); // validate before connecting
    const rcpt = envelopeAddress(mail.to);
    const session = new SmtpSession(await this.#connect(), this.#timeoutMs);
    try {
      await session.expect('greeting', [220]);
      let caps = capabilities(await session.command(`EHLO ${this.#clientName}`, [250]));

      if (!session.encrypted && this.#starttls !== 'off') {
        if (caps.has('STARTTLS')) {
          await session.command('STARTTLS', [220]);
          await session.upgrade(this.#tls);
          caps = capabilities(await session.command(`EHLO ${this.#clientName}`, [250])); // capabilities change after TLS
        } else if (this.#starttls === 'required') {
          throw new SmtpError('SMTP server does not offer STARTTLS and SMTP_STARTTLS=required');
        }
      }

      if (this.#user !== undefined && this.#pass !== undefined) {
        if (!session.encrypted) throw new SmtpError('refusing to send SMTP credentials over an unencrypted connection');
        const mechs = (caps.get('AUTH') ?? '').split(/\s+/);
        if (mechs.includes('PLAIN')) {
          const token = Buffer.from(`\0${this.#user}\0${this.#pass}`, 'utf8').toString('base64');
          await session.command(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN');
        } else if (mechs.includes('LOGIN')) {
          await session.command('AUTH LOGIN', [334], 'AUTH LOGIN');
          await session.command(Buffer.from(this.#user, 'utf8').toString('base64'), [334], 'AUTH LOGIN (user)');
          await session.command(Buffer.from(this.#pass, 'utf8').toString('base64'), [235], 'AUTH LOGIN (password)');
        } else {
          throw new SmtpError(`SMTP server offers no supported AUTH mechanism (offered: ${caps.get('AUTH') ?? 'none'})`);
        }
      }

      await session.command(`MAIL FROM:<${this.#envelopeFrom}>`, [250], 'MAIL FROM');
      await session.command(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT TO');
      await session.command('DATA', [354]);
      // Dot-stuffing: a line that starts with "." gets another one; then CRLF.CRLF ends the data.
      const stuffed = message.replace(/(^|\r\n)\./g, '$1..');
      session.write(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
      await session.expect('end of DATA', [250]);
      await session.command('QUIT', [221]).catch(() => undefined);
    } finally {
      session.close();
    }
  }

  #connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => {
        clearTimeout(timer);
        reject(new SmtpError(`SMTP connect to ${this.#host}:${this.#port} failed: ${e.message}`));
      };
      const timer = setTimeout(() => {
        s.destroy();
        reject(new SmtpError(`SMTP connect to ${this.#host}:${this.#port} timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      const ready = () => {
        clearTimeout(timer);
        s.off('error', onError);
        resolve(s);
      };
      const s: Socket = this.#secure
        ? tlsConnect({ host: this.#host, port: this.#port, ...this.#tls }, ready)
        : netConnect({ host: this.#host, port: this.#port }, ready);
      s.once('error', onError);
    });
  }
}

type Env = Record<string, string | undefined>;

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`expected a boolean, got "${v}"`);
}

/**
 * SMTP_HOST, SMTP_FROM required. SMTP_PORT (465 if SMTP_SECURE else 587), SMTP_SECURE (implicit TLS),
 * SMTP_STARTTLS=required|opportunistic|off (default required), SMTP_USER + SMTP_PASS (together),
 * SMTP_TIMEOUT_MS, SMTP_CLIENT_NAME.
 */
export function smtpConfigFromEnv(env: Env): { config: SmtpConfig; missing: string[] } {
  const missing: string[] = [];
  const host = env.SMTP_HOST?.trim() ?? '';
  const from = env.SMTP_FROM?.trim() ?? '';
  if (!host) missing.push('SMTP_HOST');
  if (!from) missing.push('SMTP_FROM');
  const user = env.SMTP_USER || undefined;
  const pass = env.SMTP_PASS || undefined;
  if (user && !pass) missing.push('SMTP_PASS');
  if (pass && !user) missing.push('SMTP_USER');
  let secure: boolean | undefined;
  try {
    secure = bool(env.SMTP_SECURE);
  } catch (e) {
    throw new Error(`SMTP_SECURE: ${(e as Error).message}`);
  }
  const starttls = (env.SMTP_STARTTLS?.trim().toLowerCase() || undefined) as StarttlsMode | undefined;
  if (starttls && !['required', 'opportunistic', 'off'].includes(starttls)) throw new Error(`SMTP_STARTTLS must be required|opportunistic|off, got "${starttls}"`);
  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`SMTP_PORT is not a port number: "${env.SMTP_PORT}"`);
  const timeout = Number(env.SMTP_TIMEOUT_MS);
  return {
    config: {
      host,
      port,
      secure,
      starttls,
      user: user && pass ? user : undefined,
      pass: user && pass ? pass : undefined,
      from,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      clientName: env.SMTP_CLIENT_NAME?.trim() || undefined,
    },
    missing,
  };
}
