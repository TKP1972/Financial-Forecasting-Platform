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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

/**
 * Load the repository .env so suites inherit the real credentials.
 *
 * SEED_ADMIN_PASSWORD is configurable and the setup script generates a random
 * one, so a suite that hardcodes the shipped default breaks the moment anyone
 * follows the documented setup. Loading it here fixes every suite at once
 * rather than in each of them.
 */
try {
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // A malformed .env is the API's problem to report, not the runner's.
}

/**
 * Order matters: the broad smoke test first, tamper detection last because it
 * deliberately corrupts audit rows and anything after it would run against a
 * damaged chain.
 *
 * The UI journey needs a browser, so it is not in the default set - a CI runner
 * without Chrome would fail for want of a browser rather than for a defect.
 * Name it explicitly to run it:  node scripts/run-e2e.mjs ui-journey
 */
const ALL_SUITES = [
  'journey-lifecycle.mjs',
  'smoke-test.ps1',
  'smoke-test-planning.ps1',
  'smoke-test-rolling.ps1',
  'smoke-test-ratecards.ps1',
  'smoke-test-pilot.ps1',
  'verify-audit-tamper-detection.ps1',
];

/** Suites that are runnable but excluded from the default set. */
const OPTIONAL_SUITES = [
  'ui-journey/journey-ui.mjs',
  'ui-journey/journey-pricing.mjs',
  'ui-journey/journey-operations.mjs',
  'ui-journey/journey-a11y.mjs',
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
const ALIASES = {
  'ui-journey': 'ui-journey/journey-ui.mjs',
  'ui-pricing': 'ui-journey/journey-pricing.mjs',
  'ui-operations': 'ui-journey/journey-operations.mjs',
  'ui-a11y': 'ui-journey/journey-a11y.mjs',
  /** Every browser suite, in the order that leaves the login limiter usable. */
  ui: 'ui-journey/journey-ui.mjs',
};

function normalise(name) {
  if (ALIASES[name]) return ALIASES[name];
  if (name.endsWith('.ps1') || name.endsWith('.mjs')) return name;
  const known = [...ALL_SUITES, ...OPTIONAL_SUITES];
  const asNode = known.find((s) => s === `${name}.mjs` || s.endsWith(`/${name}.mjs`));
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

/**
 * Run a suite, streaming its output live *and* keeping a copy.
 *
 * `stdio: 'inherit'` used to be enough, and the cost of it was invisible: the
 * runner never saw a word of what a suite printed, so the summary could only
 * ever say `FAIL smoke-test-rolling.ps1 (exit 1)`. Meanwhile the suite itself
 * had printed the diagnosis *and* the remedy at the moment it failed. Anyone
 * reading the tail - which is what you read - got the exit code and lost the
 * answer, and the same failure was re-diagnosed from scratch twice.
 *
 * PowerShell strips ANSI when its output is redirected, so capturing costs the
 * colour. The pass/fail colour is the part that carries meaning, so it is
 * repainted here on the way through rather than given up.
 */
function runSuite(exe, args) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let captured = '';

    const tap = (stream, out) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        captured += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) out.write(`${paint(line)}\n`);
      });
      stream.on('end', () => {
        if (pending) out.write(paint(pending));
      });
    };

    tap(child.stdout, process.stdout);
    tap(child.stderr, process.stderr);
    child.on('error', (error) => resolve({ code: 1, output: `${captured}\n${error.message}` }));
    child.on('close', (code) => resolve({ code, output: captured }));
  });
}

/** Repaint the verdict word a suite prints, since the pipe stripped its colour. */
function paint(line) {
  if (!process.stdout.isTTY) return line;
  const match = /^(\s*)(PASS|FAIL|SKIP)(\b.*)$/.exec(line);
  if (!match) return line;
  const colour = match[2] === 'PASS' ? '32' : match[2] === 'FAIL' ? '31' : '33';
  return `${match[1]}\u001b[${colour}m${match[2]}\u001b[0m${match[3]}`;
}

/**
 * The lines worth repeating in the summary: the assertions that failed, and any
 * line the suite printed to explain itself. Capped, because a summary that
 * reproduces the whole run is the problem it exists to solve.
 */
function reasons(output) {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const failures = lines.filter((line) => /^\s*FAIL\s/.test(line));
  const explanations = lines.filter((line) =>
    /not enough|Re-seed|no such|not found|refused connection|ECONNREFUSED|^\s*ERROR/i.test(line),
  );

  return [...new Set([...failures, ...explanations])].slice(0, 6).map((line) => line.trim());
}

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
    ? await runSuite(process.execPath, [path])
    : await runSuite(shell.exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path]);

  results.push({
    suite,
    status: run.code === 0 ? 'passed' : 'failed',
    code: run.code,
    reasons: run.code === 0 ? [] : reasons(run.output),
  });
}

// --------------------------------------------------------------------------

console.log(`\n${'='.repeat(70)}\n  Summary\n${'='.repeat(70)}`);
for (const result of results) {
  const label = result.status === 'passed' ? 'PASS' : result.status === 'missing' ? 'MISS' : 'FAIL';
  const detail = result.code !== undefined && result.code !== 0 ? ` (exit ${result.code})` : '';
  console.log(`  ${label}  ${result.suite}${detail}`);
  // Why it failed, next to the fact that it failed. Reading the tail should
  // never require going back to find what the suite already said.
  for (const reason of result.reasons ?? []) console.log(`          ${reason}`);
}

const failed = results.filter((r) => r.status !== 'passed');
console.log(`\n${results.length - failed.length}/${results.length} suite(s) passed.\n`);
process.exit(failed.length > 0 ? 1 : 0);
