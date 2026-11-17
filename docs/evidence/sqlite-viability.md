# SQLite viability: load and crash evidence

**Status: partial.** The load agent was stopped by the owner's request before it wrote its own verdict, and before the 10-year capacity run finished. This document was written afterwards from the raw results in `results/`. Every number below is quoted from those files; nothing was re-run.

- **Harness:** `scripts/load/`. Each run starts `node src/server.ts` as a child process with a fresh data directory, then drives it over HTTP with virtual users (VUs).
- **Machine:** the developer's Windows 11 laptop, one Node process, SQLite in WAL mode.
- **Code measured:** crash and limiter runs at `649bbb4`. Ramps and profiles ran on the working tree that became `649bbb4`; its `src/` was still being edited during the profiles (each result's `sourceState` lists the dirty files).

## Verdict (my judgment, from the results below)

**SQLite is not the bottleneck, and it is viable for one funding body.** No run logged a `SQLITE_BUSY`, and no crash lost an acknowledged write. **The deployment as built is not yet viable for more than about 25 concurrent active reviewers**, because the review path is CPU-bound in the application (§2). That is a code hot spot to profile and fix. It is not a reason to move to Postgres, which would not remove it.

What is still **NOT CHECKED**:
- Capacity over 10 years. Measured so far: about **60 KB per decided proposal lifecycle** (500 lifecycles, 0 errors). Building the 30,000-lifecycle database was stopped, so file size, backup time and restore time at that scale are unknown. As an extrapolation only: 30,000 × 60 KB ≈ 1.8 GB.
- Why the server stopped answering at 200 concurrent reviewers: a crash, an event-loop stall or a socket limit.
- The expected workload. The brief gives no numbers, and the agent's assumptions were not written down. The owner should state the peak number of concurrent reviewers and applicants.

## 1. Writes: submission rush

From `ramp-writers.log` (writes only) and `ramp-signin.log`:

| VUs | Throughput | p95 | Errors |
|---|---|---|---|
| 10 | 444 req/s, 254 commands/s | 44 ms | 0 |
| 50 | 444 req/s, 253 commands/s | 195 ms | 0 |
| 100 | 446 req/s, 255 commands/s | 480 ms | 0 |
| 200 | 419 req/s, 239 commands/s | 1.47 s | 0 |

- Throughput stays flat as load rises, so the single writer holds about 250 commands/s on this machine.
- Event-delivery lag stayed under 1 s at the 95th percentile.
- `sqliteBusy: 0` in every server-log scan.

## 2. The review path degrades with concurrency

From `ramp-writers.log`, review phase:

| VUs | Throughput | p50 | p95 | Errors | Server CPU |
|---|---|---|---|---|---|
| 10 | 236 req/s | 19 ms | 131 ms | 0 | 78% of one core |
| 25 | 132 req/s | 60 ms | 785 ms | 0 | 82% |
| 50 | 85 req/s | 117 ms | 3.7 s | 0 | 85% |
| 100 | 49 req/s | 204 ms | 16 s | 164 timeouts | 89% |
| 200 | 24 req/s | n/a | 30 s (timeout) | 1,443 (324 timeouts, 1,119 connection failures) | 91% |

- **The pattern:** total throughput *falls* as concurrency rises, while CPU sits near one full core and SQLite reports no lock waits. The likely cause is a per-request computation that grows with the data or the number of users. A workspace or queue query is a candidate, but this is not profiled.
- **The mixed ramp** (`ramp-mixed.log`) shows the same shape: the L=200 review phase ends with 2,115 connection failures.

## 3. Crash safety

From `crash.json` (5 rounds) and `crash-signin.json` (3 rounds): 50 VUs, and the server process is hard-killed mid-load with TerminateProcess.

| | Result |
|---|---|
| Writes acknowledged before each kill | 1,000 to 1,156 per round (`crash`), 400 per round (`crash-signin`) |
| Acknowledged writes missing after restart | **0** in every round |
| Command-log entries missing | **0** in every round |
| Restart time | 555 to 590 ms |
| Event backlog drained after restart | 11 to 16 ms |

## 4. Rate limiter under load

From `limiter.json`: 50 VUs for 20 s against shared accounts, with the default limits.
- Reads were limited to 600 per minute and writes to 120 per minute. The first 429 arrived within 0.6 to 1.2 s, each with a `Retry-After`.
- A limited request stayed cheap: p50 13 ms, p95 24 ms.

## What would change the decision

**Move off SQLite only if one of these becomes true:**
- the system needs more than one application instance (high availability, or more than one host);
- the 250 commands/s single-writer ceiling is approached;
- the database grows beyond what one volume can back up within the recovery-point window.

None of these follows from the review-path result, which is application CPU.
