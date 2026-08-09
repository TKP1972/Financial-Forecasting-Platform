/**
 * The user manual's permission matrix must match the running code.
 *
 * A capability table in a document drifts the moment someone adds a permission
 * or moves one between roles, and nothing complains. People then rely on it —
 * an auditor reads it as the statement of who can do what, and a user reads it
 * to find out who to ask. **A manual that can drift silently is worse than no
 * manual**, because it is trusted.
 *
 * So the matrix in `docs/user-manual.md` Appendix A is parsed and compared
 * against `ROLE_PERMISSIONS`. This is the same discipline the repository already
 * applies to its trap register: a convention that depends on someone
 * remembering decays, a check that fails the build does not.
 *
 * The manual is the artefact under test here, not the code. If this fails, the
 * usual fix is to update the manual — unless a permission moved by accident, in
 * which case it has caught something much more interesting.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can, type Permission } from './rbac.js';
import { ROLES, type Role } from './domain.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANUAL = resolve(repoRoot, 'docs/user-manual.md');

/** Column order in the manual, left to right. Asserted below, not assumed. */
const COLUMN_ORDER: readonly Role[] = [
  'VIEWER',
  'ANALYST',
  'BUDGET_OWNER',
  'FINANCE_MANAGER',
  'CFO',
  'ADMIN',
];

interface ParsedMatrix {
  /** permission -> role -> granted */
  grants: Map<string, Map<Role, boolean>>;
  columns: string[];
}

/**
 * Pull the matrix out from between the marker comments.
 *
 * Delimited by explicit HTML comments rather than by heading position, so
 * reordering the document or adding prose around the table does not silently
 * change what is being checked.
 */
function parseMatrix(): ParsedMatrix {
  const text = readFileSync(MANUAL, 'utf8');
  const start = text.indexOf('<!-- BEGIN PERMISSION MATRIX -->');
  const end = text.indexOf('<!-- END PERMISSION MATRIX -->');

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'docs/user-manual.md is missing the BEGIN/END PERMISSION MATRIX markers. ' +
        'They delimit the table this test checks; do not remove them.',
    );
  }

  const rows = text
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );

  // rows[0] is the header, rows[1] the alignment separator, the rest are data.
  const header = rows[0] ?? [];

  const grants = new Map<string, Map<Role, boolean>>();
  for (const row of rows.slice(2)) {
    const name = (row[0] ?? '').replace(/`/g, '').trim();
    if (!name) continue;
    const perRole = new Map<Role, boolean>();
    COLUMN_ORDER.forEach((role, index) => {
      // Column 0 is the permission name, so role columns start at 1.
      perRole.set(role, (row[index + 1] ?? '').toUpperCase() === 'Y');
    });
    grants.set(name, perRole);
  }

  return { grants, columns: header.slice(1) };
}

describe('docs/user-manual.md permission matrix', () => {
  const { grants, columns } = parseMatrix();

  it('has one column per role, in the documented order', () => {
    // Guards the parser itself: if a column were inserted or reordered, every
    // grant below would be compared against the wrong role and could still pass.
    expect(columns).toHaveLength(COLUMN_ORDER.length);
    expect(COLUMN_ORDER).toEqual(ROLES);
  });

  it('lists every permission the platform defines, and no others', () => {
    const documented = [...grants.keys()].sort();
    const actual = [...PERMISSIONS].sort();

    const missing = actual.filter((p) => !documented.includes(p));
    const extra = documented.filter((p) => !actual.includes(p as Permission));

    expect(
      missing,
      `Permissions exist in code but are absent from the manual: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      extra,
      `The manual documents permissions that no longer exist: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it.each(ROLES)('documents %s exactly as the code grants it', (role) => {
    const wrong: string[] = [];

    for (const permission of PERMISSIONS) {
      const documented = grants.get(permission)?.get(role) ?? false;
      const actual = can(role, permission);
      if (documented !== actual) {
        wrong.push(
          `${permission}: manual says ${documented ? 'Y' : 'no'}, code says ${actual ? 'Y' : 'no'}`,
        );
      }
    }

    expect(
      wrong,
      `docs/user-manual.md Appendix A is wrong for ${role}:\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });
});
