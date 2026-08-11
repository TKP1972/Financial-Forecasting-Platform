/**
 * Browser journey: does every control a user can see do what it says?
 *
 * `journey-lifecycle.mjs` proves the API enforces the right rules. This proves
 * the *interface* tells the truth about them, which is a separate claim and the
 * one a client actually experiences. Three distinct defect classes live in the
 * gap and none are visible to an API test:
 *
 *   - a button that is offered but refused (the UI promises what the server
 *     will not honour)
 *   - a capability that exists but is unreachable (the server would allow it;
 *     nothing in the interface leads there)
 *   - a refusal that is correct but unexplained (the request 403s and the panel
 *     goes blank, so the user reads a working control as a broken product)
 *
 * The third is why this suite does not simply assert "no failed requests". A
 * 403 on the audit trail for an Analyst is the control **working**. What makes
 * it a defect or not is whether the screen then says so. So every 4xx must be
 * accompanied by a visible explanation; an unexplained one is the finding.
 *
 * Effects are verified against the API, never against the screen that caused
 * them. If a click claims to have approved a budget, this asks the server
 * independently. A UI that renders an optimistic success over a failed mutation
 * would pass any assertion made purely by reading the page.
 *
 *   node scripts/ui-journey/journey-ui.mjs            (headless)
 *   node scripts/ui-journey/journey-ui.mjs --headed   (watch it)
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

// Passwords match the seeded demo identities used by the other e2e suites.
const ROLES = {
  viewer: { email: 'viewer@ffp.local', password: 'Viewer!Local26x', role: 'VIEWER' },
  analyst: { email: 'analyst@ffp.local', password: 'Analyst!Local26', role: 'ANALYST' },
  owner: { email: 'owner.mobile@ffp.local', password: 'Owner!Local26x', role: 'BUDGET_OWNER' },
  financeManager: {
    email: 'finance.manager@ffp.local',
    password: 'FinMgr!Local26',
    role: 'FINANCE_MANAGER',
  },
  cfo: { email: 'cfo@ffp.local', password: 'Cfo!Local2026x', role: 'CFO' },
};

const NAV = [
  ['Dashboard', '/'],
  ['Budget cycles', '/cycles'],
  ['Budgets', '/budgets'],
  ['Forecasting', '/forecasting'],
  ['Pricing', '/pricing'],
  ['Risk', '/risk'],
  ['Variance', '/variance'],
  ['Governance', '/governance'],
  ['Reference data', '/reference-data'],
];

// The label the workflow renders for each target status. Kept in step with
// TRANSITION_LABELS in packages/web/src/pages/BudgetDetail.tsx; a drift shows up
// here as a button the suite cannot find, which is the correct failure.
const TRANSITION_LABELS = {
  DRAFT: 'Return to draft',
  IN_REVIEW: 'Move to review',
  SUBMITTED: 'Submit',
  APPROVED: 'Approve',
  REJECTED: 'Reject',
  LOCKED: 'Lock baseline',
};

// Wording the UI uses when it is explaining a refusal rather than swallowing
// it. Matching on the user-visible sentence is deliberate: an explanation the
// suite cannot find in the rendered text is one the user cannot find either.
const EXPLAINED = /restricted|not permitted|requires |permission|forbidden|only .* can|ask a /i;

// --------------------------------------------------------------------------
// API side, used only to establish fixtures and to verify effects independently.
// --------------------------------------------------------------------------

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

/** Sign in over the API, backing off on the 10/minute rate limit. */
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

// --------------------------------------------------------------------------
// Browser side.
// --------------------------------------------------------------------------

/**
 * Sign in through the real form. Not by writing the token into localStorage:
 * the login form is a control like any other and is the one every user touches
 * first, so injecting a session would skip the single most important click in
 * the product.
 */
async function signIn(page, { email, password }, { expectSuccess = true } = {}) {
  // POST /auth/login is rate-limited to 10/minute. A suite that signs in as
  // five roles crosses that on its own, and the symptom is indistinguishable
  // from a broken login: the form simply stays put. Back off and retry rather
  // than record a failure the application did not cause.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${WEB}/login`);
    await page.clearSession();
    await page.goto(`${WEB}/login`);
    await page.fill('#login-email', email);
    await page.fill('#login-password', password);
    page.drain();
    const clicked = await page.click('Sign in');
    const observed = page.drain();
    const landedOn = await page.url();

    if (expectSuccess && observed.failedRequests.some((f) => f.status === 429)) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    return { clicked, landedOn, observed };
  }
  throw new Error(`sign-in for ${email} kept hitting the rate limit`);
}

/**
 * Judge what a page did after an interaction.
 *
 * A refusal is only a defect when nothing on screen accounts for it, so the
 * verdict needs both halves: what the network did and what the user can read.
 */
function judge(observed, text) {
  const refusals = observed.failedRequests.filter(
    (f) => typeof f.status === 'number' && f.status >= 400 && f.status < 500,
  );
  const serverErrors = observed.failedRequests.filter(
    (f) => f.status === 'net-error' || (typeof f.status === 'number' && f.status >= 500),
  );
  return {
    refusals,
    serverErrors,
    // React logs the odd benign warning through console.error; only page-level
    // exceptions are treated as hard failures.
    crashes: observed.pageErrors,
    explained: EXPLAINED.test(text),
  };
}

// --------------------------------------------------------------------------

console.log('UI journey: every control tells the truth');
console.log(`web=${WEB}  api=${API}  headless=${!HEADED}`);
mkdirSync(SHOTS, { recursive: true });

const tokens = {};
for (const [key, identity] of Object.entries(ROLES)) {
  tokens[key] = await apiLogin(identity);
}

const page = await launch({ headless: !HEADED });
let exitCode = 0;

try {
  // ------------------------------------------------------------------------
  section('1. Signing in is a real click on a real form');

  const bad = await signIn(page, { email: ROLES.analyst.email, password: 'wrong-password-here' });
  const badText = await page.text();
  check(
    'a wrong password does not sign anyone in',
    bad.landedOn === '/login',
    `landed on ${bad.landedOn}`,
  );
  check(
    'and the screen says why rather than failing silently',
    /incorrect|invalid|could not|failed|check your/i.test(badText),
    badText.slice(0, 160).replace(/\n+/g, ' | '),
  );
  // The refusal must not leave a usable session behind.
  const leaked = await page.evaluate('localStorage.getItem("ffp.auth")');
  check('and no session is written on a failed sign-in', !leaked || !/accessToken/.test(leaked));

  // ------------------------------------------------------------------------
  section('2. Fixture');

  // Build through the API rather than reusing seeded data, so the suite stays
  // idempotent and does not consume shared state.
  const cycles = await api(tokens.analyst, 'GET', '/cycles');
  const annual = cycles.body.data.find((c) => (c.horizonYears ?? 1) === 1);
  const cycle = (await api(tokens.analyst, 'GET', `/cycles/${annual.id}`)).body.data;
  const units = await api(tokens.analyst, 'GET', '/org/business-units');
  const unit = units.body.data.find((u) => u.code === 'MOB') ?? units.body.data[0];
  const accounts = await api(tokens.analyst, 'GET', '/org/accounts');

  const created = await api(tokens.analyst, 'POST', '/budgets', {
    cycleId: cycle.id,
    businessUnitId: unit.id,
    name: `UI journey ${Date.now()}`,
    lines: [
      {
        accountId: accounts.body.data[0].id,
        periodAmounts: Array.from({ length: cycle.periods.length }, () =>
          (400000 / cycle.periods.length).toFixed(4),
        ),
      },
    ],
  });
  if (created.status !== 201) {
    throw new Error(`could not create the fixture budget: ${JSON.stringify(created.body)}`);
  }
  const budgetId = created.body.data.id;
  console.log(
    `  fixture budget ${budgetId} in ${cycle.fiscalYear}, ${cycle.periods.length} periods`,
  );

  // ------------------------------------------------------------------------
  section('3. Each role walks the whole product');

  // One sign-in per role, then everything that role can see. Signing in once
  // per assertion instead would spend the 10/minute login budget on nothing and
  // make the suite slower for no extra coverage.
  for (const [key, identity] of Object.entries(ROLES)) {
    const who = identity.role.toLowerCase();
    const result = await signIn(page, identity);
    check(
      `${who} signs in and lands on the dashboard`,
      result.clicked.ok && result.landedOn === '/',
      `click=${result.clicked.reason ?? 'ok'} landed=${result.landedOn}`,
    );
    check(
      `${who}'s dashboard loads without a page exception`,
      result.observed.pageErrors.length === 0,
      result.observed.pageErrors.slice(0, 2).join(' | '),
    );

    // --- every nav destination -------------------------------------------
    // The sidebar is not permission-filtered: every role is offered all nine
    // destinations. That is a deliberate choice, but it makes each one a
    // promise — it must work, or say why not, or the user has a dead end.
    const problems = [];
    for (const [label, path] of NAV) {
      await page.goto(`${WEB}/`);
      page.drain();
      const clicked = await page.click(label);
      const landed = await page.url();
      const text = await page.text();
      const verdict = judge(page.drain(), text);

      if (!clicked.ok) problems.push(`${label}: control ${clicked.reason}`);
      else if (landed !== path) problems.push(`${label}: went to ${landed}, not ${path}`);
      else if (text.length < 400) problems.push(`${label}: rendered almost nothing`);
      else if (verdict.crashes.length) problems.push(`${label}: threw ${verdict.crashes[0]}`);
      else if (verdict.serverErrors.length)
        problems.push(
          `${label}: ${verdict.serverErrors[0].status} ${verdict.serverErrors[0].url.split('/v1')[1] ?? ''}`,
        );
      else if (verdict.refusals.length && !verdict.explained)
        problems.push(
          `${label}: ${verdict.refusals[0].status} with nothing on screen explaining it`,
        );
    }
    check(
      `${who} can click all ${NAV.length} nav items and each works or explains itself`,
      problems.length === 0,
      problems.join('; '),
    );

    // --- field-level masking ----------------------------------------------
    // pricing:view_margin is held from Budget Owner upwards. An Analyst may
    // build a price and must not see the margin inside it — a control that only
    // exists if the *screen* honours it, since the analyst legitimately holds
    // the rest of the response.
    await page.goto(`${WEB}/pricing`);
    await page.click('Calculate price');
    const priceText = await page.text();
    const marginArea = priceText.slice(
      priceText.indexOf('GROSS MARGIN'),
      priceText.indexOf('GROSS MARGIN') + 120,
    );
    const masked = /Restricted/i.test(marginArea);
    const maySeeMargin = !['viewer', 'analyst'].includes(key);
    check(
      maySeeMargin
        ? `${who} sees the gross margin`
        : `${who} is shown "Restricted" instead of the gross margin`,
      masked !== maySeeMargin,
      `margin area: ${marginArea.replace(/\n+/g, ' | ').slice(0, 90)}`,
    );
    if (key === 'analyst') await page.screenshot(join(SHOTS, 'margin-masked-analyst.png'));
    if (key === 'cfo') await page.screenshot(join(SHOTS, 'margin-visible-cfo.png'));

    // --- workflow buttons versus what the server will honour ---------------
    await page.goto(`${WEB}/budgets/${budgetId}`);
    const text = await page.text();
    const controls = (await page.controls()).filter((c) => c.visible && !c.disabled);
    page.drain();

    // What the server says this identity may do, asked independently.
    const server = await api(tokens[key], 'GET', `/budgets/${budgetId}`);
    const allowed = server.body.data.availableTransitions ?? [];
    const expectedLabels = allowed.map((t) => TRANSITION_LABELS[t]);
    const offeredLabels = expectedLabels.filter((label) =>
      controls.some((c) => c.name.includes(label)),
    );

    check(
      `${who} is offered every transition the server allows [${allowed.join(', ') || 'none'}]`,
      offeredLabels.length === expectedLabels.length,
      `offered ${offeredLabels.join(', ') || 'none'} of ${expectedLabels.join(', ') || 'none'}`,
    );

    // And nothing beyond them. A button for a transition the server would
    // refuse is the promise this suite exists to catch.
    const strayLabels = Object.entries(TRANSITION_LABELS)
      .filter(([status]) => !allowed.includes(status))
      .filter(([, label]) => controls.some((c) => c.name.trim() === label))
      .map(([, label]) => label);
    check(
      `${who} is offered no transition the server would refuse`,
      strayLabels.length === 0,
      `stray: ${strayLabels.join(', ')}`,
    );

    if (allowed.length === 0) {
      check(
        `${who} is told why no transition is available`,
        /no transition is available|locked/i.test(text),
        text.slice(0, 120).replace(/\n+/g, ' | '),
      );
    }
  }

  // ------------------------------------------------------------------------
  section('4. Clicking a workflow button really moves the budget');

  // DRAFT -> IN_REVIEW as the analyst, driven entirely from the screen, then
  // confirmed against the API. The click is only credible if the server agrees.
  await signIn(page, ROLES.analyst);
  await page.goto(`${WEB}/budgets/${budgetId}`);
  page.drain();

  const before = (await api(tokens.analyst, 'GET', `/budgets/${budgetId}`)).body.data.status;
  const moved = await page.click(TRANSITION_LABELS.IN_REVIEW, { exact: true });
  const afterObserved = page.drain();
  const afterText = await page.text();
  const after = (await api(tokens.analyst, 'GET', `/budgets/${budgetId}`)).body.data.status;

  check('the analyst can actually press "Move to review"', moved.ok, moved.reason ?? '');
  check(
    'and the budget really moved, confirmed against the API not the screen',
    before === 'DRAFT' && after === 'IN_REVIEW',
    `${before} -> ${after}`,
  );
  check(
    'the click raised no server error',
    afterObserved.serverErrors === undefined
      ? afterObserved.failedRequests.every((f) => typeof f.status === 'number' && f.status < 500)
      : true,
    JSON.stringify(afterObserved.failedRequests.slice(0, 2)),
  );
  check(
    'and the screen now reflects the new status rather than the old one',
    /in review/i.test(afterText),
    afterText.slice(0, 140).replace(/\n+/g, ' | '),
  );
  await page.screenshot(join(SHOTS, 'after-move-to-review.png'));

  // The refusal side, driven from the screen: the analyst wrote this budget, so
  // submission is not theirs to make. The button must simply not be there.
  const analystControls = (await page.controls()).filter((c) => c.visible);
  check(
    'the analyst is not offered "Submit" on work they wrote',
    !analystControls.some((c) => c.name.trim() === TRANSITION_LABELS.SUBMITTED),
    analystControls
      .map((c) => c.name)
      .filter((n) => /submit/i.test(n))
      .join(', '),
  );

  // ------------------------------------------------------------------------
  section('5. Signing out ends the session');

  await page.click('Sign out');
  const afterSignOut = await page.url();
  const residual = await page.evaluate('localStorage.getItem("ffp.auth")');
  check('sign out returns to the login screen', afterSignOut === '/login', afterSignOut);
  check(
    'and the stored session no longer carries a token',
    !residual || !/"accessToken":"[^"]+"/.test(residual),
    String(residual).slice(0, 80),
  );

  // A signed-out browser must not be able to walk back in through the URL.
  await page.goto(`${WEB}/budgets`);
  check(
    'and a protected route typed directly is bounced to login',
    (await page.url()) === '/login',
    await page.url(),
  );

  // ------------------------------------------------------------------------
  section('6. Being rate-limited looks like a rate limit, not a broken form');

  // Last on purpose: this deliberately exhausts the 10/minute login budget, so
  // anything after it would be testing the limiter rather than the product.
  //
  // Worth asserting because the failure mode is invisible from the server side.
  // The limiter is working correctly either way; what decides whether the user
  // is informed or merely stuck is whether the screen renders the 429. It does,
  // and this keeps it that way.
  let sawLimit = false;
  let limitText = '';
  for (let attempt = 0; attempt < 15 && !sawLimit; attempt += 1) {
    const tried = await signIn(page, ROLES.viewer, { expectSuccess: false });
    if (tried.observed.failedRequests.some((f) => f.status === 429)) {
      sawLimit = true;
      limitText = await page.text();
    }
  }
  check('the login limiter engages under repeated attempts', sawLimit);
  check(
    'and the form says so rather than appearing to do nothing',
    /too many requests|slow down|try again|rate limit/i.test(limitText),
    limitText.slice(0, 160).replace(/\n+/g, ' | '),
  );
  if (sawLimit) await page.screenshot(join(SHOTS, 'rate-limited.png'));

  // Leave the limiter as we found it. Every other e2e suite signs in, so
  // exiting with the budget exhausted would fail the next one for a reason
  // that has nothing to do with it — the same class of cross-suite interference
  // that made the rolling suite's period consumption worth documenting. Poll
  // rather than sleep a fixed minute, so this costs only as long as it must.
  process.stdout.write('  waiting for the login limiter to clear');
  for (let i = 0; i < 40; i += 1) {
    const probe = await api(null, 'POST', '/auth/login', {
      email: ROLES.viewer.email,
      password: ROLES.viewer.password,
    });
    if (probe.status !== 429) break;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(' clear');
} catch (error) {
  failed += 1;
  exitCode = 1;
  console.log(`\n  ERROR  ${error.message}`);
  try {
    await page.screenshot(join(SHOTS, 'error.png'));
  } catch {
    /* the browser may already be gone */
  }
} finally {
  await page.close();
}

console.log(`\n${'='.repeat(45)}`);
console.log(`  PASSED: ${passed}    FAILED: ${failed}`);
console.log(`  screenshots -> ${SHOTS}`);
console.log('='.repeat(45));
process.exit(failed > 0 || exitCode ? 1 : 0);
