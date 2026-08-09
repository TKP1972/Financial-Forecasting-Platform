# Glossary

Two vocabularies meet in this platform and they are easy to confuse.

- **Finance terms** are standard management-accounting language. If you work in finance you know
  these; if you are an engineer, these are the ones to read.
- **Platform terms** mean something specific _here_. Some are ordinary words used precisely — if
  you work in finance, these are the ones to read, because your intuition may not match the
  system's definition.

Each entry says which it is.

---

## A

**Actual** · _finance_
Money genuinely spent or earned, as recorded by the accounting system. The counterpart to a
budget. Variance is the difference between them. Actuals are loaded into the platform rather than
entered — the accounting system remains the source of truth.

**Allocation** · _platform_
Splitting an amount across periods, units or lines. The platform never divides money with plain
arithmetic, because dividing 100 by 3 three times gives 99.99. It distributes the remainder so
the parts always sum back to the original exactly. If you check the arithmetic by hand, expect
the last part to differ by a penny — that is correct, not a rounding error.

**Approval limit** · _platform_
See **Delegated authority**.

**ARPU** · _finance_
Average revenue per user. A common driver in subscription businesses: revenue = subscribers ×
ARPU.

**Assumption** · _platform_
A stated basis for a budget — a tariff increase, a headcount freeze, an exchange rate. Published
in the **guideline pack** so every unit builds on the same footing. A submission built on
different assumptions is likely to be returned.

---

## B

**Baseline** · _finance_
The approved and locked budget that variance is measured against. Once locked it does not change,
which is what makes reports issued against it remain valid.

**Burden pool** · _finance_
An indirect cost recovered by applying a rate to a base of direct costs. Fringe (on labour),
overhead, material handling, G&A. They apply in order, each potentially drawing on the ones
before. Standard absorption costing, used worldwide.

> **COM** (cost of money) is the exception. It follows a US federal government cost-accounting
> pattern; commercial cost accounting records interest below the line instead. Commercial users
> should omit the pool rather than set it to zero. See
> [the localisation policy](localisation-policy.md).

**Budget cycle** · _platform_
The container for a planning round: a fiscal year, a period structure, deadlines, assumptions,
targets and the budgets belonging to it. Almost everything in the platform hangs off a cycle.

---

## C

**Commitment** · _finance_
Money contractually promised but not yet spent — a signed purchase order not yet invoiced.
Reported separately from actuals because it consumes budget without appearing as spend.

**Contingency** · _finance_
Money set aside for risks that may not occur. The platform derives it from a **Monte Carlo**
simulation rather than a flat percentage, so the figure can be defended: "P80 contingency" means
enough to cover 80% of simulated outcomes.

**Cost behaviour** · _finance_
Whether a cost is **fixed** (unchanged with volume), **variable** (moves proportionally), or
**semi-variable** (partly both). Determines how a cost should be flexed when volume changes, and
drives the platform's break-even analysis.

---

## D

**Delegated authority** · _finance_
The value a person may approve. Budget Owner defaults to 250,000, Finance Manager to 2,000,000,
CFO unlimited — and each may be overridden per user. Enforced in the platform as control
`DOA-01`: an approval above your limit is refused, not warned about.

**Driver** · _finance_
A quantity that determines a financial value, usually as `volume × unit rate` — subscribers ×
ARPU, headcount × average salary, sites × maintenance cost. Modelling by driver rather than by
last year's number is what lets you answer "what if volume grows 5%?".

**Driver graph** · _platform_
Named drivers linked by formulas, so changing one propagates through everything that depends on
it. Called _connected planning_: a change in the volume assumption flows into revenue, cost,
headcount and margin without anyone re-keying it.

---

## F

**Fiscal period / period key** · _platform_
The platform's unit of time, e.g. `FY2026-P03`. Organisations rarely run on the calendar year, so
periods are generated from a configured fiscal-year start. **The period key is the join key
between budgets and actuals** — this is why periods are never constructed by hand anywhere in the
system.

**Forecast** · _finance_
An expectation of the future, as distinct from a budget, which is a commitment. Budgets are
approved; forecasts are published. The platform offers eleven methods, from naive to
Holt-Winters, and records which was used.

---

## G

**Guideline pack** · _platform_
What Finance publishes to open a cycle: mandatory assumptions, each unit's targets, the period
calendar and the deadlines. Published _before_ units start work — issuing it late is a process
failure, because people will already have built on their own assumptions.

---

## L

**Locked** · _platform_
Terminal status for a budget. It has been approved and made the reporting baseline, and can no
longer be amended by anyone — including the CFO who locked it. The routes onward are a
**reforecast** or a budget transfer. Enforced as control `VER-01`.

---

## M

**Monte Carlo** · _finance_
Running a model thousands of times with values drawn from probability distributions, to get a
range of outcomes rather than one number. Used here for risk exposure and contingency.

> Every run in this platform takes an explicit **seed**, so the same seed reproduces the same
> figures exactly. A published contingency number can therefore be re-derived a year later, which
> is what makes it auditable rather than merely computed.

**MTP** · _finance_
Medium Term Plan. A multi-year view, typically three to five years, sitting between the annual
budget and long-range strategy.

---

## O

**Occupancy** · _finance_
The share of paid time an agent spends on productive work. Above roughly 85% sustained, attrition
rises — the platform warns rather than silently producing a staffing number that assumes people
are machines.

**Outturn** · _finance_
The projected full-year result given what has happened so far. "Where will we land?" rather than
"where are we now?".

---

## P

**Price-to-win** · _finance_
Pricing derived from what it takes to win the work, rather than from cost plus a target margin.
The platform models both so the gap between them is explicit.

**Pursuit** · _finance_
An opportunity being bid for. Carries a probability of winning, which is what makes the
**weighted pipeline** meaningful.

---

## R

**Reforecast** · _finance_
A revised expectation issued after the budget is locked. The mechanism for changing your view
when the baseline can no longer be edited.

**Rolling forecast** · _finance_
A forecast re-anchored each period so it always looks the same distance ahead — a rolling twelve
months rather than a horizon that shrinks as the year runs out. Older generations are retained
for scoring forecast accuracy, not for reading.

**Run rate** · _finance_
Projecting forward at the average pace observed so far. Simple and useful, but sensitive to
phasing and to one-off costs already incurred.

---

## S

**Separation of duties** · _finance_
The principle that the person who prepares something is not the person who approves it. Enforced
here as control `SOD-01`, with **no exemption for any role**, including administrators. It is the
single control in this platform most likely to be met by a normal user, and meeting it means the
system is working.

**Shrinkage** · _finance_
The share of paid time not available for productive work — leave, training, sickness, breaks.
Productive hours = paid hours × (1 − shrinkage) × occupancy.

---

## V

**Variance** · _finance_
The difference between actual and budget. **Direction matters and is not symmetric**: spending
less than budget is favourable, earning less than budget is not. The platform decides this in one
place from the account type, because getting it backwards is the classic variance-report error.

**Variance decomposition** · _finance_
Splitting a variance into the parts that caused it — how much came from price, how much from
volume, and how much from the interaction of the two. Answers "why", where a single variance
number only answers "how much".

**Version snapshot** · _platform_
A complete frozen copy of a budget taken at every status change. It means an approved budget can
be reproduced exactly as it was approved, months later, regardless of what happened afterwards.
Control `VER-01`.

---

## Related documents

- [User manual](user-manual.md) — what each role can do and is accountable for
- [Audit threat model](audit-threat-model.md) — what the audit trail protects against, and what it
  does not
- [Localisation policy](localisation-policy.md) — what varies by organisation, and what deliberately
  is not built
