# Financial Forecasting Platform

Support for the entire budgeting process — from forecasting the budget and preparing the
budget plan, through to reporting on expenditure against it.

The platform covers five things that are usually spread across a dozen uncontrolled
spreadsheets: **budget preparation and approval**, **forecasting**, **pursuit pricing**,
**risk and contingency**, and **variance reporting** — under a governance model that makes
every number defensible after the fact.

---

## Quick start

**Prerequisites:** Docker Desktop, Node.js 20.11+, and about 2 GB of free memory.

```bash
git clone <repo> && cd Financial-Forecasting-Platform
node scripts/init-env.mjs     # writes .env with generated secrets, prints the admin password
npm install
npm run stack:up              # builds and starts postgres + api + web
```

`init-env.mjs` exists because the API refuses to boot in production with any placeholder
credential still in place — four of them, not two. Copying `.env.example` by hand and changing
only the obvious two produces a stack that will not start.

Open **http://localhost:8080**.

`stack:up` applies migrations and loads a full worked example — an FY2026 telecom budget
cycle with four business units, two years of seasonal actuals, a priced pursuit and a risk
register — so every screen has something real on it immediately.

### Start Menu shortcuts (Windows)

For demonstrations, where the last thing you want is to be typing Docker commands with somebody
watching:

```bash
npm run start-menu:install     # adds two entries to your Start Menu
npm run start-menu:uninstall   # removes them
```

Then press the Windows key and type "Financial". **Financial Forecasting Platform** starts the
stack and opens a browser once the API reports itself ready — starting Docker Desktop first if it
is not running, and waiting rather than opening a page whose first request fails. **Stop Financial
Forecasting** stops it and keeps the data, so starting again resumes where you left off.

Per-user, so it needs no administrator and writes nothing outside your profile. The shortcuts
point at this directory by absolute path; if the repository moves, run the install again.

### Local development (without containers)

```bash
npm run infra:up              # just postgres
npm run db:migrate
npm run db:seed
npm run dev                   # api on :4000, web on :5173
```

### Seeded logins

| Role            | Email                       | Password          | Approval limit |
| --------------- | --------------------------- | ----------------- | -------------- |
| Administrator   | `admin@ffp.local`           | `Adm1n!Local2026` | unlimited      |
| CFO             | `cfo@ffp.local`             | `Cfo!Local2026x`  | unlimited      |
| Finance Manager | `finance.manager@ffp.local` | `FinMgr!Local26`  | 2,000,000      |
| Budget Owner    | `owner.mobile@ffp.local`    | `Owner!Local26x`  | 250,000        |
| Analyst         | `analyst@ffp.local`         | `Analyst!Local26` | —              |
| Viewer          | `viewer@ffp.local`          | `Viewer!Local26x` | —              |

> Local development credentials only. Never use them anywhere real.

---

## What it does

### Budget preparation and the guideline pack

A **budget cycle** fixes the fiscal calendar, the mandatory planning assumptions, the
top-down targets and the deadlines. From it the platform generates the **annual budget plan
and guideline document pack** for distribution to business units — as structured data for
the UI and as a self-contained Markdown document covering key dates, strategic priorities,
the assumption set, per-unit targets, the period calendar, submission instructions and the
approval route.

Budgets are then built bottom-up line by line, each recording the **method** used
(incremental, zero-based, driver-based, activity-based or rolling forecast) and a
justification — because the question reviewers ask most often is "where did this number
come from?"

### Forecasting

Eleven time-series methods, from naive benchmarks through Holt-Winters triple exponential
smoothing and OLS trend, plus driver-based build-ups (subscribers × ARPU, sites × maintenance
rate) and multiplicative scenario modelling.

`method: "AUTO"` runs **rolling-origin cross-validation** across every applicable method and
selects on out-of-sample MASE — not in-sample fit, which always flatters the most flexible
model. The full candidate table is returned with the forecast, so the choice is auditable
rather than a black box.

Every run reports MAE, RMSE, MAPE, sMAPE, MASE, bias and prediction intervals, and is
persisted with its inputs and outputs.

### Pricing and cost estimation

Multi-year cost volumes with labour build-up, escalation, direct costs and pass-throughs,
wrapped by **indirect cost pools applied in a fixed order against explicitly declared bases**
(fringe → overhead → material handling → G&A → cost of money). Applying a pool to the wrong
base is the most common error in a home-grown pricing model, and a 1% base error on a 30%
pool is a real margin error — so the base composition is declared, validated and returned as
an audit trail alongside the numbers.

Includes price-to-win goal seeking (solve the fee rate for a target margin or price),
sensitivity analysis, NPV/IRR/payback, and bid/no-bid expected value with the break-even
win probability.

### Rate cards

Labour rates by **location × channel × complexity**, effective-dated. A card carries a default
plus targeted overrides rather than enumerating every combination, and resolution falls back
from the specific to the general — reporting which rule matched and what it fell back on,
because "the card said so" is not a defensible answer on a priced bid.

Three things it gets right that hand-maintained spreadsheets do not:

- **Overlaps are rejected, not resolved.** Two entries with identical dimensions whose
  effective ranges intersect mean two valid rates on some date, and whichever the code picks
  is not a decision anyone made. Validation refuses the card.
- **Fallback is deterministic.** Dimensions are weighted in powers of two (location 4,
  channel 2, complexity 1), so no two wildcard patterns can tie and the winner never depends
  on row order.
- **A term crosses rate changes automatically.** `POST /pricing/rate-cards/:id/schedule`
  prices each contract year at the rate in force on its anniversary, so a five-year contract
  spanning an April increase picks up both rates without anyone remembering to.

`POST /pricing/rate-cards/:id/price-labour` returns labour lines ready to drop straight into
`/pricing/calculate` — the resulting `ratesByYear` overrides `baseRate` and escalation, since
the schedule already carries the card's movement and escalating again would double-count it.

### Risk and contingency

A 5×5 risk register with inherent and residual scoring, expected monetary value, heat map
and escalation list — plus **Monte Carlo simulation** over triangular, PERT, normal,
lognormal, uniform and discrete distributions, with Latin Hypercube stratification, P10–P95
confidence levels, contingency sizing at P80 and a rank-correlation tornado.

Every simulation is driven by an explicit **seed** and stores it, so a contingency figure
quoted to a board can be regenerated exactly, months later, by anyone who asks.

### Expenditure reporting

Budget vs actual vs commitment, with commitments counted as consumed (a budget holder with
100k left and 90k on purchase orders does not have 100k available). Full-year outturn
projection on three stated bases, price/volume/mix variance decomposition, RAG banding with
a materiality floor, and an Excel leadership pack.

### Rolling forecasts

A cycle carries a rolling horizon that stays a constant distance ahead rather than shrinking
to nothing by month eleven. Each roll produces **actuals to date plus a forecast forward**,
and the full-year outturn is the sum of both.

The anchor is the last **closed** period, not today's date. Closing a period is an explicit,
audited, irreversible act — a forecast that silently re-anchored whenever someone imported a
partial month would produce numbers that change under the reader between refreshes. Actuals in
closed periods are locked against restatement.

Crucially, **every roll scores the generation it replaces** against what has since closed.
Superseded generations are retained, and `GET /cycles/:id/forecast-accuracy` reports whether
the cadence is actually working. Without that, "continuous recalibration" is just re-running a
model on a schedule and never learning whether it is any good.

```
POST /api/v1/cycles/:id/close-period   { "throughPeriod": 6 }
POST /api/v1/cycles/:id/roll           { "method": "AUTO" }
GET  /api/v1/cycles/:id/rolling-forecast
GET  /api/v1/cycles/:id/forecast-accuracy
```

### Medium Term Plans

Set `horizonYears` above 1 and a cycle spans multiple fiscal years — budget lines carry an
amount for every period across the whole horizon, and `GET /cycles/:id/mtp` collapses it to a
year-by-year view with year-on-year growth, because nobody reviews sixty monthly numbers.

Shortening a horizon under existing budgets is refused: their later periods would be stranded.

### Connected planning

Drivers can declare what they read from each other, forming a dependency graph that is
evaluated in topological order. A change to churn propagates to subscribers, then revenue,
then the headcount needed to serve them — in one call, rather than someone remembering which
four other numbers to revise. Circular dependencies are rejected at validation time with the
offending nodes named; a stock balance reading its own previous period (`lag: 1`) is not a
cycle and is explicitly supported.

`POST /api/v1/planning/graph/impact` perturbs one input and reports every downstream node
that moves.

### Workforce and cost-to-serve

The operational-to-financial bridge: contact volume, average handle time, occupancy and
shrinkage in; FTE, cost and cost-per-contact out.

```
productive hours per FTE = hours × (1 − shrinkage) × occupancy
FTE required             = workload hours / productive hours per FTE
```

Shrinkage and occupancy **multiply** — applying either alone understates the requirement —
and occupancy above 90% is warned about because it is not sustainable against variable
arrival. Hiring lead time and ramp productivity are modelled, so a pursuit does not assume
people are productive on day one.

### Cost behaviour

Every account and budget line carries a **telecom spend category** (access, transport,
equipment, SaaS, facilities, labour, other) and a **cost behaviour** (fixed, variable,
semi-variable with a declared variable share).

That unlocks contribution margin, operating leverage, break-even, margin of safety, and a
**flexed budget** — comparing actuals against a budget set for a different volume mixes two
effects and blames the wrong people. An overspend caused by doing 20% more work is not the
same failure as doing the same work 20% less efficiently.

### Planning bias

A single variance is noise; the same holder missing in the same direction for six cycles is a
pattern. The platform separates **magnitude** from **directional consistency**: missing by 30%
in alternating directions is an estimation problem, while missing by 4% the same way every
time is deliberate. Only the second is reported as bias, with the cumulative money it ties up.

### Strategic alignment

Budget lines link to strategic objectives with an alignment strength. The platform reports
the money-weighted alignment score, funding by objective against its declared target share,
the core/adjacent/transformational balance, and the unallocated spend — three views that are
hard to make agree unless the budget genuinely is aligned.

---

## Governance

Five controls, all enforced server-side and all covered by tests:

| Control                        | What it does                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Separation of duties**       | Nobody approves a budget they prepared or submitted. Deliberately has **no role-based bypass** — not even an administrator.                                               |
| **Delegated authority**        | Approvals above a role's limit are refused and routed to the next level. Overridable per user.                                                                            |
| **Tamper-evident audit trail** | Every governed action is hash-chained to its predecessor. Any edit, deletion or reordering breaks the chain and is detectable, with the failing sequence number reported. |
| **Version snapshots**          | Every status transition freezes the complete budget, so an approved budget can be reproduced exactly as approved.                                                         |
| **Locked baseline**            | `LOCKED` is terminal. The approved baseline that variance reporting measures against cannot be quietly amended.                                                           |

Verify the audit chain at any time:

```bash
pwsh ./scripts/verify-audit-tamper-detection.ps1
```

That script does not merely check that an untouched chain passes — it edits a row directly
in the database, confirms the tampering is caught and correctly located, deletes a row,
confirms the gap is caught, and restores both.

**Known limitation:** truncating the _tail_ of the chain is not detectable from the chain
alone. Detecting that requires an external anchor — periodically publishing the head hash to
a separate system. That is not implemented, and is noted here rather than glossed over.

---

## Architecture

```
packages/
├── shared/    Money primitives, domain vocabulary, RBAC matrix, fiscal calendar, Zod contracts
├── engine/    Pure financial math — forecasting, pricing, risk, variance, alignment
├── api/       Fastify + Prisma + PostgreSQL
└── web/       React 19 + Vite + TanStack Query + Recharts
```

`engine` is dependency-light and completely free of I/O, which is why it can carry the test
coverage it does. See [docs/architecture.md](docs/architecture.md) for the reasoning behind
the significant decisions, and [docs/runbook.md](docs/runbook.md) for operating it.

[docs/framework-alignment.md](docs/framework-alignment.md) maps this platform against the
Agentic AI Financial Forecasting & Budgeting Framework, with an honest built / partial /
not-started assessment and a recommended build sequence.

[docs/tem-design-note.md](docs/tem-design-note.md) is a proposal — not built — for the
cost-side Telecom Expense Management capability: spend cubes, contract compliance and invoice
validation, with a phased estimate and the open questions that would change it.

### Two rules that shape everything

**Money is never a float.** `0.1 + 0.2 !== 0.3` in IEEE-754, and budget rollups sum
thousands of lines — the drift is real and it surfaces in variance reports as unexplained
pennies. All monetary arithmetic uses `Decimal` with banker's rounding, money crosses the
wire as decimal _strings_, and allocation helpers distribute rounding remainders so a split
always sums back exactly to the original.

Statistical code (smoothing, Monte Carlo) deliberately uses `number`: forecast uncertainty
is many orders of magnitude larger than float64 error, and Decimal arithmetic over 10,000
iterations would be unusably slow. The boundary is explicit, and values convert back to
`Decimal` before they reach a ledger.

**The fiscal calendar is generated in one place.** Organisations rarely run on the Gregorian
year. Every period label, quarter boundary and year-to-date cut derives from
`packages/shared/src/fiscal.ts`, so "Q1" means the same thing in a forecast, a variance
report and a leadership pack — and budget and actuals join on the same period key.

---

## Testing

```bash
npm test                  # 1059 unit tests
npm run test:coverage     # gated at 90% lines / 85% branches on the engine
npm run verify            # format + lint + typecheck + test
pwsh ./scripts/smoke-test.ps1                        # 80 end-to-end API assertions
pwsh ./scripts/verify-audit-tamper-detection.ps1     # 8 tamper-detection assertions
```

Current: **1059 unit tests**, 97.52% statement and 93.83% branch coverage across the engine
and shared packages, plus 223 end-to-end assertions across six suites against a running stack.

The unit tests assert independently hand-computed expected values rather than re-running the
implementation to produce them — a tautological test on financial math is worth nothing.
Several genuine bugs were caught this way, including a burden-pool validator that wrongly
rejected any model without a material-handling pool.

---

## Commands

| Command                                        | Purpose                             |
| ---------------------------------------------- | ----------------------------------- |
| `npm run dev`                                  | API and web dev servers             |
| `npm run build`                                | Build every package                 |
| `npm run verify`                               | Format check, lint, typecheck, test |
| `npm run stack:up` / `stack:down`              | Full container stack                |
| `npm run stack:logs`                           | Tail container logs                 |
| `npm run stack:nuke`                           | Stop and delete the database volume |
| `npm run db:migrate` / `db:seed` / `db:studio` | Database operations                 |

---

## Configuration

All configuration is environment-based and validated at boot — a missing or weak secret
fails the process immediately rather than surfacing later as a subtle auth bug. See
`.env.example` for the full set.

**Four values have no safe default** and are rejected in production while they still hold the
value shipped in `.env.example`:

- `JWT_SECRET` — signs access tokens (32+ chars)
- `AUDIT_HASH_SALT` — binds the audit chain to this deployment. **Rotating it invalidates
  verification of all historical entries.**
- `POSTGRES_PASSWORD` — the example value is a known string
- `SEED_ADMIN_PASSWORD` — the seeded administrator can approve budgets, so a known password
  here is a known credential on a privileged account

`node scripts/init-env.mjs` generates all four. To do it by hand:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The stack refuses to start in production with any of them still at the example value. This is
deliberate and is checked by `packages/api/src/config.test.ts`, which reads `.env.example` and
fails if a credential there is not one the guard recognises.

> **Note:** the database is published on host port **55432**, not 5432, so it does not
> collide with a PostgreSQL already installed on the machine. Inside the compose network the
> API still connects to `postgres:5432`.
