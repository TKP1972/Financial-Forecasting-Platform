---
name: verify-against-reality
description: Exercise the actual artefact the way a stranger would, rather than reasoning about whether it works. Use before declaring work done, before showing anything to a real user, after changing anything a documented setup path touches, or whenever the evidence for "it works" is a passing test suite rather than a run.
---

# Verify against reality

The research → evaluate → refine → plan → build → test pipeline has a gap between **test** and
**done**. Tests verify what someone thought to test. This skill covers what they didn't.

It exists because in this workspace, **almost every real defect was found by running something,
not by reading or reasoning about it** — and in every case a full test suite, a green CI, and a
careful review had already passed over the same code.

| Defect                                           | Found by                                         | What had already passed |
| ------------------------------------------------ | ------------------------------------------------ | ----------------------- |
| `npm run test:e2e` executed **no suites at all** | Running it                                       | CI, 1000+ unit tests    |
| Documented quick start could not boot            | Following the README from a cold start           | All of the above        |
| One e2e suite had no rate-limit backoff          | Running the full set back-to-back, not one suite | The suite passing alone |
| Demo data buried under test fixtures             | Opening the UI and looking                       | Every API test          |
| `git status` writing to `.git/index`             | Running a test that asserted the property        | A read-only code review |
| Display rounding disagreeing with the engine     | Comparing the two outputs directly               | Both sides' own tests   |

None of these were subtle. All were invisible from inside.

## The core move

**Do the thing, then look at the result.** Not: infer that the thing would work.

Concretely, prefer in this order:

1. **Run the command** rather than reading the script.
2. **Follow the written instructions literally**, from the state a stranger starts in.
3. **Look at the output** — the screenshot, the rendered page, the actual bytes — not a summary
   of it.
4. **Run the whole set**, not the one piece you changed. Interactions between steps are where
   the shared-resource bugs live (rate limits, ports, database state, fixtures).

## Checks that repeatedly paid for themselves

### Cold-start the documented path

Whatever the README, quick start, or runbook says — do exactly that, from nothing. Not from your
working environment, which is already configured and therefore cannot fail the way a new one
does.

This is the single highest-yield check available and it is almost never run, because the person
who wrote the instructions already has everything installed.

### Drive the real artefact

For a UI, open it and look at the screenshot. A blank frame, a `NaN`, or a screen full of test
fixtures is invisible to an API test suite and obvious to an eye.

For a CLI, run a representative command and read the output. For an API, call it over HTTP rather
than through a mocked client.

### Run it twice, and run it after everything else

Idempotence and ordering bugs only appear on the second run or when a suite runs last. A step
that passes alone and fails in sequence is a real failure, not a flake — something earlier
consumed a shared resource.

### Compare the two things that should agree

When two parts of a system independently compute or format the same value, print both and
compare. Do not reason about whether they agree.

### Verify a fix the way you verified the finding

If a check caught it, that same check must fail before the fix and pass after. A plausible-looking
change is not a verified one. For a control or a guarantee, this means **writing the test that
attempts the forbidden thing** and confirming it is refused.

## What this is not

Not an argument for expensive verification everywhere. It is an argument about _where_ the
remaining risk actually is once the tests are green — and about the specific claim
"it works," which needs a run behind it rather than an inference.

If the artefact has genuinely been exercised and the evidence is a run rather than a
deduction, this skill has nothing to add and you should move on.

## Before saying "done"

- [ ] The thing was **run**, not just built and tested
- [ ] The documented setup path was followed from a cold start, or is known not to have changed
- [ ] Output was **looked at**, not summarised
- [ ] The full suite ran, in order, not just the changed part
- [ ] Anything claimed to be fixed has a check that fails without the fix
- [ ] Anything claimed to be impossible has a test that attempts it and is refused
