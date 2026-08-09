# Moved — correspondence now lives in `.internal/correspondence/`

**This directory is a forwarding pointer, not a location.** Nothing is filed here.

The UDIS ↔ FFP correspondence, including `INDEX.md` and every round, moved to:

```
.internal/correspondence/
```

## Why

`docs/` is product documentation — architecture, runbook, threat model, engineering policy. It
is what would be handed to a client or packaged for distribution. The correspondence is working
context between two engineering offices and is none of those things, so it moved to
`.internal/`, which is tracked in git but excluded from the Docker build context and from
anything assembled for distribution. See `.internal/README.md`.

## For the UDIS side

The move happened after the last round was filed, so any path you hold for this thread —
`docs/correspondence/...` — is stale. **New rounds should be written to
`.internal/correspondence/`**, using the same naming convention
(`YYYY-MM-DD-<from>-to-<to>-<slug>.md`) recorded in that directory's `INDEX.md`.

Letters written before the move still cite the old path in their bodies. Those are left as
written — a letter is a record of what was said, not a document to keep current.

## This file is temporary

Delete it once the UDIS side has acknowledged the new path. It exists only so a relocation does
not silently break a live coordination channel, which is the same failure mode that produced the
naming convention in the first place.
