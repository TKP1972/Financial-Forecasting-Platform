# Financial Forecasting Platform — working notes

Conventions and traps specific to this codebase. Read before changing financial logic.

## Layout

- `packages/shared` — money primitives, domain enums, RBAC matrix, fiscal calendar, Zod contracts
- `packages/engine` — pure financial math, no I/O, no framework. May import `shared` and nothing else.
- `packages/api` — Fastify + Prisma + PostgreSQL
- `packages/web` — React 19 + Vite

Dependency direction is one-way: `web`/`api` → `engine` → `shared`. Do not import `api` from
`engine`; the engine's testability depends on it having no I/O.

## Non-negotiables

**Money is never a `number`.** Use `Decimal` and the helpers in `shared/src/money.ts`. Money
crosses the wire as decimal _strings_ and is stored as `numeric(18,4)`. Rates are fractions
(`0.325`), not percentages, at `numeric(18,8)`. Rounding is banker's (half-to-even).

Statistical code (`engine/src/stats.ts`, smoothing, Monte Carlo) uses `number` deliberately —
see the header comment there. Convert back to `Decimal` in result builders before values
reach a ledger.

Never split money with `amount / n`. Use `allocateEvenly` or `allocateByWeights`; they
distribute the rounding remainder so the parts sum back exactly.

**Never construct a fiscal period by hand.** Everything comes from `shared/src/fiscal.ts`.
Period keys (`FY2026-P03`) are the join key between budgets and actuals.

**Variance direction lives in one place.** `FAVOURABLE_WHEN_OVER` + `varianceDirection()`.
Underspend on cost is favourable; under-delivery of revenue is not. Do not re-derive this
inline.

**Monte Carlo takes an explicit seed.** No `Math.random` anywhere in the engine — published
contingency figures must be reproducible for audit.

**Separation of duties has no bypass.** `assertSeparationOfDuties` must not gain a role
exemption, including for ADMIN.

**The audit chain's limits are documented, not assumed.** `docs/audit-threat-model.md` states
what the chain does and does not protect against — chiefly that `AUDIT_HASH_SALT` lives on the
same host as the database, so an attacker who can alter rows can likely also recompute valid
hashes. Anchoring (`AUDIT_ANCHOR_SECONDS`) emits the chain head outside the database to make
tail truncation and rewriting detectable. Keep that document honest when the control changes;
overstating it is worse than the gap.

## Traps that have already bitten

Several of these are now enforced mechanically rather than by memory — `npm run verify` runs
`check:invariants` (compiled output in `src/`, raw NUL bytes) and ESLint rules
(`z.coerce.boolean()`, default `Decimal` import) before anything else. A trap that has bitten
once will bite again; a check that fails the build will not.

- **Query-string booleans.** `z.coerce.boolean()` applies JS truthiness, so `"false"`
  becomes `true`. Use `queryBoolean` from `shared/src/contracts.ts`. Query numbers need
  `z.coerce.number()` — raw `z.number()` rejects every query param.
- **Audit `changes` is TEXT, not JSONB.** Postgres does not preserve JSONB key order, so a
  value read back does not re-serialise to the bytes that were hashed and every chain
  verification fails. It stores canonical JSON (keys sorted) and the hash covers those bytes
  verbatim. Do not "improve" it to JSONB.
- **Burden pools validate ordering, not presence.** A pool that is not configured contributes
  zero to a later pool's base. Only a pool drawing on one applied at the same time or later
  is an error.
- **`formatMoney` bounds.** Passing only `maximumFractionDigits` below 2 used to throw from
  `Intl.NumberFormat`; the helper now clamps the minimum down. Keep that.
- **Prisma columns are camelCase.** In raw SQL quote them (`"actorId"`), and pipe SQL over
  stdin rather than `psql -c "..."` — shell layers strip the inner quotes.
- **Never round-trip a UTF-8 file through Windows PowerShell 5.1.** `Get-Content -Raw` reads
  using the ANSI codepage, so writing the result back turns every em-dash and bullet into
  mojibake (`—` becomes `â€”`). Edit files with the editor tooling, or read and write
  explicitly via `[System.IO.File]::ReadAllText` / `WriteAllText` with a UTF8 encoding that
  emits no BOM.
- **Decimal import.** `import { Decimal } from 'decimal.js'` (named). Under NodeNext the
  default import resolves to the module namespace, not the class.
- **Never let `tsc` emit into a `src/` tree.** `packages/*/src/*.ts` import each other as
  `'./thing.js'`. If a compiled `thing.js` ever lands beside `thing.ts`, Vite and Vitest
  resolve the **stale `.js`** instead of the source, and tests silently run against an old
  build — new exports read as `undefined` while old ones work, which is a baffling failure
  mode. This happened once: `@ffp/web`'s build used `tsc -b`, which pulled shared's sources
  in through `paths` and emitted them next to the originals. The web build is now
  `tsc -p tsconfig.json --noEmit && vite build`. If new exports mysteriously come back
  undefined, look for `.js` files inside a `src/` directory first.
- **`.env` lives at the repo root only.** The API loads it via `process.loadEnvFile`; Prisma
  CLI commands run from the root with an explicit `--schema` path. Containers set
  `SKIP_DOTENV=true`.
- **Never embed a raw NUL byte in source.** `computeAuditHash` used a literal `0x00` as its
  field delimiter. It renders as a space everywhere, so a normalising save would silently
  substitute `0x20` — a delimiter that _does_ occur in field values — destroying the collision
  resistance and invalidating every stored hash. `grep` also skipped the file as binary and
  git stored it as an undiffable blob. Write `'\u0000'`; it is identical at runtime.
  Enforced by `check:invariants`.
- **Rebuild the libs after changing a `shared` or `engine` export.** `api` typechecks against
  `packages/shared/dist/*.d.ts`, not the sources, so a field added to a shared interface is
  invisible to it until `npm run build:libs` runs. The symptom is a lie: `tsc` reports the
  _consumer_ is wrong (`'x' does not exist in type 'Y'. Did you mean...?`) while the source
  plainly declares `x`. Vitest resolves sources through `paths`, so the tests pass at the same
  time — build first, then trust the error.

## Testing

`npm test` — 1005 unit tests, gated at 90% lines / 85% branches on the engine.

Write tests that assert **independently hand-computed** values, with the derivation in a
comment. Do not compute an expectation by calling the code under test; a tautological test on
financial math is worth nothing. Several real bugs were caught precisely because the expected
value was derived by hand.

End-to-end: `npm run test:e2e` runs the whole set — `smoke-test.ps1` (80 assertions) plus the
`planning`, `rolling`, `ratecards` and `pilot` suites, then
`verify-audit-tamper-detection.ps1` (8 assertions). All need the stack running. Pass suite
names to run a subset: `node scripts/run-e2e.mjs smoke-test-rolling`.

**Do not chain the suites with `;` in an npm script.** npm runs scripts through `cmd.exe` on
Windows, where `;` is not a command separator — it was absorbed into the filename and _no
suite ran at all_, while the error looked like a missing interpreter. `scripts/run-e2e.mjs`
runs them in-process instead, continues past a failure so one break does not hide the rest,
and returns an aggregate exit code. The old chain returned only the last suite's status, so
any earlier failure was silently discarded.

Most suites are idempotent — keep them that way by creating their own fixtures rather than
mutating seeded state. **`smoke-test-rolling.ps1` is the exception**: it closes periods, so it
consumes the seeded cycle's open periods and `exit 1`s once fewer than two remain. It needs a
fresh `npm run db:reset` to run again, and in CI it reads as a failure rather than a skip.

**Route tests use `app.inject()`, not a running server.** `packages/api/src/**/*.test.ts` build
the real Fastify app in-process — real router, real auth plugin, real error mapper — and fake
only the database, by `vi.mock`-ing `../db.js`. No port, no Docker, no seed data. Helpers live
in `packages/api/src/test-support/`; the fake environment is a Vitest `setupFile`, because
`config.ts` validates and freezes `process.env` at import time.

Assert the **error code**, not just the status. Several distinct controls all answer 403
(`FORBIDDEN` for role seniority, `SEPARATION_OF_DUTIES`, `DELEGATED_AUTHORITY_EXCEEDED`), so a
bare `expect(403)` will happily pass for the wrong reason — that mistake was made and caught
while writing these. Assert too that the guard was reached _before_ any write:
`expect(db.$transaction).not.toHaveBeenCalled()`.

`api` has its own coverage gate, `npm run test:coverage:api`, via
`vitest.coverage-api.config.ts`. It is a **ratchet set just under current coverage**, not a
target — raise it as suites land, never lower it to make a build pass. It is separate from the
main run because glob-scoped thresholds did not reliably exempt matched files from the 90/85
engine gate.

Vitest is capped at 4 worker threads; each worker loads the whole engine and the Monte Carlo
suites allocate large typed arrays.

## Local environment specifics

- Postgres is on host port **55432** to avoid colliding with a locally installed PostgreSQL.
- Container images install **no OS packages** — the Alpine CDN is unreachable behind a
  TLS-intercepting proxy here, so the API uses `node:22-slim` (OpenSSL already present) and
  Docker's `init: true` instead of tini.
- `POST /auth/login` is rate-limited to 10/minute. Scripts must back off rather than treat
  429 as a failure.
