# Control matrix

The financial controls this platform enforces, what each prevents, how it is enforced, and the
evidence that it works.

Written for the conversation that begins _"what stops someone approving their own budget?"_ —
from an auditor, a client's finance function, or your own board. Each control below can be
demonstrated on a running system in under a minute.

Two things distinguish this from a control register that merely asserts its controls exist:

- **Every control has a test that attempts the thing the control forbids** and confirms it is
  refused. A test that only exercises the happy path proves nothing about a control.
- **The live register is queryable.** `GET /api/v1/governance/controls` returns the controls in
  force, from the running system rather than from this document. Where the two disagree, the
  endpoint is right and this document is stale.

> Who holds each capability is in the [user manual](user-manual.md). How the numbers are derived
> is in the [calculation methodology](calculation-methodology.md).

---

## Summary

| ID         | Control                          | Prevents                                           | Status        |
| ---------- | -------------------------------- | -------------------------------------------------- | ------------- |
| **SOD-01** | Separation of duties             | Self-approval of budgets and of bid prices         | **ENFORCED**  |
| **DOA-01** | Delegated authority limits       | Commitment beyond a person's authority             | **ENFORCED**  |
| **AUD-01** | Tamper-evident audit trail       | Silent alteration or deletion of the record        | **ENFORCED**  |
| **VER-01** | Budget version snapshots         | An approved budget being changed after approval    | **ENFORCED**  |
| **LCK-01** | Locked baseline                  | The reporting baseline moving under issued reports | **ENFORCED**  |
| **PRC-01** | Commercial price sign-off        | A bid price committed to a client without approval | **ENFORCED**  |
| **PUB-01** | Issued report snapshots          | A tabled figure that cannot be reproduced later    | **ENFORCED**  |
| **DEL-01** | No deletion of financial records | History being removed rather than superseded       | **BY DESIGN** |
| **ADM-01** | Administration is not authority  | The system administrator committing spend          | **ENFORCED**  |

**ENFORCED** means refused server-side by the platform, not warned about and not left to
procedure. A user cannot opt out, and neither can an administrator.

**BY DESIGN** means the capability does not exist anywhere in the product, for any role. There is
nothing to bypass because there is nothing to call.

---

## SOD-01 — Separation of duties

**The control.** A budget cannot be approved by whoever prepared or submitted it, and a pricing
model cannot be approved by whoever built it (PRC-01).

**What it prevents.** One person originating a commitment and authorising it. This is the oldest
control in accounting and the one most often weakened in software, usually by an override added
for an urgent case that then becomes permanent.

**How it is enforced.** `assertSeparationOfDuties` is called inside the budget transition service,
before any write, on every transition to `APPROVED` or `LOCKED`. It compares the actor against the
recorded preparer and submitter. Refusal is HTTP 403 with code `SEPARATION_OF_DUTIES`.

**No exemption exists for any role.** The function takes no role parameter — there is no argument
through which an exemption could be passed. This is recorded in the repository's own conventions as
a rule that must never be relaxed. The CFO, the most senior finance role, is the case that proves
it binds at the top.

**The System Administrator never reaches this rule**, because it holds no financial authority to be
exempted from. A budget transition now requires the permission as well as the seniority
(`TRANSITION_PERMISSION` alongside `TRANSITION_MIN_ROLE`), and ADMIN holds none of the financial
permissions — so it is refused with `FORBIDDEN` a gate earlier, whether or not it is party to the
budget. Before this, ADMIN inherited every CFO permission and outranked every finance role, which
made "no ADMIN bypass of SOD" true and beside the point: it could approve anyone else's budget of
any size. See ADM-01.

**Evidence.**

| Test                                        | What it proves                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/rbac.test.ts`                   | The rule refuses preparer and submitter, and every role in turn.                                                                                                                                            |
| `api/src/routes/budgets.transition.test.ts` | The approval **endpoint** actually reaches the rule — preparer refused, submitter refused, applied to `LOCKED` as well as `APPROVED`, the CFO refused its own work, and the administrator refused outright. |
| `smoke-test.ps1`                            | Refused against a live stack.                                                                                                                                                                               |

Each negative test also asserts no database transaction was opened, so a control that raised
_after_ a partial write would still fail.

**To demonstrate.** Sign in as the user who submitted a budget and attempt to approve it. The
refusal names the control.

**Limit worth stating.** The control compares recorded identities. Two people sharing one account
defeat it, as they defeat every attribution control. Account sharing is a policy matter outside
the platform's reach.

---

## DOA-01 — Delegated authority limits

**The control.** An approval above the approver's limit is refused and must be escalated.

**What it prevents.** Commitment beyond the authority the organisation has granted. Seniority and
authority are separate: holding a senior role does not imply an unlimited limit, and the platform
checks role seniority **first**, then the amount.

**How it is enforced.** `assertWithinDelegatedAuthority` compares the budget total against the
actor's limit — their per-user override where set, otherwise the role default. Refusal is HTTP 403
with code `DELEGATED_AUTHORITY_EXCEEDED`, and the response carries both the limit and the amount so
the user can see the gap rather than guess at it.

| Role            | Default limit |
| --------------- | ------------- |
| Viewer, Analyst | none          |
| Budget Owner    | 250,000       |
| Finance Manager | 2,000,000     |
| CFO, Admin      | unlimited     |

Per-user overrides are a governance decision: raising someone's limit changes what they can
commit the organisation to, and the change is itself audited.

**Evidence.** `shared/src/rbac.test.ts` covers the comparison including boundary values;
`api/src/routes/budgets.transition.test.ts` proves the endpoint refuses an over-limit approval and
honours a per-user override, distinguishing this refusal from the role-seniority one by error
code — three separate controls all answer 403, and a test asserting only the status would pass for
the wrong reason.

**To demonstrate.** Attempt to approve a budget above your limit. Compare with a colleague whose
limit covers it.

---

## AUD-01 — Tamper-evident audit trail

**The control.** Every governed action is recorded in a hash chain. Any edit, deletion or splice
is detectable.

**What it prevents.** Silent alteration of the record. Not alteration itself — someone with
database access can change a row — but doing so _without leaving evidence_.

**How it is enforced.** Each entry carries a SHA-256 hash over its own fields plus the previous
entry's hash, salted per deployment. Verification walks the chain and re-derives every hash,
distinguishing three failures: content edited in place, `previousHash` spliced, and a sequence gap
from deletion. Audit rows are written **inside the transaction that caused them**, so an audited
action cannot succeed without its audit record.

**Evidence — and this is the one worth showing.** `verify-audit-tamper-detection.ps1` does not
confirm that an untouched chain passes. It:

1. verifies the chain is intact,
2. **edits a row directly in the database**, confirms detection _and correct location_,
3. restores it and confirms the chain verifies again,
4. **deletes a row**, confirms the gap is reported,
5. restores it and confirms full recovery.

Eight assertions against a live database. This is the difference between testing that a control
exists and testing that it works.

**Limits, stated because they are real.** Two are documented in full in
[the audit threat model](audit-threat-model.md):

- The salt lives in the API environment, on the same host as the database. **Someone who can alter
  rows can likely also read the salt and recompute a valid chain.** The control is effective
  against accidental modification, careless correction and casual tampering — which is what most
  audit trails actually face — and weaker against a privileged attacker.
- Truncating the tail of the chain is not detectable from the chain alone at any cost.

**Anchoring narrows both.** `AUDIT_ANCHOR_SECONDS` emits the chain head to sinks outside the
database, so a truncated tail or a rewritten chain can be caught by comparison against what was
witnessed. Residual risk is stated in the threat model rather than glossed.

**To demonstrate.** `POST /governance/audit/verify` as CFO or administrator. It reports entries
checked and the first failure if any.

**Operational requirement.** Detection requires someone to run the check. **If nobody verifies,
the property is theoretical.** Verify on a schedule and treat a failure as an incident.

---

## VER-01 — Budget version snapshots

**The control.** Every status transition freezes a complete copy of the budget.

**What it prevents.** An approved budget being edited afterwards and the approval appearing to
cover numbers it never saw. Without this, "the CFO approved it" is a claim about a document that
may since have changed.

**How it is enforced.** The transition service writes a version snapshot in the same transaction
as the status change. The snapshot is the whole budget, not a diff, so reproducing it requires no
replay.

**Evidence.** Covered by the transition tests and by `smoke-test.ps1`, which walks a budget through
its lifecycle and asserts a version exists at each stage.

**To demonstrate.** Open any approved budget and view its version history. Each entry is the budget
exactly as it stood at that transition.

---

## LCK-01 — Locked baseline

**The control.** A locked budget is terminal. It cannot be amended by anyone, including the CFO who
locked it.

**What it prevents.** The baseline moving under reports already issued. Variance reporting measures
against the baseline; if the baseline can change, every variance report ever produced becomes
unreproducible.

**How it is enforced.** `LOCKED` has no outbound transitions. The check runs before the legal-
transition check, so a locked budget produces `CONFLICT` rather than a confusing message about
which transitions are available. Locking requires the CFO role.

The onward routes are a **reforecast** or a **budget transfer** — both of which leave the baseline
intact and are themselves recorded.

**Evidence.** `api/src/routes/budgets.transition.test.ts` asserts a locked budget refuses to reopen
and that no transaction is opened. `smoke-test.ps1` confirms it against a live stack.

**To demonstrate.** Attempt any transition on a locked budget.

---

## PRC-01 — Commercial price sign-off

**The control.** A saved pricing model carries an explicit approval, given by someone who did not
build it and whose delegated authority covers the total price.

**What it prevents.** A price going to a client with nobody having authorised it. A budget is an
internal plan that can be revised; a bid price is a multi-year contractual commitment that cannot.
Before this control existed, anyone holding `pricing:write` — an Analyst, whose delegated authority
limit is zero — could persist a bid of any value at any margin with no second pair of eyes, while
an internal budget of $250,001 could not be approved by a Budget Owner. The governance was applied
to the less binding number.

**How it is enforced.** `approvePricingModel` requires `pricing:approve` (Finance Manager upwards),
then calls the **same** `assertSeparationOfDuties` and `assertWithinDelegatedAuthority` functions
the budget approval calls — not a reimplementation of the rules. Authority is checked against
total price, because that is the exposure being authorised. Refusals are HTTP 403 with codes
`FORBIDDEN`, `SEPARATION_OF_DUTIES` and `DELEGATED_AUTHORITY_EXCEEDED` respectively, so the reason
is never ambiguous.

**Approval is per version.** A pricing model is versioned per pursuit, and a new version is a new
row that starts unapproved. Re-pricing a bid therefore clears the sign-off by construction, rather
than by a rule someone has to remember to apply — the equivalent of the budget's "returning to an
editable status clears the prior sign-off", achieved through the data model instead.

**Withdrawal is deliberately not restricted to the original approver.** A price whose assumptions
have moved must stop being approved regardless of who is available; requiring the same person would
leave a stale approval standing exactly when someone has noticed it is wrong. The audit trail
records who withdrew it and why.

**Sign-off status is visible to every role**, including those without `pricing:view_margin`.
Whether a committed price carries an approval is a governance fact; the margin inside it is a
commercial one. Concealing the former would hide the control rather than the position it protects.

**Evidence.**

| Test                                      | What it proves                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/src/routes/pricing.approval.test.ts` | The endpoint reaches all three controls, each asserted by its own error code, with no write attempted on refusal; concurrent approval 409s.   |
| `scripts/ui-journey/journey-pricing.mjs`  | Against a live stack and a real browser: who is offered the control, who the server honours, that the effect is real, and that it is audited. |

---

## PUB-01 — Issued report snapshots

**The control.** A leadership pack can be _issued_: frozen exactly as it stands, attributed to the
person who issued it, and never recomputed.

**What it prevents.** A figure quoted in a review that cannot afterwards be traced to anything. The
pack is otherwise built live from budgets, actuals and forecasts. That is correct for a working
view and wrong for a record — reopening it a month later gives different numbers, and "the pack the
board saw on 11 August" ceases to exist the moment the underlying data moves.

This is the reporting analogue of LCK-01. The locked baseline stops the comparison moving; this
stops the issued report moving.

**How it is enforced.** `POST /reports/leadership-pack/publish` requires
`report:publish_leadership` (Finance Manager upwards). The pack is **built server-side from the
cycle id**, never accepted from the request body — a published record the caller could compose
would contain whatever they chose to send, which is the opposite of an issued artefact. The
snapshot and the audit entry commit in one transaction.

**Reading an issued pack requires only `report:read`.** What was published, and by whom, is not
privileged information; restricting it would hide the control from the people it exists to
reassure. An issued pack also outlives its publisher's account (`publishedById` is set null on
user deletion) — losing the record because someone left would defeat the purpose.

**Evidence.**

| Test                                     | What it proves                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/src/routes/reports.publish.test.ts` | The permission is reached before any write; the pack is built server-side and ignores caller-supplied contents; the stored snapshot is returned verbatim without rebuilding. |

---

## DEL-01 — Financial records are superseded, never deleted

**The control.** No delete capability exists for budgets, at any level of privilege. There is no
`budget:delete` permission, no route, and no administrative override.

**What it prevents.** Removal of history. The reasons are structural rather than a matter of
policy:

- **The audit trail would still verify while pointing at nothing.** Entries reference budget ids.
  Delete the budget and the hash chain remains internally consistent over records that no longer
  resolve — worse than a visible gap, because it looks intact.
- **Issued reports would silently change meaning.** Variance is measured against a locked baseline.
  Remove a budget and the comparison behind an already-distributed report moves.
- **An admin-only delete is the override shape SOD-01 warns about** — added for one urgent case,
  then permanent.

**What to do instead.** Amend the budget and let the version snapshots record the change; return it
for revision; or supersede it with a new budget, leaving both visible. If something must come out
of the numbers, that is a reversing entry, not a removal.

**A permission for this existed in the matrix for months while no route implemented it.** It was
removed rather than implemented — the fact that nothing had been built against it is the only
reason the question was still open.

**Evidence.**

| Test                             | What it proves                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `shared/src/rbac.test.ts`        | No permission ending in `:delete` exists in the matrix at all, for any role.            |
| `shared/src/user-manual.test.ts` | The published permission reference matches the code, so the manual cannot describe one. |

---

## ADM-01 — Administration is not financial authority

**The control.** The System Administrator holds no financial permission. It may observe (read
budgets, cycles, forecasts, pricing, risk and reports), audit (read the trail, verify the chain)
and administer (users, settings, reference data). It may not write, submit, approve or lock a
budget, manage a cycle, publish guidance, run or publish a forecast, price or approve a bid, see a
margin, accept a risk, import actuals, or publish a leadership pack. Its default approval limit is
zero.

**What it prevents.** The classic toxic combination: one identity that can both grant authority to
others and exercise unlimited authority itself. It is the first pairing an IT general-controls
review looks for, and the usual finding is a privileged operational account able to approve
business transactions.

**How it is enforced.** Two changes, and the second is what makes the first bite. `ROLE_PERMISSIONS.ADMIN`
is now defined explicitly rather than as a superset of `CFO` — the only role in the matrix that is
not a superset of the one below it. And budget transitions authorise on `TRANSITION_PERMISSION` as
well as `TRANSITION_MIN_ROLE`: the actor must be senior enough **and** hold the permission. Without
the second, removing permissions from ADMIN would have changed nothing, because ADMIN's rank of 60
satisfies every minimum in the seniority table.

**What it does not achieve, stated plainly.** An administrator holds `user:manage`, so it can
change a role or reset a password. Financial authority therefore remains _reachable_. What the
control changes is that reaching it is no longer silent: it costs a deliberate alteration of an
account, recorded in the audit chain against a named administrator, instead of an approval nobody
had cause to examine. **Detectable, not prevented** — the same standard `docs/audit-threat-model.md`
holds itself to, and the reason this is written down rather than claimed away.

**This gap was documented before it was closed.** The user manual asserted "deliberately not a
finance role" from the day it was written, while the matrix granted ADMIN every CFO permission and
an unlimited approval limit. A machine-checked permission table compared the manual's _matrix_
against the code and passed, because the contradiction lived in the _prose_. Documentation and
enforcement agreeing on a table is not the same as agreeing on a claim.

**Evidence.**

| Test                                        | What it proves                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `shared/src/rbac.test.ts`                   | ADMIN holds exactly 11 permissions, and each of the 17 financial ones is refused **by name** rather than derived. |
| `api/src/routes/budgets.transition.test.ts` | The endpoint refuses an administrator `FORBIDDEN` on `budget:approve`, involved in the budget or not.             |
| `shared/src/user-manual.test.ts`            | The published permission reference matches the code for every role, ADMIN included.                               |

---

## Supporting mechanisms

Not registered as controls in their own right, but each supports the ones above.

| Mechanism                     | Why it matters                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Role-based access control** | 28 permissions across 6 roles, checked server-side per route. Every one guards a route; see the user manual.                                                   |
| **Immediate deactivation**    | The user is re-read from the database on every request, so a deactivated account loses access at once rather than at token expiry.                             |
| **Canonical audit payloads**  | `changes` is stored as canonical JSON with sorted keys and hashed over those exact bytes. Storing it as JSONB would reorder keys and break every verification. |
| **Period locking**            | Closed periods refuse new actuals, so a restated prior period cannot silently change a published variance.                                                     |
| **Deterministic simulation**  | Monte Carlo takes an explicit seed, so a published contingency figure can be re-derived exactly.                                                               |
| **Money precision**           | Decimal throughout, banker's rounding, remainder-distributing allocation. Parts always sum back to the whole.                                                  |

---

## What this platform does not control

Stated because an assurance document that lists only strengths is not assurance.

- **No maker–checker on reference data.** Chart of accounts and business-unit imports are applied
  by an administrator without a second approval. The import is audited and validates before
  writing, but it is not dual-controlled.
- **No segregation between administration and finance.** The platform prevents an administrator
  from approving what they prepared; it does not prevent one person holding both an administrator
  account and a finance account. That is an account-provisioning policy, and the user manual says
  so directly.
- **No enforced verification schedule.** AUD-01 detects tampering when verification runs. Nothing
  in the platform compels it to run.
- **No control over the accounting system upstream.** Actuals are loaded from it and it remains the
  source of truth. Controls over how actuals are produced belong there.

---

## For an auditor

The fastest path to satisfying yourself, in order:

1. `GET /api/v1/governance/controls` — the live register, from the running system.
2. `POST /api/v1/governance/audit/verify` — chain integrity, with a count of entries checked.
3. Run `verify-audit-tamper-detection.ps1` and watch it tamper and detect. This is the one worth
   watching rather than reading about.
4. Sample any approved budget: its version history, and the distinct identities recorded as
   preparer, submitter and approver.
5. Attempt a self-approval as the preparer. Observe the refusal.

Steps 3 and 5 are the ones that distinguish controls that work from controls that are documented.
