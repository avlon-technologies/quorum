/**
 * Operational alerts (monitoring). An alert is written as one structured JSON line on stderr (the
 * contract for any log shipper) and, when QUORUM_ALERT_WEBHOOK is set, POSTed to that URL
 * (fire-and-forget, 5 s timeout, never retried, never blocking the caller). Alert payloads carry ids,
 * never personal data.
 */
export type Alert = { kind: string; [k: string]: unknown };

const listeners: Array<(a: Alert) => void> = [];
const counts = new Map<string, number>();

export function onAlert(f: (a: Alert) => void): () => void {
  listeners.push(f);
  return () => {
    const i = listeners.indexOf(f);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function raise(alert: Alert): void {
  counts.set(alert.kind, (counts.get(alert.kind) ?? 0) + 1);
  for (const f of listeners) {
    try {
      f(alert);
    } catch {
      /* an alert sink never breaks the caller */
    }
  }
}

export function alertCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

let installed = false;
/** The default sinks: a log line, and an optional webhook. Installed once by the server. */
export function installDefaultSinks(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  installed = true;
  onAlert((a) => console.error(JSON.stringify({ level: 'alert', at: new Date().toISOString(), ...a })));
  const url = env.QUORUM_ALERT_WEBHOOK;
  if (url) {
    onAlert((a) => {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'quorum', ...a }),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => console.error(JSON.stringify({ level: 'warn', msg: 'alert webhook failed', error: String(e) })));
    });
  }
}
