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
// 3. No replacement characters.
//
// U+FFFD means text was decoded as the wrong encoding and the original byte is
// gone. It earns its own check because it is how a NUL escapes check 2: a
// formatter that rewrites a file converts the NUL to U+FFFD, which is no longer
// a NUL and passes - while the text is now silently wrong rather than loudly
// wrong. Caught exactly that way once.
// --------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of walk(root)) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|ps1|yml|yaml)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    // Referenced by escape, not as a literal, so this file cannot fail its own
    // check — and so the character survives any tool that rewrites the source.
    const index = text.indexOf('\uFFFD');
    if (index !== -1) {
      const line = text.slice(0, index).split('\n').length;
      offenders.push(`${relative(root, file)}:${line}`);
    }
  }

  if (offenders.length > 0) {
    failures.push({
      title: 'Replacement character (U+FFFD) in a file',
      why: 'The text was decoded as the wrong encoding; the original character is unrecoverable from this file.',
      fix: 'Restore the intended character. If it was a NUL, write the escape sequence instead.',
      offenders,
    });
  }
}

// --------------------------------------------------------------------------
// 4. No stray control characters in source.
//
// The fingerprint of an escape sequence destroyed in transit. Piping source
// through a shell heredoc halves its backslashes, so a regex authored as
// /\r?\n/ arrives as a literal carriage return and newline *inside the regex
// literal*: a syntax error if you are lucky, and a regex that quietly matches
// something else if you are not. \b becomes a backspace, \u001b an escape
// character. All of it is invisible in an editor and in a diff, so the file
// reads as correct while behaving otherwise.
//
// This is the most-repeated authoring mistake in this repository - it recurred
// five times, each costing a full diagnostic cycle on a file that looked right,
// and it had never been written down. It is mechanical to detect, so it is now
// detected rather than remembered. The rule it enforces: author source with the
// editor tooling or from a script file, never through a shell heredoc.
//
// Tab, line feed and carriage return are legitimate; everything else in C0,
// plus DEL, is damage. NUL has its own check above and is left to it.
// --------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of walk(root)) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|ps1|yml|yaml)$/.test(file)) continue;

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // A trailing carriage return is a CRLF line ending and legitimate. One
        // in the *middle* of a line is the damage: it is what a regex escape
        // becomes when its backslash is stripped. The first draft of this check
        // excused carriage returns outright and therefore caught nothing, which
        // is why it was tested against planted damage before being trusted.
        const body = line.endsWith('\r') ? line.slice(0, -1) : line;

        // Compared by code point rather than written as literals, so this file
        // cannot fail its own check and no formatter can rewrite the test.
        const bad = [...body].find((ch) => {
          const code = ch.codePointAt(0);
          if (code === 0x00 || code === 0x09) return false;
          return code < 0x20 || code === 0x7f;
        });

        if (bad !== undefined) {
          const point = 'U+' + bad.codePointAt(0).toString(16).padStart(4, '0').toUpperCase();
          offenders.push(relative(root, file) + ':' + (index + 1) + ' (' + point + ')');
        }
      });
  }

  if (offenders.length > 0) {
    failures.push({
      title: 'Stray control character in a source file',
      why: 'Almost always an escape sequence mangled in transit - a regex or template literal whose backslashes were halved by a shell heredoc. Invisible in an editor and in a diff.',
      fix: 'Rewrite the line with the escape sequence spelled out, and author the file with the editor tooling or from a script file rather than piping it through a shell heredoc.',
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
