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

  /**
   * A parent unit holds no actuals of its own, so nothing under it can be
   * forecast - and the advice for that is the opposite of the advice for an
   * empty account. Reported by the owner: the control greyed out with no reason
   * he could see, and the note that did exist told him to pick another account,
   * which for a parent unit is a hunt through all fourteen that ends nowhere.
   *
   * The reason now lives on the control's own tooltip as well as the note,
   * because hovering a greyed button is the first thing anyone does.
   */
  const parentUnit = await selectByLabel(page, '#fc-unit', 'group');
  await page.settle();
  await selectByLabel(page, '#fc-account', '*');
  await page.settle({ timeoutMs: 20_000 });

  const parentState = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Run forecast'));
    return { disabled: b.disabled, title: b.title };
  })()`);

  check(
    'a parent unit disables the run',
    parentUnit.ok && parentState.disabled === true,
    `unit=${parentUnit.label} disabled=${parentState.disabled}`,
  );
  check(
    'and the control itself carries the reason, not only a note below it',
    typeof parentState.title === 'string' && parentState.title.length > 0,
    `title=${JSON.stringify(parentState.title)}`,
  );
  check(
    'and names the parent unit as the cause rather than blaming the account',
    /parent unit/i.test(parentState.title) && !/pick another account/i.test(parentState.title),
    parentState.title,
  );

  // Back to a series that has history, for the rest of the section.
  await selectByLabel(page, '#fc-unit', 'mobile');
  await page.settle();
  await selectByLabel(page, '#fc-account', 'salaries');
  await page.settle({ timeoutMs: 20_000 });

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
  section('4. Variance decomposition');

  /**
   * Price, volume and joint. The engine could always do this and no screen led
   * there - found while writing the demonstration script, which named it as a
   * highlight and would have sent somebody hunting for a button in front of a
   * client.
   *
   * The assertion that matters is the identity, not the presence of a table:
   * the three components must sum to the total, because a decomposition whose
   * parts do not reconcile is worse than none.
   */
  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/variance`);
  await page.settle();

  const decompTab = await page.click('What drove it');
  check('the decomposition tab opens', decompTab.ok, decompTab.reason ?? '');
  await page.settle();

  page.drain();
  const ranDecomp = await page.click('Decompose');
  check('an analyst can decompose a variance', ranDecomp.ok, ranDecomp.reason ?? '');
  await new Promise((r) => setTimeout(r, 1200));
  check(
    'and it is answered rather than refused',
    !page.drain().failedRequests.some((f) => f.status >= 400),
    'a 4xx or 5xx came back',
  );

  // Verified against the API rather than by parsing the screen that produced it.
  const decomposed = (
    await api(tokens.analyst, 'POST', '/variance/decompose', {
      lines: [
        {
          label: 'Energy',
          budgetVolume: '42000.0000',
          budgetPrice: '118.0000',
          actualVolume: '45360.0000',
          actualPrice: '131.0000',
        },
      ],
    })
  ).body.data.lines[0];

  // Hand-computed: volume (45,360 - 42,000) x 118 = 396,480; price
  // (131 - 118) x 42,000 = 546,000; joint 3,360 x 13 = 43,680. Total 986,160,
  // which is 5,942,160 - 4,956,000.
  check(
    'the volume effect is the quantity change at the budgeted price',
    Number(decomposed.volumeVariance) === 396480,
    `volume=${decomposed.volumeVariance}`,
  );
  check(
    'the price effect is the rate change across the budgeted quantity',
    Number(decomposed.priceVariance) === 546000,
    `price=${decomposed.priceVariance}`,
  );
  check(
    'the components sum to the total, so nothing is unexplained',
    Math.abs(
      Number(decomposed.volumeVariance) +
        Number(decomposed.priceVariance) +
        Number(decomposed.jointVariance) -
        Number(decomposed.totalVariance),
    ) < 0.0001,
    `${decomposed.volumeVariance} + ${decomposed.priceVariance} + ${decomposed.jointVariance} != ${decomposed.totalVariance}`,
  );
  check(
    'and the total reconciles to actual minus budget',
    Math.abs(
      Number(decomposed.actualAmount) -
        Number(decomposed.budgetAmount) -
        Number(decomposed.totalVariance),
    ) < 0.0001,
    `${decomposed.actualAmount} - ${decomposed.budgetAmount} != ${decomposed.totalVariance}`,
  );

  // The sign convention here is the opposite of the Budget vs actual tab, which
  // a finance reader spots immediately. The screen has to say so.
  const decompText = await page.text();
  check(
    'the screen states which way the signs run',
    /opposite way to the|effect on spend|positive.*added cost/i.test(decompText),
    decompText.slice(0, 160).replace(/\n+/g, ' | '),
  );

  // ------------------------------------------------------------------------
  section('5. Reference data');

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
  section('6. Scenario planning is reachable');

  // Driver-based scenario comparison was built in the engine, exposed on the
  // API, and led to by nothing. "What if subscribers grow 2% instead of 5%" is
  // the most common question in planning, and the product could not be asked
  // it. These assert the path a user actually walks.
  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/forecasting`);
  page.drain();

  const toScenarios = await page.click('Scenarios');
  check('the Scenarios tab opens', toScenarios.ok, toScenarios.reason ?? '');

  const driversText = await page.text();
  check(
    'the stored drivers are listed rather than typed in by hand',
    /subscribers|premises|sites/i.test(driversText),
    driversText.slice(0, 120).replace(/\n+/g, ' | '),
  );

  const compared = await page.click('Compare cases');
  check('an analyst can compare cases', compared.ok, compared.reason ?? '');
  await page.settle();

  const rows = await page.evaluate(
    '[...document.querySelectorAll("tbody tr")].map((r) => r.innerText)',
  );
  check('every case is compared against the base', rows.length >= 3, `rows=${rows.length}`);

  const scenarioText = await page.text();
  check(
    'a probability-weighted case is reported',
    /probability-weighted/i.test(scenarioText),
    scenarioText.slice(0, 120).replace(/\n+/g, ' | '),
  );

  // The weighted figure must sit between the worst and best cases, or the
  // weighting is not doing what it says. Checked from the API rather than by
  // parsing the screen that produced it.
  const driversForCheck = (await api(tokens.analyst, 'GET', '/forecasts/drivers')).body.data;
  const comparison = (
    await api(tokens.analyst, 'POST', '/forecasts/scenarios/compare', {
      drivers: driversForCheck.map((d) => ({
        code: d.code,
        name: d.name,
        unit: d.unit,
        volumes: d.volumes,
        unitRate: d.unitRate,
        ...(d.growthRate ? { growthRate: d.growthRate } : {}),
      })),
      scenarios: [
        { name: 'Base', type: 'BASE', probability: 0.5, adjustments: [] },
        {
          name: 'Down',
          type: 'WORST',
          probability: 0.5,
          adjustments: driversForCheck.map((d) => ({ targetCode: d.code, factor: '0.900000' })),
        },
      ],
    })
  ).body.data;

  const totals = comparison.scenarios.map((s) => Number(s.grandTotal));
  const weighted = Number(comparison.expectedValue);
  check(
    'the weighted case falls between the cases it weighs',
    weighted >= Math.min(...totals) && weighted <= Math.max(...totals),
    `weighted=${weighted} range=${Math.min(...totals)}..${Math.max(...totals)}`,
  );

  check(
    'a 10% volume cut moves the total by 10%',
    Math.abs((comparison.scenarios[1]?.deltaPercent ?? 0) + 0.1) < 0.0001,
    `deltaPercent=${comparison.scenarios[1]?.deltaPercent}`,
  );

  // A viewer holds forecast:read but not forecast:run: they may see the drivers
  // and may not run a comparison, and the screen has to say which.
  await signIn(page, ROLES.viewer);
  await page.goto(`${WEB}/forecasting`);
  await page.click('Scenarios');
  await page.settle();
  const viewerCompare = await control(page, 'Compare cases');
  const viewerScenarioText = await page.text();
  check(
    'a viewer cannot run a comparison',
    viewerCompare?.disabled === true,
    `disabled=${viewerCompare?.disabled}`,
  );
  check(
    'and is told which permission it needs',
    /forecast:run/i.test(viewerScenarioText),
    viewerScenarioText.slice(0, 140).replace(/\n+/g, ' | '),
  );

  // ------------------------------------------------------------------------
  section('7. The headline numbers are believable');

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
