/**
 * Request metrics, rendered with the operational gauges as Prometheus text by GET /metrics.
 * Route labels are the declared route patterns (never raw URLs), so cardinality stays bounded and no
 * identifier or personal data reaches a metric.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Series = { count: number; sum: number; buckets: number[] };
const requests = new Map<string, number>();
const latency = new Map<string, Series>();

export function recordRequest(method: string, route: string, status: number, seconds: number): void {
  const cls = `${Math.floor(status / 100)}xx`;
  const k = `${method}|${route}|${cls}`;
  requests.set(k, (requests.get(k) ?? 0) + 1);
  const lk = `${method}|${route}`;
  const s = latency.get(lk) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
  s.count++;
  s.sum += seconds;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) s.buckets[i]!++;
  });
  latency.set(lk, s);
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export type Gauge = { name: string; help: string; type?: 'gauge' | 'counter'; samples: Array<{ labels?: Record<string, string>; value: number }> };

export function renderPrometheus(gauges: Gauge[]): string {
  const out: string[] = [];
  out.push('# HELP quorum_http_requests_total HTTP requests by route pattern and status class.', '# TYPE quorum_http_requests_total counter');
  for (const [k, v] of requests) {
    const [m, r, c] = k.split('|');
    out.push(`quorum_http_requests_total{method="${m}",route="${esc(r!)}",status="${c}"} ${v}`);
  }
  out.push('# HELP quorum_http_request_duration_seconds Request latency by route pattern.', '# TYPE quorum_http_request_duration_seconds histogram');
  for (const [k, s] of latency) {
    const [m, r] = k.split('|');
    const l = `method="${m}",route="${esc(r!)}"`;
    BUCKETS.forEach((b, i) => out.push(`quorum_http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`));
    out.push(`quorum_http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`);
    out.push(`quorum_http_request_duration_seconds_sum{${l}} ${s.sum.toFixed(6)}`);
    out.push(`quorum_http_request_duration_seconds_count{${l}} ${s.count}`);
  }
  for (const g of gauges) {
    out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} ${g.type ?? 'gauge'}`);
    for (const s of g.samples) {
      const l = s.labels ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
      out.push(`${g.name}${l} ${s.value}`);
    }
  }
  return out.join('\n') + '\n';
}
