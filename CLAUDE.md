# Financial Forecasting Platform — working notes

Conventions and traps specific to this codebase. Read before changing financial logic.

## Session discipline

Two project-agnostic skills apply here and also exist in `udis-platform`:
`.claude/skills/model-and-token-efficiency` and
`.claude/skills/governance-and-correspondence-discipline`. The second covers the
`.internal/correspondence/` convention this repo already uses with UDIS — read it before
starting a new round rather than re-deriving the convention from old files.

The two skill sets are **not** kept in sync. The owner placed the same starting package in both
repositories to extract independent value from; each project keeps what serves it and diverges
freely. Do not "reconcile" them. The one skill with a standing reason to stay roughly aligned is
`governance-and-correspondence-discipline`, because it documents a bilateral convention.

## Layout

- `packages/shared` — money primitives, domain enums, RBAC matrix, fiscal calendar, Zod contracts
- `packages/engine` — pure financial math, no I/O, no framework. May import `shared` and nothing else.
- `packages/api` — Fastify + Prisma + PostgreSQL
- `packages/web` — React 19 + Vite
- `docs/` — product documentation. Everything here is shippable: architecture, runbook, threat
  model, engineering policy.
- `.internal/` — working context, tracked but **never distributed**: cross-project
  correspondence and anything else you would not hand to a client. Excluded from the Docker
  build context (verified, not assumed). The test is "would you include it if you shipped this
  to someone else?" — if no, it goes in `.internal/`, not `docs/`.

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
exemption. The CFO is the case that proves it binds at the top.

**ADMIN is not a finance role, and is the one role that is not a superset of the one below it**
(ADM-01). It observes, audits and administers; it holds no financial permission and its default
approval limit is `'0'`. Budget transitions require `TRANSITION_PERMISSION` **as well as**
`TRANSITION_MIN_ROLE` — without the permission gate the change would be cosmetic, because ADMIN's
rank of 60 satisfies every minimum in the seniority table. Do not "restore consistency" by making
the ladder monotonic again.

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
- **Never hardcode a configurable credential in a suite.** `SEED_ADMIN_PASSWORD` is settable and
  `scripts/init-env.mjs` generates a random one, so two suites hardcoding the shipped default
  broke the moment the documented setup was actually followed. `run-e2e.mjs` now loads `.env`
  before invoking suites, and they read `$env:SEED_ADMIN_PASSWORD`. The wider rule: changing a
  value from fixed to configurable means finding every consumer that assumed it was fixed.
- **The e2e suites test the running container, not your working tree.** `docker compose up -d`
  without `--build` reuses the cached image, so a suite can fail against a bug you fixed twenty
  minutes earlier — or pass against code you have since broken. This cost a real debugging
  detour: a journey suite reported a stale approval that had been fixed and unit-tested, because
  the image predated the fix by 21 minutes. **Rebuild the api image before trusting an e2e result
  after changing `packages/api`.**
- **`npm run db:reset` against a running API leaves it broken, and can silently corrupt what it
  writes.** Dropping and recreating the schema invalidates the connection pool's cached
  statements; reads keep working and writes start returning 500. **Worse, a write that does
  succeed in that window can be stored mis-encoded.** On 2026-08-11 a reset at 16:01 was followed
  at 16:04 by two audit entries whose summaries stored `ΓÇö` where the source row held a proper
  em-dash (U+2014) — the UTF-8 bytes read back through a single-byte codepage. The hash was
  computed over the correct string and the corrupted one was stored, so **the audit chain broke
  permanently at that sequence**: it cannot be repaired, which is the control working exactly as
  intended. Everything else was fine — the same code path, same container and same value round-trip
  correctly once the pool has rotated, so it reproduces only inside that window.

  **Use `npm run db:reset:stack`**, which resets and restarts the API so the window cannot open.
  Plain `db:reset` is only safe with the API stopped. If `verify-audit-tamper-detection.ps1` fails
  with "chain is intact to begin with" after a reset, this is the cause, and the only fix is
  another reset — the chain is deliberately unrepairable. Restart the API after a reset, or reset before bringing the stack up.

- **Structural correctness is not plausibility, and no test asserted the latter.** Three
  reporting defects survived 1,201 unit tests, 7 e2e suites and 4 browser journeys, because each
  produced a well-formed number of the right type with no error. What caught them was reading the
  figure and asking whether it could be true: 333.6% utilisation, minus $1.42bn remaining, every
  RAG indicator red, a board pack claiming +39.5% favourable. Their causes were unrelated —
  prior-year history attributed to the current cycle, a ratio dividing all units' actuals by
  approved-only budgets, and a report defaulting to a full-year budget against year-to-date
  actuals. `journey-operations.mjs` §7 now range-checks the headline figures against seeded data.
  Keep those bounds **loose**: a tight one breaks on every reasonable seed change and gets
  deleted, a loose one only fires when something is genuinely broken.
- **A plausibility check on the wrong subject cries wolf.** That section first took the newest
  OPEN cycle. `/cycles` returns newest fiscal year first and the e2e suites leave fixture cycles
  years ahead with budgets and no spend, so it picked one and reported 100% variance and every
  unit red — both correct for a cycle that has not started, and both looking exactly like the
  defects it exists to catch. It now resolves the subject by finding a cycle that actually has
  actuals.
- **A test fixture that satisfies the product's own "which cycle is live" heuristic will hijack
  the dashboard.** `GET /reports/dashboard` deliberately picks the newest OPEN or CONSOLIDATING
  cycle **that has actuals**, precisely so next year's empty cycle cannot displace the live one.
  When `smoke-test-rolling.ps1` was changed to provision its own cycle, that fixture was OPEN,
  sat in FY2031 and had imported actuals — so it met the test better than the real FY2026 cycle
  and the dashboard began reporting 3.27m of spend against a budget of zero. Nothing was broken:
  the heuristic did exactly what it says, on data that had no business being there. Fixing the
  suite's own idempotence created a fixture with a property no previous fixture had, and the
  older ones (budgets, no spend) had been invisible only because the heuristic already excluded
  them. The suite now parks its fixture in `PLANNING` when it finishes. **A suite that creates a
  cycle must leave it in a state that cannot be mistaken for the organisation's live one** —
  `CLOSED` is refused while budgets are in flight, so `PLANNING` is the reachable answer.
  `journey-operations.mjs` §7 caught this as an implausible headline figure, which is the whole
  reason that section exists.
- **`cycleId` on an actual means "belongs to", not "is context for".** The seed attached two prior
  years of forecasting history to the current cycle, so every aggregation `where: { cycleId }`
  summed two and a half years against a one-year budget. `periodKey` distinguishes the years
  (`FY2024-P01` vs `FY2026-P01`); `periodIndex` does not, and nothing filtered on the key. History
  now lives on its own closed prior cycles, which is what an organisation actually has. Note the
  API already refused to import a prior-year actual into a cycle — only the seed could create it.
- **Built is not the same as reachable, and `check:reachability` now asks.** The same defect
  shape was found by hand eleven times: permissions guarding no route, endpoints no screen led
  to, a seeded table no route read, columns nothing wrote, functions nothing called. Every one
  passed every test, because tests ask "does this work when called" and none asks "does anything
  call it". `npm run verify` now runs `scripts/check-reachability.mjs`: every permission guards a
  route, every table has a writer, and the count of routes exercised by no test or suite is a
  **ratchet** (currently 17 of 109) that fails the build in both directions — going up means a
  route was added untested, going down means the number needs lowering. Exceptions are declared
  with a reason and double as the register of deliberate decisions.
  **Calibrate any addition to it before committing.** The first draft reported 22 dead exports
  and an unwritten table, nearly all noise: `shared/index.ts` is `export *` so everything there
  is public API, and `BudgetLinePeriod` is written through a nested `periods: { create }` whose
  relation name matches neither the model nor its client property. Those rules were dropped
  rather than shipped loud — a check that cries wolf gets switched off.
- **A permission that guards nothing passes every consistency check.**
  `docs/user-manual.md`'s matrix is machine-checked against `rbac.ts`, and four permissions sat
  in both for months while no route required any of them — the check compares two matrices, and
  never asks whether a permission is reached. `pricing:approve` and `report:publish_leadership`
  became real controls (PRC-01, PUB-01); `budget:delete` and `actuals:read` were removed. When
  adding a permission, add the route that requires it in the same change. To audit this, scan
  the api and web sources for each permission string — but note that `budget:submit`/`approve`/
  `lock` are enforced through `TRANSITION_MIN_ROLE` seniority rather than by name, so a naive
  scan reports them as gaps. Verify before reporting; that check produced three false positives
  out of six on its first run.
- **A redaction applied per call site will be missed at one of them.** `redactMargin` gates
  the profit position on the pricing responses, and was applied on three of the four handlers
  that carry a saved model's figures. The fourth, `GET /pricing/pursuits`, selected
  `grossMargin` straight out of Prisma and returned it to any holder of `pricing:read` —
  including VIEWER. The screen rendered "Restricted" over the column client-side, so the page
  looked right while the figure sat in the response. Test a field-level restriction by calling
  the API **with the restricted user's own token** and searching the whole response
  _recursively_; naming the fields you expect is how the leak got in, because the author named
  them too. `pricing.margin.test.ts` does this and is the pattern to copy for any new
  margin-bearing route.
- **A rule the API states and a rule the API enforces must be the same expression.**
  `GET /cycles/:id` advertised a 12-period axis for a three-year cycle whose budgets require 36,
  because the endpoint and the validator each computed it their own way. Both had passing tests;
  a client obeying the advertised value got a 400 that read as its own mistake. Both now call
  `buildPeriodAxis`. Whenever something is announced in one place and enforced in another, make
  one call the other rather than testing both harder.

  It happened a second time, on the approval limit, and the second instance is subtler because
  the two readings of the same `null` disagreed. A **stored** `approvalLimit` of `null` means
  "no override, use the role default"; a **reported** `null` means "unlimited"
  (`DEFAULT_APPROVAL_LIMITS` says so). They collide exactly on ADMIN, whose stored value is null
  and whose default is `'0'` — so `POST /auth/login` and the token refresh described the
  administrator as having _no ceiling_ while every approval path held them to zero, which is the
  opposite of what ADM-01 exists to say. Enforcement was right the whole time; only the
  description was wrong, and no test caught it because each side was individually correct.
  `effectiveApprovalLimit()` is now the single expression, used by both approval services, the
  governance user list, the notification candidate filter and all three auth responses. **When a
  nullable column and a nullable policy value share a name, they do not share a meaning.**

- **Rebuild the libs after changing a `shared` or `engine` export.** `api` typechecks against
  `packages/shared/dist/*.d.ts`, not the sources, so a field added to a shared interface is
  invisible to it until `npm run build:libs` runs. The symptom is a lie: `tsc` reports the
  _consumer_ is wrong (`'x' does not exist in type 'Y'. Did you mean...?`) while the source
  plainly declares `x`. Vitest resolves sources through `paths`, so the tests pass at the same
  time — build first, then trust the error.
- **A CSS rule that loses on specificity fails silently, and no test can see it.**
  `.data-table th` set `text-left` and outranked a bare `.num` (0,1,1 against 0,1,0), so every
  `<th className="num">` in the product rendered left-aligned above right-aligned figures. On a
  nine-column variance table each number then appears to sit under the _next_ heading, and a
  reader comparing Budget with Actual compares the wrong pair. The markup was correct throughout;
  nothing was broken except where the pixels landed. Found by looking at a screenshot — 1,304 unit
  tests, 7 e2e suites and 4 browser journeys all passed over it, and axe reported nothing, because
  none of them assert position. `.data-table th.num` now wins, and `check:tables` guards the half
  CSS cannot: a heading and its column disagreeing about whether they are numeric. **When a
  utility class must override a component rule, check it actually wins.**
- **A control the docs assert and the matrix contradicts can pass a machine check.** The user
  manual said the administrator was "deliberately not a finance role" from the day it was written,
  while `ROLE_PERMISSIONS.ADMIN` was `[...CFO, 'user:manage', 'settings:manage']` — every financial
  approval, unlimited limit, rank above the CFO. `user-manual.test.ts` compares the manual's
  permission _matrix_ against the code and passed throughout, because the false claim was in the
  _prose_. It was the owner reading the About screen who asked why an administrator inherits the
  CFO's powers. When a document makes a claim about a control, the claim needs a test, not only the
  table beside it.
- **Two sign conventions on one product is a defect, not a documentation problem.** A variance
  report signs `budget − actual` (positive is underspend); a price/volume decomposition signs
  `actual − budget` (positive is added cost). Both are standard and a bare figure cannot say which
  produced it. The first fix here was a caption explaining the difference, which is managing a
  confusion rather than removing one — the owner rejected it, correctly. Money screens state a
  magnitude and then **F** or **A**, resolved through `varianceDirection()` so the rule stays in
  one place, which is what management accounts have done for a century. `decomposePriceVolume`
  takes an `accountType` for the purpose: overspending a cost and overdelivering revenue are the
  same arithmetic and opposite news, and totals across mixed types must net favourable against
  adverse rather than summing raw signs.

## Traps in how the work gets done

These cost more time than any product bug, because nothing failed — the tooling quietly did
something other than what was written.

- **Never author source through a shell heredoc.** The Bash tool halves backslashes on the way
  through, quoted heredoc or not. A regex written as `/\r?\n/` lands as a literal carriage return
  and newline _inside the regex literal_; `\b` becomes a backspace, `\u001b` an escape character.
  If you are lucky it is a syntax error. If you are not, the regex matches something else and every
  test still passes. It is invisible in an editor and in a diff, which is why it recurred **five
  times in this repository** before anyone wrote it down. Use the editor tooling, or write a
  script file with the editor tooling and run that. `check:invariants` now fails the build on
  stray control characters, and was tested against planted damage rather than assumed to work —
  its first draft excused carriage returns outright and caught nothing.
- **Read what the failing thing said before forming a theory about why it failed.**
  `smoke-test-rolling.ps1` printed its own diagnosis _and_ the remedy at the moment it failed, and
  CLAUDE.md documented the behaviour, and it was still misdiagnosed twice as a startup race —
  because `run-e2e.mjs` reported `FAIL suite (exit 1)` with the reason stripped, and the tail is
  what gets read. The runner now quotes the failing assertions and any explanatory line in its
  summary. The general rule: a hypothesis formed before reading the output is a guess, and a guess
  costs a full diagnostic cycle whether or not it is right.

## Testing

`npm test` — 1311 unit tests, gated at 90% lines / 85% branches on the engine.

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

Every suite is idempotent — keep them that way by creating their own fixtures rather than
mutating seeded state. `smoke-test-rolling.ps1` **used to be the exception**: it closed two of the
seeded cycle's periods per run and `exit 1`d once fewer than two remained, so it ran about three
times after a reset and then went red for a reason that was not a defect. It now provisions its own
annual cycle each run. Closing a period is destructive by design, so a suite that exercises it must
spend a cycle of its own rather than the one everything else depends on.

**Four browser journeys drive a real browser.** `npm run test:ui:all` runs the lot; each is
also a suite name for `scripts/run-e2e.mjs`. None are in the default `test:e2e` set, because a
CI runner without Chrome would fail for want of a browser rather than for a defect. `--headed`
to watch any of them.

| Suite                    | Alias           | Covers                                                    |
| ------------------------ | --------------- | --------------------------------------------------------- |
| `journey-ui.mjs`         | `ui-journey`    | Sign-in, all 10 nav items per role, workflow buttons (44) |
| `journey-pricing.mjs`    | `ui-pricing`    | `pricing:view_margin` and price sign-off (55)             |
| `journey-operations.mjs` | `ui-operations` | Forecasting, risk, variance, reference data (56)          |
| `journey-a11y.mjs`       | `ui-a11y`       | axe-core over every screen, three roles (38)              |

`journey-ui` is a reachability test — it proves each screen loads or explains itself.
`journey-operations` is the functional one: it runs a forecast, a simulation and a projection,
and asserts Monte Carlo reproducibility (same seed, same figures; different seed, different
figures) because that property is what makes a published contingency number auditable.

The a11y suite gates on **serious and critical** only, but records every impact level to
`artifacts/ui-journey/a11y.json`. A gate that fails on minor advisories gets switched off; one
that fails on a real barrier does not. It found the two worst contrast defects in the product on
its first run. It is **not** in the default `test:e2e` set, because a CI runner without Chrome
would fail for want of a browser rather than for a defect. `--headed` to watch it.

Three rules make it worth having rather than a screenshot generator:

- **Clicks are real mouse events at real coordinates**, and `document.elementFromPoint` must
  return the element aimed at. `element.click()` fires the handler on a control that is
  zero-sized, off-screen or covered by an overlay — all broken for a human.
- **Effects are verified against the API, never against the screen that caused them.** A UI
  rendering an optimistic success over a failed mutation passes any assertion made by reading
  the page.
- **A 4xx is not automatically a defect.** An Analyst getting 403 from the audit trail is the
  control _working_; what decides defect-or-not is whether the screen explains it. So the
  assertion is "every refusal is explained", not "no refusals". Asserting the latter would have
  reported three correct behaviours as bugs — it did, on the first draft.

Its own trap: it signs in a dozen or more times and **`POST /auth/login` is 10/minute**. The
symptom is indistinguishable from broken auth — the form just stays put. `signIn` backs off on
429, the suite signs in once per role rather than once per assertion, and the deliberate
rate-limit section runs **last** and then waits for the limiter to clear so the next suite is
not failed by it.

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
