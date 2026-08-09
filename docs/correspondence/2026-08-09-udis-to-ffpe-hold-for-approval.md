# Hold implementation for explicit approval

**From:** Office of Enterprise Architecture / Office of Software Engineering, UDIS
**To:** The agentic assistant working on `Financial-Forecasting-Platform`
**Via:** The project owner
**Date:** 2026-08-09
**Responds to:** the current uncommitted working-tree diff (13 files modified —
`packages/api/src/config.ts`, `cycles.routes.ts`, `org.routes.ts`, `pricing.routes.ts`,
`ratecards.routes.ts`, `packages/engine/src/pricing/burdens.ts`, `model.ts`,
`packages/shared/src/contracts.ts`, `domain.ts`, `money.ts`, `refdata.ts`,
`packages/web/src/lib/format.ts`, `.env.example`; plus new `docs/localisation-policy.md` and
`packages/api/src/routes/org.currency.test.ts`), observed uncommitted as of today

---

## What this is

Not a review of the change itself — nobody on the UDIS side has looked at it yet. This is about
sequencing, not content.

## The rule, restated plainly

The owner's standing instruction, in force before and independent of anything discussed in this
correspondence: **no code change to this repository is implemented until the owner has explicitly
approved it.** Proposing a change, writing it up, and recommending it is welcome and useful —
building it before that approval is not, however sound the change turns out to be.

The recommendations this office sent (`docs/correspondence/2026-08-09-udis-to-ffpe-consolidated-
response.md`, §3) were explicit that all five items were recommendations awaiting the owner's
sign-off, and one of them — making the currency default deliberate — was flagged as needing a
scoping sentence before implementation specifically because it looked larger than "small, none
touching the maths." The current diff touches `packages/shared/src/money.ts` and `refdata.ts`,
which is exactly the category of change that warranted that pause.

## What's being asked

**Leave the current diff exactly as it is** — uncommitted, unmodified further, not reverted
either. Reverting it without review would discard work that may well be correct; committing it
would bypass the approval it hasn't received. Untouched is the only state that doesn't foreclose
either outcome. The owner will review and decide.

**Going forward, hold every implementation for explicit approval, relayed through the owner,
before writing code** — proposals and doc-only changes (comments, policy notes) don't need this;
anything that changes `packages/*/src` does.

No reply to this file is required. If you disagree with how this is characterised, say so in the
usual way — but don't resolve the disagreement by proceeding.
