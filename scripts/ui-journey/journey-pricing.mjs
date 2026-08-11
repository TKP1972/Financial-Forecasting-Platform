/**
 * Pricing journey: is `pricing:view_margin` a real control or a UI courtesy?
 *
 * This is the one permission in the matrix that is not about who may *act* but
 * about what a legitimate user may *see*. An Analyst is meant to build and check
 * a cost volume without seeing the profit position on it — a commercially
 * meaningful separation, and the only field-level restriction in the product.
 *
 * That makes it the permission most easily faked. Hiding a number in a React
 * component satisfies every screenshot and every reviewer looking at the page,
 * while the value travels to the browser in the response and is readable by
 * anyone who opens the network tab. The Pricing screen makes an explicit
 * promise about this, in so many words:
 *
 *   "Cost and price are shown in full; margin, fee, NPV and IRR are withheld by
 *    the API, not merely hidden here."
 *
 * A user-facing claim about where a control lives is a claim this suite can
 * check, so it does. Section 3 asks the API directly, with a non-holder's own
 * token, whether any margin figure comes back. Nothing about the browser can
 * make that assertion pass.
 *
 *   node scripts/ui-journey/journey-pricing.mjs            (headless)
 *   node scripts/ui-journey/journey-pricing.mjs --headed
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

// Who holds pricing:view_margin, from packages/shared/src/rbac.ts. Budget Owner
// upwards. Stated here rather than derived so a change to the matrix shows up
// as a failure to be considered, not as a silently-updated expectation.
const ROLES = {
  viewer: { email: 'viewer@ffp.local', password: 'Viewer!Local26x', role: 'VIEWER', margin: false },
  analyst: {
    email: 'analyst@ffp.local',
    password: 'Analyst!Local26',
    role: 'ANALYST',
    margin: false,
  },
  owner: {
    email: 'owner.mobile@ffp.local',
    password: 'Owner!Local26x',
    role: 'BUDGET_OWNER',
    margin: true,
  },
  financeManager: {
    email: 'finance.manager@ffp.local',
    password: 'FinMgr!Local26',
    role: 'FINANCE_MANAGER',
    margin: true,
  },
  cfo: { email: 'cfo@ffp.local', password: 'Cfo!Local2026x', role: 'CFO', margin: true },
};

// Endpoints that exist only to answer a profitability question.
const MARGIN_ONLY_ENDPOINTS = [
  '/pricing/price-to-win',
  '/pricing/sensitivity',
  '/pricing/expected-value',
];

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
    const observed = page.drain();
    if (observed.failedRequests.some((f) => f.status === 429)) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    return await page.url();
  }
  throw new Error(`sign-in for ${email} kept hitting the rate limit`);
}

/**
 * Walk a response and collect anything that discloses a profit position.
 *
 * Recursive rather than field-by-field on purpose: a margin figure nested in a
 * summary, a per-year breakdown or a list row is disclosed just as thoroughly
 * as a top-level one, and naming the fields individually is how the pursuits
 * list came to be missed in the first place.
 */
const MARGIN_KEYS =
  /^(grossMargin|latestMargin|margin|markup|grossProfit|profit|fee|effectiveFeeRate|npv|irr)$/i;

function findDisclosedMargin(value, path = '$') {
  const found = [];
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findDisclosedMargin(v, `${path}[${i}]`)));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      // A redacted field is null, or the zero the redactor substitutes. Anything
      // else is a real number that reached someone who may not see it.
      if (MARGIN_KEYS.test(key) && v !== null && v !== undefined && typeof v !== 'object') {
        const numeric = Number(v);
        if (Number.isFinite(numeric) && numeric !== 0) {
          found.push(`${path}.${key}=${v}`);
        }
      }
      found.push(...findDisclosedMargin(v, `${path}.${key}`));
    }
  }
  return found;
}

// --------------------------------------------------------------------------

console.log('Pricing journey: is pricing:view_margin real?');
console.log(`web=${WEB}  api=${API}  headless=${!HEADED}`);
mkdirSync(SHOTS, { recursive: true });

const tokens = {};
for (const [key, identity] of Object.entries(ROLES)) tokens[key] = await apiLogin(identity);

const page = await launch({ headless: !HEADED });

try {
  // ------------------------------------------------------------------------
  section('1. The screen masks the profit position for those who may not see it');

  for (const identity of Object.values(ROLES)) {
    const who = identity.role.toLowerCase();
    await signIn(page, identity);
    await page.goto(`${WEB}/pricing`);
    await page.click('Calculate price');
    const text = await page.text();

    // Price and cost must remain fully visible: the restriction is on profit,
    // not on the ability to build a cost volume. Over-restricting would be as
    // much a defect as under-restricting, and less likely to be noticed.
    check(
      `${who} still sees total price and total cost in full`,
      /TOTAL PRICE/i.test(text) && /TOTAL COST/i.test(text) && /[$£€]\s?[\d,]+/.test(text),
      text
        .slice(text.indexOf('TOTAL PRICE'), text.indexOf('TOTAL PRICE') + 80)
        .replace(/\n+/g, ' '),
    );

    const marginArea = text.slice(text.indexOf('GROSS MARGIN'), text.indexOf('GROSS MARGIN') + 200);
    const masked = /Restricted/i.test(marginArea);
    check(
      identity.margin
        ? `${who} sees gross margin, NPV and IRR`
        : `${who} is shown "Restricted" for gross margin, NPV and IRR`,
      masked !== identity.margin,
      marginArea.replace(/\n+/g, ' | ').slice(0, 100),
    );

    // The goal-seek panel exists only to answer a margin question, so it must
    // not be offered to someone who cannot see the answer.
    const controls = (await page.controls()).filter((c) => c.visible);
    const hasSolve = controls.some((c) => /Solve for fee rate/i.test(c.name));
    check(
      identity.margin
        ? `${who} is offered the price-to-win goal seek`
        : `${who} is not offered the price-to-win goal seek`,
      hasSolve === identity.margin,
      `solve control ${hasSolve ? 'present' : 'absent'}`,
    );
  }

  // ------------------------------------------------------------------------
  section('2. The pursuit list masks margin on screen');

  for (const [key, identity] of Object.entries(ROLES)) {
    const who = identity.role.toLowerCase();
    await signIn(page, identity);
    await page.goto(`${WEB}/pricing`);
    await page.click('Pursuits');
    const text = await page.text();
    const masked = /Restricted/.test(text);
    check(
      identity.margin
        ? `${who} sees the margin column in the pursuit list`
        : `${who} sees "Restricted" in the pursuit list margin column`,
      masked === !identity.margin,
      text.slice(0, 100).replace(/\n+/g, ' | '),
    );
    if (key === 'analyst') await page.screenshot(join(SHOTS, 'pursuits-masked-analyst.png'));
  }

  // ------------------------------------------------------------------------
  section('3. And the API withholds it, which is what the screen claims');

  // The Pricing screen tells the user, in as many words, that margin is
  // "withheld by the API, not merely hidden here". Everything above this point
  // would pass just as happily if that sentence were false.
  for (const [key, identity] of Object.entries(ROLES)) {
    if (identity.margin) continue;
    const who = identity.role.toLowerCase();

    // Every read path that can carry a saved model's figures, checked by the
    // same rule rather than one endpoint at a time. GET /pricing/models/:id
    // needs an id, so it is resolved from a holder's own view first — the point
    // is what the *non-holder* receives from it.
    const pursuits = await api(tokens[key], 'GET', '/pricing/pursuits');
    const readPaths = [{ path: '/pricing/pursuits', body: pursuits.body }];

    const anyModel = (await api(tokens.cfo, 'GET', '/pricing/pursuits')).body?.data?.[0];
    if (anyModel) {
      const models = await api(tokens.cfo, 'GET', `/pricing/pursuits?stage=${anyModel.stage}`);
      const modelId = models.body?.data?.[0]?.id;
      if (modelId) {
        const detail = await api(tokens[key], 'GET', `/pricing/models/${modelId}`);
        // A 404 means this id was a pursuit rather than a model; only assert on
        // a response that actually carries a model.
        if (detail.status === 200)
          readPaths.push({ path: '/pricing/models/:id', body: detail.body });
      }
    }

    for (const { path, body } of readPaths) {
      const disclosed = findDisclosedMargin(body);
      check(
        `${who} receives no margin figure from GET ${path}`,
        disclosed.length === 0,
        disclosed.slice(0, 3).join(', '),
      );
    }

    // Price must still come through: the restriction is on profit, and a
    // response stripped of price would be over-reach rather than a control.
    check(
      `${who} still receives the price on the pursuit list`,
      (pursuits.body?.data ?? []).some((p) => p.latestPrice !== null),
      `prices: ${(pursuits.body?.data ?? []).map((p) => p.latestPrice).join(', ')}`,
    );

    for (const endpoint of MARGIN_ONLY_ENDPOINTS) {
      const res = await api(tokens[key], 'POST', endpoint, {});
      check(
        `${who} is refused POST ${endpoint}`,
        res.status === 403 && res.body?.error?.code === 'FORBIDDEN',
        `status=${res.status} code=${res.body?.error?.code}`,
      );
    }
  }

  // ------------------------------------------------------------------------
  section('4. The restriction does not cost an analyst their actual job');

  // A control that over-reaches is still a defect. An Analyst holds
  // pricing:write and must be able to build and save a model.
  const analystCalc = await api(tokens.analyst, 'POST', '/pricing/calculate', {});
  check(
    'an analyst can still run a calculation',
    analystCalc.status === 200 || analystCalc.status === 400,
    `status=${analystCalc.status} (400 is a payload issue, not a refusal)`,
  );
  check(
    'and is not refused it on permission grounds',
    analystCalc.status !== 403,
    `status=${analystCalc.status}`,
  );

  const viewerWrite = await api(tokens.viewer, 'POST', '/pricing/models', {});
  check(
    'a viewer cannot save a pricing model',
    viewerWrite.status === 403 && viewerWrite.body?.error?.code === 'FORBIDDEN',
    `status=${viewerWrite.status} code=${viewerWrite.body?.error?.code}`,
  );

  // ------------------------------------------------------------------------
  section('5. The goal seek works for those entitled to it');

  await signIn(page, ROLES.cfo);
  await page.goto(`${WEB}/pricing`);
  page.drain();
  const solved = await page.click('Solve for fee rate');
  const solveObserved = page.drain();
  const solveText = await page.text();
  check('the CFO can press "Solve for fee rate"', solved.ok, solved.reason ?? '');
  check(
    'and it is answered rather than refused',
    !solveObserved.failedRequests.some((f) => f.status === 403),
    JSON.stringify(solveObserved.failedRequests.slice(0, 2)),
  );
  check(
    'and the panel reports a result rather than staying blank',
    /fee rate|target|margin|price/i.test(solveText),
    solveText.slice(0, 100).replace(/\n+/g, ' | '),
  );
  await page.screenshot(join(SHOTS, 'price-to-win-cfo.png'));

  // ------------------------------------------------------------------------
  section('6. Commercial sign-off on the price');

  // pricing:approve was in the matrix and in the user manual for months while
  // guarding nothing at all - a documented capability that did not exist. Now
  // that it does, these assert the control end to end: who is offered it, who
  // the server actually honours, and that the effect is real.

  // Resolve the fixture and normalise to unapproved, so the suite is idempotent
  // rather than dependent on how the last run left it.
  const cfoPursuits = await api(tokens.cfo, 'GET', '/pricing/pursuits');
  const target = (cfoPursuits.body?.data ?? []).find((p) => p.latestModelId);
  if (!target) {
    check('a priced pursuit exists to sign off', false, 'no pursuit has a saved pricing model');
  } else {
    const modelId = target.latestModelId;
    if (target.latestApprovedAt) {
      await api(tokens.cfo, 'POST', `/pricing/models/${modelId}/withdraw-approval`, {
        reason: 'ui-journey reset',
      });
    }

    // --- who the server honours -------------------------------------------
    // Three different controls answer 403 here, so each asserts its own code.
    // A bare status check would pass for the wrong reason.
    const analystApprove = await api(
      tokens.analyst,
      'POST',
      `/pricing/models/${modelId}/approve`,
      {},
    );
    check(
      'an analyst cannot approve a price - no pricing:approve',
      analystApprove.status === 403 && analystApprove.body?.error?.code === 'FORBIDDEN',
      `status=${analystApprove.status} code=${analystApprove.body?.error?.code}`,
    );

    const fmApprove = await api(
      tokens.financeManager,
      'POST',
      `/pricing/models/${modelId}/approve`,
      {},
    );
    check(
      'a finance manager holds the permission but not the authority for this bid',
      fmApprove.status === 403 && fmApprove.body?.error?.code === 'DELEGATED_AUTHORITY_EXCEEDED',
      `status=${fmApprove.status} code=${fmApprove.body?.error?.code} price=${target.latestPrice}`,
    );

    // --- who is offered it on screen --------------------------------------
    for (const [key, identity] of Object.entries(ROLES)) {
      const who = identity.role.toLowerCase();
      await signIn(page, identity);
      await page.goto(`${WEB}/pricing`);
      await page.click('Pursuits');
      const text = await page.text();
      const controls = (await page.controls()).filter((c) => c.visible);
      const offered = controls.some((c) => /Approve price|Withdraw approval/i.test(c.name));
      const mayApprove = ['financeManager', 'cfo'].includes(key);

      check(
        mayApprove
          ? `${who} is offered the sign-off control`
          : `${who} is not offered the sign-off control`,
        offered === mayApprove,
        `control ${offered ? 'present' : 'absent'}`,
      );

      // Sign-off state is a governance fact, not a commercial one: every role
      // must be able to see whether a committed price carries an approval,
      // including those who may not see the margin inside it.
      check(
        `${who} can see whether the price is signed off`,
        /signed off|not signed off/i.test(text),
        text.slice(text.indexOf('Sign-off'), text.indexOf('Sign-off') + 60).replace(/\n+/g, ' | '),
      );
    }

    // --- the click does what it says --------------------------------------
    await signIn(page, ROLES.cfo);
    await page.goto(`${WEB}/pricing`);
    await page.click('Pursuits');
    page.drain();

    const clicked = await page.click('Approve price');
    check('the CFO can press "Approve price"', clicked.ok, clicked.reason ?? '');

    // Verified against the API, not against the screen that caused it.
    const afterApprove = await api(tokens.cfo, 'GET', '/pricing/pursuits');
    const approvedRow = afterApprove.body.data.find((p) => p.latestModelId === modelId);
    check(
      'and the price is really signed off, confirmed against the API',
      approvedRow?.latestApprovedAt !== null && approvedRow?.latestApprovedAt !== undefined,
      `latestApprovedAt=${approvedRow?.latestApprovedAt}`,
    );
    await page.screenshot(join(SHOTS, 'pricing-signed-off-cfo.png'));

    // --- the sign-off is visible without disclosing the margin -------------
    const analystView = await api(tokens.analyst, 'GET', '/pricing/pursuits');
    const analystRow = analystView.body.data.find((p) => p.latestModelId === modelId);
    check(
      'an analyst sees the sign-off but still no margin',
      analystRow?.latestApprovedAt !== null && analystRow?.latestMargin === null,
      `approvedAt=${analystRow?.latestApprovedAt} margin=${analystRow?.latestMargin}`,
    );

    // --- it is audited, and the chain still verifies -----------------------
    const audit = await api(tokens.cfo, 'GET', `/governance/audit?pageSize=10&entityId=${modelId}`);
    const entries = audit.body?.data ?? [];
    check(
      'the sign-off is recorded in the audit trail as an APPROVE',
      entries.some((e) => e.action === 'APPROVE'),
      `actions=${entries.map((e) => e.action).join(',') || 'none'}`,
    );
    const chain = await api(tokens.cfo, 'POST', '/governance/audit/verify', {});
    check(
      'and the audit chain still verifies afterwards',
      chain.body?.data?.valid === true,
      `reason=${chain.body?.data?.reason}`,
    );

    // --- withdrawing clears it --------------------------------------------
    const withdrawn = await api(
      tokens.cfo,
      'POST',
      `/pricing/models/${modelId}/withdraw-approval`,
      {
        reason: 'ui-journey teardown',
      },
    );
    check('the sign-off can be withdrawn', withdrawn.status === 200, `status=${withdrawn.status}`);
    const afterWithdraw = await api(tokens.cfo, 'GET', '/pricing/pursuits');
    check(
      'and the pursuit reads as unapproved again, leaving the fixture as found',
      afterWithdraw.body.data.find((p) => p.latestModelId === modelId)?.latestApprovedAt === null,
    );
  }
} catch (error) {
  failed += 1;
  console.log(`\n  ERROR  ${error.message}`);
  try {
    await page.screenshot(join(SHOTS, 'pricing-error.png'));
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
process.exit(failed > 0 ? 1 : 0);
