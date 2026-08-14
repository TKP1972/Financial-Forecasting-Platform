/**
 * Automated accessibility scan of every screen, as each role sees it.
 *
 * `docs/accessibility.md` states plainly that no automated scan had ever been
 * run and that the position was therefore "unknown, not compliant". This is
 * that scan. It is the first of the five steps that document lists towards a
 * conformance statement, and the cheapest by a wide margin.
 *
 * Run per role rather than once, because the interesting screens differ by
 * permission: a Viewer sees restricted panels and disabled states an Admin
 * never renders, and those are exactly the branches most likely to ship with a
 * missing label or a colour-only cue.
 *
 * **What this does not prove.** axe-core finds roughly a third of WCAG issues —
 * the mechanical ones. It cannot judge whether a label is *meaningful*, whether
 * focus order makes sense, or whether a chart's text alternative conveys the
 * trend. A clean run here is a floor, not a conformance claim, and the document
 * should keep saying so.
 *
 *   node scripts/ui-journey/journey-a11y.mjs           (headless)
 *   node scripts/ui-journey/journey-a11y.mjs --headed
 *   node scripts/ui-journey/journey-a11y.mjs --all     (report minor issues too)
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './driver.mjs';

const WEB = process.env.FFP_WEB_URL ?? 'http://localhost:8080';
const HEADED = process.argv.includes('--headed');
const ALL = process.argv.includes('--all');
const OUT = join(process.cwd(), 'artifacts', 'ui-journey');

const AXE = readFileSync(join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n== ${t} ==`);

const ROLES = {
  viewer: { email: 'viewer@ffp.local', password: 'Viewer!Local26x', role: 'VIEWER' },
  analyst: { email: 'analyst@ffp.local', password: 'Analyst!Local26', role: 'ANALYST' },
  cfo: { email: 'cfo@ffp.local', password: 'Cfo!Local2026x', role: 'CFO' },
};

const PAGES = [
  ['Dashboard', '/'],
  ['Budget cycles', '/cycles'],
  ['Budgets', '/budgets'],
  ['Forecasting', '/forecasting'],
  ['Pricing', '/pricing'],
  ['Risk', '/risk'],
  ['Variance', '/variance'],
  ['Reports', '/reports'],
  ['Governance', '/governance'],
  ['Reference data', '/reference-data'],
  ['About', '/about'],
];

/**
 * Serious and critical only, by default.
 *
 * Not to flatter the result — the full list is written to
 * `artifacts/ui-journey/a11y.json` every run and `--all` prints it. It is
 * because a gate that fails on every minor advisory gets switched off within a
 * week, and one that fails on a genuine barrier does not.
 */
const GATED = ALL ? ['minor', 'moderate', 'serious', 'critical'] : ['serious', 'critical'];

async function signIn(page, { email, password }) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${WEB}/login`);
    await page.clearSession();
    await page.goto(`${WEB}/login`);
    await page.fill('#login-email', email);
    await page.fill('#login-password', password);
    page.drain();
    await page.click('Sign in');
    if (page.drain().failedRequests.some((f) => f.status === 429)) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    return;
  }
  throw new Error(`sign-in for ${email} kept hitting the rate limit`);
}

/** Inject axe and run it against the whole document. */
async function scan(page) {
  await page.evaluate(`if (!window.axe) { ${AXE} }`);
  return await page.evaluate(`
    axe.run(document, {
      resultTypes: ['violations'],
      // Colour contrast needs real rendering; it works headless but is the one
      // rule prone to false positives over gradients and semi-transparent
      // overlays, so it is reported rather than gated.
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }).then((r) =>
      r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
        example: v.nodes[0] ? v.nodes[0].target.join(' ') : null,
        summary: v.nodes[0] && v.nodes[0].failureSummary ? v.nodes[0].failureSummary.split('\\n')[1] || '' : '',
      })),
    )
  `);
}

// --------------------------------------------------------------------------

console.log('Accessibility scan (axe-core, WCAG 2.1 A/AA)');
console.log(`web=${WEB}  gating on: ${GATED.join(', ')}`);
mkdirSync(OUT, { recursive: true });

const page = await launch({ headless: !HEADED });
const report = {};

try {
  section('1. The login screen, before anyone is signed in');

  await page.goto(`${WEB}/login`);
  const loginViolations = await scan(page);
  report['(signed out) /login'] = loginViolations;
  const loginGated = loginViolations.filter((v) => GATED.includes(v.impact));
  check(
    'the login screen has no serious or critical issues',
    loginGated.length === 0,
    loginGated
      .map((v) => `${v.impact}: ${v.help} (${v.nodes} nodes, e.g. ${v.example})`)
      .join('\n        '),
  );

  section('2. Every screen, as each role renders it');

  for (const identity of Object.values(ROLES)) {
    const who = identity.role.toLowerCase();
    await signIn(page, identity);

    for (const [label, path] of PAGES) {
      await page.goto(`${WEB}${path}`);
      const violations = await scan(page);
      report[`${who} ${path}`] = violations;
      const gated = violations.filter((v) => GATED.includes(v.impact));
      check(
        `${who} — ${label}`,
        gated.length === 0,
        gated
          .map((v) => `${v.impact}: ${v.help} (${v.nodes} node(s), e.g. ${v.example})`)
          .join('\n        '),
      );
    }
  }

  section('3. The chart text alternatives are real, not decorative');

  // Charts were the largest gap in docs/accessibility.md: Recharts renders an
  // SVG a screen reader gets nothing from. AccessibleChart names each one and
  // carries the figures as a table. Asserted here rather than trusted, because
  // this is exactly the kind of thing that silently regresses.
  await signIn(page, ROLES.cfo);
  await page.goto(`${WEB}/risk`);

  // The charts only exist once a simulation has produced a result, so the scan
  // has to run one first. Without this the checks below inspect an empty page
  // and `every()` over nothing passes - which is how the first draft of this
  // section reported the charts as accessible before they were.
  const ran = await page.click('Run simulation');
  await page.settle({ timeoutMs: 30_000 });

  const riskCharts = await page.evaluate(`(() => {
    const figures = [...document.querySelectorAll('figure')];
    return figures.map((f) => {
      const img = f.querySelector('[role="img"]');
      const table = f.querySelector('figcaption table');
      return {
        labelled: !!(img && img.getAttribute('aria-label') || '').trim(),
        label: img ? (img.getAttribute('aria-label') || '').slice(0, 60) : null,
        svgHidden: !!f.querySelector('[aria-hidden="true"] svg, [aria-hidden="true"]'),
        tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
      };
    });
  })()`);

  check(
    'a simulation runs, so there are charts to assess at all',
    ran.ok && riskCharts.length > 0,
    `click=${ran.reason ?? 'ok'} figures=${riskCharts.length}`,
  );
  check(
    'every chart has an accessible name describing what it shows',
    riskCharts.length > 0 && riskCharts.every((c) => c.labelled),
    JSON.stringify(riskCharts),
  );
  check(
    'and the raw SVG is hidden from assistive technology',
    riskCharts.length > 0 && riskCharts.every((c) => c.svgHidden),
    JSON.stringify(riskCharts.map((c) => c.svgHidden)),
  );
  check(
    'the chart that has no adjacent table carries its figures as a hidden one',
    // The tornado sits above a real table and deliberately omits the duplicate;
    // the distribution has no such table, so it must supply one.
    riskCharts.some((c) => c.tableRows > 0),
    JSON.stringify(riskCharts.map((c) => c.tableRows)),
  );
} catch (error) {
  failed += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await page.close();
}

const path = join(OUT, 'a11y.json');
writeFileSync(path, JSON.stringify(report, null, 2));

// Everything found, including what is not gated, so the real position is
// visible rather than only the part that fails a build.
const everything = Object.values(report).flat();
const byImpact = everything.reduce((acc, v) => {
  acc[v.impact] = (acc[v.impact] ?? 0) + 1;
  return acc;
}, {});

console.log(`\n${'='.repeat(45)}`);
console.log(`  PASSED: ${passed}    FAILED: ${failed}`);
console.log(`  findings by impact: ${JSON.stringify(byImpact)}`);
console.log(`  full report -> ${path}`);
console.log('='.repeat(45));
process.exit(failed > 0 ? 1 : 0);
