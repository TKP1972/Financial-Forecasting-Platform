# Localisation policy

How this platform stays usable outside its first market **without acquiring a body of
jurisdictional rules to maintain**. Read before adding anything that varies by country,
industry or accounting convention.

The short version: the platform's portability comes from what it has declined to encode. Zero
tax handling, zero regulatory citations, no statutory reporting formats. That is an asset, and
it was preserved partly by accident. This document is the attempt to hold it on purpose.

---

## The test

> **If a government can change it without asking you, it must not be in your code.**
> **If the customer's finance function chooses it, it is configuration.**

Apply it before writing the feature, not after. It sorts almost everything.

| Category            | Examples here                                                                                             | Lives in      | Maintained by               |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- |
| **Invariants**      | `allocateEvenly` summing exactly, banker's rounding, variance direction, hash chain, separation of duties | Code          | Us — and it does not change |
| **Conventions**     | Fiscal year start, base currency, locale, approval limits, chart of accounts                              | Configuration | The customer                |
| **Regulated rules** | Tax rates, e-invoicing mandates, IFRS 16 vs ASC 842, statutory filing formats                             | **Nowhere**   | Someone else, or nobody     |

The third row is the cost trap. The discipline is not "build it flexibly" — it is **refuse to
own it**. Tax goes to a specialist provider or arrives as an input. A statutory chart of
accounts arrives through the existing CSV import. Currency and number formatting go to `Intl`
and CLDR, which Unicode maintains at no cost to us.

### Explicitly not doing

- **No rules engine or DSL.** It becomes a second product with no owner, no tests and no domain
  expert.
- **No jurisdiction enum that branches logic.** That is how a codebase acquires forty
  conditionals nobody dares delete.
- **No IFRS/GAAP mode flag.** The differences are accounting policy, not a switch, and policy is
  the customer's to state.

---

## The discriminator that actually matters here

For the pricing module, country predicts almost nothing. This does:

> **Does this customer price from cost, or from the market?**

`packages/engine/src/pricing` assumes **cost-plus contracting**: ordered burden absorption
(fringe → overhead → material handling → G&A) with fee applied to a burdened base. That build-up
exists to justify a price _from_ cost. A retailer prices from the market and works backwards to
margin; they would never construct the stack at all.

So the module suits contractors, professional services and any cost-reimbursable arrangement —
**in any jurisdiction** — and suits a market-priced business poorly in all of them. The
constraint is commercial, not legal. It is answerable in one sentence at qualification, and it
predicts which module fits rather than which enum needs editing.

### The one genuinely jurisdictional element

`COM` (cost of money) in `STANDARD_BURDEN_BASES` applies a cost-of-money burden over direct
labour, fringe and overhead. That is the Facilities Capital Cost of Money pattern from US federal
cost accounting. Commercial cost accounting records interest below the line and does not absorb
it into a cost base.

The other four pools — fringe, overhead, material handling, G&A — are ordinary absorption
costing, taught worldwide. **A commercial user should omit the COM pool entirely**, not re-rate
it to zero; a zero-rate line still appears on the build-up and their accountants would not
recognise it.

---

## Current state

### Settled

- **Base currency** is one setting, `BASE_CURRENCY`, applied by the API to every record that
  does not state one. It was previously nine independent `'USD'` literals across the Prisma
  schema, the Zod contracts, the pricing engine and the money formatter — the same accident
  repeated, not one decision. A budget with no currency inherits its **cycle's** currency rather
  than the global default, which is the more correct rule and is deliberately left in place.
- **No tax handling of any kind.** Keep it that way.
- **Fiscal calendar is parameterised** — `FiscalConfig` supports any `startMonth` and both
  `labelBy` conventions, covering UK/India (April), Australia/NZ (July), Japan (April) and US
  federal (October).

### Known gaps, not yet decided

- **`FiscalConfig` is never supplied.** Nothing outside `fiscal.ts` passes it, so every call
  takes the January default. The capability exists; the wiring does not. Cheapest high-value
  regionalisation available.
- **No 4-4-5 or 13-period calendar.** `PERIODS_PER_YEAR` is fixed at
  `{ MONTH: 12, QUARTER: 4, HALF: 2, YEAR: 1 }`. Common in telecom and retail. This one is
  **storage-shaped**: period keys (`FY2026-P03`) are the join key between budgets and actuals, so
  it gets more expensive with every cycle recorded. Industry convention rather than jurisdiction.
- **FX translation deliberately not built.** Amounts are stored in the currency they were entered
  in and never translated. Doing it properly needs rate tables and translation methods per account
  class. When it arrives: build translation, **do not** build CTA or hedge accounting — that is
  row three of the table above.
- **`SPEND_CATEGORIES` is a telecom taxonomy** (`ACCESS`, `TRANSPORT`, `EQUIPMENT`…). A vertical
  assumption rather than a regional one, but the same class of problem. Accounts already come from
  customer CSV import, which is the pattern to follow if this needs to open up.
- **Presentation locale** defaults to `en-US` in `formatMoney` and the web formatter. Distinct
  from currency — a euro amount shown to a German reader is the same money formatted differently.

---

## A note on measuring this

Searching for regulation names (`FAR`, `DCAA`, `GAAP`) tests whether code **cites** a regulation.
It cannot test whether a design **derives** from one, because nobody annotates an enum with its
regulatory lineage. COM is exactly the case that passes such a search and is still jurisdictional.

Two rules earned the hard way while auditing this:

1. **Match on word boundaries.** A case-insensitive substring search for `VAT` returns 151 hits
   here — `obserVATions`, `priVATe`, `minimumObserVATions`. With `\b` it returns zero, which is
   the true answer.
2. **An implausible count is a measurement bug until proven otherwise.** 151 tax references in a
   codebase with no tax handling is not a finding; it is a broken instrument.
