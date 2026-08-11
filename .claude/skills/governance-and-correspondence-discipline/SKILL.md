---
name: governance-and-correspondence-discipline
description: Practices for recording decisions, verifying claims, and coordinating across UDIS and FFP sessions — developed through real incidents in both projects, not theory. Use when making an architectural or design decision, when a measurement or count needs to be trusted before acting on it, or when relaying findings to the other project's session.
---

# Governance and correspondence discipline

Six rules, each earned by a specific incident in this workspace, not asserted in the abstract.
Apply judgement about when a decision is big enough to warrant the full version of each — a
one-line fix doesn't need a decision record; a change to what a tool claims about itself does.

## 1. A decision isn't real until it's committed

Conversation and chat history are not a controlled location — several expensive corrections in
this project's history trace back to something agreed in discussion that existed nowhere else.
Before treating a non-trivial decision as settled, write a short record: what was decided, why,
what it affects, and how it's discharged. Commit it. A decision record doesn't need to be long —
it needs to exist somewhere other than the conversation that produced it.

## 2. A positive control before trusting a zero or a suspiciously clean result

A search or check that returns "nothing found" is indistinguishable from a broken instrument
unless it's also been run against something known to produce a hit. This project's single most
repeated failure pattern — six separate instances — was a confident claim resting on an
unverified measurement: a wrong file path silently returning an empty result, a `git status`
call that turned out to write to `.git/index` despite looking read-only, a CSV parser silently
corrupting a column name on a byte-order mark. Each was caught only once someone ran the check
against a case they already knew the answer to.

**Rule:** before reporting a zero, an "all clear," or a count, run the same check against a case
where you already know it should find something. If that also comes back empty, the instrument
is broken, not the target.

## 3. Declare, never infer

When wiring two things together — a relationship between two data files, a default value, a
naming convention — require an explicit declaration rather than a name-matching guess. Matching
`customer_id` to `customer_id` by string equality works right up until a real client's naming
isn't that clean, and a wrong inference fails _silently_ with a plausible-looking wrong answer.
A missing declaration fails loudly and gets fixed. When in doubt, make the caller state the
mapping as data rather than have the tool guess it.

## 4. Cross-session correspondence: dated files, never overwritten, explicit "responds to"

When two Claude sessions (different projects, or a project and a reviewing session) need to hand
work to each other asynchronously:

- Each round is a **new file**, named `YYYY-MM-DD-<from>-to-<to>-<short-slug>.md` — never
  overwrite a previous reply. A fixed filename that gets overwritten is how a reply gets
  misattributed to the wrong exchange.
- Every file states explicitly **what it responds to** — the prior file's path, and a commit
  hash or modified-time. "Your last message" is not enough once there's more than one thread.
- Keep an index (one line per round: date, from → to, subject, location, status) so either side
  can see what's open without reading every file.
- **The human stays the trigger for every round, on both sides.** Filesystem access between
  sessions is for fidelity of content, not for removing the approval gate — neither session
  should read or react to the other's output autonomously, and nothing changes in either
  project without the human's explicit sign-off.
- Correspondence about a project's own internals lives **with that project**, not with whoever
  is reviewing it — especially if the reviewing project is on a path to being published or
  shared more broadly than the subject matter should be.

## 5. Proportionality — check whether something already does the job

Before adding a new mechanism, a new identifier series, or a second document that says roughly
what an existing one says: check whether something already covers it. More than one real
decision in this project's history was "don't build a second thing — the first thing already
does this, formalise that instead." Governance that outgrows what it's governing is a real,
recurring failure mode, not a hypothetical one.

## 6. Own mistakes visibly, verify fixes with the same rigor as findings

When a claim turns out wrong or a bug is self-inflicted, record the correction rather than
quietly fixing it and moving on — the correction, including what was wrong and why, is worth
more than the original claim was. When fixing something a positive control caught, apply the
same discipline to the fix: confirm the fix actually closes the gap (a test that fails without
the fix and passes with it) rather than assuming a plausible-looking change worked.
