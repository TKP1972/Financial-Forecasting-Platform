---
name: test-and-harden
description: Generate or improve tests, run/diagnose failures, apply minimal fixes, and apply a lightweight security/performance/robustness checklist. Use after implementation or when the user asks to test, debug, harden, or prepare code for production readiness.
---

# Test and Harden

## Goals

- Make the new or changed code reliably verifiable.
- Surface and fix real failures with minimal diffs.
- Apply a practical hardening pass before considering the work “done”.

## Process

### 1. Test Inventory

- Identify what already exists (unit, integration, e2e).
- List the critical behaviors from the refined spec that must be covered.
- Propose the smallest set of new or updated tests that give high confidence.

### 2. Implement / Update Tests

- Prefer focused tests that assert observable behavior.
- Follow the project’s existing test style and helpers.
- Keep test code itself simple and readable.

#### Test the refusal, not just the success

For anything that is a **control, guarantee, or invariant** — an authorisation rule, a limit, a
"this can never happen" — a test that exercises the happy path proves the feature works. It
proves nothing about the control.

**Write the test that attempts the forbidden thing and assert it is refused.** Both projects in
this workspace arrived at this independently, and in one case the new test failed on its first
run and exposed a real violation that a passing suite had covered for months.

Two refinements that turned out to matter:

- **Assert the specific reason, not just the failure.** Where several distinct controls produce
  the same status code or error class, a test asserting only "it failed" will pass for the wrong
  reason. That mistake was made and caught here: three separate controls all returned HTTP 403.
- **Assert nothing was written.** A control that raises _after_ a partial write still fails the
  test but leaves damage. Check that the write path was not entered.

#### Prove the test can fail

A test that cannot detect the defect it targets is worse than none, because it is trusted. Before
relying on a new test for something important: **break the thing on purpose, confirm the test
fails, then restore it.** Keep the restoration reliable — restore from a copy you made, not from
version control, if the file has uncommitted work in it.

**A suite that passes everything on its first run has not been shown to work.** It has been shown
to be consistent with the current behaviour, which is also what a suite asserting nothing does.

Where breaking the source is undesirable — someone else's code, an approval boundary, a
production path — **inject the defect into the running system instead**. For a browser suite that
meant, at runtime: overlaying a div on a button, setting a control to zero size, appending a
button that should not exist, and feeding the judgement function an unexplained error string. All
four were detected, which is what made the green run mean something.

Always include a **negative control** — something that must _not_ trip the check. A detector that
fires on everything reads exactly like a detector that works. The check "is this refusal
explained?" was confirmed both to flag a bare error and to tolerate a properly worded one.

#### A perfect fixture makes a correct-looking test vacuous

Whether an assertion can fail is decided by the **data it runs against**, not by how it is
written. A test can name the right property, call the right function and assert the right
comparison, and still be incapable of failing.

The instance: a forecasting suite asserted that linear regression beats a naive forecast — the
correct skill property — against a fixture of `1000 + i * 50`. OLS on a noiseless straight line is
exact, so that assertion holds for any implementation that is not actively broken. Its sibling
fixture was an exactly repeating seasonal pattern with no noise. Both tests passed for years and
neither could have detected a method that fell apart the moment real data arrived.

The fix is not a better assertion, it is a harder fixture: signal **plus noise**, seeded so a
failure is reproducible. Once the data is realistic the same assertion becomes a real claim —
here it separated methods scoring 0.59 from methods scoring 1.36 on the same series.

Two habits that follow:

- **Measure before setting a threshold, then set it with headroom.** Print what the code actually
  scores, record those numbers in the file, and pick a bound that asserts the property with room
  for a reasonable fixture change. A threshold sitting on the measured value breaks on the next
  edit; one set far away asserts nothing.
- **Prefer a bound that means something independently.** "MASE < 1" is definitional — it means
  beating the naive baseline — so it survives review in a way "MAPE < 4.2%" never does, because
  nobody can tell whether 4.2% was reasoned or fitted.

#### Leave shared resources as you found them

A suite that consumes something global must restore it before exiting. A rate limiter, a pool of
open periods, a fixture the next suite expects. The failure it causes lands on the _next_ suite,
which is the hardest place to diagnose it, and reads as a defect in code that is fine.

Prefer polling until the resource is actually available again over sleeping a fixed interval —
it is both faster and honest about what it is waiting for.

### 3. Run & Diagnose

- Run the relevant test command(s).
- For failures: diagnose root cause, propose the minimal fix, apply it, re-run.
- Avoid large speculative rewrites while chasing a failing test.

### 4. Hardening Checklist (lightweight)

Run through these and act only where relevant:

- [ ] Happy path works and is tested
- [ ] Important error / edge paths return correct results or errors (no silent failures)
- [ ] Inputs are validated at boundaries
- [ ] No obvious injection, path traversal, or secret leakage
- [ ] Resource cleanup (connections, files, locks) is handled
- [ ] Logging / observability is sufficient for the new paths
- [ ] Performance-sensitive paths avoid obvious N+1 or unbounded work
- [ ] Feature flags / config for risky behavior if appropriate

### 5. Convert a repeat offender into a build failure

If the same class of mistake has now happened twice, stop relying on remembering it. A
documented convention decays; a check that fails the build does not.

In this workspace the same invisible character was pasted into source **four times**, each time
by someone who knew about it — including once into the checker written to catch it, and once in
a form the checker missed. Each recurrence made the check stricter rather than the author more
careful, which is the only thing that has ever worked.

Cheap enforcement, in rough order of preference: a lint rule, a repo-invariant script wired into
the verify step, a test that parses the artefact and compares it to the code it documents.

### 6. Output

- Summary of tests added/changed
- Any remaining known gaps or risks
- Clear statement of current confidence level (ready for review / needs more work / ready for deploy consideration)
- **How the claim was verified** — a run, or an inference. Say which.

## Rules

- **A correct test against broken code stays red.** When a new test fails because the code is
  genuinely wrong, do not weaken the assertion, add an exception list, or reframe the defect as
  expected behaviour to get a green run. Report it, and fix the code — or get approval to, if the
  source is behind a gate. A suite edited to agree with a defect is worse than no suite, because
  it now certifies it.
- Prefer minimal fixes over broad refactors while in this skill.
- If a failure reveals a design-level problem, surface it and recommend returning to the spec or plan rather than papering over it.
- Use the cheapest capable model for pure test generation and simple fixes; escalate only for subtle concurrency, timing, or architectural bugs.
