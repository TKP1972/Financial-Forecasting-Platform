# Design note: cost-side Telecom Expense Management

**Status:** proposal, not built. Written to be argued with before any code exists.

**Scope:** the cost-side half of the framework's assurance requirement — spend analytics,
contract compliance and invoice validation. The revenue-side half (revenue assurance, fraud
management) is explicitly **out of scope** and is a different product; see
[framework-alignment.md](framework-alignment.md) for why.

---

## 1. The organising idea

Cost-side TEM is a **three-way reconciliation**. Everything else follows from it.

```
        INVENTORY                CONTRACT                 INVOICE
   what we believe we have   what we agreed to pay   what we were billed
            │                         │                       │
            └──────── ghost ──────────┴──── rate variance ─────┘
                     services              duplicate charges
                                          uncontracted spend
```

**Every finding is a disagreement between two of those three.** A circuit on an invoice with
no inventory record is a ghost service. A billed rate that differs from the contracted rate is
a rate variance. A service in inventory that nobody is billing for is either stale inventory
or a missing invoice.

That framing matters because it tells you what the product actually is: not a reporting tool,
but a **difference engine with money attached to each difference**. Design the model around
the three sources and the findings fall out; design it around "invoice analytics" and you end
up with dashboards nobody acts on.

### The uncomfortable truth about inventory

Of the three sources, **inventory is almost always the weakest**, and it is usually nobody's
job. The framework's own RACI line says _"IT owns inventory accuracy"_ — which is the correct
answer and also the one most organisations have not actually implemented.

This is the single largest risk to the whole programme, and section 7 proposes a way to start
without it rather than pretending otherwise.

---

## 2. Data model

New entities. Names are indicative; the shape is the proposal.

### Vendor and contract

```
Vendor            id, code, name, isActive
Contract          id, vendorId, reference, description,
                  startDate, endDate,
                  autoRenews, noticePeriodDays, renewalTermMonths,
                  minimumSpendCommitment, commitmentPeriod,
                  earlyTerminationBasis, earlyTerminationAmount,
                  currency, status, documentUri
ContractRate      id, contractId, serviceType, location?, speed?,
                  rate, unit, effectiveFrom, effectiveTo?
```

`ContractRate` is deliberately the **same shape as the existing `RateCardEntry`** —
effective-dated, wildcard dimensions, rejected on overlap. That is not a coincidence worth
resisting: `engine/src/pricing/ratecard.ts` already implements dimension resolution with
deterministic specificity weighting and overlap validation, and it is fully tested. Reuse it
rather than writing a second, subtly different resolver.

### Inventory

```
Service           id, identifier (circuit ID / line number / licence key),
                  serviceType, vendorId, contractId?,
                  businessUnitId, accountId, siteId?,
                  location, speed?, quantity,
                  contractedRate?, currency,
                  status (ACTIVE | CEASING | CEASED | DISPUTED),
                  activatedAt, ceasedAt?,
                  source (CMDB | VENDOR_FEED | BOOTSTRAPPED | MANUAL),
                  confidence (CONFIRMED | INFERRED)
```

`source` and `confidence` exist because inventory will be partly inferred (section 7). A
finding raised against an inferred record must be presented differently from one raised
against a confirmed record, or the first wave of false positives destroys trust in the tool.

### Invoices

```
Invoice           id, vendorId, invoiceNumber, invoiceDate,
                  periodStart, periodEnd, periodKey,
                  currency, subtotal, tax, total,
                  status (RECEIVED | VALIDATED | DISPUTED | APPROVED | PAID),
                  rawPayload, ingestedAt, sourceSystem
InvoiceLine       id, invoiceId, lineNumber,
                  description, serviceIdentifier?, serviceId?,
                  quantity, unitRate, amount,
                  periodStart, periodEnd,
                  accountId?, spendCategory?, costBehaviour?
```

`periodKey` uses the **existing fiscal calendar** (`FY2026-P03`), which is what lets invoice
spend join to budget and actuals without a date-range reconciliation. `rawPayload` is retained
immutably for the same reason the audit trail is hash-chained: a finding you cannot trace back
to the document that produced it is an assertion, not evidence.

### Findings — the output

```
AssuranceFinding  id, type, severity,
                  vendorId?, contractId?, serviceId?, invoiceId?, invoiceLineId?,
                  businessUnitId?, accountId?, periodKey?,
                  expectedValue, actualValue, valueAtRisk,
                  confidence, explanation,
                  status (OPEN | INVESTIGATING | CONFIRMED | RECOVERED |
                          REJECTED | ACCEPTED),
                  assigneeId?, resolutionNote?, recoveredAmount?,
                  detectedAt, resolvedAt?, riskId?
```

**`valueAtRisk` is mandatory on every finding.** A finding without money attached cannot be
prioritised, cannot be reported to a CFO, and cannot prove the tool paid for itself. If a
detector cannot quantify its finding, it is not ready to ship.

---

## 3. Finding taxonomy

The detectors, and what each is worth. This list is the product.

| Type                      | Detects                                                                                                            | Typically worth                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `BILLED_NOT_IN_INVENTORY` | Invoiced for a service with no inventory record — the classic ghost circuit billed for years after decommissioning | High; often the single largest recovery                                                 |
| `CEASED_STILL_BILLING`    | Service ceased on a date, invoices continue after it                                                               | High, and unambiguous                                                                   |
| `DUPLICATE_CHARGE`        | Same service, same period, billed twice                                                                            | Medium, easy win, near-zero false positives                                             |
| `RATE_VARIANCE`           | Billed rate differs from the contracted rate in force                                                              | High; compounds silently every month                                                    |
| `QUANTITY_VARIANCE`       | Billed quantity differs from inventory quantity                                                                    | Medium                                                                                  |
| `IN_INVENTORY_NOT_BILLED` | We think we have it; nobody bills for it                                                                           | Usually stale inventory, occasionally a missing invoice — either way it needs resolving |
| `UNCONTRACTED_SPEND`      | Vendor invoicing with no contract on file (maverick spend)                                                         | Medium; mostly a governance finding                                                     |
| `MINIMUM_SPEND_SHORTFALL` | Tracking below a commitment with the period closing                                                                | High, and **predictive** rather than retrospective                                      |
| `AUTO_RENEWAL_WINDOW`     | Notice period closing on a contract that may not be wanted                                                         | Very high per event; pure avoidable cost                                                |
| `TERMINATION_LIABILITY`   | Cost of exiting now — needed before any decommissioning decision                                                   | Enabling; makes other findings actionable                                               |

The last three need **only contract metadata**. No invoice feed, no inventory. That is the
basis of the phasing in section 6.

### On false positives

A detector that is right 70% of the time will be switched off within a quarter, because the
30% burns the credibility of the whole tool. Two design responses:

- **Ship detectors behind a confidence threshold** and start conservative. Under-reporting on
  day one is recoverable; over-reporting is not.
- **Never auto-close a finding.** A human confirms or rejects, and the rejection reason feeds
  back into tuning. `REJECTED` is a first-class outcome, not a failure.

---

## 4. Ingest

### Invoices

Three realistic paths, in order of preference:

1. **Structured feed from the ERP/AP system.** Best case. Already-coded, already-approved
   invoice lines. Design for this as primary.
2. **Vendor electronic invoice** (EDI, or the vendor's own portal export). Richer per-line
   detail than AP, which usually summarises. Worth having _in addition_ to (1), because
   AP-level data often lacks the per-circuit granularity that makes validation possible.
3. **PDF extraction.** Last resort. Assume it is wrong until confirmed, route through a human
   confirmation step, and never raise a finding from unconfirmed extracted data.

### Pipeline

```
raw payload  →  staging  →  normalise  →  match to inventory  →  detect  →  findings
   (kept)                   (map to CoA,      (identifier,        (rules)
                             spend category,   fuzzy, then
                             period key)       manual)
```

**Batch, not streaming.** Invoices arrive monthly. Real-time infrastructure here would be
engineering for a cadence that does not exist — the opposite of the fraud case, where hours
matter. Run on invoice receipt and on a monthly close schedule.

**Idempotent on `(vendorId, invoiceNumber)`.** Vendors resend invoices, and a duplicate ingest
that creates duplicate findings is its own credibility problem.

---

## 5. Integration with this platform

### What gets reused, not rebuilt

| Existing                                 | Used for                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `Account` (chart of accounts)            | Invoice lines code to accounts; findings roll up the same tree as budgets |
| `SpendCategory` (7 telecom categories)   | Already built — the spend cube's primary axis                             |
| `CostBehaviour` + `variableShare`        | Fixed/variable split of vendor spend; flexed-budget comparison            |
| `BusinessUnit` hierarchy                 | Findings roll up to the units that own the spend                          |
| Fiscal calendar / `periodKey`            | Joins invoice spend to budget and actuals with no date-range logic        |
| `Risk` register                          | Material findings publish in as risks with an owner and a review date     |
| Audit chain (`appendAuditEntry`)         | Every write-off, dispute and acceptance is a governed action              |
| RBAC matrix                              | New permissions slot into the existing roles                              |
| Money primitives (`Decimal`, allocation) | Every amount, without exception                                           |

### New permissions

Following the existing `resource:action` convention:

```
assurance:read          VIEWER and up      see findings
assurance:investigate   ANALYST and up     assign, comment, mark investigating
assurance:resolve       FINANCE_MANAGER    confirm, reject, record recovery
assurance:accept        FINANCE_MANAGER    formally accept a finding (no recovery)
contract:read           VIEWER and up
contract:write          ANALYST and up
inventory:write         ANALYST and up     curate the service register
```

`assurance:resolve` sits at Finance Manager because closing a finding is a decision with a
money consequence — the same reasoning that put `risk:accept` there.

### Where it lives

**Recommendation: a new `packages/assurance` in this monorepo, deployable separately if
volume ever demands it.**

This is a deliberate change from my earlier advice, and worth being explicit about. When the
scope included revenue-side RA and fraud, I recommended a wholly separate service — those
carry a genuinely different data shape (event streams, near-real-time, billions of records)
and coupling them to a periodic planning system would have been wrong.

**Cost-side TEM does not justify that split.** It is periodic, it is modest in volume, it
joins directly to the chart of accounts, and its output belongs in the risk register. A
separate repository would force duplicating the shared contracts, the money primitives and
the fiscal calendar — and duplicated money handling is exactly the failure this codebase is
built to avoid. A package boundary gives the isolation; a repository boundary would only give
drift.

If revenue-side is ever picked up, that decision reverts: it should be its own service.

---

## 6. Phasing and estimate

Ordered so each phase ships something usable and de-risks the next.

### Phase 1 — Contract compliance · 3–5 weeks

Contract register, effective-dated contract rates, and the three date-driven detectors:
auto-renewal windows, termination liability, minimum-spend shortfall.

**Needs only contract metadata.** No invoice feed, no inventory. Ships independently, proves
the seam into the risk register and audit chain, and a single caught auto-renewal usually
exceeds the build cost.

### Phase 2 — Spend cube · 2–4 weeks

Invoice ingest, coding to the chart of accounts, and multi-dimensional spend analytics across
vendor / spend category / business unit / period, plus `UNCONTRACTED_SPEND`.

Reuses the taxonomy and cost-behaviour work already built. Delivers analytical value before
any matching logic exists.

### Phase 3 — Invoice validation · 6–10 weeks

Service inventory, invoice-to-inventory matching, and the reconciliation detectors — ghost
services, rate variance, duplicates, ceased-still-billing.

**This is where the recoveries are, and where the risk is.** The estimate assumes an inventory
source exists (see below).

**Total: 11–19 weeks**, phased, with value delivered from week 5.

### What moves the estimate

| Condition                                      | Impact                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No inventory source of truth                   | **+4–6 weeks** — bootstrap and curation (section 7)                                       |
| PDF-only invoices                              | +3–5 weeks — extraction plus a confirmation workflow                                      |
| More than ~100k invoice lines per month        | +2–3 weeks — columnar storage or partitioning                                             |
| Multi-currency vendors                         | +1–2 weeks — and it forces the FX decision this platform has so far deliberately deferred |
| Each additional source system beyond the first | +1 week per connector                                                                     |

The multi-currency point deserves emphasis: [architecture.md](architecture.md) records that FX
translation was deliberately _not_ built, because doing it properly needs rate tables,
translation methods and CTA handling. Multi-currency vendor invoices would force that decision
rather than allowing it to stay deferred.

---

## 7. Starting without an inventory source

If there is no CMDB or service register — the common case — do **not** stop, and do **not**
build a CMDB first. Bootstrap instead:

1. **Derive a candidate inventory from 3–6 months of invoices.** Every distinct service
   identifier a vendor has billed becomes a `Service` with `source = BOOTSTRAPPED`,
   `confidence = INFERRED`.
2. **Request the vendor's own service list.** Slightly absurd — asking the counterparty what
   they think they are selling you — but it is authoritative about what _will be billed_, and
   any divergence from the bootstrapped set is itself a finding.
3. **Curate by exception.** Business units confirm or reject the inferred records for their
   own cost centres. Confirmation flips `confidence` to `CONFIRMED`.
4. **Only then enable ghost-service detection**, and only against confirmed records.

This inverts the usual failure: instead of a twelve-month inventory project that delivers
nothing until it finishes, the inventory is a _by-product_ of running the tool, and it
improves every month. It also means `IN_INVENTORY_NOT_BILLED` starts almost empty and grows —
which is the correct behaviour, not a gap.

---

## 8. Success measures

Instrument from day one, or the programme cannot defend its own budget:

- **Recovered amount** — credits actually received, not findings raised. The only number that
  survives contact with a CFO.
- **Avoided cost** — auto-renewals cancelled inside the notice window, shortfalls averted.
- **Finding precision** — confirmed ÷ (confirmed + rejected), per detector. Falling precision
  on a detector is the early warning that it needs tuning or retiring.
- **Time to resolution** — findings ageing in `OPEN` mean nobody owns them.
- **Inventory confidence** — share of services `CONFIRMED` rather than `INFERRED`. The
  leading indicator for everything in Phase 3.

---

## 9. Risks

| Risk                                      | Why it matters                                            | Response                                                                                   |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Inventory accuracy is nobody's job        | Phase 3 depends on it entirely                            | Bootstrap approach (section 7); make confirmation a named responsibility per business unit |
| Findings without an owner                 | The tool becomes noise and gets switched off              | Do not build past Phase 1 until an exceptions owner is named                               |
| False positives early                     | Destroys trust faster than true positives build it        | Conservative thresholds; confidence on every finding; `REJECTED` feeds tuning              |
| Vendor data quality varies wildly         | Detectors that work for one vendor fail for another       | Per-vendor onboarding with a validation period before findings go live                     |
| Recoveries need commercial follow-through | Detection is not recovery; someone must dispute and chase | Confirm procurement will act before building the detectors                                 |

---

## 10. Open questions

Blocking Phase 3, not Phase 1. Phase 1 can start on the answer to (5) alone.

1. **Is there a service inventory source of truth?** If not, section 7 applies and the
   estimate carries the +4–6 weeks.
2. **What form do invoices arrive in** — ERP feed, EDI, vendor portal, or PDF?
3. **Are contract terms structured anywhere**, or are they PDFs? How many active contracts?
4. **Roughly how many invoice lines per month**, across how many vendors?
5. **Who works the exceptions?** A named team or person. _This one gates everything._
6. **Is there an incumbent TEM vendor** to integrate with or replace?
7. **Multi-currency?** If yes, the FX decision comes forward.

---

## 11. Recommendation

**Build Phase 1 first, and treat it as the decision point.**

It needs one answer (question 5) rather than seven, it ships in 3–5 weeks, it depends on no
data feed anyone has to build, and it exercises every integration seam — risk register, audit
chain, RBAC, fiscal calendar — at low cost. If the auto-renewal and minimum-spend detectors
find nothing in the first quarter, that is a genuine and cheap signal that this organisation's
contract hygiene is already good and Phases 2–3 should be reconsidered on their own merits.

If they find what they usually find, Phase 1 will have paid for Phases 2 and 3 before either
starts.
