/**
 * The four analytical screens, driven rather than glanced at.
 *
 * `journey-ui.mjs` clicks every nav item and checks each destination loads or
 * explains itself. That is a reachability test, not a functional one — it never
 * runs a forecast, a simulation or a variance report, so those four screens
 * were only ever proven to *render*.
 *
 * This drives them. Two things it looks for that a rendering test cannot:
 *
 *   - **A control disabled for the right reason.** "Run simulation" is disabled
 *     for a Viewer because they lack `risk:simulate`, and disabled for an
 *     Analyst until they have chosen a business unit. Those are different
 *     states and only one of them is about permission. A screen that leaves the
 *     user unable to tell which has failed them.
 *   - **Reproducibility.** Monte Carlo takes an explicit seed precisely so a
 *     contingency figure quoted to a board can be re-derived later. That is a
 *     governance property, and it is checkable: same seed, same numbers.
 *
 *   node scripts/ui-journey/journey-operations.mjs           (headless)
 *   node scripts/ui-journey/journey-operations.mjs --headed
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { launch } from './driver.mjs';

const WEB = process.env.FFP_WEB_URL ?? 'http://localhost:8080';
const API = process.env.FFP_API_URL ?? 'http://localhost:4000/api/v1';
const HEADED = process.argv.includes('--headed');
const SHOTS = join(process.cwd(), 'artifacts', 'ui-journey');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n== ${t} ==`);

const ROLES = {
  viewer: { email: 'viewer@ffp.local', password: 'Viewer!Local26x', role: 'VIEWER' },
  analyst: { email: 'analyst@ffp.local', password: 'Analyst!Local26', role: 'ANALYST' },
  financeManager: {
    email: 'finance.manager@ffp.local',
    password: 'FinMgr!Local26',
    role: 'FINANCE_MANAGER',
  },
};

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function apiLogin({ email, password }) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await api(null, 'POST', '/auth/login', { email, password });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`API login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.accessToken;
  }
  throw new Error(`API login kept hitting the rate limit for ${email}`);
}

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

/** Select an option by its visible label, the way a user picks from a list. */
async function selectByLabel(page, selector, match) {
  return await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'no such select' };
    const option = [...el.options].find((o) => o.value && ${JSON.stringify(match)} === '*'
      ? o.value
      : o.textContent.toLowerCase().includes(${JSON.stringify(match)}.toLowerCase()));
    const chosen = option ?? [...el.options].find((o) => o.value);
    if (!chosen) return { ok: false, reason: 'no options' };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, chosen.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: chosen.textContent.trim() };
  })()`);
}

const control = async (page, name) =>
  (await page.controls()).find((c) => c.name.replace(/\s+/g, ' ').includes(name));

// --------------------------------------------------------------------------

console.log('Operations journey: forecasting, risk, variance, reference data');
console.log(`web=${WEB}  api=${API}  headless=${!HEADED}`);
mkdirSync(SHOTS, { recursive: true });

const tokens = {};
for (const [key, identity] of Object.entries(ROLES)) {
  tokens[key] = await apiLogin(identity);
}

const page = await launch({ headless: !HEADED });

try {
  // ------------------------------------------------------------------------
  section('1. Forecasting');

  await signIn(page, ROLES.viewer);
  await page.goto(`${WEB}/forecasting`);
  const viewerRun = await control(page, 'Run forecast');
  const viewerText = await page.text();
  check(
    'a viewer is not able to run a forecast',
    viewerRun?.disabled === true,
    `disabled=${viewerRun?.disabled}`,
  );
  check(
    'and the screen explains it rather than leaving a dead button',
    // Deliberately not requiring the permission identifier. The page says "your
    // role can view forecasts but not run them", which is a proper explanation.
    // An earlier draft demanded the literal string "forecast:run" and reported
    // working, plainly-worded copy as a defect — the same mistake as asserting
    // "no failed requests" instead of "every refusal is explained".
    /can view forecasts but not run|forecast:run|not permitted|your role/i.test(viewerText),
    viewerText.slice(0, 160).replace(/\n+/g, ' | '),
  );

  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/forecasting`);

  // Before any selection the control is disabled for a different reason - not
  // permission, but an incomplete form. The distinction is the point.
  const beforeSelect = await control(page, 'Run forecast');
  check(
    'an analyst holding forecast:run still starts with the control disabled',
    beforeSelect?.disabled === true,
    `disabled=${beforeSelect?.disabled}`,
  );
  check(
    'and the screen says what is missing, rather than why they are not allowed',
    /select a business unit and account/i.test(await page.text()),
    (await page.text()).slice(0, 140).replace(/\n+/g, ' | '),
  );

  const unit = await selectByLabel(page, '#fc-unit', 'mobile');
  await page.settle();
  // A series with real history, so the run is actually exercised rather than
  // skipped. Resolved by label rather than by id so it survives a re-seed.
  const account = await selectByLabel(page, '#fc-account', 'salaries');
  await page.settle({ timeoutMs: 20_000 });

  const afterSelect = await control(page, 'Run forecast');
  const selectedText = await page.text();
  check(
    'choosing a unit and account loads that series',
    unit.ok &&
      account.ok &&
      /historical points loaded|fewer than two recorded actuals/i.test(selectedText),
    `unit=${unit.label} account=${account.label}`,
  );

  // Two different reasons the control can still be disabled, and the screen has
  // to distinguish them: too little history is a data problem the user can act
  // on, and it is not the same as being disallowed.
  const thinSeries = /fewer than two recorded actuals/i.test(selectedText);
  if (thinSeries) {
    check(
      'a series too short to forecast says so, rather than disabling silently',
      afterSelect?.disabled === true,
      `disabled=${afterSelect?.disabled}`,
    );
    console.log('  NOTE  this account has under two actuals; the run itself is not exercised');
  } else {
    check('a series with enough history enables the run', afterSelect?.disabled === false);

    page.drain();
    const ranForecast = await page.click('Run forecast');
    await page.settle({ timeoutMs: 30_000 });
    const forecastObserved = page.drain();
    const forecastText = await page.text();
    check('the analyst can run a forecast', ranForecast.ok, ranForecast.reason ?? '');
    check(
      'and it is answered rather than refused',
      !forecastObserved.failedRequests.some((f) => f.status === 403),
      JSON.stringify(forecastObserved.failedRequests.slice(0, 2)),
    );
    check(
      'and the result appears rather than the empty state',
      !/Nothing to plot yet/i.test(forecastText),
      forecastText.slice(0, 120).replace(/\n+/g, ' | '),
    );
  }

  await page.screenshot(join(SHOTS, 'forecast-run.png'));

  // ------------------------------------------------------------------------
  section('2. Risk — and that a published contingency figure is reproducible');

  await signIn(page, ROLES.viewer);
  await page.goto(`${WEB}/risk`);
  const viewerSim = await control(page, 'Run simulation');
  const riskText = await page.text();
  check(
    'a viewer cannot run a simulation',
    viewerSim?.disabled === true,
    `disabled=${viewerSim?.disabled}`,
  );
  check(
    'and the refusal names risk:simulate specifically',
    /risk:simulate/i.test(riskText),
    riskText.slice(0, 120).replace(/\n+/g, ' | '),
  );

  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/risk`);
  page.drain();
  const ranSim = await page.click('Run simulation');
  await page.settle({ timeoutMs: 45_000 });
  const simText = await page.text();
  check('an analyst can run a simulation', ranSim.ok, ranSim.reason ?? '');
  check(
    'and the run states its iteration count and seed on screen',
    /iterations/i.test(simText) && /seed/i.test(simText),
    simText
      .slice(simText.search(/iterations/i) - 40, simText.search(/iterations/i) + 60)
      .replace(/\n+/g, ' '),
  );
  await page.screenshot(join(SHOTS, 'risk-simulation.png'));

  // The seed exists so a figure quoted to a board can be re-derived. Asserted
  // against the API rather than the screen: two runs at the same seed must
  // agree to the last decimal, and a different seed must not.
  // The same request the Risk screen sends, so this exercises the real contract
  // rather than a reduced one the UI would never produce.
  const simulationRequest = (seed) => ({
    name: 'Reproducibility probe',
    iterations: 2000,
    seed,
    baseValue: '402000000',
    inputs: [
      {
        code: 'ENERGY',
        label: 'Energy and site power',
        distribution: 'PERT',
        min: -2000000,
        mode: 1500000,
        max: 8500000,
      },
      {
        code: 'LABOUR',
        label: 'Salary inflation above assumption',
        distribution: 'TRIANGULAR',
        min: -1000000,
        mode: 900000,
        max: 4000000,
      },
    ],
    confidenceLevels: [0.1, 0.5, 0.8, 0.9, 0.95],
  });

  const first = await api(tokens.analyst, 'POST', '/risk/simulate', simulationRequest(424242));
  const repeat = await api(tokens.analyst, 'POST', '/risk/simulate', simulationRequest(424242));
  const different = await api(tokens.analyst, 'POST', '/risk/simulate', simulationRequest(999));

  check(
    'the simulation endpoint answers an analyst',
    first.status === 200 || first.status === 201,
    `status=${first.status} ${JSON.stringify(first.body?.error ?? '').slice(0, 100)}`,
  );
  if (first.status === 200 || first.status === 201) {
    const fingerprint = (r) =>
      JSON.stringify({
        mean: r.body?.data?.mean,
        sd: r.body?.data?.standardDeviation,
        pct: r.body?.data?.percentiles,
      });
    check(
      'the same seed reproduces the same figures exactly',
      fingerprint(first) === fingerprint(repeat),
      `${fingerprint(first).slice(0, 90)} vs ${fingerprint(repeat).slice(0, 90)}`,
    );
    check(
      'and a different seed does not, so the seed is genuinely the input',
      fingerprint(first) !== fingerprint(different),
      'identical results across different seeds would mean the seed is ignored',
    );
    check(
      'and the run reports the seed back, so it can be repeated from the record',
      String(first.body?.data?.seed) === '424242',
      `seed=${first.body?.data?.seed}`,
    );
  }

  const viewerSimApi = await api(tokens.viewer, 'POST', '/risk/simulate', simulationRequest(1));
  check(
    'and the API refuses a viewer, so the disabled button is not the only guard',
    viewerSimApi.status === 403 && viewerSimApi.body?.error?.code === 'FORBIDDEN',
    `status=${viewerSimApi.status} code=${viewerSimApi.body?.error?.code}`,
  );

  // ------------------------------------------------------------------------
  section('3. Variance');

  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/variance`);
  page.drain();
  await page.settle();
  const varianceText = await page.text();
  const varianceObserved = page.drain();
  check(
    'the variance report renders for a role that may read reports',
    varianceText.length > 600 && !/Nothing to show|no data/i.test(varianceText.slice(0, 200)),
    varianceText.slice(0, 120).replace(/\n+/g, ' | '),
  );
  check(
    'without a server error',
    !varianceObserved.failedRequests.some(
      (f) => f.status === 'net-error' || (typeof f.status === 'number' && f.status >= 500),
    ),
    JSON.stringify(varianceObserved.failedRequests.slice(0, 2)),
  );

  const projection = await page.click('Full-year projection');
  await page.settle({ timeoutMs: 30_000 });
  const projectionText = await page.text();
  check('the projection tab opens', projection.ok, projection.reason ?? '');
  check(
    'and shows a projected outturn rather than an empty panel',
    projectionText.length > 600,
    `${projectionText.length} chars`,
  );
  await page.screenshot(join(SHOTS, 'variance-projection.png'));

  // ------------------------------------------------------------------------
  section('4. Reference data');

  // The chart of accounts and the unit hierarchy are what every budget is built
  // from, so importing over them is an administrator's job alone.
  for (const key of ['viewer', 'analyst', 'financeManager']) {
    const identity = ROLES[key];
    await signIn(page, identity);
    await page.goto(`${WEB}/reference-data`);
    const controls = (await page.controls()).filter((c) => c.visible);
    const mutating = controls.filter((c) => /import|upload|apply|delete|save/i.test(c.name));
    check(
      `${identity.role.toLowerCase()} is offered no way to overwrite reference data`,
      mutating.length === 0,
      mutating.map((c) => c.name).join(', '),
    );
  }

  const importRefused = await api(tokens.analyst, 'POST', '/import/accounts', { rows: [] });
  check(
    'and the API refuses an analyst attempting an import directly',
    importRefused.status === 403 || importRefused.status === 400,
    `status=${importRefused.status} code=${importRefused.body?.error?.code}`,
  );
  if (importRefused.status === 403) {
    check(
      'with a permission error rather than a validation one',
      importRefused.body?.error?.code === 'FORBIDDEN',
      `code=${importRefused.body?.error?.code}`,
    );
  }

  // ------------------------------------------------------------------------
  section('5. The headline numbers are believable');

  /**
   * Plausibility, which is not a property any other test asserts.
   *
   * Three reporting defects survived 1,201 unit tests, seven end-to-end suites
   * and four browser journeys. Every one was structurally correct — right
   * shape, right types, no error — and every one was obviously wrong to anyone
   * who read the number:
   *
   *   - 333.6% utilisation and minus $1.42bn remaining, because two and a half
   *     years of history were attributed to a one-year cycle
   *   - the dashboard and the leadership pack $531m apart on the same figure,
   *     because one compared every unit against approved-only budgets
   *   - a leadership pack reporting +39.5% favourable, because it compared a
   *     full-year budget against year-to-date actuals
   *
   * These are deliberately loose range checks against seeded demonstration
   * data. They are not accounting assertions — the arithmetic is tested in the
   * engine — they are a smoke alarm for a figure that has stopped meaning
   * anything. A tight bound would break on every reasonable seed change and get
   * deleted; a loose one only fires when something is genuinely broken.
   */
  /**
   * A cycle that has actuals, resolved rather than assumed.
   *
   * The first draft took the newest OPEN cycle. `/cycles` returns newest fiscal
   * year first, and the e2e suites leave behind fixture cycles years in the
   * future with budgets and no spend - so it picked one of those and reported
   * 100% favourable variance and every unit red. Both were *correct* for a
   * cycle that has not started, and both looked exactly like the defects this
   * section exists to catch. A plausibility check on the wrong subject is worse
   * than none, because it cries wolf.
   */
  const allCycles = (await api(tokens.analyst, 'GET', '/cycles')).body.data;
  let current = null;
  let pack = null;
  for (const candidate of allCycles) {
    const built = (
      await api(tokens.financeManager, 'GET', `/reports/leadership-pack?cycleId=${candidate.id}`)
    ).body?.data;
    if (built && Number(built.summary?.actual ?? 0) > 0) {
      current = candidate;
      pack = built;
      break;
    }
  }

  const dash = (await api(tokens.analyst, 'GET', '/reports/dashboard')).body.data;

  check(
    'a cycle with recorded spend exists to assess',
    pack !== null,
    `checked ${allCycles.length} cycle(s); none had actuals`,
  );

  if (!pack) {
    console.log('  NOTE  no cycle has actuals; the ratio checks below need one');
  }

  const utilisation = dash.expenditure?.utilisation;
  check(
    'utilisation is a proportion of a budget, not a multiple of one',
    utilisation === null || utilisation === undefined || (utilisation >= 0 && utilisation <= 1.5),
    `utilisation=${utilisation == null ? 'null' : (utilisation * 100).toFixed(1) + '%'}`,
  );

  check(
    'nothing has consumed several times its approved budget',
    Number(dash.expenditure?.actual ?? 0) <= Number(dash.budget?.totalApproved ?? 0) * 2,
    `actual=${dash.expenditure?.actual} approved=${dash.budget?.totalApproved}`,
  );

  // The $531m defect, asserted against the live stack rather than in isolation:
  // the two screens must agree on the figure they both claim to report.
  const dashboardCompared =
    Number(dash.expenditure?.actual ?? 0) - Number(dash.expenditure?.unapprovedActual ?? 0);
  // Only comparable when the dashboard's own cycle is the one with the spend.
  // The dashboard reports the current cycle; the pack was resolved above.
  const sameCycle = pack !== null && dash.cycle?.id === current?.id;
  // The pack is built from budget lines, so its `actual` counts only spend a
  // line claims; anything on an unbudgeted pair is reported separately. The two
  // screens agree once that is added back. Asserting plain equality passed only
  // while the seed happened to have no unbudgeted spend, and broke the moment
  // real fixtures created some - which is how the omission was found.
  const packTotal = pack
    ? Number(pack.summary.actual) + Number(pack.summary.unbudgetedActual ?? 0)
    : 0;
  check(
    'the dashboard and the leadership pack account for the same spend',
    !sameCycle || Math.abs(dashboardCompared - packTotal) < 1,
    `dashboard=${dashboardCompared} pack=${pack?.summary?.actual} + unbudgeted=${pack?.summary?.unbudgetedActual} = ${packTotal}`,
  );

  check(
    'the pack reports through a period that has actuals, not the whole year',
    pack === null || (pack.throughPeriod >= 1 && pack.throughPeriod <= pack.periodsInYear),
    `through=${pack?.throughPeriod} of ${pack?.periodsInYear}`,
  );

  // Budget-to-date and actual-to-date must cover the same months. If the pack
  // reverted to a full-year denominator, this ratio would leap.
  const packVariance = pack?.summary?.variancePercent ?? null;
  check(
    'budget to date and actual to date cover the same months',
    packVariance === null || Math.abs(packVariance) <= 0.5,
    `variance=${packVariance === null ? 'null' : (packVariance * 100).toFixed(1) + '%'} — a large favourable swing usually means a full-year budget against part-year actuals`,
  );

  // Every unit red is what the mis-attributed history produced. One or two red
  // units is a business problem; all of them is a data problem.
  const rags = (pack?.byBusinessUnit ?? []).map((u) => u.rag);
  check(
    'not every business unit is red',
    rags.length === 0 || rags.some((r) => r !== 'RED'),
    `rag=${rags.join(',') || 'none'}`,
  );
} catch (error) {
  failed += 1;
  console.log(`\n  ERROR  ${error.message}`);
  try {
    await page.screenshot(join(SHOTS, 'operations-error.png'));
  } catch {
    /* browser may already be gone */
  }
} finally {
  await page.close();
}

console.log(`\n${'='.repeat(45)}`);
console.log(`  PASSED: ${passed}    FAILED: ${failed}`);
console.log(`  screenshots -> ${SHOTS}`);
console.log('='.repeat(45));
process.exit(failed > 0 ? 1 : 0);
