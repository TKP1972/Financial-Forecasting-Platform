---
name: model-and-token-efficiency
description: Model routing, effort selection, and context-hygiene practices for working efficiently across Claude Code and Cowork sessions in this workspace. Use when starting a session, deciding whether to escalate model or effort, or reviewing why a session burned more tokens than expected.
---

# Model and token efficiency

Adapted from a generic Cowork setup guide, corrected against what actually happened running this
project: efficiency is about not spending tokens on the _wrong_ things — over-scoped context, the
wrong model tier, restating what's already known — not about skipping verification. Several of
the most valuable things done in this project (running a full test suite, a positive control
against a suspiciously clean search result, actually executing a CLI command instead of trusting
a code review) cost real tokens and were exactly the right spend. Don't apply this guide to those.

## Model routing

| Model        | Best for                                                                                      | Avoid for                                     |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Haiku 4.5    | Mechanical, high-volume, low-judgment: extraction, formatting, classification, sub-agent work | Nuanced judgement, multi-step reasoning       |
| Sonnet 5     | Default. Everyday coding, analysis, writing, agentic work — 80–90% of tasks                   | Only when quality is proven insufficient      |
| Opus 5 / 4.8 | Complex agentic coding, architecture, multi-step enterprise decisions, subtle bugs            | Simple edits, classification, bulk formatting |
| Fable 5      | Rarest, hardest problems where quality genuinely changes the outcome                          | Routine coding, summaries, high-volume work   |

Default to Sonnet. Escalate when the smaller model is confidently wrong or the task is genuinely
architectural/high-stakes — not pre-emptively. Drop to Haiku for mechanical sub-tasks. Reserve
Fable for the rare case where Opus is insufficient.

## Effort

Effort (thoroughness — how much is read, verified, and checked before acting) is a separate
dial from model (capability). Most tasks need calibration on both, not maximum on either.

- Lower effort for routine, well-scoped work.
- Raise effort for multi-file changes, architecture decisions, or anything where being wrong is
  expensive to discover later.
- Thinking tokens bill as output tokens and dominate cost at high effort — don't default to
  maximum effort out of caution; default to _matched_ effort.

**Exception, learned the hard way:** verification steps — running the actual test suite, a
positive control on a search result, actually executing a command rather than reading the code
and assuming it works — are not the place to economize. A cheap verification step that catches a
real bug (a wrong file path returning a false-clean result; a git operation silently writing to
`.git/index`; a CSV BOM corrupting a column name) is worth far more than the tokens it costs.
Economize on scope and model tier before economizing on verification.

## Context hygiene

- Scope each session to the tightest relevant folder, not the whole workspace.
- Reuse project files and skills instead of re-explaining context every session — this is
  literally what skills are for, loaded on demand rather than kept in permanent instructions.
- Clear or compact between genuinely unrelated tasks so stale context doesn't get carried and
  re-billed.
- Prefer a short, structured written record (see the companion
  `governance-and-correspondence-discipline` skill) over relying on conversational memory across
  a long session — it's cheaper to read a decision record next time than to re-derive it, and it
  survives a session boundary the chat history doesn't.

## Prompt and session discipline

- State the goal and scope in one line before starting multi-file or multi-tool work.
- Batch related questions in one message rather than serially.
- Ask for confirmation before expensive work when the direction is genuinely ambiguous — don't
  ask when the reasonable call is obvious; that costs a round trip for no information gained.
- Give concise output instructions when a short answer is wanted ("3 bullets", "just the diff").

## Cowork-specific setup (if using the Cowork surface)

The mechanics below are Cowork-app-specific and don't apply inside a Claude Code session, which
already runs in a scoped working directory with its own settings.

1. Claude Desktop → Cowork mode → `/setup-cowork` on first use.
2. Enable only the connectors actually needed; prefer read-only where available.
3. Global instructions: keep short — role, defaults, safety/scope boundary, output style. Long
   permanent instructions are re-sent or cached on every turn regardless of relevance.
4. One Project per workstream; add only essential reference files (Projects cache content, so
   reused material counts far less against limits than re-pasting it).
5. Point each session at the tightest relevant folder.

## Quick checklist

- [ ] Goal and scope stated in one line
- [ ] Model matches task difficulty (default Sonnet)
- [ ] Effort matches task complexity, not maxed by default
- [ ] Session/folder scoped tightly
- [ ] Verification steps (tests, positive controls) are not where you're cutting cost
