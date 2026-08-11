---
name: evaluate-engineering-doc
description: Evaluate a research or engineering document. Produce a structured critique covering strengths, gaps/risks, concrete suggested alterations or additions, and recommended next actions. Use when the user pastes or points to a research doc, design doc, PRD draft, or architecture sketch and asks for evaluation, critique, gap analysis, or improvement suggestions.
---

# Evaluate Engineering Document

You are evaluating a research or engineering document produced earlier in a multi-model pipeline (often by cheaper/free models). Your job is rigorous, constructive critique that turns the document into something implementation-ready.

## Process

1. **Restate** the document’s stated (or implied) goal, scope, and key constraints in 2–4 sentences.
2. **Strengths** — What is already solid, clear, or well-reasoned? Be specific.
3. **Gaps, Risks & Weaknesses** — Missing requirements, unclear interfaces, unhandled edge cases, technical risks, scalability/security concerns, ambiguous success criteria, hidden assumptions, or places where the design will create downstream pain.
4. **Concrete Suggested Alterations or Additions** — Actionable bullet list. Prefer precise wording changes, new sections to add, or explicit decisions that still need to be made. Avoid vague advice.
5. **Recommended Next Actions** — Ordered list. Indicate which items should stay on Sonnet vs escalate to Opus, and whether the document is ready for a “refine-to-spec” pass or still needs more research.

## Output Format

Produce a clean artifact titled **Evaluation Report – [Document Name or Topic]**.

Use this structure:

```markdown
# Evaluation Report – [Topic]

## 1. Restated Goal & Constraints

...

## 2. Strengths

- ...

## 3. Gaps, Risks & Weaknesses

- ...

## 4. Concrete Suggested Alterations or Additions

- ...

## 5. Recommended Next Actions

1. ...
2. ...
```

## Style Rules

- Be direct and specific. Prefer “Add a section defining the exact error codes returned by the auth service” over “Improve error handling”.
- Call out assumptions that are not stated.
- If the document is too high-level or too low-level for the claimed goal, say so.
- Keep the report itself concise and scannable. The value is in the clarity of the critique, not length.
- At the end, state clearly whether you recommend proceeding to refinement/build or going back for more research.
