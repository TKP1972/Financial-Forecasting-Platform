# User manual

Who does what in the Financial Forecasting Platform, what the system will refuse you, and what
you are accountable for.

This is organised by **role**, because the platform is organised by role. What you see, what you
can change, and what your sign-off means all follow from the role you were given. If you are not
sure which you have, it is shown next to your name in the top-right of every screen.

Each role below answers three questions:

1. **What you can do** — your capabilities.
2. **What the system will refuse, and why** — the controls you will meet. These are deliberate.
   Meeting one is not a fault.
3. **What you are accountable for** — what your name is attached to, permanently.

The third is the one that matters most. This platform records who did what, in a chain that
cannot be quietly edited. Your actions are attributable long after you have forgotten them.

> **Terms in _italics_** are defined in the [glossary](glossary.md).

---

## The six roles at a glance

| Role                        | Approval limit | In one sentence                                                       |
| --------------------------- | -------------- | --------------------------------------------------------------------- |
| **Viewer**                  | none           | Reads everything in scope, changes nothing.                           |
| **Financial Analyst**       | none           | Builds the numbers. Cannot submit them and cannot see margin.         |
| **Budget Owner**            | 250,000        | Owns a unit's budget and submits it for approval.                     |
| **Finance Manager**         | 2,000,000      | Approves budgets, runs the cycle, loads actuals.                      |
| **Chief Financial Officer** | unlimited      | Approves without limit, locks the baseline, verifies the audit chain. |
| **System Administrator**    | none           | Manages users, settings and reference data. Not a finance role.       |

Approval limits are per-role defaults and can be raised or lowered **per user** — your effective
limit may differ. It is shown to you when an approval is refused.

---

## Viewer

For people who need to see the numbers and must not change them: auditors, non-finance
leadership, colleagues in adjacent teams.

### What you can do

Read budgets, budget cycles, forecasts, pricing models, risks, actuals and reports. That is the
whole role, and it is a real one — most people who need this platform need only this.

### What the system will refuse, and why

Everything that writes. You cannot create or edit a budget, run a forecast, or export a report.
Refusals arrive as _"Your role (VIEWER) does not permit this action."_

You also cannot see **margin** on a pricing model. Price and cost are visible; the margin
position is not.

### What you are accountable for

Nothing is recorded against you beyond sign-in, because you change nothing. If you need a number
changed, ask the Budget Owner for that unit — do not ask for elevated access, because the value
of your role to an auditor is precisely that you could not have changed anything.

---

## Financial Analyst

The role that does the modelling. Deliberately capable and deliberately unable to commit.

### What you can do

Build and edit budgets. Run forecasts using any of the eleven methods. **Compare scenarios** —
vary the volume drivers underneath a plan and see the cases side by side with a
probability-weighted outturn. Build pricing models. Write and simulate risks, including _Monte
Carlo_ runs. Export reports.

**Scenario comparison saves nothing.** It is a calculator: the same drivers and the same
adjustments always give the same answer, so the assumptions are the record and the result can be
re-derived at any time. If a case is going to justify a budget submission, put the assumptions in
the submission comment — that is what gets kept.

### What the system will refuse, and why

**You cannot submit a budget.** You can build it completely; someone with ownership of the unit
must submit it. This is not a lack of trust — it is what makes the eventual approval meaningful.
A number that was prepared and submitted by the same person, then approved by a third, has had
two pairs of eyes on it. That is the design.

**You cannot see margin** on a pricing model (`pricing:view_margin`). You can build the entire
cost volume, apply _burden pools_, set fee, and produce a price. What you cannot see is the
profitability position on the bid. This lets an estimator price a bid honestly without being
influenced by, or accountable for, the commercial position.

**You cannot publish a forecast** as the unit's official view, only run it.

### What you are accountable for

Every budget line you write is version-snapshotted with your name as _preparer_. When a budget is
later approved, the record shows you prepared it. If a number is wrong, the trail leads to you —
and equally, if a number is right and later questioned, the trail defends you.

Your figures should be reproducible. If you used a forecast method, say which in the assumptions;
if you used a _Monte Carlo_ simulation, record the seed. The platform makes seeded runs
reproducible precisely so a figure can be re-derived a year later.

---

## Budget Owner

Accountable for one business unit's numbers. The first role that can commit something.

### What you can do

Everything an Analyst can, plus: **submit** a budget for approval, **publish** a forecast as your
unit's view, and **see margin** on pricing.

### What the system will refuse, and why

**You cannot approve your own budget** — nor anyone else's, because Budget Owner does not carry
`budget:approve` at all. If you try, you are told a different approver is required.

**You cannot approve above 250,000** even where approval is otherwise available to you, because
that is the default _delegated authority_ limit for the role. Above it, the request must be
escalated to a Finance Manager or the CFO. Your personal limit may have been set differently.

**You cannot reopen a locked budget.** Once the CFO locks the baseline it is terminal. Raise a
_reforecast_ or a budget transfer instead.

### What you are accountable for

**Submitting is the moment of commitment.** Before you submit, the numbers are a draft. After
you submit, they are your unit's stated position, recorded with your name and the timestamp,
and they become the basis on which your unit is measured.

You are accountable for the assumptions, not only the totals. If your budget assumes a 9.2%
energy tariff and that assumption came from the _guideline pack_, say so. If it did not, say
that too — a submission built on different assumptions from the published guidance is likely to
be returned.

You are accountable for meeting the **submission deadline**. Late submissions are consolidated at
the top-down target rather than your bottom-up build, which means someone else's number becomes
your budget.

---

## Finance Manager

Runs the cycle and approves the work of others.

### What you can do

Everything a Budget Owner can, plus: **approve** budgets up to 2,000,000, **sign off bid prices**
up to the same limit, **manage cycles** (open them, set deadlines), **publish the guideline pack**,
**import actuals**, **accept risks**, **issue leadership packs**, **read the audit trail**, and see the user list.

### What the system will refuse, and why

**You cannot approve a budget you prepared or submitted.** This is _separation of duties_ and it
has no exemption — not for you, not for the CFO, not for an administrator. If you prepared it,
someone else approves it. The refusal names this explicitly.

**You cannot approve above 2,000,000.** Escalate to the CFO. This applies to a **bid price** as
well as to a budget, and it is measured against the total price of the pursuit — most large bids
will exceed your limit and need the CFO.

**You cannot sign off a price you built.** Separation of duties applies to pricing exactly as it
applies to budgets, and for the same reason.

**Issuing a leadership pack freezes it.** The pack on screen is rebuilt from live data every time
it is opened, which is right for working with and wrong for a record: reopen it next month and the
numbers have moved. Publishing stores it exactly as it stands, under your name. Do it before the
review, not after — the point is that a figure someone questions in the meeting can be traced back
to what was actually tabled.

**You cannot lock a budget.** Locking makes a budget the reporting baseline and is reserved for
the CFO.

**You cannot verify the audit chain.** You can read the audit trail; running the cryptographic
verification is reserved for the CFO and the administrator. The person who approves the numbers
is not the person who certifies that the record of those approvals is intact.

### What you are accountable for

**Your approval is a control, not a formality.** It asserts that you have examined the submission
and that it is within your authority. It is recorded permanently and it is the specific thing an
auditor will sample.

**A price sign-off is the more consequential of the two.** A budget is an internal plan that can be
revised next quarter; a price is what the business commits to a client and cannot take back. Sign
off the version, not the pursuit — re-pricing a bid clears the approval automatically, so a figure
that has moved since you looked at it is never still carrying your name. If assumptions change
after you have signed, **withdraw the approval**; you do not need to be the person who gave it.

You are accountable for the **integrity of the cycle**: that the guideline pack was published
before people started work, that deadlines were realistic and communicated, and that actuals were
loaded accurately and on time. Variance analysis is only as good as the actuals underneath it.

When you **return** a budget, record why. The person revising it sees your comment and nothing
else — a rejection with no reason is a round trip wasted.

---

## Chief Financial Officer

Final financial authority.

### What you can do

Everything a Finance Manager can, plus: approve **without limit** — budgets and bid prices
alike — **lock** an approved budget as
the reporting baseline, and **verify the audit chain**.

### What the system will refuse, and why

**Separation of duties still applies to you.** Being the CFO does not let you approve something
you prepared or submitted. This is stated in the platform's own conventions as a rule that must
never gain a role exemption, and it is tested.

**Locking is terminal.** Once locked, the budget cannot be amended by anyone, including you. The
only routes are a reforecast or a transfer.

### What you are accountable for

**Locking is the moment the organisation commits.** After it, every variance report measures
against that baseline, and every report already issued stays valid. Locking a wrong number is
expensive to undo — not technically, but organisationally.

**Chain verification is yours.** The audit trail is hash-chained so that any edit or deletion is
detectable, but detection requires someone to run the check. If nobody verifies, the property is
theoretical. Verify on a schedule, and treat a failure as an incident rather than a bug.

Note the honest limit: verification proves the chain is internally consistent. It does not defend
against someone with direct access to the server who can also read the signing salt. See
[the audit threat model](audit-threat-model.md) for what is and is not covered.

---

## System Administrator

Runs the platform. **Not a finance role** — and, unlike every other role, not a superset of the
one below it.

### What you can do

**Observe** — read budgets, cycles, forecasts, pricing, risk and reports, so you can support the
people using them. **Audit** — read the audit trail and verify the hash chain, which is properly
your job precisely because you are not party to what it records. **Administer** — manage users
(create, deactivate, set roles and per-user approval limits), manage settings, and import
reference data: the chart of accounts and the business-unit hierarchy.

### What you cannot do

**Anything financial.** You cannot write, submit, approve or lock a budget, manage a cycle,
publish guidance, run or publish a forecast, price a bid, approve a price, see the margin on one,
accept a risk, import actuals, or publish a leadership pack. Your default approval limit is zero,
and budget transitions require the permission as well as the seniority — so outranking the CFO
buys you nothing here.

This is segregation of duties between administering a system and transacting in it. An identity
that can both manage users and approve unlimited spend is the first thing an auditor looks for,
and until recently this role was exactly that.

**What it does and does not achieve, stated honestly.** You hold `user:manage`, so you can change
a role or reset a password — financial authority remains _reachable_. What has changed is that
reaching it is no longer silent. It now takes a deliberate alteration of an account, recorded
against your name in the audit chain, rather than an approval nobody had reason to question.
Detectable, not prevented.

### What the system will refuse, and why

**Separation of duties has no exemption for anyone, and you never reach it.** You are refused a
budget approval on the permission, a gate earlier than SOD-01 — with or without any involvement in
the budget. The CFO, now the most senior finance role, is the one that has to prove the SOD rule
still binds at the top; there is a test asserting it does, and another asserting you are refused
outright.

**You cannot delete a budget, and neither can anyone else.** No such capability exists anywhere in
the platform, for any role. A budget is amended, superseded or returned for revision. This is not
an omission — deleting one would leave audit entries referencing a record that no longer exists, in
a chain that still verifies, and would move the baseline underneath reports already issued. If
something must be taken out of the numbers, supersede it with a new version or a reversing entry,
so both remain visible and the history stays readable.

### What you are accountable for

**If you also have a finance function, hold a second account for it.** The platform now refuses
you financial actions outright, so the separation is enforced rather than advisory — but that only
helps if the finance work is done under an identity that carries the accountability for it.

**Deactivation takes effect immediately** — the platform re-reads the user on every request rather
than trusting the token, so a deactivated account loses access at once rather than when its
session expires. Use this rather than deleting people; deletion breaks the attribution the audit
trail depends on.

**Per-user approval limits are a governance decision, not a convenience.** Raising someone's limit
changes what they can commit the organisation to. Record why, outside the platform, before you do
it.

---

## When the system says no

These are the refusals you are most likely to meet. All are deliberate.

| What you see                                                | What it means                                             | What to do                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| _Your role does not permit this action_                     | The capability is not part of your role.                  | Ask the role that holds it — see the matrix in Appendix A. |
| _You cannot approve a submission you prepared or submitted_ | _Separation of duties_. No exemption exists for any role. | Find a different approver. This is not escalable.          |
| _Amount exceeds your delegated authority_                   | The value is above your approval limit.                   | Escalate to a Finance Manager or the CFO.                  |
| _This budget is locked_                                     | It is the reporting baseline and is terminal.             | Raise a reforecast or a budget transfer.                   |
| _Moving a budget to X requires role Y_                      | Role seniority, checked before your authority limit.      | Escalate. A higher limit will not help.                    |
| _This account is no longer active_                          | The account was deactivated since you signed in.          | Contact your administrator.                                |
| _Too many requests_                                         | Rate limiting, most often repeated sign-in attempts.      | Wait a minute and retry.                                   |

Three of these — separation of duties, delegated authority, and the locked baseline — are
**recorded controls** with identifiers (`SOD-01`, `DOA-01`, `VER-01`). They appear in the control
register an auditor will ask for. Meeting one means the platform is working.

---

## Appendix A — Permission reference

The authoritative capability matrix. `Y` means the role holds the permission.

<!-- BEGIN PERMISSION MATRIX -->

| Permission                  | Viewer | Analyst | Owner | Fin Mgr | CFO | Admin |
| --------------------------- | :----: | :-----: | :---: | :-----: | :-: | :---: |
| `actuals:import`            |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `audit:read`                |   ·    |    ·    |   ·   |    Y    |  Y  |   Y   |
| `audit:verify`              |   ·    |    ·    |   ·   |    ·    |  Y  |   Y   |
| `budget:approve`            |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `budget:lock`               |   ·    |    ·    |   ·   |    ·    |  Y  |   ·   |
| `budget:read`               |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `budget:submit`             |   ·    |    ·    |   Y   |    Y    |  Y  |   ·   |
| `budget:write`              |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `cycle:manage`              |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `cycle:read`                |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `forecast:publish`          |   ·    |    ·    |   Y   |    Y    |  Y  |   ·   |
| `forecast:read`             |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `forecast:run`              |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `guidance:publish`          |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `pricing:approve`           |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `pricing:read`              |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `pricing:view_margin`       |   ·    |    ·    |   Y   |    Y    |  Y  |   ·   |
| `pricing:write`             |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `report:export`             |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `report:publish_leadership` |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `report:read`               |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `risk:accept`               |   ·    |    ·    |   ·   |    Y    |  Y  |   ·   |
| `risk:read`                 |   Y    |    Y    |   Y   |    Y    |  Y  |   Y   |
| `risk:simulate`             |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `risk:write`                |   ·    |    Y    |   Y   |    Y    |  Y  |   ·   |
| `settings:manage`           |   ·    |    ·    |   ·   |    ·    |  ·  |   Y   |
| `user:manage`               |   ·    |    ·    |   ·   |    ·    |  ·  |   Y   |
| `user:read`                 |   ·    |    ·    |   ·   |    Y    |  Y  |   Y   |

<!-- END PERMISSION MATRIX -->

> This table is **checked against the running code** by
> `packages/shared/src/user-manual.test.ts`. If someone changes a role's permissions without
> updating this manual, that test fails. A manual that can drift silently is worse than no
> manual, because people rely on it.
