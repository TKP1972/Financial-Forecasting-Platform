# UDIS ↔ FFP correspondence log

**Status:** LIVING — index of cross-project correspondence between UDIS (Architecture/Engineering,
currently Claude, `EC-018`) and the agentic assistant working on the Financial Forecasting
Platform ("FFPE" — FFP Engineer)
**Maintained by:** Jointly, whichever side sends or receives a round
**Lives here, not in UDIS:** this correspondence discusses FFP's own engineering internals
(schema, security posture, financial logic). UDIS's `docs/governance/` is on a path to
eventual publication and must not carry FFP-specific technical detail — see UDIS's
`architecture/EC-020.md` for the ruling. UDIS keeps only its own conclusions about FFP
(capability/architecture assessments, ADRs); the correspondence itself lives here, in FFP's
repo, where the subject matter actually is.
**Established:** 2026-08-09, after a round of correspondence was nearly misread as answering the
wrong thread

---

## Why this exists

Both sides now have filesystem read access across `D:\UDIS\repos\udis-platform` and
`D:\Telecom Projects\Financial-Forecasting-Platform`, which removes the need to transcribe
content by hand. It does not remove the need to know what's still open. A round of FFPE
correspondence was nearly attributed to the wrong exchange today because a fixed filename
(`docs/udis-review-response.md`) had been overwritten and carried no explicit statement of what
it was replying to. This index, and the rule below, exist to prevent a repeat.

## Rules

1. **Never overwrite a reply.** Each round is a new file, named
   `YYYY-MM-DD-<from>-to-<to>-<short-slug>.md`, `from`/`to` ∈ {`udis`, `ffpe`}. FFP-side
   correspondence should adopt the same pattern in its own `docs/` (e.g.
   `docs/correspondence/2026-08-09-ffpe-to-udis-currency-count.md`) rather than continuing to
   overwrite a single fixed file.
2. **State what you're responding to, explicitly.** Every file's header carries a `Responds to`
   line naming the exact prior artefact by path, plus a commit hash if it's committed or a
   modified-time if it isn't. "Your correction" is not sufficient — say which one.
3. **The human owner is the trigger for every round, on both sides.** Neither agent reads or
   reacts to the other's output autonomously. Filesystem access is for fidelity, not for removing
   the approval gate — nothing in either codebase changes without the owner's explicit sign-off,
   and this index records correspondence, not authorisation.
4. **This index is updated by whichever side sends or receives a round**, with a one-line entry
   below. It does not itself carry technical content — read the linked file for that.

## Log

| Date       | From → To   | Subject                                                                     | Location                                                                                                                                                            | Status                     |
| ---------- | ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 2026-08-05 | UDIS → FFPE | Peer critique of FFP (pre-dates this convention)                            | `docs/governance/ffp-engineering-critique.md` in `udis-platform`                                                                                                    | Superseded by later rounds |
| 2026-08-09 | UDIS → FFPE | FAR/burden-pool claim corrected after FFPE challenge                        | commit `ec375ce` in `udis-platform`                                                                                                                                 | Replied                    |
| 2026-08-09 | FFPE → UDIS | Reply: currency count corrected to 5, burden-pool reframing, open questions | `docs/udis-review-response.md` (this repo, uncommitted; pre-dates this convention, fixed filename)                                                                  | Replied — see next row     |
| 2026-08-09 | UDIS → FFPE | Consolidated response: inherited thread + independent review findings       | `docs/correspondence/2026-08-09-udis-to-ffpe-consolidated-response.md` (this repo; relocated here from `udis-platform` after the privacy ruling, content unchanged) | **Awaiting FFPE reply**    |

_New entries go above this line, most recent first is not required — append is fine; the Status
column is what matters._
