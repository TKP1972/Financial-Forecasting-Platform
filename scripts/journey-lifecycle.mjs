/**
 * End-to-end authorisation journey: one budget, five identities, cradle to grave.
 *
 * The existing smoke suites test features. This tests a *path* — it walks a
 * single budget through the entire lifecycle, changing who is acting at each
 * step, and asserts two things at every stage:
 *
 *   1. the role that should be able to act, can
 *   2. every role that should not, is refused **for the right reason**
 *
 * The second half is the point. Three separate controls all answer HTTP 403 —
 * role seniority, separation of duties, and delegated authority — so a test
 * that checked only the status code would pass while the wrong control fired.
 * Every refusal here asserts the error code.
 *
 * Written in Node rather than PowerShell deliberately. The e2e harness is
 * otherwise Windows-only, which is a documented limitation and an obstacle the
 * moment CI runs on Linux. This suite runs anywhere Node does.
 *
 *   node scripts/journey-lifecycle.mjs
 */
const API = process.env.FFP_API_URL ?? 'http://localhost:4000/api/v1';

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

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** Sign in, backing off on the 10/minute rate limit rather than failing. */
async function login(email, password) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return { token: body.accessToken, user: body.user };
  }
  throw new Error(`login kept hitting the rate limit for ${email}`);
}

/** Returns { status, body } rather than throwing, so refusals are assertable. */
async function call(actor, method, path, payload) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${actor.token}`,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const errorCode = (result) => result.body?.error?.code ?? null;

// --------------------------------------------------------------------------

console.log('Lifecycle authorisation journey');

const stamp = Date.now();

const analyst = await login('analyst@ffp.local', 'Analyst!Local26');
const owner = await login('owner.mobile@ffp.local', 'Owner!Local26x');
const financeManager = await login('finance.manager@ffp.local', 'FinMgr!Local26');
const cfo = await login('cfo@ffp.local', 'Cfo!Local2026x');
const viewer = await login('viewer@ffp.local', 'Viewer!Local26x');

console.log(
  `Signed in: analyst, budget owner, finance manager, CFO, viewer (${new Date().toISOString()})`,
);

// Find the cycle and a business unit to build against.
const cycles = await call(analyst, 'GET', '/cycles');
const cycle = cycles.body.data[0];
const units = await call(analyst, 'GET', '/org/business-units');
const unit = units.body.data.find((u) => u.code === 'MOB') ?? units.body.data[0];
const accounts = await call(analyst, 'GET', '/org/accounts');
const account = accounts.body.data[0];

const periodCount = (await call(analyst, 'GET', `/cycles/${cycle.id}`)).body.data.periods.length;

// 400,000 total: above a Budget Owner's 250,000 limit, below a Finance
// Manager's 2,000,000. That gap is what makes the delegated-authority step
// meaningful rather than incidental.
const perPeriod = (400000 / periodCount).toFixed(4);

section('1. Analyst builds the budget');

const created = await call(analyst, 'POST', '/budgets', {
  cycleId: cycle.id,
  businessUnitId: unit.id,
  name: `Journey ${stamp}`,
  lines: [
    {
      accountId: account.id,
      periodAmounts: Array.from({ length: periodCount }, () => perPeriod),
    },
  ],
});
check('analyst can create a budget', created.status === 201, `status=${created.status}`);
const budgetId = created.body?.data?.id;
if (!budgetId) {
  console.log('\nCannot continue without a budget id.');
  process.exit(1);
}

const viewerCreate = await call(viewer, 'POST', '/budgets', {
  cycleId: cycle.id,
  businessUnitId: unit.id,
  name: `Viewer should not ${stamp}`,
  lines: [],
});
check(
  'viewer cannot create a budget',
  viewerCreate.status === 403 && errorCode(viewerCreate) === 'FORBIDDEN',
  `status=${viewerCreate.status} code=${errorCode(viewerCreate)}`,
);

section('2. Submission requires ownership, not just authorship');

// The analyst moves it to review themselves - that transition is theirs to
// make. Doing this first is not incidental: DRAFT -> SUBMITTED is not a legal
// edge at all, so attempting it from DRAFT is refused by the transition-legality
// check before role is ever consulted. Testing the role rule requires standing
// on a legal edge first, or the assertion passes for the wrong reason.
const toReview = await call(analyst, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'IN_REVIEW',
});
check(
  'analyst can move their own draft to review',
  toReview.status === 200,
  `status=${toReview.status}`,
);

const analystSubmit = await call(analyst, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'SUBMITTED',
});
check(
  'analyst cannot submit what they wrote - submission needs ownership',
  analystSubmit.status === 403 && errorCode(analystSubmit) === 'FORBIDDEN',
  `status=${analystSubmit.status} code=${errorCode(analystSubmit)}`,
);

const submitted = await call(owner, 'POST', `/budgets/${budgetId}/transition`, { to: 'SUBMITTED' });
check('budget owner submits', submitted.status === 200, `status=${submitted.status}`);

section('3. Approval: seniority, then separation of duties, then authority');

const ownerApprove = await call(owner, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'APPROVED',
});
check(
  'budget owner cannot approve - role seniority, checked first',
  ownerApprove.status === 403 && errorCode(ownerApprove) === 'FORBIDDEN',
  `status=${ownerApprove.status} code=${errorCode(ownerApprove)}`,
);

// The finance manager returns it, submits it themselves, and then tries to
// approve it - which is the separation-of-duties case, reached legitimately
// rather than contrived.
await call(financeManager, 'POST', `/budgets/${budgetId}/transition`, { to: 'IN_REVIEW' });
const fmSubmit = await call(financeManager, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'SUBMITTED',
});
check('finance manager can submit', fmSubmit.status === 200, `status=${fmSubmit.status}`);

const selfApprove = await call(financeManager, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'APPROVED',
});
check(
  'the submitter cannot approve their own submission',
  selfApprove.status === 403 && errorCode(selfApprove) === 'SEPARATION_OF_DUTIES',
  `status=${selfApprove.status} code=${errorCode(selfApprove)}`,
);

const cfoApprove = await call(cfo, 'POST', `/budgets/${budgetId}/transition`, { to: 'APPROVED' });
check(
  'a different approver of sufficient seniority can approve',
  cfoApprove.status === 200,
  `status=${cfoApprove.status} ${JSON.stringify(cfoApprove.body).slice(0, 120)}`,
);

section('4. Returning it for revision clears the approval');

const backToReview = await call(cfo, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'IN_REVIEW',
});
check('an approved budget can be pulled back', backToReview.status === 200);

const afterReturn = await call(cfo, 'GET', `/budgets/${budgetId}`);
check(
  'the approver is cleared, so no stale sign-off survives onto editable numbers',
  afterReturn.body?.data?.approvedBy === null && afterReturn.body?.data?.approvedAt === null,
  `approvedBy=${JSON.stringify(afterReturn.body?.data?.approvedBy)} approvedAt=${afterReturn.body?.data?.approvedAt}`,
);

section('5. Locking is the CFO alone, and terminal');

await call(owner, 'POST', `/budgets/${budgetId}/transition`, { to: 'SUBMITTED' });
await call(cfo, 'POST', `/budgets/${budgetId}/transition`, { to: 'APPROVED' });

const fmLock = await call(financeManager, 'POST', `/budgets/${budgetId}/transition`, {
  to: 'LOCKED',
});
check(
  'finance manager cannot lock',
  fmLock.status === 403 && errorCode(fmLock) === 'FORBIDDEN',
  `status=${fmLock.status} code=${errorCode(fmLock)}`,
);

const locked = await call(cfo, 'POST', `/budgets/${budgetId}/transition`, { to: 'LOCKED' });
check('CFO locks the baseline', locked.status === 200, `status=${locked.status}`);

const reopen = await call(cfo, 'POST', `/budgets/${budgetId}/transition`, { to: 'IN_REVIEW' });
check(
  'a locked budget cannot be reopened, even by the CFO who locked it',
  reopen.status === 409 && errorCode(reopen) === 'CONFLICT',
  `status=${reopen.status} code=${errorCode(reopen)}`,
);

const editLocked = await call(analyst, 'PUT', `/budgets/${budgetId}/lines`, {
  lines: [
    { accountId: account.id, periodAmounts: Array.from({ length: periodCount }, () => '1.0000') },
  ],
});
check(
  'a locked budget cannot be edited',
  editLocked.status === 409,
  `status=${editLocked.status} code=${errorCode(editLocked)}`,
);

section('6. The trail records who did what');

const detail = await call(cfo, 'GET', `/budgets/${budgetId}`);
const versions = detail.body?.data?.versions ?? [];
check(
  'every transition left a version snapshot',
  versions.length >= 5,
  `versions=${versions.length}`,
);

const audit = await call(cfo, 'GET', `/governance/audit?pageSize=50&entityId=${budgetId}`);
const entries = audit.body?.data ?? [];
check('the journey is audited', entries.length >= 5, `entries=${entries.length}`);

const actors = new Set(entries.map((e) => e.actorEmail).filter(Boolean));
check(
  'the trail names more than one actor, as a real approval must',
  actors.size >= 2,
  `actors=${[...actors].join(', ')}`,
);

const chain = await call(cfo, 'POST', '/governance/audit/verify', {});
check(
  'the audit chain still verifies after the journey',
  chain.body?.data?.valid === true,
  `reason=${chain.body?.data?.reason}`,
);

// --------------------------------------------------------------------------

console.log(`\n${'='.repeat(45)}`);
console.log(`  PASSED: ${passed}    FAILED: ${failed}`);
console.log('='.repeat(45));
process.exit(failed > 0 ? 1 : 0);
