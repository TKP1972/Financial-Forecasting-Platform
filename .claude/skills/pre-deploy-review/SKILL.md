---
name: pre-deploy-review
description: Final pre-deployment review covering security, operability, rollback, configuration, documentation, and release readiness. Use when code is feature-complete and tested and the user is preparing to deploy or open a production PR.
---

# Pre-Deploy Review

Perform a focused production-readiness review. Assume implementation and basic testing are already done.

## Review Dimensions

### 1. Correctness & Completeness

- Does the change match the refined spec / success criteria?
- Are there known open questions that should block deploy?

### 2. Security

- Authn/Authz boundaries respected?
- Secrets handled correctly (no hard-coding, proper injection of config)?
- Input validation and output encoding where relevant?
- Dependency or supply-chain notes if new packages were added?

### 3. Operability

- Logging and metrics sufficient to diagnose problems in production?
- Health checks / readiness if this is a service?
- Timeouts, retries, and circuit-breaking for external calls?

### 4. Configuration & Environment

- All new config is explicit and documented?
- Sensible defaults vs required environment variables?
- Feature flags for risky or reversible behavior?

### 5. Rollback & Safety

- Can this be rolled back cleanly?
- Database migrations are backward-compatible or have a clear rollback path?
- Any one-way data changes?

### 6. Documentation & Handover

- README / runbook / API docs updated if needed?
- Changelog or release notes entry drafted?
- On-call or support notes for new failure modes?

## Output Format

```markdown
# Pre-Deploy Review – [Feature or Change Name]

## Summary Verdict

Ready / Ready with minor follow-ups / Not ready (blockers listed)

## Findings by Dimension

### Correctness & Completeness

...

### Security

...

### Operability

...

### Configuration & Environment

...

### Rollback & Safety

...

### Documentation & Handover

...

## Blockers (if any)

1. ...

## Recommended Follow-ups (non-blocking)

- ...

## Suggested Release Notes Blurb

...
```

## Rules

- Be decisive. “Looks fine” is not useful; either clear it or list concrete issues.
- Prefer actionable findings over theoretical risk lists.
- If the change is small and low-risk, keep the review proportionally short.
