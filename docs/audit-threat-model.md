# Audit trail — threat model and stated limits

What the tamper-evident audit chain does and does not protect against. Written because
"tamper-evident" is a stronger word than the control earns on its own, and a system that
states its boundary is more trustworthy than one that leaves the reader to assume.

## The control

Every audited action appends a row carrying a SHA-256 hash over its own fields plus the
previous row's hash, salted with `AUDIT_HASH_SALT`. `verifyAuditChain` walks the chain and
re-derives every hash, distinguishing three failures:

| Failure                                   | How it is caught                                     |
| ----------------------------------------- | ---------------------------------------------------- |
| A row edited in place                     | Re-derived hash no longer matches the stored one     |
| A row spliced out and the chain re-linked | `previousHash` does not match the actual predecessor |
| A row deleted                             | Gap in the sequence                                  |

`scripts/verify-audit-tamper-detection.ps1` proves each of these on a live database: it edits a
row, confirms detection _and correct location_, deletes a row, confirms the gap is caught, then
restores both.

Two implementation details are load-bearing and must not be "improved":

- **`changes` is TEXT, not JSONB.** Postgres does not preserve JSONB key order, so a value read
  back would not re-serialise to the bytes that were hashed, and every verification would fail.
  It stores canonical JSON with sorted keys, and the hash covers those bytes verbatim.
- **The field delimiter is `'\u0000'`.** A delimiter that cannot occur in a field value is what
  stops `("ab","c")` and `("a","bc")` from colliding. It was once a raw NUL byte in the source,
  which rendered as a space in every editor and was one careless save away from silently
  becoming `0x20` — a character that appears in `summary` text constantly.

## What it protects against

Accidental modification, a careless correction applied directly to the database, and casual
tampering by someone without host access. This is what most audit trails actually face, and the
control is genuinely effective against it.

## What it does not protect against

### 1. An attacker who can read `AUDIT_HASH_SALT`

The chain assumes whoever can write rows cannot compute valid hashes. That assumption does not
hold in our deployments: `AUDIT_HASH_SALT` lives in the API process environment, on the same
host as the database. **Anyone who can alter rows can very likely also read the salt** — and can
then recompute a consistent chain over altered data. `verifyAuditChain` would report
`valid: true`.

The salt is therefore best understood as binding the chain to a _deployment_ — stopping entries
being lifted wholesale from another environment — rather than as a secret that defeats a
privileged attacker.

### 2. Truncation of the tail

A chain of 400 entries and the same chain with its last 50 removed are both internally
consistent. This is not a weakness of the implementation; it is not detectable from the chain
alone at any cost.

## What anchoring adds

`AUDIT_ANCHOR_SECONDS` emits the current head — sequence and hash — to sinks outside the
database: always the application log, and optionally an append-only JSON Lines file
(`AUDIT_ANCHOR_FILE`). `verifyAgainstAnchors` then checks the live chain against what was
witnessed.

This changes both limits above:

- **Truncation becomes detectable** for any period covered by an anchor. The witness says
  sequence 3 existed; sequence 3 is gone.
- **Rewriting becomes detectable** rather than invisible. An attacker holding the salt can still
  produce a chain that verifies internally, but cannot make an already-emitted hash match their
  substitute. They must now also reach every sink that has seen an anchor.

### Residual risk, stated plainly

Anchoring is not tamper-_proofing_.

- Entries newer than the most recent anchor are **not covered**. The interval is the window.
- An attacker with host access can **stop the anchor job**. A gap in anchor emissions is
  therefore itself a signal worth alerting on — absence of anchors is not the same as absence of
  activity.
- If the anchor file shares a volume, host, or backup domain with the database, an attacker who
  reaches one very likely reaches the other. **Put it somewhere else**, or rely on log shipping.
- Anchors witness the _head_. They say nothing about entries that were never written in the
  first place — an action performed with auditing bypassed leaves no trace to anchor.

### Getting more than this

If the audit trail ever needs to survive a fully privileged insider, the honest answer is that
it needs a sink under different administrative control: append-only object storage with
retention lock, a managed log service the API can write to but not delete from, or a third-party
timestamping service. That is a deployment decision rather than a code change, and the anchor
sink interface (`AnchorSink`) exists so adding one is small.

## Operational note

Anchors are logged at `warn`, not `info`. The record that makes truncation detectable must
survive a log level set to filter routine chatter — an anchor that was never retained is an
anchor that never existed.
