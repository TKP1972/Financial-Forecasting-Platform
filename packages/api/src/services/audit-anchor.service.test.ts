/**
 * Anchoring tests.
 *
 * The two that matter are the attack simulations at the bottom: a truncated
 * tail and a rewritten chain. Both are cases where `verifyAuditChain` reports
 * the chain as intact - the first because a shortened chain is still internally
 * consistent, the second because an attacker holding AUDIT_HASH_SALT can
 * recompute every hash. Anchoring exists solely to catch those two, so a test
 * suite that did not simulate them would be testing the plumbing and none of
 * the point.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentHead,
  emitAnchor,
  fileSink,
  logSink,
  readAnchorFile,
  verifyAgainstAnchors,
  type AuditAnchor,
} from './audit-anchor.service.js';

/**
 * A fake audit table.
 *
 * Only the two shapes the anchor code uses: findFirst ordered by sequence desc
 * (the head) and findUnique by sequence (verification).
 */
function fakeDb(rows: Array<{ sequence: bigint; hash: string }>) {
  return {
    auditLog: {
      findFirst: vi.fn(async () => {
        if (rows.length === 0) return null;
        return [...rows].sort((a, b) => (a.sequence > b.sequence ? -1 : 1))[0];
      }),
      findUnique: vi.fn(async ({ where }: { where: { sequence: bigint } }) => {
        return rows.find((r) => r.sequence === where.sequence) ?? null;
      }),
    },
  } as never;
}

const CHAIN = [
  { sequence: 1n, hash: 'hash-one' },
  { sequence: 2n, hash: 'hash-two' },
  { sequence: 3n, hash: 'hash-three' },
];

const NOW = new Date('2026-08-09T12:00:00.000Z');

let tempDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), 'ffp-anchor-'));
});

describe('currentHead', () => {
  it('returns the highest sequence and its hash', async () => {
    const head = await currentHead(fakeDb(CHAIN));
    expect(head).toEqual({ sequence: 3n, hash: 'hash-three' });
  });

  it('returns null for an empty chain', async () => {
    // A fresh deployment has nothing to anchor. Recording a zero-length chain
    // would later read as "we witnessed an empty chain", which is a different
    // and false claim.
    expect(await currentHead(fakeDb([]))).toBeNull();
  });
});

describe('emitAnchor', () => {
  it('writes the head to every sink', async () => {
    const seen: AuditAnchor[] = [];
    const path = join(tempDir, 'anchors.jsonl');

    const result = await emitAnchor([logSink((a) => seen.push(a)), fileSink(path)], {
      db: fakeDb(CHAIN),
      now: NOW,
    });

    expect(result.emitted).toBe(true);
    expect(result.written).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(result.anchor).toEqual({
      sequence: '3',
      hash: 'hash-three',
      emittedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(seen).toHaveLength(1);

    const onDisk = await readFile(path, 'utf8');
    expect(JSON.parse(onDisk.trim())).toEqual(result.anchor);
  });

  it('appends rather than overwriting', async () => {
    // The single most important property of the file sink. If a later emission
    // rewrote the file, every earlier witness would be lost - and losing
    // earlier witnesses is exactly what an attacker wants.
    const path = join(tempDir, 'anchors.jsonl');
    const db = fakeDb(CHAIN);

    await emitAnchor([fileSink(path)], { db, now: new Date('2026-08-09T10:00:00.000Z') });
    await emitAnchor([fileSink(path)], { db, now: new Date('2026-08-09T11:00:00.000Z') });

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).emittedAt).toBe('2026-08-09T10:00:00.000Z');
    expect(JSON.parse(lines[1]).emittedAt).toBe('2026-08-09T11:00:00.000Z');
  });

  it('emits nothing for an empty chain', async () => {
    const result = await emitAnchor([logSink(() => {})], { db: fakeDb([]), now: NOW });
    expect(result.emitted).toBe(false);
    expect(result.anchor).toBeNull();
  });

  it('records a failing sink without losing the others', async () => {
    // One unwritable file must not stop the log sink from witnessing the head.
    const seen: AuditAnchor[] = [];
    const broken = {
      name: 'broken',
      write: async () => {
        throw new Error('read-only filesystem');
      },
    };

    const result = await emitAnchor([broken, logSink((a) => seen.push(a))], {
      db: fakeDb(CHAIN),
      now: NOW,
    });

    expect(seen).toHaveLength(1);
    expect(result.emitted).toBe(true);
    expect(result.written).toEqual(['log']);
    expect(result.failed).toEqual([{ sink: 'broken', error: 'read-only filesystem' }]);
  });
});

describe('readAnchorFile', () => {
  it('returns an empty list when the file does not exist', async () => {
    expect(await readAnchorFile(join(tempDir, 'absent.jsonl'))).toEqual([]);
  });

  it('skips a truncated final line but keeps every complete one', async () => {
    // A process killed mid-append leaves a partial line. Refusing to parse the
    // file would discard every earlier witness over one incomplete byte range.
    const path = join(tempDir, 'partial.jsonl');
    await writeFile(
      path,
      '{"sequence":"1","hash":"h1","emittedAt":"2026-08-09T10:00:00.000Z"}\n' +
        '{"sequence":"2","hash":"h2","emittedAt":"2026-08-09T11:00:00.000Z"}\n' +
        '{"sequence":"3","hash":"h3","emit',
      'utf8',
    );

    const anchors = await readAnchorFile(path);
    expect(anchors).toHaveLength(2);
    expect(anchors.map((a) => a.sequence)).toEqual(['1', '2']);
  });
});

describe('verifyAgainstAnchors - the attacks this exists to catch', () => {
  it('passes when the chain still matches every anchor', async () => {
    const anchors: AuditAnchor[] = [
      { sequence: '2', hash: 'hash-two', emittedAt: '2026-08-09T10:00:00.000Z' },
      { sequence: '3', hash: 'hash-three', emittedAt: '2026-08-09T11:00:00.000Z' },
    ];

    const result = await verifyAgainstAnchors(anchors, { db: fakeDb(CHAIN), now: NOW });

    expect(result.valid).toBe(true);
    expect(result.anchorsChecked).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('detects a truncated tail', async () => {
    // The attack: delete the most recent entries. Sequences 1-2 remain and are
    // perfectly self-consistent, so verifyAuditChain reports valid. The anchor
    // witnessed sequence 3, and sequence 3 is gone.
    const truncated = CHAIN.slice(0, 2);
    const anchors: AuditAnchor[] = [
      { sequence: '3', hash: 'hash-three', emittedAt: '2026-08-09T11:00:00.000Z' },
    ];

    const result = await verifyAgainstAnchors(anchors, { db: fakeDb(truncated), now: NOW });

    expect(result.valid).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe('TRUNCATED');
    expect(result.failures[0].sequence).toBe('3');
    expect(result.failures[0].actualHash).toBeNull();
  });

  it('detects a chain rewritten by someone holding the salt', async () => {
    // The attack the critique identified: an actor who can write rows can very
    // likely read AUDIT_HASH_SALT from the same host, recompute every hash, and
    // leave a chain that verifies. The anchor witnessed the OLD hash at
    // sequence 2, so the substitution is visible.
    const rewritten = [
      { sequence: 1n, hash: 'hash-one' },
      { sequence: 2n, hash: 'recomputed-hash-two' },
      { sequence: 3n, hash: 'recomputed-hash-three' },
    ];
    const anchors: AuditAnchor[] = [
      { sequence: '2', hash: 'hash-two', emittedAt: '2026-08-09T10:00:00.000Z' },
    ];

    const result = await verifyAgainstAnchors(anchors, { db: fakeDb(rewritten), now: NOW });

    expect(result.valid).toBe(false);
    expect(result.failures[0].kind).toBe('REWRITTEN');
    expect(result.failures[0].expectedHash).toBe('hash-two');
    expect(result.failures[0].actualHash).toBe('recomputed-hash-two');
  });

  it('reports truncation and rewriting separately', async () => {
    // They mean different things to whoever reads the report, so a single
    // "invalid" verdict would lose the distinction that drives the response.
    const tampered = [
      { sequence: 1n, hash: 'hash-one' },
      { sequence: 2n, hash: 'recomputed-hash-two' },
    ];
    const anchors: AuditAnchor[] = [
      { sequence: '2', hash: 'hash-two', emittedAt: '2026-08-09T10:00:00.000Z' },
      { sequence: '3', hash: 'hash-three', emittedAt: '2026-08-09T11:00:00.000Z' },
    ];

    const result = await verifyAgainstAnchors(anchors, { db: fakeDb(tampered), now: NOW });

    expect(result.failures.map((f) => f.kind)).toEqual(['REWRITTEN', 'TRUNCATED']);
  });

  it('is vacuously valid with no anchors, and says how many it checked', async () => {
    // Honesty about coverage: "valid" with zero anchors means "nothing was
    // witnessed", not "nothing was tampered with". anchorsChecked is what tells
    // the reader which of those they are looking at.
    const result = await verifyAgainstAnchors([], { db: fakeDb(CHAIN), now: NOW });

    expect(result.valid).toBe(true);
    expect(result.anchorsChecked).toBe(0);
  });
});
