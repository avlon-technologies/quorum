import { afterEach, describe, expect, it } from 'vitest';
import { SmtpError, SmtpMailTransport, buildMessage, envelopeAddress, type SmtpConfig } from '../../src/integrations/smtp.ts';
import { TEST_TLS, decodeBody, header, smtpSink, type SinkOptions, type SmtpSink } from './fakes.ts';

const PASS = 'smtp-pass-should-never-leak';
const mail = { id: 'msg_01HX', to: 'priya.raman@quorum.test', subject: 'Your proposal was submitted', body: 'Dear Priya,\n.\nA line that starts with a dot.\n\nQuorum' };

let sink: SmtpSink | null = null;
afterEach(async () => {
  await sink?.close();
  sink = null;
});

async function start(o: SinkOptions) {
  sink = await smtpSink(o);
  return sink;
}
const transport = (s: SmtpSink, c: Partial<SmtpConfig> = {}) =>
  new SmtpMailTransport({ host: '127.0.0.1', port: s.port, from: 'Quorum <no-reply@quorum.test>', timeoutMs: 1000, tls: { ca: TEST_TLS.cert }, ...c });

describe('SmtpMailTransport against a local SMTP sink', () => {
  it('plain connection (STARTTLS off, no auth): the message is accepted', async () => {
    const s = await start({});
    await transport(s, { starttls: 'off' }).send(mail);
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0]!;
    expect(m.from).toBe('no-reply@quorum.test');
    expect(m.to).toEqual(['priya.raman@quorum.test']);
    expect(m.encrypted).toBe(false);
    expect(header(m.data, 'Subject')).toBe(mail.subject);
    expect(header(m.data, 'From')).toBe('Quorum <no-reply@quorum.test>');
    expect(header(m.data, 'Message-ID')).toBe('<msg_01HX@quorum.test>');
    expect(decodeBody(m.data)).toBe(mail.body.replace(/\n/g, '\r\n'));
    expect(s.commands.at(-1)).toBe('QUIT');
  });

  it('STARTTLS + AUTH PLAIN: upgrades, re-EHLOs, authenticates, delivers', async () => {
    const s = await start({ starttls: true, auth: { user: 'quorum', pass: PASS } });
    await transport(s, { user: 'quorum', pass: PASS }).send(mail);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ encrypted: true, authUser: 'quorum' });
    expect(s.commands.filter((c) => c.startsWith('EHLO'))).toHaveLength(2);
    expect(s.commands.join('\n')).not.toContain(PASS);
  });

  it('STARTTLS + AUTH LOGIN when PLAIN is not offered', async () => {
    const s = await start({ starttls: true, auth: { user: 'quorum', pass: PASS }, authMechs: ['LOGIN'] });
    await transport(s, { user: 'quorum', pass: PASS }).send(mail);
    expect(s.messages[0]).toMatchObject({ encrypted: true, authUser: 'quorum' });
  });

  it('implicit TLS (SMTP_SECURE) with AUTH', async () => {
    const s = await start({ implicitTls: true, auth: { user: 'quorum', pass: PASS } });
    await transport(s, { secure: true, user: 'quorum', pass: PASS }).send(mail);
    expect(s.messages[0]).toMatchObject({ encrypted: true, authUser: 'quorum' });
  });

  it('an untrusted server certificate fails the send', async () => {
    const s = await start({ starttls: true });
    await expect(transport(s, { tls: {} }).send(mail)).rejects.toThrow(/TLS handshake failed/);
    expect(s.messages).toHaveLength(0);
  });

  it('STARTTLS required but not offered: refuses to send', async () => {
    const s = await start({});
    await expect(transport(s).send(mail)).rejects.toThrow(/does not offer STARTTLS/);
    expect(s.messages).toHaveLength(0);
  });

  it('never sends credentials over an unencrypted connection', async () => {
    const s = await start({ auth: { user: 'quorum', pass: PASS } });
    await expect(transport(s, { starttls: 'off', user: 'quorum', pass: PASS }).send(mail)).rejects.toThrow(/unencrypted/);
    expect(s.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
  });

  it('wrong password: SmtpError 535, password not in the message', async () => {
    const s = await start({ starttls: true, auth: { user: 'quorum', pass: PASS } });
    const err = await transport(s, { user: 'quorum', pass: 'wrong-pass' }).send(mail).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(535);
    expect(err.message).not.toContain('wrong-pass');
  });

  it('a permanent RCPT refusal propagates (so the drain records the failure)', async () => {
    const s = await start({ rcptReply: '550 5.1.1 no such user' });
    const err = await transport(s, { starttls: 'off' }).send(mail).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).toMatchObject({ code: 550, permanent: true });
  });

  it('a transient DATA refusal propagates as non-permanent', async () => {
    const s = await start({ dataReply: '451 4.3.0 try later' });
    await expect(transport(s, { starttls: 'off' }).send(mail)).rejects.toMatchObject({ code: 451, permanent: false });
  });

  it('slow server: times out waiting for the greeting', async () => {
    const s = await start({ greetingDelayMs: 2000 });
    const started = Date.now();
    await expect(transport(s, { starttls: 'off', timeoutMs: 200 }).send(mail)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('connection refused propagates', async () => {
    const t = new SmtpMailTransport({ host: '127.0.0.1', port: 9, from: 'no-reply@quorum.test', starttls: 'off', timeoutMs: 500 });
    await expect(t.send(mail)).rejects.toBeInstanceOf(SmtpError);
  });

  it('rejects header injection before connecting', async () => {
    const s = await start({});
    const t = transport(s, { starttls: 'off' });
    await expect(t.send({ ...mail, subject: 'Hi\r\nBcc: victim@example.org' })).rejects.toThrow(/line break/);
    await expect(t.send({ ...mail, to: 'a@b.test\r\nRCPT TO:<x@y.test>' })).rejects.toThrow(/line break/);
    expect(s.commands).toHaveLength(0);
  });

  it('describe() never contains the password', () => {
    const t = new SmtpMailTransport({ host: 'smtp.example.org', from: 'no-reply@quorum.test', user: 'u', pass: PASS });
    expect(t.describe()).not.toContain(PASS);
    expect(JSON.stringify(t)).not.toContain(PASS);
  });
});

describe('message building', () => {
  it('encodes a non-ASCII subject (RFC 2047) and keeps the body UTF-8', () => {
    const m = buildMessage({ ...mail, subject: 'Décision du comité', body: 'Résultat : financé' }, 'no-reply@quorum.test');
    expect(header(m, 'Subject')).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeBody(m)).toBe('Résultat : financé');
  });
  it('extracts envelope addresses', () => {
    expect(envelopeAddress('Quorum <no-reply@quorum.test>')).toBe('no-reply@quorum.test');
    expect(() => envelopeAddress('not an address')).toThrow();
  });
});
