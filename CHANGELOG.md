# Changelog

Notable changes to the Financial Forecasting Platform.

## How to read this

Entries are grouped by the thing a user cares about, not by the package that changed. One
category matters more than the rest:

> ### ⚠️ Calculation-affecting
>
> **A change that makes a number come out differently.** These are called out separately, with
> the old and new behaviour stated explicitly, because a figure that changes silently between
> releases destroys trust in every figure — including the ones that did not change.
>
> If you have issued a report, reconciled to another system, or defended a number to a board, this
> is the section to read. Nothing else in a release can invalidate work you have already done.

A calculation-affecting entry always states: **what changed, which figures move, by how much, and
whether previously issued reports remain valid.**

Other categories: **Added**, **Changed**, **Fixed**, **Security**, **Documentation**.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is
[semantic](https://semver.org/); a calculation-affecting change is a **minor** bump at minimum,
never a patch, however small the code diff.

---

## [Unreleased]

### ⚠️ Calculation-affecting

- **Displayed money and percentages now round half-to-even (banker's rounding), matching the
  arithmetic.** Display previously went through `Intl.NumberFormat`, whose default is half-expand,
  so a displayed figure could disagree with the stored one on an exact tie.

  | Value       | Before  | After   |
  | ----------- | ------- | ------- |
  | 0.125 (2dp) | `$0.13` | `$0.12` |
  | 0.145 (2dp) | `$0.15` | `$0.14` |
  | 7.25% (1dp) | `7.3%`  | `7.2%`  |

  **Which figures move:** only values that are an exact tie at the displayed precision — a `5` in
  the first dropped digit and nothing after it. In practice that is rare in aggregate totals and
  more common in unit rates and percentages.

  **Are issued reports still valid?** Yes. **No stored value changed** — this is presentation only,
  and the underlying amounts were always rounded half-to-even. A report reissued from the same data
  may show a penny difference on affected lines, and the new figure is the one consistent with the
  stored value.

### Added

- **Fiscal calendars other than January.** A budget cycle now carries its own fiscal year start
  month and labelling convention, seeded from `FISCAL_YEAR_START_MONTH` and
  `FISCAL_YEAR_LABEL_BY`. Covers UK and India (April), Australia and New Zealand (July), Japan
  (April) and US federal (October). Stored per cycle so changing the deployment setting never
  re-dates a year already closed. **Period keys are unaffected**, so the budget-to-actual join does
  not move.
- `scripts/init-env.mjs` — generates a working `.env` with real secrets, replacing a documented
  quick start that could not succeed.
- First tests for `packages/web`, covering the money formatters, the session store and the
  permission hooks.
- Audit-chain anchoring (`AUDIT_ANCHOR_SECONDS`), making tail truncation and chain rewriting
  detectable.

### Fixed

- **Stale approvals no longer survive into an editable state.** Returning a budget to `IN_REVIEW`
  now clears the approver and approval date, as returning to `DRAFT` already did. Previously an
  approved budget could be pulled back, edited, and still display the approver of the numbers that
  person actually signed off.
- **`?includeSuperseded=false` now means false.** The rolling-forecast endpoint used JavaScript
  truthiness, so the string `"false"` was read as `true` and superseded generations were returned
  from a read path that documents excluding them.
- Concurrent budget transitions now fail with a legible conflict rather than a database constraint
  message.
- `npm run test:e2e` ran no suites at all on Windows, because `;` is not a command separator in
  `cmd.exe`. It also reported only the last suite's exit status, so an earlier failure was
  discarded on every platform.

### Security

- The production placeholder guard now covers all four shipped credentials, not two.
  `POSTGRES_PASSWORD` and `SEED_ADMIN_PASSWORD` ship as working values in `.env.example`, and a
  known password on an account that can approve budgets is a real hole.
- The audit hash delimiter is written as `'\u0000'` rather than a raw NUL byte. Identical at
  runtime; the raw byte rendered as a space and was one normalising save away from silently
  changing the hash preimage.

### Documentation

- User manual, glossary, calculation methodology, control matrix, data dictionary, operating
  calendar, localisation policy, audit threat model and this accessibility position.
- The user manual's permission matrix is checked against the code by a test, so it cannot drift.

---

## Release checklist

Before tagging, for whoever is releasing:

- [ ] `npm run verify` passes
- [ ] `npm run test:e2e` passes against a freshly seeded database
- [ ] **Every calculation-affecting change is in its own section above**, with old and new values
      and a statement on whether issued reports remain valid
- [ ] Any new environment variable is in `.env.example` with a comment explaining it
- [ ] Any schema change has a migration, and the migration has been applied to a copy of
      production data rather than only to a fresh database
- [ ] `docs/` reflects the change — particularly the control matrix and the data dictionary, which
      external readers rely on
