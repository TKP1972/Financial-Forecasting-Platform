# Runbook

Operating the Financial Forecasting Platform locally.

---

## Starting and stopping

```bash
npm run stack:up        # build + start postgres, migrate, seed, api, web
npm run stack:logs      # tail everything
npm run stack:down      # stop, keep data
npm run stack:nuke      # stop and DELETE the database volume
```

Start order is enforced by compose: Postgres must report healthy, then the one-shot
`migrate` service applies migrations and seeds and must exit successfully, then the API
starts, then the web container waits for the API to report healthy.

| Service  | Host port | Purpose                                                                 |
| -------- | --------- | ----------------------------------------------------------------------- |
| web      | 8080      | The application. Also proxies `/api` to the API.                        |
| api      | 4000      | REST API. Exposed directly for debugging and scripts.                   |
| postgres | **55432** | Database. Not 5432, to avoid colliding with a local PostgreSQL install. |

---

## Health checks

```bash
curl http://localhost:4000/health/live     # process is up. Does NOT touch the database.
curl http://localhost:4000/health/ready    # database reachable
```

These are deliberately separate. Liveness must not depend on the database — if Postgres
blips, the container should recover, not be killed and restarted by the orchestrator.

---

## Verifying a deployment

```bash
pwsh ./scripts/smoke-test.ps1                        # 80 assertions across every module
pwsh ./scripts/verify-audit-tamper-detection.ps1     # 8 assertions on the audit chain
```

The smoke test is idempotent — it creates its own budgets rather than mutating seeded state,
so it can be run repeatedly against the same environment.

The tamper-detection script deliberately corrupts the audit table and restores it. Every
mutation is wrapped in `try/finally`, so an abort still restores the row. It is safe to run
against a local environment; **do not run it against anything holding real audit data.**

> The login endpoint is rate-limited to 10 requests/minute. Running the smoke test several
> times in quick succession will trip it — the script backs off and retries rather than
> reporting a false failure.

---

## Database operations

```bash
npm run db:migrate      # create + apply a migration (development)
npm run db:deploy       # apply existing migrations (production/CI)
npm run db:seed         # load the worked example (idempotent)
npm run db:studio       # browse the data
npm run db:reset:stack  # drop, re-migrate, re-seed, restart the API — DESTRUCTIVE
npm run db:reset        # the same without the restart; only safe if the API is stopped
```

Prisma commands run from the repo root so they pick up the single `.env`; the schema path is
passed explicitly.

Direct SQL:

```bash
docker exec -it ffp-postgres psql -U ffp -d ffp
```

> Prisma maps model fields to **camelCase columns**, which Postgres folds to lowercase unless
> quoted. Write `"actorId"`, not `actorId`. When scripting, pipe SQL over stdin
> (`$sql | docker exec -i ...`) rather than passing `-c "..."` — shell layers strip the inner
> quotes and you get `column "actorid" does not exist`.

---

## Common problems

### `P1000: Authentication failed against database server`

Something else is listening on the database port. A locally installed PostgreSQL will shadow
the container. Confirm what holds the port:

```powershell
Get-NetTCPConnection -LocalPort 55432 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

The stack uses 55432 specifically to avoid this. If you changed `POSTGRES_PORT`, change
`DATABASE_URL` to match.

### `Invalid environment configuration: JWT_SECRET is required`

The API loads `.env` from the repo root. Copy `.env.example` to `.env` and set real values
for `JWT_SECRET` and `AUDIT_HASH_SALT`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In containers the environment comes from compose and `SKIP_DOTENV=true` is set, so no file is
read.

### Audit chain verification fails

Read the reported `reason` — it distinguishes three cases:

| Reason                  | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| _Content hash mismatch_ | A row was edited in place after being written. |
| _Chain link mismatch_   | Rows were inserted, removed or reordered.      |
| _Sequence gap_          | One or more rows were deleted.                 |

`brokenAtSequence` gives the first failing entry. Everything before it is intact.

**Legitimate causes:** rotating `AUDIT_HASH_SALT` invalidates verification of all historical
entries — the salt binds the chain to a deployment and must not be rotated casually. A schema
migration that alters an audited column has the same effect on pre-migration rows.

### `apk add` fails during a container build with a TLS error

The Alpine package CDN is unreachable behind a TLS-intercepting proxy. The API image uses
`node:22-slim` and installs no packages at all, precisely to avoid this. If you add a package
install to a Dockerfile, you reintroduce the dependency.

### Builds or tests fail with "JavaScript heap out of memory"

Usually genuine machine memory pressure rather than a code problem — Docker/WSL, browsers and
editors add up fast. Check free memory:

```powershell
$os = Get-CimInstance Win32_OperatingSystem
[math]::Round($os.FreePhysicalMemory/1MB, 2)
```

Stop the dev servers before a container build. Vitest is capped at 4 worker threads in
`vitest.config.ts` for the same reason — each worker loads the whole engine, and the Monte
Carlo suites allocate large typed arrays.

### Frontend loads but every API call 404s

The app calls a relative `/api/v1` path. In development that needs the Vite proxy (already
configured); in containers it needs the nginx `location /api/` block. If you serve the built
`dist/` with any other static server, add an equivalent proxy.

---

## Data growth and retention

**The platform deletes almost nothing, deliberately.** Financial records are amended, superseded
or closed — never removed (DEL-01 in `control-matrix.md`). Audit entries are hash-chained, so
removing one breaks verification for every entry after it, which is the control working rather
than a bug to route around. Plan for a database that only grows.

### What grows, and how fast

Measured on a seeded development database, so the per-row figures are real and the volumes are
not:

| Table               | Bytes/row (approx) | Driven by                                     |
| ------------------- | ------------------ | --------------------------------------------- |
| `audit_logs`        | ~1.3 kB            | Every governed action, plus every sign-in     |
| `budget_versions`   | ~2.3 kB            | Every budget transition (full snapshot each)  |
| `simulations`       | ~6.8 kB            | Every Monte Carlo run, kept with its seed     |
| `rolling_forecasts` | ~2.9 kB            | Each roll, per business unit and account      |
| `actuals`           | ~0.5 kB            | Volume × periods, the largest table long-term |
| `published_reports` | varies             | One frozen leadership pack per publication    |

A rough sizing: an organisation with 50 users doing a monthly cycle across 20 business units will
generate on the order of tens of thousands of audit rows a year — comfortably tens of megabytes,
not gigabytes. **Nothing here is alarming for years.** The point of this section is that there is
no automatic pruning, so it is a number to watch rather than one to ignore.

Check it with:

```sql
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
from pg_stat_user_tables
where n_live_tup > 0
order by pg_total_relation_size(relid) desc
limit 15;
```

### The one thing that is deleted

Expired refresh and password-reset tokens, by the `token-purge` background job every
`TOKEN_PURGE_SECONDS` (six hours by default; `0` disables it). These are not financial records —
nothing references them, no audit entry depends on them, and an expired token grants nothing.
Retaining them grows the table for the life of the deployment and keeps dead credential hashes on
disk for no reason.

Both purge functions existed and were never called until 2026-08-11, so a deployment older than
that will have accumulated one refresh-token row per sign-in since it was installed. The job
clears the backlog on its first run.

### What to do when a table does get large

In order of preference:

1. **Nothing.** Postgres handles tens of millions of rows in these shapes without help. Confirm
   the queries are still fast before treating size as a problem.
2. **Index and partition**, particularly `actuals` and `audit_logs` by period or date. This keeps
   every row and is the right answer for almost every case.
3. **Archive out, with the chain intact.** If audit rows genuinely must leave the primary
   database, export them **contiguously from the oldest**, keep the anchor records that cover
   them, and record where they went. Never remove from the middle: the chain links each entry to
   the previous hash, so a gap makes everything after it unverifiable.
4. **Never delete financial records to save space.** If storage is the binding constraint, the
   answer is more storage. A budget removed to save a few megabytes takes an auditable history
   with it.

### Closed cycles

A closed cycle stays readable permanently and its budgets remain the baseline any variance was
reported against. The Cycles screen defaults to **In progress** and offers Closed and All, so the
list stays useful as the years accumulate — the data is filtered from view, never removed.

---

## Rotating secrets

| Secret              | Effect of rotation                                        | Safe?                   |
| ------------------- | --------------------------------------------------------- | ----------------------- |
| `JWT_SECRET`        | All access tokens invalid; everyone re-authenticates.     | Yes                     |
| `AUDIT_HASH_SALT`   | **All historical audit verification fails permanently.**  | No — treat as immutable |
| `POSTGRES_PASSWORD` | Update `DATABASE_URL` to match, then recreate containers. | Yes                     |

To rotate `JWT_SECRET` cleanly, set the new value and restart the API. Existing refresh
tokens remain valid (they are opaque random values, not JWTs), so clients recover on their
next refresh without a forced sign-out.

---

## Backup and restore

```bash
# Backup
docker exec ffp-postgres pg_dump -U ffp -d ffp -Fc > ffp-$(date +%Y%m%d).dump

# Restore into an empty database
docker exec -i ffp-postgres pg_restore -U ffp -d ffp --clean --if-exists < ffp-20260807.dump
```

After any restore, verify the audit chain before trusting the data:

```bash
pwsh ./scripts/verify-audit-tamper-detection.ps1
```

A partial or row-filtered restore will break the chain — it must be restored whole.

---

## What to check after a deployment

1. `curl localhost:4000/health/ready` returns `{"status":"ready"}`
2. `pwsh ./scripts/smoke-test.ps1` reports 80/80
3. `POST /api/v1/governance/audit/verify` (as CFO or Admin) reports `valid: true`
4. `GET /api/v1/governance/controls` lists all five controls as `ENFORCED`
5. The dashboard at http://localhost:8080 renders with data
