/**
 * End-to-end suite runner.
 *
 * Replaces a semicolon-chained npm script. npm runs scripts through cmd.exe on
 * Windows, where `;` is not a command separator - it was absorbed into the
 * filename, so the chain died on the first entry with
 *
 *   The argument './scripts/smoke-test.ps1;' is not recognized as the name of
 *   a script file.
 *
 * and no suite ran at all. The failure looked like a missing interpreter rather
 * than a broken script, which is what made it survive so long.
 *
 * Semicolons were the right intent - run every suite even when one fails, so a
 * single failure does not hide the state of the rest - so this runner keeps that
 * behaviour and adds an aggregate exit code, which the semicolon form never had:
 * the old chain reported the exit status of the LAST suite only, so a failure in
 * any earlier one was silently discarded.
 *
 *   node scripts/run-e2e.mjs [suite ...]
 *
 * With no arguments it runs every suite in order. Names may be given with or
 * without the .ps1 extension.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** Order matters: the broad smoke test first, tamper detection last. */
const ALL_SUITES = [
  'journey-lifecycle.mjs',
  'smoke-test.ps1',
  'smoke-test-planning.ps1',
  'smoke-test-rolling.ps1',
  'smoke-test-ratecards.ps1',
  'smoke-test-pilot.ps1',
  'verify-audit-tamper-detection.ps1',
];

/**
 * PowerShell 7 is cross-platform, so these suites can run on a Linux CI runner
 * with pwsh installed. Windows PowerShell 5.1 is the fallback and exists only on
 * Windows; the suites are compatible with it, but prefer pwsh where present.
 */
function findShell() {
  for (const candidate of ['pwsh', 'powershell']) {
    const probe = spawnSync(
      candidate,
      ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
      {
        encoding: 'utf8',
        shell: false,
      },
    );
    if (probe.status === 0) return { exe: candidate, major: probe.stdout.trim() };
  }
  return null;
}

const requested = process.argv.slice(2);
/** A bare name means a PowerShell suite; .mjs suites are named in full. */
function normalise(name) {
  if (name.endsWith('.ps1') || name.endsWith('.mjs')) return name;
  const asNode = ALL_SUITES.find((s) => s === `${name}.mjs`);
  return asNode ?? `${name}.ps1`;
}

const suites = requested.length > 0 ? requested.map(normalise) : ALL_SUITES;

const shell = findShell();
if (!shell) {
  console.error(
    '\nNo PowerShell interpreter found. Install PowerShell 7 (https://aka.ms/powershell)\n' +
      'or, on Windows, ensure powershell.exe is on PATH.\n',
  );
  process.exit(1);
}

console.log(`Running ${suites.length} suite(s) with ${shell.exe} (v${shell.major}).\n`);

const results = [];

for (const suite of suites) {
  const path = join(scriptsDir, suite);
  if (!existsSync(path)) {
    console.error(`\n=== ${suite}: NOT FOUND at ${path} ===\n`);
    results.push({ suite, status: 'missing' });
    continue;
  }

  console.log(`\n${'='.repeat(70)}\n  ${suite}\n${'='.repeat(70)}`);

  // Node suites run directly. Migrating suites off PowerShell one at a time is
  // how the Windows-only constraint gets removed without a rewrite.
  const run = suite.endsWith('.mjs')
    ? spawnSync(process.execPath, [path], { stdio: 'inherit', shell: false })
    : spawnSync(shell.exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path], {
        stdio: 'inherit',
        shell: false,
      });

  results.push({ suite, status: run.status === 0 ? 'passed' : 'failed', code: run.status });
}

// --------------------------------------------------------------------------

console.log(`\n${'='.repeat(70)}\n  Summary\n${'='.repeat(70)}`);
for (const result of results) {
  const label = result.status === 'passed' ? 'PASS' : result.status === 'missing' ? 'MISS' : 'FAIL';
  const detail = result.code !== undefined && result.code !== 0 ? ` (exit ${result.code})` : '';
  console.log(`  ${label}  ${result.suite}${detail}`);
}

const failed = results.filter((r) => r.status !== 'passed');
console.log(`\n${results.length - failed.length}/${results.length} suite(s) passed.\n`);
process.exit(failed.length > 0 ? 1 : 0);
