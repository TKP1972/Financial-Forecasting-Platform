---
name: refine-to-spec
description: Turn an evaluated research document plus critique into a clean, implementation-ready engineering specification / PRD / design doc. Use after an evaluation report exists or when the user asks to refine, tighten, or formalize a design into a buildable spec.
---

# Refine to Implementation-Ready Spec

Take the original document and the Evaluation Report (or inline critique) and produce a single, clean engineering specification that can serve as the source of truth for implementation.

## Required Sections

Produce a document with these sections (adapt names slightly if the domain demands it, but keep the intent):

1. **Goal & Success Criteria**  
   What “done” looks like. Measurable or clearly observable outcomes.

2. **Non-Goals**  
   Explicitly out of scope. Prevents scope creep during build.

3. **Context & Constraints**  
   Technical constraints, existing systems, performance/security/compliance requirements, timeline or resource limits.

4. **High-Level Design**  
   Components, responsibilities, data flow, key interfaces. Prefer diagrams in text (boxes & arrows) or clear bullet structure over prose.

5. **Detailed Interfaces & Contracts**  
   APIs, events, data models, error handling expectations. Be precise enough that two implementers would produce compatible code.

6. **Edge Cases & Failure Modes**  
   What happens when things go wrong or inputs are unexpected.

7. **Test Strategy Outline**  
   What must be tested (unit / integration / e2e), critical scenarios, and definition of “tests pass”.

8. **Open Questions / Decisions Still Needed**  
   Only items that truly block or significantly affect implementation. Everything else should already be decided in the spec.

9. **Implementation Notes** (optional)  
   Suggested order of work, risky areas, or references to existing code patterns that should be followed.

## Rules

- Resolve as many ambiguities from the Evaluation Report as possible. If something cannot be resolved without the user, put it in Open Questions.
- Prefer precision over completeness of prose. Short, declarative sentences and structured lists beat long paragraphs.
- The refined spec should be usable as the single source of truth. Implementation sessions should be able to work primarily from this document + the codebase.
- Output the full refined document as a clean markdown artifact ready to be saved under `engineering/`.
