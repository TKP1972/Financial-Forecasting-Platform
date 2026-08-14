# Architecture

This document records the decisions that were genuinely contested — what was chosen, what
was rejected, and why. Decisions with an obvious answer are not listed.

---

## 1. Package layout

```
packages/
├── shared/    Money primitives, domain vocabulary, RBAC matrix, fiscal calendar, Zod contracts
├── engine/    Pure financial math. No I/O, no database, no framework.
├── api/       Fastify + Prisma + PostgreSQL
└── web/       React 19 + Vite
```

**Why `engine` is a separate package with no dependencies on anything.**

The financial math is the part that must not be wrong, and the part most expensive to
verify. Isolating it from I/O means it can be exhaustively unit-tested with hand-computed
expected values, no fixtures, no database and no mocking — 774 tests run in under three
seconds. Had the pricing build-up lived inside a route handler, testing a burden-application
edge case would have meant standing up Postgres and authenticating.

The separation is enforced by dependency direction: `engine` may import `shared`, and
nothing else. `api` composes them.

---

## 2. Money is never a float

**Decision:** all monetary arithmetic uses `decimal.js` with 28-digit precision and banker's
rounding. Money crosses the wire and rests in the database as a decimal _string_ /
`numeric(18,4)`, never as a JavaScript `number`.

**Why.** IEEE-754 cannot represent 0.1 exactly. `0.1 + 0.2 === 0.30000000000000004`. A
budget rollup sums thousands of lines across twelve periods and four business units; the
drift is real, and it surfaces in a variance report as pennies nobody can explain. Worse, it
surfaces _inconsistently_ — the same logical total computed via two different aggregation
orders disagrees, and reconciling that consumes days.

Banker's rounding (round-half-to-even) rather than round-half-up, because half-up is biased
upward and that bias compounds across a large number of roundings.

**The deliberate exception.** Statistical code — exponential smoothing, Monte Carlo,
correlation — uses `number`. Two reasons: the uncertainty in any forecast is many orders of
magnitude larger than float64 error, so Decimal precision there is meaningless; and Decimal
arithmetic across 10,000 Monte Carlo iterations × 50 inputs would be unusably slow. The
boundary is explicit and documented at the top of `engine/src/stats.ts`, and values convert
back to `Decimal` in the result builders before they can reach a ledger.

**Allocation.** `allocateEvenly` and `allocateByWeights` exist because the naive
`amount / n` rounded per-part leaks money — splitting 100 three ways gives 33.33 × 3 = 99.99.
Both distribute the rounding remainder (largest-remainder method for weighted splits) so the
result always sums back to exactly the input. Tested for that property directly.

---

## 3. The fiscal calendar is generated in exactly one place

**Decision:** `shared/src/fiscal.ts` owns every period label, quarter boundary, year-to-date
window and period key. Nothing else constructs a period.

**Why.** Organisations rarely run on the Gregorian year; April and October starts are
normal. The failure mode when period logic is duplicated is not a crash — it is a forecast
labelled "Q1" that means a different quarter from the "Q1" in the variance report, and
totals that disagree for reasons nobody can find.

Period keys (`FY2026-P03`) are the join key between budget lines and actuals, which is what
makes the variance report a simple join rather than a date-range reconciliation.

**Rejected:** storing period start/end dates on each row and matching by range. That pushes
the fiscal-year definition into every query and makes changing the fiscal calendar a data
migration.

---

## 4. Burden pools declare their base explicitly

**Decision:** each indirect cost pool declares which elements it burdens; pools are applied
in a fixed order (`FRINGE → OVERHEAD → MATERIAL_HANDLING → G&A → COM`); a pool may only draw
on elements resolved before it, validated up front; and the applied base and rate are
returned as an audit trail alongside the amounts.

**Why.** The single most common defect in a home-grown pricing model is applying a pool to
the wrong base — G&A on a base that already contains G&A, or overhead before fringe. A 1%
base error on a 30% pool is a real margin error on a real bid, and it is invisible in the
output unless the base is shown.

**A bug this caught.** The first implementation validated that every referenced pool was
_defined_, and threw otherwise. That wrongly rejected an entirely normal
fringe/overhead/G&A model, because G&A's standard base mentions material handling and no
such pool existed. The correct rule is about _ordering_, not presence: an undefined pool
simply contributes zero. Caught by a test asserting a realistic three-pool model prices
correctly.

---

## 5. Forecast method selection is by backtest, not fit

**Decision:** `AUTO` runs rolling-origin cross-validation over every applicable method and
selects on out-of-sample MASE. The complete candidate table is returned with the forecast.

**Why.** Selecting on in-sample fit always favours the most flexible model — Holt-Winters
will fit noise better than a naive benchmark every time. That is exactly how a budget ends
up anchored to an over-fitted trend that reverses in month two.

MASE rather than MAPE: MAPE is undefined when any actual is zero, and it penalises
over-forecasts more harshly than under-forecasts, which biases method selection. MAPE is
still _reported_, because finance teams ask for it — but nothing is selected on it.

Returning the candidate table matters as much as the selection. A reviewer asking "why this
method?" gets an answer with numbers attached instead of a black box.

---

## 6. Monte Carlo is seeded and reproducible

**Decision:** every simulation takes an explicit integer seed, uses a deterministic PRNG
(sfc32, seeded through SplitMix32), and stores the seed with its results. `Math.random` is
not used anywhere in the engine.

**Why.** This is a governance requirement, not a nicety. A contingency figure quoted to a
board — "we are holding 380k against a P80 of 4.2m" — has to be re-derivable months later
during an audit. A simulation that cannot be reproduced is an assertion, not evidence.

sfc32 specifically because it is pure 32-bit integer arithmetic, so it produces identical
streams on every platform the service might run on. A generator relying on floating-point
state could diverge across architectures and silently break reproducibility.

Latin Hypercube stratification is applied where a distribution can be driven by a single
uniform, which materially improves tail accuracy at a given iteration count — and P80 is a
tail number. Normal, lognormal and PERT consume the generator directly and cannot be
stratified; the result says so in its warnings rather than implying uniform treatment.

---

## 7. The audit trail is hash-chained

**Decision:** every governed action appends a row whose SHA-256 hash covers its own content
_and_ the hash of the row before it. There is no update or delete path in the application.
The chain is salted per deployment.

**Why.** A plain log can be edited by anyone with database access and nobody would know. The
chain means any retrospective edit, deletion or reordering breaks verification from that
point forward, and `verifyAuditChain` reports which of the three occurred and at which
sequence number.

Audit rows are written inside the caller's transaction, so the audited change and its
evidence commit or roll back together. An action that succeeded without its audit row would
be worse than no audit at all.

**A bug this design surfaced.** `changes` was originally a JSONB column. Verification failed
immediately on a clean chain, because **Postgres does not preserve JSONB key order** — the
value read back does not re-serialise to the bytes that were hashed. Fixed by storing
canonical JSON _text_ (keys sorted at every level) and hashing the stored bytes verbatim.
Nothing queries inside the field, so the JSONB operators were no loss.

**Known limitation, stated plainly:** truncating the _tail_ of the chain is undetectable
from the chain alone — the remaining prefix is internally consistent. Detecting that
requires an external anchor, such as periodically publishing the head hash to a separate
system. Not implemented.

---

## 8. Separation of duties has no bypass

**Decision:** `assertSeparationOfDuties` refuses an approval by whoever prepared or
submitted the record. There is no administrator override.

**Why.** A control with an exemption is not a control. If an administrator can approve their
own submission, the audit trail cannot answer "was this properly approved?" without also
establishing who held admin at the time — and at that point the guarantee is gone. The cost
is that a single-person deployment cannot self-approve, which is the correct outcome.

Five checks run before any transition, in order: legal transition → role seniority →
separation of duties → delegated authority → not already locked. All of them, plus the
version snapshot and the audit entry, commit in one transaction.

---

## 9. Variance sign convention lives in one constant

**Decision:** `FAVOURABLE_WHEN_OVER` maps account type to direction, and
`varianceDirection()` is the only place the sign is decided.

**Why.** Spending less than budget is favourable; earning less than budget is not. Both are
"actual below budget". Getting this backwards is the classic variance-report bug, and it is
particularly insidious because the numbers look right — only the RAG colour is inverted, on
revenue lines, which nobody notices until a board meeting.

Commitments count as consumed. A budget holder with 100k remaining and 90k on purchase
orders does not have 100k available, and a report saying otherwise causes the overspend it
was meant to prevent.

A materiality floor suppresses flags on trivial absolute variances — a 40 budget overspent
by 30 is 75%, which would otherwise dominate a report about millions.

---

## 10. Same-origin frontend

**Decision:** the web app calls the API on a relative `/api/v1` path. Vite proxies it in
development; nginx proxies it in the container.

**Why.** Same-origin means no CORS preflights, no third-party-cookie complications, and — the
real benefit — the front end needs no environment-specific configuration at all. There is no
`VITE_API_URL` to get wrong per environment, and no build-time bake-in that makes an image
non-portable between environments.

---

## 11. Access tokens are short-lived; refresh tokens rotate

**Decision:** 15-minute access tokens; refresh tokens stored only as SHA-256 digests, single
use, rotated on every refresh. Presenting an already-used refresh token revokes every
session for that user.

**Why.** Reuse of a rotated token means either a replay or a stolen token; in both cases the
safe response is to drop all sessions rather than merely refuse the request.

The authenticated request path re-reads the user from the database on every call rather than
trusting the token's claims. That costs a query per request, but it means a deactivated
account or a revoked role takes effect immediately instead of at token expiry. For a system
where role gates financial approval, that is the right trade — a demoted approver should not
retain approval rights for another fourteen minutes.

---

## 12. Things deliberately not built

- **No OpenAPI/Swagger UI.** Hand-maintained JSON schemas alongside the Zod contracts would
  drift, and a generated document sparse enough to be automatic is not worth the dependency.
  The Zod contracts in `shared/src/contracts.ts` are the specification, and they are the
  same objects that validate at runtime.
- **No soft deletes.** The audit trail and version snapshots already provide history.
  Soft deletes would add a `WHERE deleted_at IS NULL` to every query and a class of bugs
  where one query forgets it.
- **No caching layer.** Nothing in the workload justifies one yet, and a cache in front of
  financial data is a correctness risk before it is a performance win.
- **No multi-currency translation.** Budgets carry a currency and the cycle carries a base
  currency, but there is no FX translation engine. Doing that properly needs rate tables,
  translation methods (current/temporal), and CTA handling — a substantial piece of work that
  should not be half-built.
