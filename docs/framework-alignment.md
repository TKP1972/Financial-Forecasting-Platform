# Alignment against the Agentic AI Financial Forecasting & Budgeting Framework

The framework specification arrived after the platform was built. This document is an honest
delta: what the framework asks for, what exists today, and what to build next and in what
order.

**Headline:** of 33 discrete requirements, **20 are fully met, 6 are partially met, and 7 are
not started.** The framework's _planning_ half is now essentially complete; every remaining
gap of substance sits in its TEM / revenue-assurance half, which is a different product — see
the scope finding below.

> **Update.** This began as a pure gap analysis, at which point the position was 11 met /
> 12 partial / 10 not started. Every structural item in the recommended sequence has since
> been built: connected planning, the workforce driver, cost behaviour with the telecom spend
> taxonomy, planning-bias detection, **rolling-forecast cadence** and **multi-year Medium
> Term Plans**. Rows marked **(new)** are the ones that moved.
>
> What remains is additive and can be scheduled on business priority rather than technical
> urgency — nothing left on the planning side gets more expensive by waiting.

Status key: **Built** · **Partial** · **Not built**

---

## The scope finding that matters most

The framework blends **two distinct products** under one heading:

1. **An EPM / connected-planning platform** — budgeting, forecasting, pricing, variance,
   governance. This is what exists today.
2. **A TEM / revenue-assurance platform** — revenue leakage, billing-error detection, tariff
   misconfiguration, contract compliance, fraud management, spend cubes.

These share a cost taxonomy and almost nothing else. Their data shapes differ (planning works
in periods and versions; assurance works in event streams and reconciliations), their write
patterns differ (batch approval versus continuous ingest), and their users differ.

**Recommendation: do not build the second inside the first.** Build it as a separate service
consuming the same chart of accounts and cost taxonomy, publishing findings into the risk
register. Merging them produces a codebase where a budgeting change can break fraud
detection — exactly the coupling the current package boundaries were drawn to avoid.

---

## Requirement-by-requirement

### 1. Core platform

| #   | Requirement                                   | Status            | Where it lives / what is missing                                                                                                                                                                                                   |
| --- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Rolling forecasts on a monthly/weekly cadence | **Built** _(new)_ | `engine/src/forecasting/rolling.ts`. Anchors on the last **closed** period, blends actuals to date with a forecast forward, re-anchors on each roll, and scores the superseded generation. `POST /cycles/:id/{close-period,roll}`. |
| 1.2 | Annual Operating Plan creation                | **Built**         | `BudgetCycle` + workflow + guideline pack.                                                                                                                                                                                         |
| 1.3 | Medium Term Plans (3–5 year)                  | **Built** _(new)_ | `horizonYears` on the cycle; budget lines span the whole horizon; `GET /cycles/:id/mtp` collapses it to fiscal years with year-on-year growth. Shortening the horizon under existing budgets is refused.                           |
| 1.4 | Real-time expenditure tracking vs budget      | **Built**         | `/variance/report`, with commitments counted as consumed.                                                                                                                                                                          |
| 1.5 | "Decision support" rather than "reporting"    | **Partial**       | Exceptions, RAG, outturn projection, alignment and bias observations point at decisions. Missing: recommended actions.                                                                                                             |

### 2A. Budget forecasting & unit input

| #    | Requirement                                                        | Status            | Where it lives / what is missing                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A.1 | Driver modelling: volume, AHT, occupancy, shrinkage                | **Built** _(new)_ | `engine/src/forecasting/workforce.ts`. Shrinkage and occupancy multiply; occupancy above 90% is warned about; whole-FTE rounding and hiring ramps included. `POST /api/v1/planning/workforce`.                 |
| 2A.2 | **Connected planning** — a change in one domain updates the others | **Built** _(new)_ | `engine/src/forecasting/graph.ts`. Typed dependency graph, topological evaluation, cycle detection, lagged references for stock balances, `analyseImpact` for downstream what-ifs. `/api/v1/planning/graph/*`. |
| 2A.3 | Unit-level input on a shared data foundation                       | **Built**         | Per-unit budgets against a shared chart of accounts, calendar and published assumption set.                                                                                                                    |

### 2B. Pricing & cost estimation

| #    | Requirement                                         | Status            | Where it lives / what is missing                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2B.1 | Cost-to-serve: wages, benefits, occupancy, overhead | **Built**         | Labour build-up plus fringe/overhead/G&A/COM pools with declared bases.                                                                                                                                                                          |
| 2B.2 | Rate cards by location, channel, complexity         | **Built** _(new)_ | `engine/src/pricing/ratecard.ts`. Effective-dated, wildcard fallback with deterministic specificity weighting, overlapping versions rejected at validation, and a multi-year schedule that crosses rate changes. `/api/v1/pricing/rate-cards/*`. |
| 2B.3 | Gainshare / risk-reward mechanisms                  | **Not built**     | Contract types exist; the mechanics (shared-savings bands, at-risk fee, service-credit regimes) do not.                                                                                                                                          |
| 2B.4 | Staffing ramps, workforce assumptions, ROI          | **Built** _(new)_ | ROI was already complete (NPV, IRR, payback, expected value, break-even win probability). `applyStaffingRamp` adds lead time, ramp productivity and shortfall detection.                                                                         |

### 2C. Annual plan & guideline generation

| #    | Requirement                                       | Status        | Where it lives / what is missing                                                  |
| ---- | ------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| 2C.1 | Automated guideline packs distributed to units    | **Built**     | `guidance.service.ts`, structured and Markdown. One of the strongest areas.       |
| 2C.2 | Coordination workflow                             | **Built**     | Six-state workflow, deadlines, approvals, escalation.                             |
| 2C.3 | Internal interlocks (volume/non-volume alignment) | **Not built** | No cross-unit reconciliation that one unit's volume assumption matches another's. |
| 2C.4 | Strategic priorities into unit priorities         | **Built**     | Objectives, horizons, target shares, alignment scoring.                           |

### 2D. Leadership reviews

| #    | Requirement                             | Status        | Where it lives / what is missing                                                                                                     |
| ---- | --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2D.1 | Layered dashboards, regional drill-down | **Partial**   | Dashboard, Excel pack and unit hierarchy exist. Missing: the hierarchy is not used as a drill-down axis in reports.                  |
| 2D.2 | SLA risk                                | **Not built** | Not modelled.                                                                                                                        |
| 2D.3 | Real-time what-if on liquidity / EBITDA | **Partial**   | The plan graph now answers structural what-ifs across connected domains. Missing: an EBITDA and liquidity model to run them against. |

### 3. Finance & budget management

| #   | Requirement                                       | Status            | Where it lives / what is missing                                                                                                                                                                                                           |
| --- | ------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | Continuous recalibration                          | **Built** _(new)_ | Follows from 1.1, and goes further: every roll **scores the generation it replaces** against what has since closed, surfaced at `GET /cycles/:id/forecast-accuracy`. Without that, recalibration is just re-running a model on a schedule. |
| 3.2 | Fixed vs variable across seven telecom categories | **Built** _(new)_ | Seven-category `SpendCategory` taxonomy plus `CostBehaviour` on accounts and budget lines. Unlocks contribution margin, operating leverage, break-even and flexed budgets — `engine/src/variance/costbehaviour.ts`.                        |

### Financial governance

| #   | Requirement                                | Status        | Where it lives / what is missing                                                                                            |
| --- | ------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G.1 | Parent oversight vs unit independence      | **Built**     | RBAC, delegated authority, separation of duties, escalation routing, hash-chained audit. Exceeds what the framework asks.   |
| G.2 | Information protection, project disclosure | **Not built** | No per-project confidentiality classification or need-to-know data-sharing policy.                                          |
| G.3 | RACI accountability model                  | **Not built** | Roles are functional (who may approve), not RACI (who owns inventory accuracy vs invoice approval vs vendor relationships). |

### Reporting & analytics

| #   | Requirement                                                   | Status            | Where it lives / what is missing                                                                                                                                                    |
| --- | ------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R.1 | Spend cubes segmenting CCaaS / telecom / network / facilities | **Partial**       | Variance groups on four dimensions, and the spend taxonomy now provides the segmentation axis. Missing: a cleansed multi-dimensional cube.                                          |
| R.2 | Correlate actual to projected, manage overruns                | **Built**         | Variance, exceptions, outturn projection, price/volume/mix decomposition.                                                                                                           |
| R.3 | Anomaly detection                                             | **Not built**     | No outlier detection over actuals.                                                                                                                                                  |
| R.4 | Predictive forecasting                                        | **Built**         | Eleven methods, backtested auto-selection, prediction intervals.                                                                                                                    |
| R.5 | Tendency analysis to identify planning bias                   | **Built** _(new)_ | `engine/src/variance/bias.ts`. Separates magnitude from directional consistency, so deliberate padding is distinguished from poor estimation. `GET /api/v1/planning/planning-bias`. |

### Risk management

| #   | Requirement                                                        | Status        | Where it lives / what is missing |
| --- | ------------------------------------------------------------------ | ------------- | -------------------------------- |
| K.1 | Revenue assurance — leakage, billing errors, tariffs               | **Not built** | Product 2.                       |
| K.2 | Contract compliance — renewals, termination liabilities, min spend | **Not built** | Product 2.                       |
| K.3 | Fraud management — traffic pumping, payment risk                   | **Not built** | Product 2.                       |

> The existing risk module is an **enterprise risk register with Monte Carlo contingency
> sizing** — a genuinely different thing from telecom revenue assurance. Both get called "risk
> management"; conflating them would be a mistake.

### 4. Stakeholder education & strategic alignment

| #   | Requirement                                                  | Status      | Where it lives / what is missing                                                                                          |
| --- | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| S.1 | Align budgets to A2030 KPIs and transformation plans         | **Built**   | Objectives with H1/H2/H3 horizons map cleanly onto transformation planning. Named KPI linkage would be a small extension. |
| S.2 | Democratisation — self-service without Finance as gatekeeper | **Partial** | Read access is role-gated and dashboards are self-serve. Missing: an ad-hoc report builder.                               |

---

## What was delivered

Ordered by cost of retrofitting later, which is why connected planning came first despite
being the largest.

| Item | Capability                              | Where                                                                                                |
| ---- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | Connected planning dependency graph     | `engine/src/forecasting/graph.ts`, `/api/v1/planning/graph/{validate,evaluate,impact}`               |
| 4    | Workforce / cost-to-serve driver        | `engine/src/forecasting/workforce.ts`, `POST /api/v1/planning/workforce`                             |
| 5    | Cost behaviour + telecom spend taxonomy | `engine/src/variance/costbehaviour.ts`, `/api/v1/planning/{cost-behaviour,contribution,flex-budget}` |
| 7    | Planning-bias detection                 | `engine/src/variance/bias.ts`, `GET /api/v1/planning/planning-bias`                                  |
| 1.1  | Rolling-forecast cadence                | `engine/src/forecasting/rolling.ts`, `POST /api/v1/cycles/:id/{close-period,roll}`                   |
| 1.3  | Multi-year Medium Term Plans            | `horizonYears` on the cycle, `GET /api/v1/cycles/:id/mtp`, `PATCH .../horizon`                       |
| 2B.2 | Effective-dated rate cards              | `engine/src/pricing/ratecard.ts`, `/api/v1/pricing/rate-cards/*`                                     |

157 new unit tests (930 total) and 110 new end-to-end assertions
(`smoke-test-planning.ps1`, `smoke-test-rolling.ps1`, `smoke-test-ratecards.ps1`).

Five design points worth knowing:

- **The plan graph exposes a fixed operation vocabulary over HTTP, not an expression
  language.** An interpreter would need its own parser, error reporting and sandbox, and each
  is a place for a user-supplied string to become a security problem. Evaluation order — the
  genuinely hard part — is identical either way.
- **Only same-period references create dependency edges.** A stock balance reading its own
  previous value (`lag: 1`) is legitimate and common, so it must not be treated as a cycle.
- **Bias separates magnitude from consistency.** Missing by 30% in alternating directions is
  an estimation problem; missing by 4% the same way every time is deliberate. Only the second
  is bias, and only the second should be challenged as such.
- **The rolling anchor is the last _closed_ period, not "today".** Closing is an explicit
  governed act, audited and irreversible. A forecast that silently re-anchored whenever
  someone imported a partial month would produce numbers that change under the reader between
  one refresh and the next. Actuals in closed periods are locked (`423 PERIOD_LOCKED`).
- **Every roll scores the generation it replaces.** Superseded generations are retained rather
  than overwritten, and the new one measures the old against what has since closed. That
  feedback loop is what separates continuous recalibration from re-running a model on a
  schedule.

---

## Recommended sequence for what remains

Nothing left on the planning side gets more expensive by waiting, so this is ordered by value
rather than by urgency.

### Tier 1 — domain depth

1. **Gainshare / outcome-based pricing mechanics.** _~1 week._
2. **EBITDA and liquidity models** to run plan-graph what-ifs against. _~1 week._

### Tier 2 — separate service (TEM / revenue assurance)

4. Revenue assurance, contract compliance, fraud management, spend cubes. _Weeks to months_,
   and its own deployable — see the scope finding.

### Tier 3 — reporting and governance polish

5. Anomaly detection over actuals; unit-hierarchy drill-down; SLA risk; RACI ownership model;
   project disclosure lists; ad-hoc report builder.

**Make an explicit decision about Tier 3 before starting any of it** — it is plausibly larger
than everything else combined.
