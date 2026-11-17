import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Outbound mail transport. The file transport is the local stub; SmtpMailTransport (./smtp.ts) is the production one. */
export type OutboundMail = { id: string; to: string; subject: string; body: string };
export interface MailTransport {
  readonly kind: string;
  send(mail: OutboundMail): Promise<void>;
}

export class FileMailTransport implements MailTransport {
  readonly kind = 'stub-file';
  readonly #file: string;
  failNext = 0;
  constructor(file: string) {
    this.#file = file;
    mkdirSync(dirname(file), { recursive: true });
  }
  async send(mail: OutboundMail): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('mail transport unavailable (injected)');
    }
    // The id makes a redelivery recognisable downstream (idempotent receiver).
    appendFileSync(this.#file, JSON.stringify({ ...mail, at: new Date().toISOString() }) + '\n');
  }
}
