# Calculation methodology

How every number in this platform is derived.

The purpose is narrow and practical: **you should be able to defend any figure this system
produces**, to a board, an auditor, or a colleague who thinks it is wrong. A number you cannot
explain is a number you cannot use, however sophisticated the model behind it.

Every formula here is the one the code actually applies. Where a worked example appears, it is
computed by hand and asserted in the engine's own tests — if the code changed, the test would
fail before this document became wrong.

> Terms are defined in the [glossary](glossary.md). Who may run each calculation is in the
> [user manual](user-manual.md).

---

## 1. Rules that apply to every number

### Money is never a floating-point number

All monetary arithmetic uses arbitrary-precision decimals at 28 significant digits. This is not
fastidiousness: `0.1 + 0.2` in binary floating point is `0.30000000000000004`, and a ledger that
does that a million times does not reconcile.

### Rounding is banker's rounding

Half-to-even: `2.5` rounds to `2`, `3.5` rounds to `4`. Rounding half **up** every time biases a
large population of roundings upward; half-to-even does not, because ties go up and down equally
often. This is the standard convention in financial systems and it is why a hand-check using
"round half up" may differ from the platform by one penny on a tie.

### Splitting money never loses a penny

Money is never divided with plain arithmetic. Dividing 100 by 3 gives three parts of 33.33 that
sum to 99.99. The platform distributes the remainder across the parts, so **the parts always sum
back to the original exactly**.

The consequence you will see: split 100 three ways and the parts are 33.34, 33.33, 33.33 — not
identical. That is correct. If they were identical, a penny would have vanished.

### Statistics use floating point, deliberately

Forecasting, smoothing and simulation run in ordinary floating point. This is a considered
exception, not an oversight: the uncertainty in a forecast is measured in percentage points,
which dwarfs floating-point error by many orders of magnitude, and decimal arithmetic across ten
thousand Monte Carlo iterations would be unusably slow. **Results convert back to decimal before
they reach anything that behaves like a ledger.**

### Simulation is reproducible

Every Monte Carlo run takes an explicit seed. The same seed and the same inputs produce the same
figures, exactly, forever. A contingency number published this year can be re-derived and
re-checked next year. This is what makes a simulated figure auditable rather than merely
computed.

---

## 2. Forecasting

Eleven methods. The platform does not choose for you, and it does not hide which was used —
the method and its fitted parameters are recorded with the forecast.

### The methods

| Method                           | What it assumes                                              | When it misleads                                                                                                  |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Naive**                        | Tomorrow equals today.                                       | Any trend or seasonality. **It is the benchmark**: a method that cannot beat naive is not earning its complexity. |
| **Seasonal naive**               | This period equals the same period last cycle.               | A level shift — a price change, a new contract.                                                                   |
| **Run rate**                     | The average pace so far continues.                           | Heavy phasing, or one-off costs already incurred. The mid-year favourite, and the most commonly abused.           |
| **Moving average**               | Recent periods, equally weighted, represent the level.       | Trend — it lags systematically.                                                                                   |
| **Weighted moving average**      | As above, recent periods weighted more heavily.              | Same lag, reduced but not removed.                                                                                |
| **Simple exponential smoothing** | A level with no trend, older data decaying in weight.        | Any persistent trend.                                                                                             |
| **Holt linear**                  | A level plus a trend, optionally damped.                     | Seasonality. Undamped, it extrapolates a trend indefinitely — which is why damping exists.                        |
| **Holt-Winters additive**        | Level, trend, and seasonal swings of roughly constant size.  | Seasonality that scales with the level.                                                                           |
| **Holt-Winters multiplicative**  | Level, trend, and seasonal swings proportional to the level. | Series containing zeros or negatives.                                                                             |
| **Linear regression (OLS)**      | A straight line through time.                                | Anything with curvature; sensitive to outliers at the ends.                                                       |
| **Driver-based**                 | Value = volume × unit rate.                                  | Unit economics that are not multiplicative — see §3.                                                              |

### How parameters are chosen

Smoothing parameters you do not supply are fitted by **grid search against in-sample sum of
squared errors** — a coarse pass, then local refinement around the best point. It is
deterministic: the same series always yields the same parameters. No random restarts, no hidden
optimiser state.

Supply the parameters yourself if you have a reason to. The fitted values are recorded either
way, so a forecast can be reproduced.

### Why the uncertainty band widens

Each method declares how fast its uncertainty fans out with the forecast horizon. A flat method
like run rate has constant uncertainty; a trend method's uncertainty grows, because an error in
the estimated trend compounds every period.

This is why a twelve-month forecast band is wider than a one-month band by more than a factor of
twelve for trending methods — and why a narrow band far into the future should be treated with
suspicion.

### Accuracy is measured against held-out data

Forecast accuracy metrics compare predictions against actuals that were **not** used to fit the
model. A model scored on the data it was fitted to will always look excellent and tell you
nothing.

---

## 3. Driver-based modelling

`value = volume × unit rate`, with volume growth and rate escalation compounding independently
per period.

Two separate factors, deliberately. Subscribers growing 5% a year while ARPU falls 2% a year is a
different business from either alone, and collapsing them into one "growth" number hides the
question worth asking.

**The limit worth knowing:** this shape assumes unit economics are multiplicative. Where value is
a probability-weighted expectation (insurance claims), or a balance accruing margin over time
(lending), the driver model does not fit and forcing it will produce a confident wrong answer.

### Connected planning

Drivers can reference each other by name in a graph, so a change propagates to everything
downstream. The graph is evaluated in dependency order and cycles are rejected — a driver cannot
depend on itself, directly or through a chain.

---

## 4. Variance

### Direction is not symmetric

Spending **less** than budget is favourable. Earning **less** than budget is not. The direction
is derived in exactly one place, from the account type, because reversing it is the classic
variance-report error and it is invisible in a spreadsheet until someone senior asks why an
underperforming quarter is coloured green.

### Price, volume and the joint effect

"We spent 200k more than budget" is not actionable. "We used 12% more hours at a 3% higher rate"
is. The platform splits a variance three ways:

```
volume variance = (actual volume − budget volume) × budget price
price variance  = (actual price  − budget price)  × budget volume
joint variance  = (actual volume − budget volume) × (actual price − budget price)
```

These three sum **exactly** to the total variance. That is an algebraic identity, not a
convention, and it is asserted in the tests.

**The joint term is reported separately rather than folded into price.** Folding it in is a
common shortcut, and it quietly overstates the price effect — it charges the price variance for
an interaction that only exists because volume also moved. If you have seen a variance report
where the price effect looked implausibly large, this is usually why.

#### Worked example

Budget: 1,000 hours at 100.00 = 100,000. Actual: 1,120 hours at 103.00 = 115,360.

```
volume = (1,120 − 1,000) × 100.00 =  12,000
price  = (103.00 − 100.00) × 1,000 =  3,000
joint  = (1,120 − 1,000) × (103.00 − 100.00) =    360
                                        total = 15,360  ✓ = 115,360 − 100,000
```

The reading: most of the overspend is volume, not rate. Fold the joint term into price and the
rate effect appears as 3,360 — 12% overstated, and it points the conversation at the wrong
lever.

---

## 5. Outturn projection

"Where will we land?" rather than "where are we now?". The projection states its **basis** —
which method was used to extend the remaining periods — because a full-year number derived from
run rate and one derived from a seasonal method can differ enormously, and the difference is the
whole argument.

Commitments are carried separately from actuals. Money contractually promised but not yet
invoiced consumes budget without appearing as spend, and a projection that ignores it
understates the outturn.

---

## 6. Cost behaviour and break-even

Costs are classified **fixed**, **variable**, or **semi-variable**. A semi-variable cost carries
a variable share as a fraction — 0.35 means 35% of the cost moves with volume.

```
contribution        = revenue − variable cost
contribution margin = contribution ÷ revenue
break-even revenue  = fixed cost ÷ contribution margin
```

**Break-even is undefined, not zero, when the contribution margin is zero or negative.** If each
additional unit loses money, no volume reaches break-even, and reporting a number there would be
worse than reporting nothing. The platform returns no value and warns.

---

## 7. Pricing

### Burden absorption

Indirect costs are recovered by applying a rate to a base of direct costs. Pools apply **in a
fixed order**, and each may draw on pools applied before it:

```
FRINGE → OVERHEAD → MATERIAL_HANDLING → GA → COM
```

A pool whose base references a pool applied at the same time or later is **an error**, not a
warning — that would be circular. A pool that is simply not configured contributes **zero** to a
later pool's base, which is normal: a fringe/overhead/G&A model with no material-handling pool is
entirely ordinary.

#### Worked example

1,000 labour hours at 100.00; materials 10,000; travel 5,000 marked pass-through. Fringe 30%,
overhead 20%, G&A 10%.

| Step              | Base                                                | Rate | Amount     |
| ----------------- | --------------------------------------------------- | ---- | ---------- |
| Direct labour     | —                                                   | —    | 100,000    |
| **Fringe**        | direct labour = 100,000                             | 0.30 | **30,000** |
| **Overhead**      | direct labour + fringe = 130,000                    | 0.20 | **26,000** |
| Material handling | not configured                                      | —    | 0          |
| **G&A**           | labour + fringe + overhead + other direct = 156,000 | 0.10 | **15,600** |
|                   |                                                     |      | **71,600** |

Note that the 10,000 of materials does **not** attract G&A — G&A draws on the material _handling_
pool, which is not configured here, not on materials directly. This is exactly the kind of detail
that makes two people's spreadsheets disagree, and it is why the base composition is explicit and
overridable per model rather than assumed.

### Pass-through costs

Costs marked pass-through are excluded from **every** burden base and from the fee base, and added
to the price at cost. In the example above, the 5,000 of travel touches no calculation until the
final price. Billing a client a fee on money you merely handled is the kind of thing that ends a
commercial relationship.

### Fee and discount

Fee is a fraction of burdened cost. Any discount applies to the final price, after fee — because
that is what a discount is, commercially.

### NPV and IRR

Cash flows are discounted at the stated cost of capital. IRR is found numerically; where cash
flows change sign more than once, more than one IRR can exist mathematically, and IRR should not
be the deciding metric on such a profile. NPV is well-defined in every case and is the safer
comparison.

---

## 8. Risk and contingency

### Monte Carlo

The model runs thousands of times with values drawn from declared probability distributions, then
reports the distribution of outcomes rather than a single number.

Six distributions are available. Choose by what you actually know:

| You know                                           | Use        |
| -------------------------------------------------- | ---------- |
| A best case, worst case, and most likely           | Triangular |
| A range, with nothing to prefer inside it          | Uniform    |
| A mean and a spread, symmetric                     | Normal     |
| A quantity that cannot go below zero and is skewed | Lognormal  |
| An event that either happens or does not           | Bernoulli  |
| A rate of occurrences per period                   | Poisson    |

### Contingency

```
contingency = P80 outcome − deterministic estimate
```

The reserve funds the gap between "what we expect" and "what covers us 80% of the time". The
percentile is a policy choice, not a mathematical one — P80 is a common convention, and a
different appetite justifies a different number, stated explicitly.

**Below 5,000 iterations the platform warns**, because tail percentiles are noisy at low iteration
counts and P80 is a tail statistic. For a figure you intend to publish, 10,000 or more.

### Sensitivity

Inputs are ranked by their contribution to output variance — which uncertainty actually matters.
Usually two or three inputs dominate and the rest are noise, which tells you where to spend effort
reducing uncertainty rather than modelling it.

---

## 9. Workforce

```
productive hours = paid hours × (1 − shrinkage) × occupancy
```

Shrinkage is time not available at all: leave, training, sickness, breaks. Occupancy is the share
of _available_ time spent on productive work.

**Above roughly 85% sustained occupancy the platform warns.** Sustained high occupancy drives
attrition, and a staffing model that assumes 95% occupancy indefinitely will understate headcount
while appearing efficient. The warning exists because the arithmetic cannot see the consequence.

---

## 10. What this platform deliberately does not calculate

Stating these matters as much as stating the formulas. A gap you know about is a decision; a gap
you discover is an incident.

- **No currency translation.** Amounts are stored in the currency they were entered in and are
  never converted. Doing it properly requires rate tables, a translation method per account class,
  and cumulative translation adjustment handling. Consolidating across currencies is therefore not
  supported today.
- **No tax of any kind.** No VAT, GST, sales tax or withholding. Tax is jurisdictional, changes
  without notice, and belongs to a specialist system or to the inputs you supply.
- **No statutory reporting formats.** The platform produces management information, not statutory
  accounts.
- **No accruals or provisions engine.** Actuals arrive from the accounting system, which remains
  the source of truth.

See [the localisation policy](localisation-policy.md) for the reasoning, which is deliberate:
encoding rules a government can change without asking you is how a platform acquires a
maintenance burden it cannot afford.

---

## 11. How to defend a number

When someone challenges a figure, these are the questions in the order they will be asked, and
where the platform answers each.

1. **What period and what scope?** Period keys are the join between budget and actual; a
   mismatch here explains most "the numbers don't tie" disputes.
2. **Budget, forecast, or actual?** A budget is a commitment, a forecast is an expectation, an
   actual is a fact. They are different objects and are not interchangeable in a sentence.
3. **Which version?** Every status change snapshots the budget completely. An approved budget can
   be reproduced exactly as approved, whatever happened afterwards.
4. **What method, and what parameters?** Recorded with the forecast, including fitted smoothing
   parameters.
5. **What assumptions?** Recorded on the cycle in the guideline pack, and on the budget where they
   were overridden.
6. **If simulated, what seed and how many iterations?** Both recorded. The run can be repeated
   exactly.
7. **Who prepared, submitted and approved it?** All three, with timestamps, in a hash-chained
   audit trail that detects tampering.

A figure that can answer all seven is defensible. If any answer is missing, that is where the
conversation should go.
