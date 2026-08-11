---
name: plan-then-build
description: Force a short, reviewable implementation plan before any code is written. After plan approval, implement in small vertical slices with verification after each slice. Use when starting implementation of a feature, module, or bugfix from a refined spec.
---

# Plan Then Build

Never jump straight to code for non-trivial work. This skill enforces a plan → approve → implement → verify loop that reduces wasted tokens and rework.

## Phase 1 – Plan (read-only)

1. Confirm the source of truth (refined engineering document / PRD / issue).
2. Identify the smallest set of files/modules that will be touched.
3. Produce a short plan with:
   - Ordered implementation steps (vertical slices preferred over horizontal layers)
   - Key risks or unknowns
   - Verification method for each step (which tests, manual checks, or success criteria)
   - Suggested model/effort for any particularly hard steps
4. Stop and wait for explicit approval or requested changes to the plan.

**Do not write production code in Phase 1.**

### The approval boundary is the owner's, and it does not transfer

In this workspace the standing rule is stronger than "make a plan first": **nothing under
`packages/*/src` changes without the owner's explicit approval.** Documentation, comments and
policy notes do not need it; anything that alters behaviour does.

Three things learned about applying that:

- **Approval for one thing is not approval for the next.** A broad "go ahead" covers the scope
  that was discussed, not whatever turns out to be adjacent to it.
- **A reviewing party's recommendation is advice, not authorisation.** Where a second session or
  office proposes a change, it still waits for the owner. Treating a peer's "approve" as the gate
  is how a review turns into a decision nobody made.
- **Some tools carry their own gate, and prior conversation does not satisfy it.** A destructive
  database command here refuses agent-initiated runs and requires the owner's consent text for
  that specific invocation. Do not route around a gate like that; surface it.

When a plan turns out to be wrong mid-build, stop and re-seek approval rather than adapting
silently — the adaptation is a new plan, and it was the old one that was approved.

## Phase 2 – Build (after approval)

- Implement one slice at a time.
- After each slice:
  - Show the minimal diff or new files.
  - Run or describe the verification for that slice.
  - Only proceed to the next slice when the current one is verified or the user explicitly says to continue.
- Prefer minimal, focused changes that follow existing patterns in the codebase.
- Update or add tests as part of the slice, not as an afterthought.

## Phase 3 – Wrap-up

When all planned slices are done (or the user stops):

- Summarize what was implemented vs the plan.
- Note any deviations and why.
- Propose the next verification or hardening steps (can hand off to `test-and-harden`).

## Style & Token Rules

- Keep the plan itself short (ideally one screen).
- In the build phase, avoid re-explaining the whole design; reference the approved plan and the refined spec.
- If a slice reveals that the plan was wrong, stop, update the plan, and re-seek approval rather than silently continuing.
