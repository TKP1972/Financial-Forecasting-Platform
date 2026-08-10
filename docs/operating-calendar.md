# Operating calendar

How a planning cycle runs, in order, and who does what at each stage.

The platform enforces deadlines, role seniority and period locking. It does not tell you when to
open a cycle or how long to give people — those are decisions, and this document is how they get
made consistently rather than reinvented each year.

Written as a procedure a finance team can follow. Where the platform will refuse something, it
says so, because a control met unexpectedly mid-cycle costs more than one anticipated.

> Capabilities per role are in the [user manual](user-manual.md). The controls are in the
> [control matrix](control-matrix.md).

---

## The cycle at a glance

```
PLANNING  →  OPEN  →  CONSOLIDATING  →  CLOSED
   │           │            │              │
 set up     units build   approve &     baseline
 & publish  & submit      lock          in force
```

Budgets move through their own lifecycle inside this, and the two are not the same thing: a cycle
can be `OPEN` while individual budgets sit anywhere from `DRAFT` to `LOCKED`.

```
DRAFT → IN_REVIEW → SUBMITTED → APPROVED → LOCKED
  ↑         │            │          │
  └── REJECTED ←─────────┘          └──→ IN_REVIEW (before locking)
```

`LOCKED` is terminal. Nothing leaves it.

---

## Stage 1 — PLANNING: set up before anyone builds

**Owner: Finance Manager.** Nobody else can create a cycle or publish guidance.

### Do, in this order

1. **Create the cycle.** Fiscal year, period type, and three deadlines: when it opens, when
   submissions close, when approvals close. The platform validates that they are in that order.
2. **Confirm the chart of accounts and business-unit hierarchy** are current. Reference data is
   imported by an administrator; a unit created halfway through a cycle is disruptive because
   budgets already reference the hierarchy.
3. **Set targets per unit** — the top-down number each unit is building against.
4. **Write the assumptions.** Tariff movements, pay award, headcount policy, FX position, anything
   a unit would otherwise guess.
5. **Publish the guideline pack.**

### The one rule that matters here

**Publish guidance before people start work, not after.**

This is the most common process failure in budgeting and the platform cannot prevent it. If units
begin building before assumptions are published, they build on their own — and you will either
accept inconsistent submissions or send everyone back to redo work. Neither is recoverable
cheaply. The submission deadline is not the constraint; the _publication_ date is.

### Give people enough time

The platform will accept a two-day submission window. Do not set one. A realistic bottom-up build
for a unit with a real cost base is two to four weeks, and a deadline that cannot be met produces
either late submissions consolidated at the top-down target, or numbers filled in without thought.
Both defeat the exercise.

---

## Stage 2 — OPEN: units build and submit

**Owners: Analysts build, Budget Owners submit.**

### Building

Analysts create and edit budget lines, run forecasts, and model drivers. An Analyst **cannot
submit** — that is deliberate, and it is what makes the eventual approval meaningful.

Record the method per line. The platform asks because _"where did this number come from?"_ is the
question reviewers ask more than any other, and the answer is worth more than the number.

### Submitting

The Budget Owner submits. **This is the moment of commitment** — before it, a draft; after it, the
unit's stated position, recorded with a name and a timestamp.

Check before submitting:

- Do the assumptions match the published pack? A submission on different assumptions is likely to
  be returned.
- Is the phasing right, or is it a twelfth of the annual number in every period? Flat phasing makes
  every subsequent variance report meaningless.
- Are one-off costs marked as such?

### Deadlines

The platform sends reminders as the submission deadline approaches, then a notice when it passes.
**A unit that has not submitted is consolidated at its top-down target** — someone else's number
becomes their budget. Say this out loud at the start of the cycle; it is a much better motivator
than a reminder email.

---

## Stage 3 — CONSOLIDATING: review, approve, lock

**Owners: Finance Manager approves; CFO locks.**

### Reviewing

Compare bottom-up against target, examine variance by unit, and question phasing. The consolidated
view is the point at which inconsistent assumptions become visible — if two units assumed different
pay awards, it shows here.

### Approving

An approval is a control, not a formality. It asserts the submission has been examined and is
within your authority. It is recorded permanently and it is what an auditor samples.

**Three things will refuse you, and they are checked in this order:**

1. **Role seniority** — approving requires Finance Manager or above. Checked first, so a junior
   role is refused before authority is even consulted.
2. **Separation of duties** — you cannot approve what you prepared or submitted. **No exemption
   exists for any role**, including administrators. This is not escalable; it needs a different
   person.
3. **Delegated authority** — above your limit, escalate. Finance Manager 2,000,000, CFO unlimited,
   and per-user overrides may apply.

### Returning

Record why. The person revising sees your comment and nothing else — a rejection with no reason is
a wasted round trip, and it is the single most common complaint about budgeting software.

A returned budget goes to `REJECTED`, then back to `DRAFT` for revision.

### Locking

**CFO only, and it is terminal.** Locking makes the budget the reporting baseline that every
variance report will measure against.

Lock when the cycle is genuinely settled. Nobody — including the CFO — can amend a locked budget
afterwards. The onward routes are a **reforecast** or a **budget transfer**, both of which leave
the baseline intact and are themselves recorded.

Locking a wrong number is expensive to undo. Not technically — organisationally.

---

## Stage 4 — CLOSED: the baseline is in force

The cycle is the reporting baseline. From here the rhythm is monthly rather than annual.

### Each period

1. **Load actuals** (Finance Manager). From the accounting system, which remains the source of
   truth.
2. **Review variance.** Direction is not symmetric — underspend on cost is favourable, under-
   delivery of revenue is not. Use the price/volume decomposition: _"12% more hours at a 3% higher
   rate"_ is actionable where _"200k over"_ is not.
3. **Update the rolling forecast**, re-anchored on the last closed period.
4. **Project the outturn** and state its basis. A run-rate projection and a seasonal one can differ
   enormously, and the difference is the conversation.
5. **Close the period.**

### Closing a period is a commitment

Once closed, actuals for that period are **locked**. A restatement is refused with `PERIOD_LOCKED`;
post the adjustment to an open period instead.

This is deliberate. If a closed period could be restated, every variance report already issued
against it would become unreproducible. Close when the period is genuinely final, not on a date.

---

## Governance rhythm

Independent of the planning cycle, and easy to let slip because nothing forces it.

| Activity                      | Frequency                               | Who             | Why                                                                                                  |
| ----------------------------- | --------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| **Verify the audit chain**    | Monthly, and before any external review | CFO or Admin    | Tamper detection only works if someone runs it. **If nobody verifies, the property is theoretical.** |
| Review user access and limits | Quarterly                               | Admin + CFO     | Leavers, movers, and approval limits that no longer match the role.                                  |
| Review the control register   | Annually, or on any process change      | Finance Manager | Confirm the controls still match how the organisation actually works.                                |
| Re-seed the demo environment  | Before any demonstration                | Admin           | Test runs accumulate fixtures; a demo should show real seeded content, not `Smoke test 1786290…`.    |

A failed chain verification is an **incident**, not a bug. Preserve the state, do not "fix" the
data, and establish what changed before anything else.

---

## Annual setup checklist

For the start of each planning year.

- [ ] Fiscal calendar confirmed — start month and labelling convention
- [ ] Chart of accounts reviewed; new accounts added, obsolete ones deactivated rather than deleted
- [ ] Business-unit hierarchy reflects the current organisation
- [ ] User list reviewed: leavers deactivated, roles correct, approval limits current
- [ ] Prior year locked, so the baseline cannot move
- [ ] Cycle created with the three deadlines, working backwards from when the board needs the number
- [ ] Targets set per unit
- [ ] Assumptions written and **published before anyone is told to start**

---

## What the platform will not do for you

Worth knowing so it is planned around rather than discovered.

- **It will not chase people.** Reminders are sent; escalation is yours.
- **It will not decide your deadlines are unrealistic.** It validates their order, not their
  sensibility.
- **It will not stop you locking a wrong number.** Only that you cannot unlock it afterwards.
- **It will not verify the audit chain on a schedule.** Detection requires someone to run it.
- **It will not reconcile to your accounting system.** It consumes actuals; it does not audit
  where they came from.
