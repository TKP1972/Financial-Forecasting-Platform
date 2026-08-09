/**
 * External anchoring for the audit chain.
 *
 * ## Why the chain alone is not enough
 *
 * `verifyAuditChain` re-derives every hash and catches an edited row, a spliced
 * `previousHash`, or a sequence gap. That is genuinely effective against
 * accidental modification, a careless correction, and casual tampering - which
 * is what most audit trails actually face.
 *
 * But it rests on an assumption the documentation never stated: that whoever can
 * write to the database cannot compute valid hashes. `AUDIT_HASH_SALT` lives in
 * the environment of the API process, on the same host as the database in every
 * deployment we run. Anyone who can alter rows can very likely also read the
 * salt - and can then recompute a consistent chain over altered data. Chain
 * verification would report `valid: true`.
 *
 * There is also a gap the docs do disclose: truncating the *tail* of the chain
 * is undetectable from the chain alone. A chain of 400 entries and the same
 * chain with its last 50 removed are both internally consistent.
 *
 * ## What anchoring adds
 *
 * Periodically emit the current head - its sequence and hash - to somewhere the
 * database cannot reach: the application log, and optionally an append-only
 * file. An attacker who rewrites the chain still cannot retract a hash that has
 * already left the building.
 *
 * This closes the tail-truncation gap completely for any period covered by an
 * anchor, and converts undetectable rewriting into detectable rewriting - the
 * attacker must now also reach every sink that has seen an anchor.
 *
 * It is not tamper-*proofing*. An attacker with host access can still alter
 * entries newer than the most recent anchor, and can stop the anchor job. What
 * they cannot do is make an already-emitted anchor un-emitted. The residual
 * window is the anchor interval, which is the knob to turn.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { prisma, type Tx } from '../db.js';

/** A recorded observation of the chain head at a point in time. */
export interface AuditAnchor {
  sequence: string;
  hash: string;
  emittedAt: string;
}

export interface AnchorSink {
  readonly name: string;
  write(anchor: AuditAnchor): Promise<void>;
}

/**
 * The current chain head.
 *
 * Returns null for an empty chain - a fresh deployment has nothing to anchor,
 * which is not an error and must not be recorded as a zero-length chain.
 */
export async function currentHead(
  db: Tx = prisma,
): Promise<{ sequence: bigint; hash: string } | null> {
  const last = await db.auditLog.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true, hash: true },
  });
  return last ? { sequence: last.sequence, hash: last.hash } : null;
}

/**
 * Append the head to an append-only file, one JSON object per line.
 *
 * JSON Lines rather than a JSON array: an array would have to be read, parsed
 * and rewritten to add an entry, which is precisely the read-modify-write an
 * append-only record must avoid. `appendFile` with a single line is the whole
 * point - existing bytes are never revisited.
 */
export function fileSink(path: string): AnchorSink {
  return {
    name: `file:${path}`,
    async write(anchor) {
      await appendFile(path, `${JSON.stringify(anchor)}\n`, 'utf8');
    },
  };
}

/** Emit to the application log, which ships off-host in any real deployment. */
export function logSink(log: (anchor: AuditAnchor) => void): AnchorSink {
  return {
    name: 'log',
    async write(anchor) {
      log(anchor);
    },
  };
}

export interface EmitResult {
  emitted: boolean;
  anchor: AuditAnchor | null;
  /** Sinks that accepted the anchor. */
  written: string[];
  /** Sinks that threw, with the reason. Never fatal - see below. */
  failed: Array<{ sink: string; error: string }>;
}

/**
 * Emit the current head to every sink.
 *
 * A failing sink is recorded and skipped rather than thrown, because the
 * alternative is worse in both directions: one unwritable file must not stop the
 * log sink from receiving the anchor, and an anchor job that throws is an
 * anchor job that someone eventually disables. The result object is what the
 * caller logs, so a persistently failing sink is visible rather than silent.
 */
export async function emitAnchor(
  sinks: readonly AnchorSink[],
  options: { db?: Tx; now?: Date } = {},
): Promise<EmitResult> {
  const head = await currentHead(options.db ?? prisma);
  if (!head) return { emitted: false, anchor: null, written: [], failed: [] };

  const anchor: AuditAnchor = {
    sequence: head.sequence.toString(),
    hash: head.hash,
    emittedAt: (options.now ?? new Date()).toISOString(),
  };

  const written: string[] = [];
  const failed: EmitResult['failed'] = [];

  for (const sink of sinks) {
    try {
      await sink.write(anchor);
      written.push(sink.name);
    } catch (error) {
      failed.push({
        sink: sink.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { emitted: written.length > 0, anchor, written, failed };
}

/** Read anchors back from a JSON Lines file. Missing file means no anchors. */
export async function readAnchorFile(path: string): Promise<AuditAnchor[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const anchors: AuditAnchor[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditAnchor;
      if (typeof parsed.sequence === 'string' && typeof parsed.hash === 'string') {
        anchors.push(parsed);
      }
    } catch {
      // A truncated final line is expected if the process died mid-append.
      // Skip it rather than refusing to verify against every earlier anchor.
    }
  }
  return anchors;
}

export type AnchorFailureKind = 'TRUNCATED' | 'REWRITTEN';

export interface AnchorVerification {
  valid: boolean;
  anchorsChecked: number;
  failures: Array<{
    kind: AnchorFailureKind;
    sequence: string;
    expectedHash: string;
    actualHash: string | null;
    reason: string;
  }>;
  verifiedAt: string;
}

/**
 * Check the live chain against previously emitted anchors.
 *
 * Two distinct findings, reported separately because they mean different things
 * to whoever reads the report:
 *
 *   TRUNCATED - the chain no longer reaches a sequence we have witnessed. Entries
 *               have been removed from the end. This is the failure the chain
 *               cannot detect on its own at any cost.
 *   REWRITTEN - the sequence exists but hashes differently than when witnessed.
 *               The entry, or something before it, has been altered and the chain
 *               re-derived - which is exactly what an attacker holding the salt
 *               would produce, and what plain chain verification would pass.
 */
export async function verifyAgainstAnchors(
  anchors: readonly AuditAnchor[],
  options: { db?: Tx; now?: Date } = {},
): Promise<AnchorVerification> {
  const db = options.db ?? prisma;
  const verifiedAt = (options.now ?? new Date()).toISOString();
  const failures: AnchorVerification['failures'] = [];

  for (const anchor of anchors) {
    const row = await db.auditLog.findUnique({
      where: { sequence: BigInt(anchor.sequence) },
      select: { hash: true },
    });

    if (!row) {
      failures.push({
        kind: 'TRUNCATED',
        sequence: anchor.sequence,
        expectedHash: anchor.hash,
        actualHash: null,
        reason:
          `Entry ${anchor.sequence} was witnessed at ${anchor.emittedAt} but no longer exists. ` +
          `The chain has been truncated - this is undetectable by chain verification alone.`,
      });
      continue;
    }

    if (row.hash !== anchor.hash) {
      failures.push({
        kind: 'REWRITTEN',
        sequence: anchor.sequence,
        expectedHash: anchor.hash,
        actualHash: row.hash,
        reason:
          `Entry ${anchor.sequence} hashed ${anchor.hash} when witnessed at ${anchor.emittedAt}, ` +
          `but now hashes ${row.hash}. The chain has been rewritten by someone able to compute ` +
          `valid hashes, which chain verification alone would report as intact.`,
      });
    }
  }

  return {
    valid: failures.length === 0,
    anchorsChecked: anchors.length,
    failures,
    verifiedAt,
  };
}
