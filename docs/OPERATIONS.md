# Operating Quorum

This is the runbook for a production deployment. The deployment shape follows from the SQLite decision, which is backed by measurements in `docs/evidence/sqlite-viability.md`:
- one funding body;
- **exactly one** `QuorumServer` process;
- the SQLite file (WAL) on a persistent volume;
- scheduled online backups.

The model declares this environment as `::Quorum.Production`, and `continuum/model/production.adl-binding.json` binds it.

## 1. Configuration

| Variable | Purpose | Production value |
|---|---|---|
| `NODE_ENV` | `production` disables demo mode: there is no movable clock, nothing is auto-seeded, and no demo password is printed | `production` |
| `QUORUM_DATA_DIR` | Database, signing secret, backups (by default) | A persistent volume |
| `PORT`, `HOST` | Listener | Behind a TLS-terminating reverse proxy |
| `QUORUM_ORCID` | `stub` \| `http` | `http`, plus `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET`, `ORCID_BASE_URL` |
| `QUORUM_TRIAGE` | `stub` \| `anthropic` | `anthropic`, plus `ANTHROPIC_API_KEY`, optionally `QUORUM_TRIAGE_MODEL` |
| `QUORUM_MAIL` | `file` \| `smtp` | `smtp`, plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` or `SMTP_STARTTLS` |
| `QUORUM_ROLE_EMAIL_PROGRAMOFFICER`, `_PANELCHAIR`, `_OPERATOR` | The mailbox for role-addressed notices: escalations, holds, refused awards | A shared team mailbox |
| `QUORUM_BACKUP_INTERVAL_HOURS`, `QUORUM_BACKUP_KEEP`, `QUORUM_BACKUP_DIR` | Scheduled online backups | `6`, `28`, a second volume |
| `QUORUM_METRICS_TOKEN` | Bearer token for `GET /metrics`. Without it, only loopback may scrape | Set it |
| `QUORUM_ALERT_WEBHOOK` | URL that receives every alert as JSON | Your paging or chat webhook |
| `QUORUM_RATE_LIMIT`, `QUORUM_RL_*` | Rate limits (§6) | Leave the defaults |

**Startup rules:**
- An adapter that is selected but under-configured stops startup, with a message such as `QUORUM_MAIL=smtp needs SMTP_HOST`. It never falls back to a stub.
- In production, a stub adapter that is still selected is logged as a WARNING.
- Startup prints the integrations in use and lists any production configuration that is missing.

## 2. Health and monitoring

| Endpoint | Meaning | Use |
|---|---|---|
| `GET /healthz` | The process is serving | Liveness probe |
| `GET /readyz` | The database is readable and the schema version matches this build (503 otherwise) | Readiness probe; check it after a deploy and after a restore |
| `GET /metrics` | Prometheus text: request counts and latency by route pattern, plus the gauges below | Scrape every 30 s |
| `GET /api/operations/health` | The same data as JSON, for the operator page | Operator role |

**Suggested alert rules:**
- `quorum_deliveries_parked > 0` for 5 min: a consumer keeps failing (§3).
- `quorum_delivery_oldest_pending_age_seconds > 600`: delivery is stalled.
- `quorum_outbound_messages{status="failed"}` increasing: mail is failing (check the SMTP relay).
- `quorum_last_backup_age_seconds > 2 × interval`, or `= -1`: backups have stopped.
- `quorum_decisions_escalated_open > 0`: decisions are overdue. This is a business alert for the officers, not a page.
- `rate(quorum_http_requests_total{status="5xx"}[5m]) > 0`.
- `rate(quorum_rate_limited_total[5m])` unusually high: possible credential stuffing.

**Alerts** (`delivery_parked`, `mail_failed`, `backup_failed`):
- Each is written as one JSON line on stderr (`{"level":"alert",...}`).
- Each is POSTed to `QUORUM_ALERT_WEBHOOK` when that is set.
- They carry ids only, never personal data.

## 3. Repeatedly failing deliveries

A consumer that fails five times on an event **parks** that delivery. Its partition (the proposal) is then held *for that consumer only*, so ordering is never broken, and an alert is raised. Other consumers carry on.

1. Read the failure on the operator page (**System health**, then **Parked deliveries**) or in `/api/operations/health`. `lastError` holds the cause.
2. Fix the cause: configuration, a bug fix and redeploy, or an external outage.
3. **Retry.** The delivery re-runs from attempt 0; the action and your reason are recorded in `ops_action`.
4. **Skip** only if the event can never succeed and its effect is not needed.
   - Skipping is **refused** for `submission.*`, `peer-review.*` and `adjudication.*`, whose effects guard an invariant. For those, the only way out is to fix the cause and retry.
   - A skip drops the event's *whole* effect, including data that later events depend on. For example, skipping a `ProposalSubmitted` notification means later emails about that proposal cannot be addressed to the applicant.
   - Skipping requires a reason of at least 10 characters and is recorded.
5. A skipped projection delivery can be repaired with **rebuild projections**, which replays the retained log.

`ops_action` is append-only: a database trigger refuses updates and deletes.

## 4. Backup and restore

**Backup** runs online and is safe while the server is serving.
- **Scheduled:** set `QUORUM_BACKUP_INTERVAL_HOURS`.
- **On demand:** the operator page (**Back up now**), `POST /api/operations/backup`, or `npm run ops -- backup` on the host.
- **Verification:** each backup is opened read-only, `PRAGMA integrity_check` must answer `ok`, and its schema version must be one this build knows. Only then does it count. A `.sha256` sidecar records it.
- **Retention:** the newest `QUORUM_BACKUP_KEEP` are kept.
- **Off-site:** copy the backup directory off the host. Quorum does not do this.

**Restore** is offline, and the recovery point is the newest good backup:
```
# 1. stop the server (systemctl stop quorum, or equivalent)
npm run ops -- list                       # choose a backup
npm run ops -- verify <backup-file>       # must print "ok": true
npm run ops -- restore <backup-file>      # refuses while a live server holds the database (pid file)
# 2. start the server; check /readyz; pending deliveries in the restored outbox resume on their own
```
- The current file is **moved aside**, never deleted: `quorum.sqlite.before-restore-<time>`.
- The restore is recorded in the restored database's `ops_action`.
- Anything committed after the backup was taken is lost. Tell the officers which window to re-check.

**Rehearse the restore regularly.** `tests/scenarios/production-readiness.test.ts` restores a backup taken while the server was serving, and proves the restored state is exactly the backup point.

## 5. Erasing personal data

For a data-subject request, use the operator page (**Erase personal data**) or `POST /api/operations/accounts/:id/erase` with a reason that cites the request reference. One transaction:
1. pseudonymises the account (name, email, institution, ORCID iD), removes its password and roles, and ends its sessions at once;
2. redacts those values from every retained event payload and from the command log;
3. publishes `AccountErased`. Notifications then delete the account's own messages and scrub its name from officers' notices; the oversight projection scrubs the portfolio and the audit trail. A projection rebuilt later from the redacted log gives the same result.

**Business records are kept** under business-record retention: proposals, reviews, decisions and budget. They refer to the account by id only.

**Out of Quorum's reach**, so record them in the request's response:
- email already delivered;
- backups taken before the erasure, which age out after `QUORUM_BACKUP_KEEP` intervals;
- free text that others wrote about the person (rationales, comments) when it does not contain the exact erased values.

## 6. Rate limiting

In-memory fixed windows. This is correct only for the single instance this deployment runs; a second instance would need a shared store, and that is the same trigger that ends SQLite's viability.

| Policy | Default | Variable |
|---|---|---|
| Failed sign-ins per (address, email) | 10 per 15 min, after which even a correct password is refused | `QUORUM_RL_SIGNIN_PER_IDENTITY` |
| Failed sign-ins per address | 50 per 15 min | `QUORUM_RL_SIGNIN_PER_IP` |
| Writes per account (or per address when anonymous) | 120 per minute | `QUORUM_RL_WRITES_PER_MIN` |
| Reads per account (or per address) | 600 per minute | `QUORUM_RL_READS_PER_MIN` |

A limited request gets 429 with `Retry-After`, and nothing is applied. Behind a reverse proxy, configure Fastify's `trustProxy` so that `req.ip` is the client's address. This is **not yet configured**, because the proxy is unknown (§8).

## 7. Integrations: what is exercised locally and what needs your input

Every adapter has been exercised against local fakes in `tests/integrations/` (62 tests). None has been run against the real service.

| Integration | Missing input to verify it for real | Decision needed |
|---|---|---|
| ORCID (`QUORUM_ORCID=http`) | Public API client credentials. Start with sandbox: register at sandbox.orcid.org, then Developer Tools, giving an app name, URL and redirect URI. Provide `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET` and `ORCID_BASE_URL=https://sandbox.orcid.org`, plus one known sandbox iD to look up | A lookup proves only that an iD **exists**. Proving that the person **owns** it needs the 3-legged `/authenticate` OAuth flow. Is existence enough for INV-12? |
| Triage (`QUORUM_TRIAGE=anthropic`) | An Anthropic Console organisation with billing, and an API key (`ANTHROPIC_API_KEY`) | The data-processing terms for sending applicant abstracts to a model provider; the model and effort level; a small labelled set of proposals to check the agent's accuracy |
| Mail (`QUORUM_MAIL=smtp`) | A relay account (for example SES, Postmark or Microsoft 365), a verified sender domain with SPF, DKIM and DMARC, the host and port, and a test mailbox | The From address and display name; which mailbox receives role notices (`QUORUM_ROLE_EMAIL_*`) |

## 8. Known limits

- **One instance only.** There is no high availability: a host failure means a restore on a new host, whose recovery point is the last backup. The trigger for Postgres is listed in the SQLite evidence document.
- **Proxy and TLS** are outside Quorum. `trustProxy` must be set once the proxy is known.
- **No password reset or MFA.** Both are out of MVP scope in the brief.
