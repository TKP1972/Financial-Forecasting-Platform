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

- Prefer minimal fixes over broad refactors while in this skill.
- If a failure reveals a design-level problem, surface it and recommend returning to the spec or plan rather than papering over it.
- Use the cheapest capable model for pure test generation and simple fixes; escalate only for subtle concurrency, timing, or architectural bugs.
