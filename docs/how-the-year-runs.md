# How the year runs

Who does what, in what order, and why the platform refuses some of it.

The other documents describe capabilities. This one describes a **working year** — the rhythm a
finance function actually keeps — and maps each screen onto the moment somebody would open it.
Read it before demonstrating the platform to anyone, because the questions you will be asked are
about the process, not the software.

---

## 1. The five people

A budget is not a document. It is a **chain of accountability**, and every role exists to break
that chain into parts no one person controls. That is the product's whole argument, so it is
worth being able to say it in a sentence: _one person prepares, a second submits, a third
approves, and none of them can do the other's job._

| Role                  | What they own                                                    | The thing they cannot do                                               |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Viewer**            | Reads. A board member, an internal auditor, an adjacent team.    | Change anything at all.                                                |
| **Financial Analyst** | Builds the numbers. Forecasts, prices, models scenarios.         | Submit their own work, approve anything, or see a bid's margin.        |
| **Budget Owner**      | Owns one business unit's budget and submits it.                  | Approve. Commit above 250,000.                                         |
| **Finance Manager**   | Runs the cycle. Approves, loads actuals, issues the board pack.  | Approve their own submission. Commit above 2,000,000. Lock a baseline. |
| **CFO**               | Approves without limit. Locks the baseline. Verifies the record. | Approve their own submission — no exemption exists, for anyone.        |

There is also an **Administrator**, who manages users and settings and is deliberately _not_ a
finance role. They can create the CFO's account and cannot approve a budget.

> **The line to use:** "The system will not let the person who built a number be the person who
> signs it off. Not even the CFO. Not even the administrator. There is no override, because an
> override is the first thing an auditor asks about."

---

## 2. The planning year

A budget for calendar 2026 is built in the autumn of **2025**. This trips people up constantly:
when you open the platform in August 2026, the FY2026 cycle is in _execution_, and its submission
deadline passed months ago. That is normal, not a fault.

### September — the cycle opens

**Finance Manager.** Creates the FY2026 cycle: its fiscal calendar, its period type, its
submission and approval deadlines.

Then the part that matters more than it sounds — publishing the **guideline pack**. It carries the
planning assumptions everyone must use (inflation, salary inflation, FX, energy prices), the
strategic priorities, the top-down target for each business unit, the period calendar and the
submission instructions.

**Why it matters:** without a common assumption set, one unit budgets 3% wage inflation and
another 6%, and the consolidated total is a number nobody can defend. The pack is versioned and
dated, so "which assumptions was this built on" always has an answer.

_Screen:_ Budget cycles → open the cycle → Guidance.

### October — the units build

**Financial Analyst**, one per business unit.

They build the budget line by line: an account, a cost category, an amount for each period of the
year. Every line records the **method** used and a justification, because the question a reviewer
asks most is _"where did this number come from?"_

Four ways to arrive at a line, and a good analyst uses different ones for different costs:

- **Incremental** — last year plus a percentage. Fine for rent. Lazy for everything else.
- **Zero-based** — build it up from nothing and justify all of it. Expensive to do, so reserved
  for the categories under scrutiny.
- **Driver-based** — the number falls out of an operational quantity. Subscribers × cost to serve.
  Sites × maintenance rate. This is the one finance people respect, because it survives the
  question _"what if volumes are 10% lower?"_
- **Rolling forecast** — take the trend and project it.

_Screens:_ Forecasting for the history and the projection; Scenarios for the driver cases;
Budgets to enter the lines.

**How the analyst actually uses Forecasting:** pick a business unit and an account — say Mobile
Networks, Salaries & wages — and the platform loads the recorded history. `AUTO` then backtests
every applicable method against that history and picks the one with the best _out-of-sample_
accuracy, showing the whole candidate table. That last part is the point: the analyst can say
"Holt-Winters, because it scored 0.61 against a naive baseline's 1.36", rather than "the tool
chose it".

**How they use Scenarios:** vary the volume drivers rather than the money. Take subscribers at
100% of plan, then a downside at 90% and an upside at 108%, attach a likelihood to each, and read
the probability-weighted outturn. That is the conversation a CFO wants — not one number, but a
range with a shape.

The budget sits in **DRAFT** throughout. The analyst cannot submit it.

### Late October — submission

**Budget Owner.** Reviews what their analyst built, moves it DRAFT → IN REVIEW → **SUBMITTED**.

**Why the analyst cannot do this:** the person who prepared the numbers should not be the person
who asserts they are ready. It is a small friction that makes the eventual approval mean
something.

### November — approval

**Finance Manager**, then the **CFO** for anything larger.

Three separate controls run before an approval is written, and they answer differently on purpose:

1. **Role seniority** — a Budget Owner cannot approve at all. Refusal: `FORBIDDEN`.
2. **Separation of duties** — you cannot approve what you submitted. Refusal:
   `SEPARATION_OF_DUTIES`. No role is exempt.
3. **Delegated authority** — a Finance Manager cannot approve 5,000,000 against a 2,000,000
   limit. Refusal: `DELEGATED_AUTHORITY_EXCEEDED`, which tells them to escalate rather than to
   ask for more permissions.

Returning a budget for revision **clears the approval**, so a stale sign-off can never sit on
numbers that have since changed.

> **The line to use:** "Three different things can stop an approval, and the system says which.
> 'Forbidden' and 'that is above your limit' are different problems with different answers, and a
> tool that says 'access denied' to both sends people to the wrong person."

### December — the baseline is locked

**CFO only.** APPROVED → **LOCKED**, which is terminal.

**Why this exists:** every variance figure for the next twelve months is measured against this. If
the budget could still move, "we are 4% over" would be meaningless — over _what?_ Locking is the
act that turns a plan into a control. After it, changes happen through reforecasts and transfers,
which are visible, rather than by editing the original, which is not.

---

## 3. The monthly rhythm

From January the cycle is in execution, and the month has a shape.

### Days 1–5 — actuals arrive

**Finance Manager** imports the ledger extract. The platform matches it to the budget on the
period key (`FY2026-P03`), which is the join between what was planned and what happened.

Then they **close the period**, which locks those actuals against restatement. Closing is
explicit, audited and irreversible.

**Why closing matters:** the rolling forecast anchors on the last _closed_ period, not on today's
date. Without that, importing a partial month would silently re-anchor every forecast, and the
numbers would change under a reader between refreshes.

### Days 5–8 — variance

**Finance Manager and Analysts.**

Variance compares budget-to-date against actual-to-date, and the direction depends on the account:
**underspending a cost is favourable; under-delivering revenue is not.** The platform knows the
difference, which sounds trivial until you have seen a spreadsheet colour a revenue shortfall
green.

Two things a spreadsheet usually gets wrong and this does not:

- **Commitments count as consumed.** A budget holder with 100,000 left and 90,000 on purchase
  orders does not have 100,000 to spend. Reporting the 100,000 is how a unit overspends while
  looking healthy.
- **Like is compared with like.** Budget-to-date for the periods that have actuals, never a
  full-year budget against seven months of spend — that comparison flatters every unit by about
  40% and is the single most common reporting error.

Where a variance is material, look at it along more than one axis: the report groups by account,
business unit, cost category or period, and a cost that is adverse by unit but flat by category is
telling you something different from one that is adverse everywhere.

> **Not yet on screen.** The engine also decomposes a variance into **price, volume and
> efficiency** — "we did 9% more work and got 3% worse at it" rather than "we spent 12% more" —
> and that is available over the API (`POST /variance/decompose`) but has no screen yet. Do not
> promise it in a demonstration until it does. It is the most senior thing the product can
> calculate and it is worth building before a serious meeting.

_Screens:_ Variance → Report, grouped four ways; Projection for the outturn. Dashboard for the
headline position.

### Days 8–10 — the board pack

**Finance Manager.** Opens Reports, reviews the leadership pack — approved budget, actual to date,
commitment, variance by unit with RAG status, the exceptions worth discussing, the risk position,
and generated commentary — then **issues** it.

**Why issuing matters, and this is the most under-appreciated feature in the product:** the pack
is otherwise rebuilt from live data every time it is opened. Reopen it next month and the numbers
have moved. Issuing freezes it — attributed, dated, never recomputed — so a figure someone
questions in a board meeting can be traced back to exactly what was tabled. Everything else is a
report; this is a _record_.

### Any time — the reforecast

**Analyst or Finance Manager.** Roll the forecast forward: actuals to date plus a projection for
the rest of the year, giving a full-year outturn.

The platform scores each generation against what has since closed, so you can ask whether the
forecasting is actually getting better. Without that, "continuous reforecasting" is just running a
model on a schedule and never learning if it works.

---

## 4. Two threads that run all year

### Bids and pricing

**Analyst builds, Finance Manager or CFO signs off.**

A cost volume is built from the bottom: labour hours × rates, escalated across the contract years;
direct costs; then the indirect pools applied **in a fixed order against declared bases** —
fringe, then overhead, then material handling, then G&A, then cost of money. Getting that order or
those bases wrong is the most common error in a home-grown pricing model, and a 1% base error on a
30% pool is a real margin error on a real bid.

Then fee, and the price.

**The control worth demonstrating:** an Analyst can build the entire cost volume and **cannot see
the margin**. Total price and total cost show in full; gross margin, fee, NPV and IRR read
"Restricted". It is enforced by the API, not hidden in the browser — a point worth making, because
most tools that claim this are only hiding a number on screen.

Before the bid goes out, someone with `pricing:approve` **signs off the price**, subject to the
same separation of duties and delegated authority as a budget. A price is a multi-year commitment
to a client; a budget is an internal plan that can be revised. The more binding number gets the
same governance.

_Screens:_ Pricing → Pricing workbench, then Pursuits for the sign-off.

### Risk and contingency

**Analyst raises, Finance Manager accepts.**

Risks are scored 5×5 on probability and impact, inherent and residual, with an expected monetary
value. Where the aggregate matters, run a **Monte Carlo simulation** and size contingency at P80 —
the amount that covers the outcome eight times in ten.

Two things to say about it:

- **Formally accepting a risk is a separate permission.** An Analyst can describe and treat a
  risk; deciding to _carry_ it is a Finance Manager's decision, because that is what accepting
  means.
- **Every simulation stores its seed**, so a contingency figure quoted to a board can be
  regenerated exactly, months later, by whoever asks. A number nobody can reproduce is an opinion.

---

## 5. The words you will hear

Enough vocabulary to hold the conversation.

| Term                       | What it means                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| **Top-down target**        | The number leadership hands a unit before it builds anything.                              |
| **Bottom-up build**        | What the unit produces line by line. The gap between the two is the negotiation.           |
| **Baseline**               | The approved, locked budget. What variance is measured against.                            |
| **Variance**               | Budget minus actual. **Favourable** or **adverse**, never just positive or negative.       |
| **Commitment**             | Money contractually promised but not yet spent. Consumed for control purposes.             |
| **Reforecast**             | A revised expectation. It does **not** change the baseline — that is the point.            |
| **Outturn**                | Where the full year is expected to land.                                                   |
| **Accrual**                | Cost recognised when incurred, not when paid. Budgets are accrual, not cash.               |
| **Run rate**               | Recent spend projected forward unchanged. The simplest forecast, and the honest benchmark. |
| **Driver**                 | An operational quantity money follows from — subscribers, sites, homes passed.             |
| **Burden / indirect pool** | An overhead recovered as a percentage of a declared base.                                  |
| **MASE**                   | Forecast error against a naive forecast. Below 1 means the model beat "assume no change".  |
| **P80**                    | The value not exceeded in 80% of simulated outcomes. The usual basis for contingency.      |
| **RAG**                    | Red / amber / green banding, with a materiality floor so trivial variances stay green.     |
| **Separation of duties**   | The preparer, submitter and approver must be different people.                             |
| **Delegated authority**    | The value a given role may approve. Above it, escalate.                                    |

---

## 6. A demonstration, in order

Forty minutes, following the year rather than the menu. Sign in as the **CFO**
(`cfo@ffp.local`) unless a step says otherwise.

> Reset first — `npm run db:reset:stack` — so the data is the clean worked example rather than
> whatever the last session left behind.

**1. Dashboard (2 min).** Start with the position, not the features. Approved budget, actual
spend, commitment, remaining, utilisation against how far through the year the cycle is. Say:
_"Sixty per cent consumed at fifty-eight per cent of the year — slightly ahead of plan."_ That one
sentence tells them the tool answers the question they actually have.

**2. Budget cycles → the cycle → Guidance (3 min).** The assumption set everybody budgeted on.
Say: _"This is what stops one unit assuming three per cent inflation and another six."_

**3. Budgets → open one (5 min).** Show the lines, the method on each, the justification. Then the
workflow panel: only the transitions this role can legally make are offered. Sign out, sign in as
the **Analyst**, and show that the Submit button is simply not there on work they wrote.

**4. Forecasting (5 min).** Mobile Networks, Salaries & wages. Run `AUTO`. Show the candidate
table and say: _"It backtested every method and chose on out-of-sample accuracy. Here is the
scoreboard, so you can challenge the choice."_ Then the **Scenarios** tab: base, downside, upside,
and the probability-weighted case.

**5. Variance (5 min).** Budget versus actual with commitments consumed. Point out that the
comparison is like-for-like — budget to date, not the full year, which is the error that flatters
every unit by about forty per cent. Regroup by cost category and by period to show the same
variance from three angles. Then the **Projection** tab: full-year outturn on a stated basis, and
say which basis, because "our projection" without one is a guess.

**6. Reports (5 min).** The leadership pack. Then **issue** it, switch to Issued packs, and say:
_"That is now frozen. If someone asks in March what the January pack said, this is it, not a
re-run."_

**7. Pricing (5 min).** As the **Analyst**: build the cost volume, calculate, and show margin
reading "Restricted". Then as the **CFO**: the same screen with the margin visible, and the price
sign-off. Say: _"The analyst who priced this cannot approve it, and could not see the profit on
it."_

**8. Risk (4 min).** The register and a Monte Carlo run. Run it twice with the same seed to show
identical numbers, then change the seed to show different ones. Say: _"The contingency figure in
your board pack can be regenerated exactly, months later."_

**9. Governance (4 min).** The audit trail, then **verify the chain**. Say: _"Every governed
action is hash-chained. If a row were altered in the database, this verification fails and names
the entry."_ Then the permissions matrix — every role, every capability, machine-checked against
the code.

**Close on the audit trail, not the dashboard.** The dashboard shows it is useful; the audit trail
shows it is trustworthy, and trust is what you are actually selling.

---

## 7. Questions you will be asked

Answer these plainly. Being straight about limits buys more credibility than the features do.

**"Can an administrator change a number and cover it up?"**
They can change a database row — anyone with database access can. What they cannot do is make the
audit chain still verify: each entry is hashed with the previous hash, so altering one breaks
every entry after it. `docs/audit-threat-model.md` states this honestly, including the residual
risk that the salt lives on the same host as the database. Show them that document. Nobody expects
a vendor to hand over their own threat model, and doing it changes the conversation.

**"What if we need to delete a budget?"**
You cannot, and that is deliberate. Deleting one would leave audit entries pointing at a record
that no longer exists, and would move the baseline underneath reports already issued. Budgets are
amended, superseded or returned for revision. If something must come out of the numbers, that is a
reversing entry, not a removal.

**"Does it integrate with our ERP?"**
Actuals come in as a file import today. There is no ERP connector. Say so — an honest "not yet,
and here is the import format" is better received than a vague yes that unravels in week three.

**"Does it do cash flow?"**
No. It plans and controls accrual budgets and prices bids. There is no cash-flow statement or
balance sheet. If their real problem is liquidity, this is not the tool, and finding that out in
the first meeting is a good outcome for both of you.

**"Is any of this AI?"**
No. The forecasting is classical time-series statistics — exponential smoothing, Holt-Winters,
OLS — chosen by backtesting and reported with their error metrics. Monte Carlo takes an explicit
seed. Every number is reproducible and every method is one a finance person can name. That is a
strength in this market, not a gap.

**"How do we know the forecasting is any good?"**
It is measured, not asserted. Each method is backtested by rolling-origin cross-validation and
scored on out-of-sample MASE, and the whole candidate table is shown so the choice can be
challenged. On the reference series the selected method reaches roughly 3.8% MAPE against 4%
noise, which is as close to the signal as anything can get.

**"What happens when two people approve at once?"**
The second one gets a conflict rather than a silent overwrite. Every governed write is guarded on
the state it read.
