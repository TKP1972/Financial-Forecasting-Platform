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
npm run db:reset        # drop, re-migrate, re-seed — DESTRUCTIVE
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
