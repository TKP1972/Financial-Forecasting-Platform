# Session skills

Eight skills, loaded on demand rather than held in permanent instructions. Two sources, and the
difference matters when they disagree.

| Skill                                      | Origin    | Loads when                                                     |
| ------------------------------------------ | --------- | -------------------------------------------------------------- |
| `evaluate-engineering-doc`                 | Package   | Critiquing a research doc, spec or design                      |
| `refine-to-spec`                           | Package   | Turning a critique into an implementable spec                  |
| `plan-then-build`                          | Package † | Starting implementation                                        |
| `test-and-harden`                          | Package † | Writing tests, diagnosing failures, hardening                  |
| `pre-deploy-review`                        | Package   | Feature-complete, preparing to deploy                          |
| `verify-against-reality`                   | Earned    | Before declaring anything done, or showing it to a real person |
| `governance-and-correspondence-discipline` | Earned    | Decisions, measurements, cross-project correspondence          |
| `model-and-token-efficiency`               | Earned    | Session start, escalation decisions, cost review               |

† amended with practices from this workspace — see below.

## The two sources

**Package skills** came from a general Cowork playbook: a clean
research → evaluate → refine → plan → build → test → deploy pipeline. They are good at what they
cover and they are generic by design.

**Earned skills** were written from incidents in _these two projects_. Where they contradict the
package, they win — they were paid for.

## Where they contradict, and why the earned version wins

**The package optimises token spend. Two of its instincts are wrong here.**

_"Keep test loops on cheaper models"_ and general token hygiene are sound for volume work. But
almost every real defect in this workspace was found by **spending tokens on execution** — running
the full e2e suite, driving the UI in a browser, following the README from a cold start, running a
positive control against a suspiciously clean search. A green test suite and a passing CI had
already covered every one of them.

`model-and-token-efficiency` states the correction directly: economise on scope and model tier,
never on verification. `verify-against-reality` is the stage the package pipeline is missing
altogether — it sits between _test_ and _done_.

**The package says "plan before code". The real constraint here is stronger:** nothing under
`packages/*/src` changes without the owner's explicit approval, and a reviewing party's
recommendation is not that approval. `plan-then-build` carries this now.

## Reading order for a new session

1. `model-and-token-efficiency` — model and effort for the session ahead
2. `governance-and-correspondence-discipline` — if the work involves a decision, a count, or the
   other project
3. Whichever pipeline skill matches the stage
4. `verify-against-reality` — before saying it is done

## Keeping this honest

The package lives at `Claude_Cowork_AI_Engineer_Package/` as the pristine upstream copy; these
are the working versions and they have diverged. When a skill and the package disagree, the skill
is current.

Two duplications are known and deliberate:

- `Model_Selection_Cheat_Sheet.md` in the package overlaps `model-and-token-efficiency`. The
  cheat sheet carries a **dated price table**, which will go stale and be confidently wrong — the
  exact failure both projects have spent weeks fighting. Treat the skill as authoritative for
  routing rules and check current pricing at the source rather than from a document.
- Everything here also exists in `udis-platform`. Kept in sync deliberately, so a practice earned
  in one project is available in the other.

**The compounding rule:** after any session that surfaces a new trap or a corrected assumption,
put it in the relevant skill. That is the whole mechanism — the skills are only worth their token
cost if they absorb what was learned instead of it being re-derived next time.
