# Data dictionary

What the platform stores, what each value means, and where the truth lives.

Written for the two people who need it most: whoever reconciles these numbers against another
system, and whoever integrates with the API. Both need to know not just a field's type but its
**precision, its source of truth, and who may change it** — a reconciliation that fails by a
penny usually fails on one of those three.

This is not a schema dump. The schema is authoritative and machine-readable at
`packages/api/prisma/schema.prisma`; 29 entities are more than anyone needs to read at once. What
follows is the part you cannot get from reading it.

> Business meaning is in the [glossary](glossary.md). How values are derived is in the
> [calculation methodology](calculation-methodology.md).

---

## 1. Rules that apply to every value

### Numeric precision

Three shapes, and the distinction is deliberate.

| Kind          | Stored as       | Used for                                                    | Count      |
| ------------- | --------------- | ----------------------------------------------------------- | ---------- |
| **Money**     | `numeric(18,4)` | Every monetary amount                                       | 25 columns |
| **Rate**      | `numeric(18,8)` | Fractions: escalation, burden rates, growth, variable share | 12 columns |
| **Unit rate** | `numeric(18,6)` | Rate-card hourly rates                                      | 1 column   |

**Four decimal places on money, not two.** Intermediate results — a burdened cost, an allocated
share — need more precision than the presentation currency has, or rounding error accumulates
through a chain of calculations. Amounts are rounded to currency scale at presentation, not in
storage.

**Rates are fractions, never percentages.** `0.325` means 32.5%. A rate stored as `32.5` is wrong
by two orders of magnitude and the import validator rejects it with that message, because it is
the single most common data-entry error in this domain.

The `numeric(18,6)` outlier is `RateCardEntry.rate` — a labour rate per hour, which needs more
precision than a total but less than a compounding fraction.

### Money crosses the wire as a string

Every monetary value in an API response is a **decimal string**, never a JSON number.
`"1500000.0000"`, not `1500000`. JSON numbers are IEEE 754 doubles and cannot represent every
decimal exactly; a client that parses money with `JSON.parse` and does arithmetic on the result
has already lost.

Parse into a decimal type. If your language has none, keep it as a string and do the arithmetic
server-side.

### Currency

Every entity that carries an amount carries a currency code with it (ISO 4217, three letters).
**Amounts are never converted.** There is no FX translation in this platform — a consolidated
view across two currencies is not supported, and would be wrong if it appeared. See
[the localisation policy](localisation-policy.md).

A new record without an explicit currency takes the deployment's `BASE_CURRENCY`, except a budget,
which inherits its **cycle's** currency — a more specific rule, deliberately preserved.

### Identifiers

All primary keys are CUIDs — collision-resistant, sortable by creation time, and safe to expose in
a URL. They are opaque: do not parse them, and do not infer ordering from them beyond creation.

### Timestamps

UTC, ISO 8601, always. Fiscal periods are a separate concept and are not derived from timestamps
at read time — see below.

---

## 2. The join keys

Three keys carry the weight of every reconciliation. Getting one wrong is the usual cause of
"the numbers don't tie".

### Period key — `FY2026-P03`

**The join between budget and actual.** Budgets are stored per period, actuals arrive per period,
and variance is their difference at the same key.

The key encodes the **fiscal** year and period index, not the calendar. An organisation whose year
starts in April has `FY2026-P01` covering April — so a calendar-month join against `FY2026-P01`
would be wrong by three months. Period keys are generated from the configured fiscal calendar and
are **never constructed by hand** anywhere in the system.

### Account code

The line of the chart of accounts. Owned by the customer, loaded through reference-data import,
and expected to match the accounting system exactly. If it does not, nothing else reconciles.

### Business unit code

The organisational dimension, hierarchical via `parentId`. A unit's budget rolls up to its
ancestors; the hierarchy is validated on import and cycles are rejected.

---

## 3. Core entities

The ones you will actually touch. Each notes its **source of truth** — which system owns the
value — because that is the question a reconciliation turns on.

### BudgetCycle

The container for a planning round. Owns the fiscal year, the period type, deadlines, the base
currency, and `actualsThroughPeriod` — the boundary of what is closed.

**Source of truth: this platform.** Statuses are `PLANNING → OPEN → CONSOLIDATING → CLOSED`.

### Budget · BudgetLine · BudgetLinePeriod

A budget belongs to one cycle and one business unit. Lines carry an account, a method, and a
total; period rows carry the phased amount per period.

`Budget.totalAmount` is **derived** — the sum of every period of every line. Do not write to it
expecting it to stand alone; it is maintained by the platform and a discrepancy between it and the
lines is a defect, not a permitted state.

**Source of truth: this platform.** This is where budgets are authored.

### BudgetVersion

A complete frozen copy at each status transition — the whole budget, not a diff. This is what makes
"reproduce the budget exactly as approved" a lookup rather than a replay. Control `VER-01`.

### Approval

Who approved what, when, with what comment. Carries the distinct identities that
[SOD-01](control-matrix.md) depends on: preparer, submitter, approver.

### Actual

Money genuinely spent or earned, per account, per business unit, per period.

**Source of truth: your accounting system.** Actuals are _loaded_, not authored. The platform is a
consumer. Where the two disagree, the accounting system is right and the load is at fault.

Actuals for a closed period are refused with `PERIOD_LOCKED` — a restated prior period cannot
silently change a published variance. Post an adjustment to an open period.

### RateCard · RateCardEntry

Labour rates by category, with optional location, channel and complexity, each effective over a
date range. Overlapping ranges are rejected at write time, because a card that cannot be resolved
deterministically only defers the failure to whoever next prices against it.

### PricingModel

A cost build-up: labour, direct costs, burden pools, fee. Stores both its **input** and its
computed **result**, so a price quoted last quarter can be re-derived exactly even if the engine
has changed since. Versioned per pursuit.

### Risk · Simulation

The register, and Monte Carlo runs against it. A simulation stores its **seed and iteration
count** — without both, a published contingency figure cannot be reproduced, which is the whole
point of the control.

### AuditLog

The hash chain. Append-only by intent; nothing in the API updates or deletes an entry.

**`changes` is `TEXT`, not `JSONB`, and this must not be "improved".** PostgreSQL does not preserve
JSONB key order, so a value read back would not re-serialise to the bytes that were hashed and
**every verification would fail**. It stores canonical JSON with sorted keys, and the hash covers
those exact bytes. Nothing queries inside the field, so the JSONB operators are no loss.

### User

Identity, role, business unit, and `approvalLimit` — the per-user override for
[DOA-01](control-matrix.md). Deactivation is immediate: the user is re-read from the database on
every request rather than trusted from the token.

**Deactivate rather than delete.** Deletion breaks the attribution the audit trail depends on.

---

## 4. Enumerated values

Codes that appear in API payloads and must be matched exactly.

| Set                | Values                                                         |
| ------------------ | -------------------------------------------------------------- |
| **Budget status**  | `DRAFT` `IN_REVIEW` `SUBMITTED` `APPROVED` `REJECTED` `LOCKED` |
| **Cycle status**   | `PLANNING` `OPEN` `CONSOLIDATING` `CLOSED`                     |
| **Account type**   | `REVENUE` `COGS` `OPEX` `CAPEX` `HEADCOUNT` `OTHER`            |
| **Cost behaviour** | `FIXED` `VARIABLE` `SEMI_VARIABLE`                             |
| **Period type**    | `MONTH` `QUARTER` `HALF` `YEAR`                                |
| **Burden pool**    | `FRINGE` `OVERHEAD` `MATERIAL_HANDLING` `GA` `COM`             |

**Account type determines variance direction.** For `REVENUE`, actual above budget is favourable;
for cost types it is not. This is derived in one place from the account type — if a code is
mapped to the wrong type, every variance report reads backwards for that line.

---

## 5. Reconciling against another system

The order these usually fail in, and what to check.

1. **Period boundaries.** Is the other system on the calendar year while this one is on a fiscal
   year? This causes the largest and most confusing differences.
2. **Account mapping.** One code to one code, no silent aggregation.
3. **Commitments.** The platform reports commitments separately from actuals. A comparison that
   treats them as one will differ by exactly the committed-not-invoiced balance.
4. **Closed periods.** A restatement posted upstream after a period closed here will not appear.
   That is the control working, not a sync failure.
5. **Rounding.** Money is stored at four decimals and presented at two. Compare at storage
   precision, and expect banker's rounding on ties.
6. **Currency.** No conversion happens here. Two currencies in one comparison means the
   comparison is wrong, not the data.

---

## 6. What is not stored

- **No tax of any kind** — no VAT, GST, sales tax or withholding.
- **No exchange rates**, and therefore no translated amounts.
- **No general ledger.** This is a planning and analysis system consuming actuals, not a ledger.
- **No customer or supplier master data** beyond what a pursuit needs.
- **No document attachments.**
