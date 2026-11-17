/**
 * Local fakes for the integration adapters. Everything listens on 127.0.0.1 with an ephemeral port;
 * no test reaches a real network service.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { TLSSocket, createServer as createTlsServer } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
/** Self-signed test certificate for localhost / 127.0.0.1 (test-only key, generated for this suite). */
export const TEST_TLS = { key: fixture('smtp-test-key.pem'), cert: fixture('smtp-test-cert.pem') };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
export type FakeHttp = { url: string; requests: Recorded[]; close: () => Promise<void> };

export async function fakeHttp(handler: (req: Recorded, res: ServerResponse) => void | Promise<void>): Promise<FakeHttp> {
  const requests: Recorded[] = [];
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(rec);
      Promise.resolve(handler(rec, res)).catch((e) => {
        if (!res.headersSent) res.writeHead(599);
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------------------------
// SMTP sink: enough of RFC 5321 to accept a message, with STARTTLS, implicit TLS and AUTH PLAIN/LOGIN.

export type SinkOptions = {
  starttls?: boolean;
  implicitTls?: boolean;
  /** Accepted credentials; when set, AUTH is advertised once the connection is encrypted. */
  auth?: { user: string; pass: string };
  authMechs?: string[];
  rcptReply?: string;
  dataReply?: string;
  greetingDelayMs?: number;
};

export type SinkMessage = { from: string; to: string[]; data: string; encrypted: boolean; authUser: string | null };
export type SmtpSink = { port: number; messages: SinkMessage[]; commands: string[]; close: () => Promise<void> };

export async function smtpSink(o: SinkOptions = {}): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const session = (initial: Socket, encryptedAtStart: boolean) => {
    let sock: Socket = initial;
    let encrypted = encryptedAtStart;
    let buf = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    let authUser: string | null = null;
    let loginStep: null | 'user' | 'pass' = null;
    let loginUser = '';
    const send = (line: string) => sock.write(`${line}\r\n`);

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          if (o.dataReply) return send(o.dataReply);
          messages.push({ from, to, data, encrypted, authUser });
          from = '';
          to = [];
          data = '';
          return send('250 2.0.0 queued');
        }
        data += (line.startsWith('.') ? line.slice(1) : line) + '\r\n';
        return;
      }
      if (loginStep === 'user') {
        loginUser = Buffer.from(line, 'base64').toString('utf8');
        loginStep = 'pass';
        return send('334 UGFzc3dvcmQ6');
      }
      if (loginStep === 'pass') {
        loginStep = null;
        const pass = Buffer.from(line, 'base64').toString('utf8');
        if (o.auth && loginUser === o.auth.user && pass === o.auth.pass) {
          authUser = loginUser;
          return send('235 2.7.0 ok');
        }
        return send('535 5.7.8 bad credentials');
      }
      commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN ***' : line);
      const verb = line.split(' ')[0]!.toUpperCase();
      switch (verb) {
        case 'EHLO': {
          const caps = ['250-sink.test'];
          if (o.starttls && !encrypted) caps.push('250-STARTTLS');
          if (o.auth && encrypted) caps.push(`250-AUTH ${(o.authMechs ?? ['PLAIN', 'LOGIN']).join(' ')}`);
          caps.push('250 8BITMIME');
          return sock.write(caps.join('\r\n') + '\r\n');
        }
        case 'STARTTLS': {
          if (!o.starttls || encrypted) return send('502 5.5.1 no');
          send('220 2.0.0 go ahead');
          sock.removeAllListeners('data');
          const tlsSock = new TLSSocket(sock, { isServer: true, key: TEST_TLS.key, cert: TEST_TLS.cert });
          sockets.add(tlsSock);
          tlsSock.on('error', () => undefined);
          tlsSock.on('secure', () => undefined);
          sock = tlsSock;
          encrypted = true;
          buf = '';
          tlsSock.on('data', onData);
          return;
        }
        case 'AUTH': {
          const [, mech, arg] = line.split(' ');
          if (!o.auth || !encrypted) return send('503 5.5.1 auth not available');
          if (mech === 'PLAIN' && arg) {
            const [, u, p] = Buffer.from(arg, 'base64').toString('utf8').split('\0');
            if (u === o.auth.user && p === o.auth.pass) {
              authUser = u!;
              return send('235 2.7.0 ok');
            }
            return send('535 5.7.8 bad credentials');
          }
          if (mech === 'LOGIN') {
            loginStep = 'user';
            return send('334 VXNlcm5hbWU6');
          }
          return send('504 5.5.4 mechanism not supported');
        }
        case 'MAIL':
          if (o.auth && !authUser) return send('530 5.7.0 authentication required');
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          return send('250 2.1.0 ok');
        case 'RCPT':
          if (o.rcptReply) return send(o.rcptReply);
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          return send('250 2.1.5 ok');
        case 'DATA':
          inData = true;
          return send('354 end with <CRLF>.<CRLF>');
        case 'QUIT':
          send('221 2.0.0 bye');
          return sock.end();
        default:
          return send('500 5.5.2 unknown command');
      }
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };

    sock.on('data', onData);
    sock.on('error', () => undefined);
    setTimeout(() => send('220 sink.test ESMTP fake'), o.greetingDelayMs ?? 0);
  };

  const server: NetServer = o.implicitTls
    ? createTlsServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (s) => {
        sockets.add(s);
        session(s, true);
      })
    : createNetServer((s) => {
        sockets.add(s);
        session(s, false);
      });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    messages,
    commands,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Decodes the base64 text/plain body of a message produced by SmtpMailTransport. */
export function decodeBody(data: string): string {
  const [, body = ''] = data.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

export function header(data: string, name: string): string | undefined {
  const head = data.split('\r\n\r\n')[0] ?? '';
  const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}
