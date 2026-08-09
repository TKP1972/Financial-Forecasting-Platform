/**
 * Mechanical checks for traps recorded in CLAUDE.md.
 *
 * Every trap in that register is a defect that has already happened once, which
 * makes it likely to happen again. A convention that depends on someone
 * remembering it decays; a check that fails the build does not.
 *
 * Deliberately Node rather than PowerShell: the end-to-end suites are already
 * Windows-only, and there is no reason to add another platform constraint to
 * something that must run everywhere, including a Linux CI runner.
 *
 *   node scripts/check-repo-invariants.mjs
 *
 * Exits non-zero on the first category with violations, printing every offender
 * rather than just the first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'build', '.turbo']);

/** Every file under `dir`, skipping build output and dependencies. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const failures = [];

// --------------------------------------------------------------------------
// 1. No compiled output inside a src/ tree.
//
// packages/*/src/*.ts import each other as './thing.js'. If a compiled
// thing.js lands beside thing.ts, Vite and Vitest resolve the stale .js and
// the tests silently run against an old build - new exports read as undefined
// while old ones keep working.
// --------------------------------------------------------------------------
{
  const offenders = walk(join(root, 'packages'))
    .filter((f) => f.split(sep).includes('src'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.d.ts'));

  if (offenders.length > 0) {
    failures.push({
      title: 'Compiled output found inside a src/ tree',
      why: 'Vite and Vitest will resolve the stale .js instead of the .ts source, so tests run against an old build.',
      fix: 'Delete these files and find the build step that emitted them (tsc -b pulling sources in through paths is the usual cause).',
      offenders: offenders.map((f) => relative(root, f)),
    });
  }
}

// --------------------------------------------------------------------------
// 2. No raw NUL bytes in source.
//
// audit.service.ts once embedded the audit hash delimiter as a literal 0x00.
// It renders as a space, so any normalising save would silently swap in a
// delimiter that DOES occur in field values; grep treated the file as binary
// and skipped it; git stored it as a binary blob with no usable diff.
// Write '\u0000' instead - identical at runtime, visible on the page.
// --------------------------------------------------------------------------
{
  const offenders = [];
  // Repo-wide, not just packages/: the delimiter is discussed in CLAUDE.md and
  // in this file, and a raw NUL pasted into either is just as invisible there.
  for (const file of walk(root)) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|ps1|yml|yaml)$/.test(file)) continue;
    const buf = readFileSync(file);
    const index = buf.indexOf(0);
    if (index !== -1) {
      const line = buf.subarray(0, index).toString('utf8').split('\n').length;
      offenders.push(`${relative(root, file)}:${line}`);
    }
  }

  if (offenders.length > 0) {
    failures.push({
      title: 'Raw NUL byte in a source file',
      why: 'A NUL renders as a space, makes grep skip the file as binary, and makes git store it as an undiffable blob.',
      fix: "Write the escape sequence '\\u0000' instead. It denotes the same code point, so runtime behaviour is unchanged.",
      offenders,
    });
  }
}

// --------------------------------------------------------------------------

if (failures.length === 0) {
  console.log('repo invariants: OK');
  process.exit(0);
}

for (const failure of failures) {
  console.error(`\n  FAIL  ${failure.title}`);
  console.error(`        ${failure.why}`);
  console.error(`        Fix: ${failure.fix}`);
  for (const offender of failure.offenders) console.error(`          - ${offender}`);
}
console.error(`\n${failures.length} invariant(s) violated.\n`);
process.exit(1);
