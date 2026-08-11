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

| Defect                                                | Found by                                          | What had already passed                            |
| ----------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `npm run test:e2e` executed **no suites at all**      | Running it                                        | CI, 1000+ unit tests                               |
| Documented quick start could not boot                 | Following the README from a cold start            | All of the above                                   |
| One e2e suite had no rate-limit backoff               | Running the full set back-to-back, not one suite  | The suite passing alone                            |
| Demo data buried under test fixtures                  | Opening the UI and looking                        | Every API test                                     |
| `git status` writing to `.git/index`                  | Running a test that asserted the property         | A read-only code review                            |
| Display rounding disagreeing with the engine          | Comparing the two outputs directly                | Both sides' own tests                              |
| An API advertising 12 periods where it enforced 36    | Behaving as a naive client and being refused      | Both endpoints' tests                              |
| A field-level permission enforced only in the browser | Asking the API with a non-holder's own token      | The screen showing "Restricted"                    |
| Every money figure roughly 4x too high                | Reading the number and asking if it could be true | 1,201 unit tests, 7 e2e suites, 4 browser journeys |

None of these were subtle. All were invisible from inside.

The last two share a shape worth naming on its own.

## Two definitions of one rule will diverge

Whenever a system **states** a constraint in one place and **enforces** it in another, those two
will eventually disagree, and the disagreement is invisible to tests written on either side.

Both endpoints had passing tests. The endpoint that advertised a cycle's period axis computed it
with one helper; the validator that rejected budgets computed it with another. Each was correct
about its own answer. A client that read the first and obeyed it was refused by the second, with
an error that read as the client's own mistake.

Ask, of any rule a caller must satisfy:

- What does the system **tell** a caller the rule is?
- What does the system **actually enforce**?
- Are those the same expression, or two expressions that happen to agree today?

The fix is not to test both harder. It is to make one call the other.

## A UI-side check is not a control

If a restriction can be satisfied by hiding a value in a component, assume it has been, and go
and look. Redaction applied in three of four handlers is the normal shape of this defect — not a
missing concept, but a rule applied by hand once per site.

Test it by **asking the API directly with the restricted user's own token** and searching the
whole response recursively for what should not be there. Naming the fields you expect to find is
how the leak got in: the developer named the fields too, and missed the same one.

Worth checking for the inverse at the same time. Over-restriction is equally a defect and much
less likely to be reported, because the user who cannot do their job assumes they lack a
permission rather than that the product is broken.

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

When driving a UI programmatically, **dispatch real events at real coordinates** and confirm the
element at that point is the one aimed at. A synthetic `element.click()` fires the handler on a
control that is zero-sized, scrolled away, or covered by an overlay — all broken for a human, all
green in the test.

And **verify the effect against a different source than the one that caused it**. A screen
rendering an optimistic success over a failed mutation passes every assertion made by reading
that screen.

### Ask whether the number could be true

Structural correctness is not plausibility, and almost nothing asserts the latter. A figure can
have the right type, the right shape, no error anywhere, and still be impossible.

Three reporting defects in this workspace survived a full suite because each produced a
well-formed number. What caught them was reading the output: 333% utilisation, a negative
remaining budget larger than the budget, every status indicator red, a board pack claiming a 39.5%
favourable variance for a business spending to plan. The causes were unrelated to each other; the
symptom was the same, and so was the detection method.

For anything that computes a figure a human will act on, add a **loose range check** against known
demonstration data — a proportion between 0 and 1.5, a total no more than twice its own
denominator, not every indicator the same colour. Keep it loose on purpose: a tight bound breaks
on every reasonable data change and gets deleted, while a loose one only fires when something is
genuinely broken.

Two cautions, both learned by getting them wrong:

- **Check the right subject.** The first version of that check took "the newest open cycle" and
  landed on a test fixture with a budget and no spend, where 100% variance and all-red are
  correct. A plausibility check that cries wolf is worse than none. Resolve the subject by the
  property you need — the cycle that _has_ data — rather than by position in a list.
- **Two screens showing one concept must be compared to each other.** Both figures were correct
  from their own inputs; only putting them side by side showed a $531m gap. Neither suite could
  have found it, because each checked one screen against itself.

### A refusal is not automatically a defect

Judge a 4xx by what the user is shown, not by its presence in the network log.

A permission check that fires is the control **working**. What decides defect-or-not is whether
the screen then explains it. So the assertion is "every refusal is explained", never "no
refusals" — the latter reports correct behaviour as broken. Written the wrong way round first,
it flagged three working controls as bugs: a restricted audit trail, a masked pricing margin, and
a login rate limiter, each of which already named the reason on screen.

The corollary matters more: **before reporting a refusal as a defect, go and read what the user
sees.** Reporting three non-problems costs the owner's trust in the next real finding.

### Never discard the evidence of a failure

Piping a run through `tail`, `grep` or `>/dev/null` while it is failing destroys the only account
of what happened. This was done three times in one session here: a `tail -14` that hid which
assertion failed, a suppressed `db:reset` that had silently been refused by a safety gate while
"reseeding" was reported as done, and a `tail -12` that lost the reason a suite failed — leaving
"unexplained, passes now" as the only honest answer available afterwards.

**Write the full output to a file and read the file.** Summarise from the log, not instead of it.
The cost of keeping it is nothing; the cost of losing it is either a wrong theory or a second run.

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
- [ ] Any rule the system **states** to a caller is the same expression it **enforces**
- [ ] Any restriction visible in a UI was confirmed at the API with the restricted user's token
- [ ] Every refusal found was judged by what the user is shown, before being called a defect
- [ ] A claim the product makes **in its own words** to the user was checked against the facts
- [ ] Every headline figure was read and judged **possible**, not merely well-formed
- [ ] Where two screens report one concept, they were compared **to each other**
