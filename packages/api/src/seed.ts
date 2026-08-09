/**
 * Seed data.
 *
 * Builds a complete, coherent worked example rather than a handful of empty
 * rows: a telecom operator's FY2026 cycle with real-shaped budgets, two years of
 * seasonal actuals to forecast from, a live pursuit with a priced cost volume,
 * and a risk register. Every screen has something meaningful on it immediately,
 * and the numbers relate to each other the way they would in practice.
 *
 * Idempotent: safe to run repeatedly.
 */
import {
  Decimal,
  buildFiscalYear,
  periodKey,
  toMoneyString,
  type AccountType,
  type CostBehaviour,
  type CostCategory,
  type SpendCategory,
} from '@ffp/shared';
import { PrismaClient } from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';

const prisma = new PrismaClient();

const FISCAL_YEAR = 2026;
const PRIOR_YEARS = [2024, 2025];

const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/**
 * Deterministic pseudo-randomness so re-seeding produces the same demo data.
 * Nothing here is security-sensitive; it just has to be repeatable.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

async function main(): Promise<void> {
  console.log('Seeding the Financial Forecasting Platform...\n');

  // ---- Business units ----------------------------------------------------

  const group = await upsertUnit({ code: 'GRP', name: 'Group', currency: 'USD' });

  const units = {
    group,
    mobile: await upsertUnit({
      code: 'MOB',
      name: 'Mobile Networks',
      parentId: group.id,
      costCentre: 'CC-1000',
    }),
    fixed: await upsertUnit({
      code: 'FIX',
      name: 'Fixed Line & Fibre',
      parentId: group.id,
      costCentre: 'CC-2000',
    }),
    enterprise: await upsertUnit({
      code: 'ENT',
      name: 'Enterprise Solutions',
      parentId: group.id,
      costCentre: 'CC-3000',
    }),
    shared: await upsertUnit({
      code: 'SHR',
      name: 'Shared Services',
      parentId: group.id,
      costCentre: 'CC-9000',
    }),
  };
  console.log(`  Business units:      ${Object.keys(units).length}`);

  // ---- Users -------------------------------------------------------------

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@ffp.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Adm1n!Local2026';

  const people = [
    {
      email: adminEmail,
      first: 'System',
      last: 'Administrator',
      role: 'ADMIN',
      unit: null,
      password: adminPassword,
    },
    {
      email: 'cfo@ffp.local',
      first: 'Nomsa',
      last: 'Dlamini',
      role: 'CFO',
      unit: null,
      password: 'Cfo!Local2026x',
    },
    {
      email: 'finance.manager@ffp.local',
      first: 'Peter',
      last: 'Nakamura',
      role: 'FINANCE_MANAGER',
      unit: units.group.id,
      password: 'FinMgr!Local26',
    },
    {
      email: 'owner.mobile@ffp.local',
      first: 'Aisha',
      last: 'Okafor',
      role: 'BUDGET_OWNER',
      unit: units.mobile.id,
      password: 'Owner!Local26x',
    },
    {
      email: 'owner.fixed@ffp.local',
      first: 'Lars',
      last: 'Andersen',
      role: 'BUDGET_OWNER',
      unit: units.fixed.id,
      password: 'Owner!Local26x',
    },
    {
      email: 'analyst@ffp.local',
      first: 'Riya',
      last: 'Chandran',
      role: 'ANALYST',
      unit: units.enterprise.id,
      password: 'Analyst!Local26',
    },
    {
      email: 'viewer@ffp.local',
      first: 'Tom',
      last: 'Beckett',
      role: 'VIEWER',
      unit: null,
      password: 'Viewer!Local26x',
    },
  ] as const;

  const userByEmail = new Map<string, { id: string }>();
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      create: {
        email: person.email,
        passwordHash: await argonHash(person.password, ARGON_OPTIONS),
        firstName: person.first,
        lastName: person.last,
        role: person.role as never,
        businessUnitId: person.unit,
      },
      update: { firstName: person.first, lastName: person.last, role: person.role as never },
      select: { id: true },
    });
    userByEmail.set(person.email, user);
  }
  console.log(`  Users:               ${people.length}`);

  await prisma.businessUnit.update({
    where: { id: units.mobile.id },
    data: { ownerId: userByEmail.get('owner.mobile@ffp.local')?.id },
  });
  await prisma.businessUnit.update({
    where: { id: units.fixed.id },
    data: { ownerId: userByEmail.get('owner.fixed@ffp.local')?.id },
  });

  // ---- Chart of accounts -------------------------------------------------

  const accountSpecs: Array<{
    code: string;
    name: string;
    type: AccountType;
    category?: CostCategory;
    /** Rough share of a unit's budget, used to generate realistic figures. */
    weight: number;
    /** Seasonal shape: 1.0 is flat. */
    seasonality?: number[];
  }> = [
    { code: '4000', name: 'Mobile service revenue', type: 'REVENUE', weight: 0 },
    { code: '4100', name: 'Fixed & broadband revenue', type: 'REVENUE', weight: 0 },
    { code: '4200', name: 'Enterprise contract revenue', type: 'REVENUE', weight: 0 },
    {
      code: '5000',
      name: 'Interconnect & wholesale costs',
      type: 'COGS',
      category: 'OTHER_DIRECT',
      weight: 0.18,
    },
    {
      code: '5100',
      name: 'Handset & device costs',
      type: 'COGS',
      category: 'MATERIAL',
      weight: 0.12,
    },
    {
      code: '6000',
      name: 'Salaries & wages',
      type: 'OPEX',
      category: 'DIRECT_LABOUR',
      weight: 0.24,
    },
    {
      code: '6010',
      name: 'Contractor & subcontract',
      type: 'OPEX',
      category: 'SUBCONTRACT',
      weight: 0.08,
    },
    {
      code: '6100',
      name: 'Network operations & maintenance',
      type: 'OPEX',
      category: 'FACILITIES',
      weight: 0.11,
    },
    {
      code: '6200',
      name: 'Site rental & power',
      type: 'OPEX',
      category: 'FACILITIES',
      weight: 0.09,
    },
    { code: '6300', name: 'Software & licences', type: 'OPEX', category: 'SOFTWARE', weight: 0.05 },
    {
      code: '6400',
      name: 'Marketing & customer acquisition',
      type: 'OPEX',
      category: 'OTHER_DIRECT',
      weight: 0.06,
      seasonality: [0.7, 0.7, 0.9, 1.0, 1.0, 1.1, 0.9, 0.9, 1.1, 1.3, 1.6, 1.8],
    },
    {
      code: '6500',
      name: 'Professional services',
      type: 'OPEX',
      category: 'PROFESSIONAL_SERVICES',
      weight: 0.03,
    },
    { code: '6600', name: 'Travel & expenses', type: 'OPEX', category: 'TRAVEL', weight: 0.02 },
    {
      code: '7000',
      name: 'Network capital expenditure',
      type: 'CAPEX',
      category: 'EQUIPMENT',
      weight: 0.02,
    },
  ];

  /**
   * Telecom spend taxonomy and cost behaviour, keyed on account code.
   *
   * The behaviours are the interesting part: interconnect is billed per minute
   * so it is purely variable, whereas site rental and power do not fall when
   * traffic does. Payroll is semi-variable - a fixed core with a variable
   * overtime and contractor edge - which is why a flat percentage cut of
   * "headcount cost" never lands where anyone expects.
   */
  const classifications: Record<
    string,
    { spend: SpendCategory; behaviour: CostBehaviour; variableShare?: string }
  > = {
    '5000': { spend: 'ACCESS', behaviour: 'VARIABLE' },
    '5100': { spend: 'EQUIPMENT', behaviour: 'VARIABLE' },
    '6000': { spend: 'LABOUR', behaviour: 'SEMI_VARIABLE', variableShare: '0.25' },
    '6010': { spend: 'LABOUR', behaviour: 'VARIABLE' },
    '6100': { spend: 'TRANSPORT', behaviour: 'SEMI_VARIABLE', variableShare: '0.40' },
    '6200': { spend: 'FACILITIES', behaviour: 'FIXED' },
    '6300': { spend: 'SOFTWARE_SAAS', behaviour: 'SEMI_VARIABLE', variableShare: '0.35' },
    '6400': { spend: 'OTHER', behaviour: 'VARIABLE' },
    '6500': { spend: 'OTHER', behaviour: 'VARIABLE' },
    '6600': { spend: 'OTHER', behaviour: 'VARIABLE' },
    '7000': { spend: 'EQUIPMENT', behaviour: 'FIXED' },
  };

  const accountByCode = new Map<string, { id: string }>();
  for (const spec of accountSpecs) {
    const classification = classifications[spec.code];
    const behaviourFields = {
      spendCategory: (classification?.spend ?? null) as never,
      costBehaviour: (classification?.behaviour ?? null) as never,
      variableShare: classification?.variableShare ?? null,
    };

    const account = await prisma.account.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        name: spec.name,
        type: spec.type as never,
        category: (spec.category ?? null) as never,
        ...behaviourFields,
      },
      update: { name: spec.name, ...behaviourFields },
      select: { id: true },
    });
    accountByCode.set(spec.code, account);
  }
  console.log(`  Accounts:            ${accountSpecs.length}`);

  // ---- Strategic objectives ---------------------------------------------

  const objectiveSpecs = [
    {
      code: 'SO-1',
      title: 'Sustain and modernise the core network',
      horizon: 'H1_CORE',
      targetShare: '0.45',
    },
    {
      code: 'SO-2',
      title: 'Grow enterprise and B2B revenue',
      horizon: 'H2_ADJACENT',
      targetShare: '0.25',
    },
    {
      code: 'SO-3',
      title: 'Accelerate fibre-to-the-home coverage',
      horizon: 'H2_ADJACENT',
      targetShare: '0.20',
    },
    {
      code: 'SO-4',
      title: 'Build new digital service lines',
      horizon: 'H3_TRANSFORMATIONAL',
      targetShare: '0.10',
    },
  ] as const;

  const objectiveByCode = new Map<string, { id: string }>();
  for (const spec of objectiveSpecs) {
    const objective = await prisma.strategicObjective.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        title: spec.title,
        horizon: spec.horizon as never,
        targetShare: spec.targetShare,
        ownerId: userByEmail.get('cfo@ffp.local')?.id ?? null,
      },
      update: { title: spec.title, targetShare: spec.targetShare },
      select: { id: true },
    });
    objectiveByCode.set(spec.code, objective);
  }
  console.log(`  Objectives:          ${objectiveSpecs.length}`);

  // ---- Budget cycle & guidance ------------------------------------------

  const cycle = await prisma.budgetCycle.upsert({
    where: { fiscalYear_name: { fiscalYear: FISCAL_YEAR, name: `FY${FISCAL_YEAR} Annual Budget` } },
    create: {
      name: `FY${FISCAL_YEAR} Annual Budget`,
      fiscalYear: FISCAL_YEAR,
      periodType: 'MONTH',
      status: 'OPEN',
      opensAt: new Date(Date.UTC(FISCAL_YEAR - 1, 8, 1)),
      submissionDeadline: new Date(Date.UTC(FISCAL_YEAR - 1, 9, 31)),
      approvalDeadline: new Date(Date.UTC(FISCAL_YEAR - 1, 10, 30)),
      baseCurrency: 'USD',
      guidanceNotes:
        'Submissions must use the published assumptions. Any line varying more than 10% from prior year requires written justification.',
      // A 12-period rolling horizon, so the forecast always looks a full year
      // ahead rather than shrinking to nothing by month eleven. Periods are left
      // open: closing one is a governed act, not something a seed should decide.
      rollingHorizonPeriods: 12,
      actualsThroughPeriod: 0,
    },
    update: { status: 'OPEN', rollingHorizonPeriods: 12 },
  });

  const assumptions = [
    {
      key: 'salary_inflation',
      label: 'Salary inflation',
      value: '0.055',
      unit: 'RATE',
      notes: 'Group HR guidance, effective 1 April.',
    },
    {
      key: 'general_inflation',
      label: 'General cost inflation',
      value: '0.038',
      unit: 'RATE',
      notes: 'Central bank forecast, mid-case.',
    },
    {
      key: 'energy_escalation',
      label: 'Energy price escalation',
      value: '0.092',
      unit: 'RATE',
      notes: 'Site power is the largest single exposure this cycle.',
    },
    {
      key: 'fx_usd_zar',
      label: 'FX rate USD/ZAR',
      value: '18.4000',
      unit: 'AMOUNT',
      notes: 'Budget rate, fixed for the cycle.',
    },
    {
      key: 'subscriber_growth',
      label: 'Subscriber growth',
      value: '0.031',
      unit: 'RATE',
      notes: 'Net additions, blended prepaid and postpaid.',
    },
    { key: 'churn_rate', label: 'Monthly churn', value: '0.017', unit: 'RATE' },
    {
      key: 'capex_ratio',
      label: 'Capex as % of revenue',
      value: '0.145',
      unit: 'RATE',
      notes: 'Board-approved ceiling.',
    },
  ];

  await prisma.budgetAssumption.deleteMany({ where: { cycleId: cycle.id } });
  await prisma.budgetAssumption.createMany({
    data: assumptions.map((a) => ({
      cycleId: cycle.id,
      key: a.key,
      label: a.label,
      value: a.value,
      unit: a.unit,
      notes: a.notes ?? null,
    })),
  });

  await prisma.budgetGuidance.upsert({
    where: { cycleId: cycle.id },
    create: {
      cycleId: cycle.id,
      title: `FY${FISCAL_YEAR} Budget Plan & Guideline Pack`,
      strategicPriorities: [
        'Protect core network availability while reducing unit cost of delivery.',
        'Shift mix toward enterprise and fibre, which carry higher margin than legacy voice.',
        'Hold total opex growth below revenue growth — no exceptions without CFO sign-off.',
        'Fund at least one transformational initiative per business unit.',
      ],
      submissionInstructions: null,
      publishedAt: new Date(),
      publishedById: userByEmail.get('finance.manager@ffp.local')?.id ?? null,
      version: 1,
    },
    update: { publishedAt: new Date() },
  });

  const targets = [
    { unitId: units.mobile.id, revenue: '620000000', cost: '410000000', headcount: 1450 },
    { unitId: units.fixed.id, revenue: '285000000', cost: '210000000', headcount: 780 },
    { unitId: units.enterprise.id, revenue: '190000000', cost: '128000000', headcount: 410 },
    { unitId: units.shared.id, revenue: null, cost: '96000000', headcount: 320 },
  ];
  for (const target of targets) {
    await prisma.budgetTarget.upsert({
      where: { cycleId_businessUnitId: { cycleId: cycle.id, businessUnitId: target.unitId } },
      create: {
        cycleId: cycle.id,
        businessUnitId: target.unitId,
        revenueTarget: target.revenue,
        costCeiling: target.cost,
        headcountCeiling: target.headcount,
      },
      update: { revenueTarget: target.revenue, costCeiling: target.cost },
    });
  }
  console.log(
    `  Cycle:               FY${FISCAL_YEAR} (${assumptions.length} assumptions, ${targets.length} targets)`,
  );

  // ---- Budgets -----------------------------------------------------------

  const periods = buildFiscalYear(FISCAL_YEAR, 'MONTH');
  const costAccounts = accountSpecs.filter((a) => a.weight > 0);

  const budgetPlans = [
    {
      unit: units.mobile,
      name: 'Mobile Networks FY2026',
      annualCost: 402_000_000,
      status: 'APPROVED',
      objective: 'SO-1',
      seed: 101,
    },
    {
      unit: units.fixed,
      name: 'Fixed Line & Fibre FY2026',
      annualCost: 206_500_000,
      status: 'APPROVED',
      objective: 'SO-3',
      seed: 202,
    },
    {
      unit: units.enterprise,
      name: 'Enterprise Solutions FY2026',
      annualCost: 124_800_000,
      status: 'SUBMITTED',
      objective: 'SO-2',
      seed: 303,
    },
    {
      unit: units.shared,
      name: 'Shared Services FY2026',
      annualCost: 94_200_000,
      status: 'DRAFT',
      objective: 'SO-4',
      seed: 404,
    },
  ] as const;

  const preparer = userByEmail.get('analyst@ffp.local')?.id ?? null;
  const approver = userByEmail.get('finance.manager@ffp.local')?.id ?? null;
  let budgetCount = 0;

  for (const plan of budgetPlans) {
    const existing = await prisma.budget.findFirst({
      where: { cycleId: cycle.id, businessUnitId: plan.unit.id, name: plan.name },
      select: { id: true },
    });
    if (existing) {
      budgetCount += 1;
      continue;
    }

    const random = makeRandom(plan.seed);
    let budgetTotal = new Decimal(0);

    const lines = costAccounts.map((account, index) => {
      const annual = plan.annualCost * account.weight;
      const shape = account.seasonality ?? new Array(12).fill(1);
      const shapeTotal = shape.reduce((a, b) => a + b, 0);

      const periodAmounts = periods.map((_, i) => {
        // Small deterministic jitter so the demo does not look synthetic.
        const jitter = 0.97 + random() * 0.06;
        const value = annual * ((shape[i] ?? 1) / shapeTotal) * jitter;
        return toMoneyString(value);
      });

      const lineTotal = periodAmounts.reduce((acc, v) => acc.plus(v), new Decimal(0));
      budgetTotal = budgetTotal.plus(lineTotal);

      return {
        accountId: (accountByCode.get(account.code) as { id: string }).id,
        costCategory: (account.category ?? null) as never,
        method: (account.code === '6000'
          ? 'DRIVER_BASED'
          : index % 3 === 0
            ? 'ZERO_BASED'
            : 'INCREMENTAL') as never,
        description: account.name,
        strategicObjectiveId: objectiveByCode.get(plan.objective)?.id ?? null,
        alignment: (index % 4 === 0
          ? 'DIRECT'
          : index % 4 === 1
            ? 'SUPPORTING'
            : 'INDIRECT') as never,
        justification:
          account.code === '6200'
            ? 'Uplifted at the published energy escalation of 9.2%; site count held flat.'
            : 'Prior year outturn uplifted at general inflation, adjusted for known contract changes.',
        sortOrder: index,
        totalAmount: lineTotal.toFixed(4),
        periods: {
          create: periodAmounts.map((amount, i) => ({
            periodKey: (periods[i] as { key: string }).key,
            periodIndex: i + 1,
            amount,
          })),
        },
      };
    });

    const isApproved = plan.status === 'APPROVED';
    const budget = await prisma.budget.create({
      data: {
        cycleId: cycle.id,
        businessUnitId: plan.unit.id,
        name: plan.name,
        currency: 'USD',
        status: plan.status as never,
        version: isApproved ? 3 : plan.status === 'SUBMITTED' ? 2 : 1,
        preparedById: preparer,
        // Separation of duties holds even in the seed: the approver is never
        // the preparer or the submitter.
        submittedById: plan.status === 'DRAFT' ? null : preparer,
        approvedById: isApproved ? approver : null,
        submittedAt: plan.status === 'DRAFT' ? null : new Date(Date.UTC(FISCAL_YEAR - 1, 9, 20)),
        approvedAt: isApproved ? new Date(Date.UTC(FISCAL_YEAR - 1, 10, 12)) : null,
        totalAmount: budgetTotal.toFixed(4),
        lines: { create: lines },
      },
      select: { id: true, name: true, status: true, totalAmount: true },
    });

    await prisma.budgetVersion.create({
      data: {
        budgetId: budget.id,
        version: 1,
        status: budget.status,
        totalAmount: budget.totalAmount,
        snapshot: { seeded: true, note: 'Initial seeded snapshot' },
        createdById: preparer,
        comment: 'Seeded baseline',
      },
    });

    if (isApproved) {
      await prisma.approval.create({
        data: {
          budgetId: budget.id,
          approverId: approver as string,
          fromStatus: 'SUBMITTED',
          toStatus: 'APPROVED',
          comment: 'Approved subject to the energy escalation assumption being reviewed at H1.',
          amount: budget.totalAmount,
        },
      });
    }

    budgetCount += 1;
  }
  console.log(`  Budgets:             ${budgetCount}`);

  // ---- Actuals -----------------------------------------------------------

  /**
   * Two prior years plus part of the current year. The prior years give the
   * forecasting module something real to fit against; the current-year actuals
   * make the variance report and outturn projection meaningful.
   */
  const PERIODS_ELAPSED = 7;
  const existingActuals = await prisma.actual.count({ where: { cycleId: cycle.id } });

  if (existingActuals === 0) {
    const rows: Array<{
      cycleId: string;
      businessUnitId: string;
      accountId: string;
      periodKey: string;
      periodIndex: number;
      amount: string;
      commitment: string;
      source: string;
    }> = [];

    for (const plan of budgetPlans) {
      const random = makeRandom(plan.seed + 7777);

      for (const account of costAccounts) {
        const accountId = (accountByCode.get(account.code) as { id: string }).id;
        const shape = account.seasonality ?? new Array(12).fill(1);
        const shapeTotal = shape.reduce((a, b) => a + b, 0);

        // Prior years, at a lower base so there is a genuine growth trend.
        for (const [yearIndex, year] of PRIOR_YEARS.entries()) {
          const yearFactor = 0.9 + yearIndex * 0.05;
          const annual = plan.annualCost * account.weight * yearFactor;
          for (let i = 0; i < 12; i += 1) {
            const jitter = 0.94 + random() * 0.12;
            rows.push({
              cycleId: cycle.id,
              businessUnitId: plan.unit.id,
              accountId,
              periodKey: periodKey(year, i + 1, 'MONTH'),
              periodIndex: i + 1,
              amount: toMoneyString(annual * ((shape[i] ?? 1) / shapeTotal) * jitter),
              commitment: '0.0000',
              source: 'SEED_HISTORY',
            });
          }
        }

        // Current year to date. Mobile is deliberately running hot on energy so
        // the variance report has a real red line to show.
        const overrun = plan.unit.id === units.mobile.id && account.code === '6200' ? 1.14 : 1.0;
        const annual = plan.annualCost * account.weight;
        for (let i = 0; i < PERIODS_ELAPSED; i += 1) {
          const jitter = 0.96 + random() * 0.08;
          rows.push({
            cycleId: cycle.id,
            businessUnitId: plan.unit.id,
            accountId,
            periodKey: (periods[i] as { key: string }).key,
            periodIndex: i + 1,
            amount: toMoneyString(annual * ((shape[i] ?? 1) / shapeTotal) * jitter * overrun),
            commitment: i === PERIODS_ELAPSED - 1 ? toMoneyString(annual * 0.02) : '0.0000',
            source: 'SEED_ACTUALS',
          });
        }
      }
    }

    // Chunked: a single createMany of ~5k rows is fine, but chunking keeps
    // memory flat and gives useful progress if the seed is extended later.
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.actual.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
    }
    console.log(
      `  Actuals:             ${rows.length} (2 prior years + ${PERIODS_ELAPSED} months current)`,
    );
  } else {
    console.log(`  Actuals:             ${existingActuals} (already present)`);
  }

  // ---- Pursuit & pricing model ------------------------------------------

  const pursuit =
    (await prisma.pursuit.findFirst({ where: { name: 'National Grid Connectivity Framework' } })) ??
    (await prisma.pursuit.create({
      data: {
        name: 'National Grid Connectivity Framework',
        client: 'National Utilities Authority',
        businessUnitId: units.enterprise.id,
        stage: 'PROPOSAL',
        contractType: 'MANAGED_SERVICE',
        probabilityOfWin: '0.45',
        expectedAwardDate: new Date(Date.UTC(FISCAL_YEAR, 2, 31)),
        durationMonths: 60,
        notes:
          'Five-year managed connectivity for 2,400 substation sites. Incumbent is under-performing on SLA; our differentiator is guaranteed restoration time.',
      },
    }));

  const existingModel = await prisma.pricingModel.findFirst({ where: { pursuitId: pursuit.id } });
  if (!existingModel) {
    const pricingInput = {
      name: 'National Grid Framework — bid case v1',
      contractType: 'MANAGED_SERVICE',
      currency: 'USD',
      years: 5,
      labour: [
        {
          labourCategory: 'Network Engineer',
          hoursByYear: [18720, 18720, 17680, 17680, 17680],
          baseRate: '68.50',
          escalationRate: '0.055',
          fte: 9,
        },
        {
          labourCategory: 'Field Technician',
          hoursByYear: [37440, 37440, 35360, 35360, 35360],
          baseRate: '41.20',
          escalationRate: '0.055',
          fte: 18,
        },
        {
          labourCategory: 'Service Desk Analyst',
          hoursByYear: [12480, 12480, 12480, 12480, 12480],
          baseRate: '28.75',
          escalationRate: '0.048',
          fte: 6,
        },
        {
          labourCategory: 'Programme Manager',
          hoursByYear: [2080, 2080, 2080, 2080, 2080],
          baseRate: '95.00',
          escalationRate: '0.05',
          fte: 1,
        },
      ],
      directCosts: [
        {
          description: 'Edge routers and CPE',
          category: 'EQUIPMENT',
          amountByYear: ['4200000', '900000', '640000', '640000', '2100000'],
          escalationRate: '0.02',
          isPassThrough: false,
        },
        {
          description: 'Backhaul circuit lease',
          category: 'SUBCONTRACT',
          amountByYear: ['2880000'],
          escalationRate: '0.038',
          isPassThrough: false,
        },
        {
          description: 'Site power and cooling',
          category: 'FACILITIES',
          amountByYear: ['1150000'],
          escalationRate: '0.092',
          isPassThrough: false,
        },
        {
          description: 'Client-directed spectrum fees',
          category: 'OTHER_DIRECT',
          amountByYear: ['640000'],
          escalationRate: '0.03',
          isPassThrough: true,
        },
      ],
      burdens: [
        { pool: 'FRINGE', ratesByYear: ['0.3150'], appliesTo: [] },
        { pool: 'OVERHEAD', ratesByYear: ['0.2280'], appliesTo: [] },
        { pool: 'GA', ratesByYear: ['0.0940'], appliesTo: [] },
      ],
      feeRate: '0.115',
      discountRate: '0.02',
      costOfCapital: '0.098',
      assumptions: [
        'Site count fixed at 2,400 for the full term; volume changes are priced as a change order.',
        'Labour escalated at the published 5.5% salary inflation assumption.',
        'Spectrum fees are client-directed and billed at cost with no fee applied.',
        'Energy escalated at 9.2% per the cycle assumption set — the single largest downside exposure.',
      ],
    };

    // Priced through the engine so the stored result is genuinely the engine's
    // output, not a hand-written approximation that could drift from it.
    const { buildPricingModel } = await import('@ffp/engine');
    const result = buildPricingModel({
      name: pricingInput.name,
      contractType: pricingInput.contractType as never,
      currency: pricingInput.currency,
      years: pricingInput.years,
      labour: pricingInput.labour,
      directCosts: pricingInput.directCosts as never,
      burdens: pricingInput.burdens.map((b) => ({
        pool: b.pool as never,
        ratesByYear: b.ratesByYear,
      })),
      feeRate: pricingInput.feeRate,
      discountRate: pricingInput.discountRate,
      costOfCapital: pricingInput.costOfCapital,
      assumptions: pricingInput.assumptions,
    });

    await prisma.pricingModel.create({
      data: {
        pursuitId: pursuit.id,
        name: pricingInput.name,
        contractType: 'MANAGED_SERVICE',
        currency: 'USD',
        years: 5,
        input: pricingInput as never,
        result: JSON.parse(JSON.stringify(result)) as never,
        totalPrice: result.totals.price,
        totalCost: result.totals.totalCost,
        grossMargin: result.margin.grossMargin,
        npv: result.npv,
        irr: result.irr,
        version: 1,
        createdById: userByEmail.get('analyst@ffp.local')?.id ?? null,
      },
    });

    console.log(
      `  Pricing model:       ${result.totals.price} USD at ${((result.margin.grossMargin ?? 0) * 100).toFixed(1)}% margin`,
    );
  } else {
    console.log('  Pricing model:       already present');
  }

  // ---- Rate card ---------------------------------------------------------

  /**
   * A default rate per category, targeted overrides by location and channel,
   * and a version that takes effect a year in - so a multi-year pursuit priced
   * off this card genuinely crosses a rate change and has to handle it.
   */
  const rateCardEntries: Array<{
    labourCategory: string;
    location?: string;
    channel?: string;
    complexity?: string;
    rate: string;
    effectiveFrom: Date;
    effectiveTo?: Date;
  }> = [];

  const categories: Array<[string, number]> = [
    ['Network Engineer', 68.5],
    ['Field Technician', 41.2],
    ['Service Desk Analyst', 28.75],
    ['Programme Manager', 95.0],
  ];

  const year1From = new Date(Date.UTC(FISCAL_YEAR, 0, 1));
  const year1To = new Date(Date.UTC(FISCAL_YEAR + 1, 0, 1));
  const year2From = year1To;

  for (const [category, base] of categories) {
    // Unqualified default, then the FY+1 version at a 5.5% uplift.
    rateCardEntries.push({
      labourCategory: category,
      rate: base.toFixed(2),
      effectiveFrom: year1From,
      effectiveTo: year1To,
    });
    rateCardEntries.push({
      labourCategory: category,
      rate: (base * 1.055).toFixed(2),
      effectiveFrom: year2From,
    });

    // Lagos delivers below the blended default; onsite work above it.
    rateCardEntries.push({
      labourCategory: category,
      location: 'Lagos',
      rate: (base * 0.82).toFixed(2),
      effectiveFrom: year1From,
      effectiveTo: year1To,
    });
    rateCardEntries.push({
      labourCategory: category,
      location: 'Lagos',
      rate: (base * 0.82 * 1.055).toFixed(2),
      effectiveFrom: year2From,
    });
    rateCardEntries.push({
      labourCategory: category,
      channel: 'Onsite',
      rate: (base * 1.18).toFixed(2),
      effectiveFrom: year1From,
    });
  }

  const existingCard = await prisma.rateCard.findUnique({ where: { code: 'STD-DELIVERY' } });
  if (!existingCard) {
    await prisma.rateCard.create({
      data: {
        code: 'STD-DELIVERY',
        name: 'Standard delivery rates',
        description:
          'Blended delivery rates by location and channel. The FY+1 version applies the 5.5% salary inflation assumption, so multi-year pursuits cross a rate change.',
        currency: 'USD',
        createdById: userByEmail.get('finance.manager@ffp.local')?.id ?? null,
        entries: { create: rateCardEntries },
      },
    });
    console.log(`  Rate card:           STD-DELIVERY (${rateCardEntries.length} entries)`);
  } else {
    console.log('  Rate card:           already present');
  }

  // ---- Risk register -----------------------------------------------------

  const riskSpecs = [
    {
      title: 'Energy tariff increase exceeds the 9.2% budget assumption',
      category: 'MARKET',
      probability: 4,
      impact: 4,
      financialImpact: '8400000',
      response: 'MITIGATE',
      residualProbability: 3,
      residualImpact: 3,
      mitigation:
        'Hedge 60% of site power via fixed-price PPA; accelerate the solar retrofit programme at the 400 highest-consumption sites.',
      unit: units.mobile.id,
    },
    {
      title: 'Fibre build permits delayed by municipal backlog',
      category: 'REGULATORY',
      probability: 4,
      impact: 3,
      financialImpact: '5200000',
      response: 'MITIGATE',
      residualProbability: 3,
      residualImpact: 2,
      mitigation:
        'Pre-lodge permits one quarter ahead; second contractor on standby for permitted areas.',
      unit: units.fixed.id,
    },
    {
      title: 'Loss of the National Grid framework to the incumbent',
      category: 'STRATEGIC',
      probability: 3,
      impact: 5,
      financialImpact: '12500000',
      response: 'MITIGATE',
      residualProbability: 2,
      residualImpact: 5,
      mitigation:
        'Restructure the SLA credit regime to make the restoration-time differentiator contractual rather than promised.',
      unit: units.enterprise.id,
    },
    {
      title: 'Handset supply constraint from a single-source vendor',
      category: 'SUPPLY_CHAIN',
      probability: 3,
      impact: 3,
      financialImpact: '3100000',
      response: 'TRANSFER',
      residualProbability: 2,
      residualImpact: 2,
      mitigation: 'Dual-source agreement signed with a secondary ODM; 6-week buffer stock held.',
      unit: units.mobile.id,
    },
    {
      title: 'Salary inflation settles above the 5.5% assumption',
      category: 'FINANCIAL',
      probability: 3,
      impact: 3,
      financialImpact: '4600000',
      response: 'ACCEPT',
      residualProbability: 3,
      residualImpact: 3,
      mitigation: 'Accepted. Contingency held centrally rather than distributed to business units.',
      unit: units.shared.id,
    },
    {
      title: 'Core network outage exceeding the SLA threshold',
      category: 'OPERATIONAL',
      probability: 2,
      impact: 5,
      financialImpact: '9800000',
      response: 'MITIGATE',
      residualProbability: 1,
      residualImpact: 4,
      mitigation:
        'N+1 redundancy completed on all Tier-1 nodes; quarterly failover testing mandated.',
      unit: units.mobile.id,
    },
    {
      title: 'Data protection non-compliance following the regulation update',
      category: 'COMPLIANCE',
      probability: 2,
      impact: 4,
      financialImpact: '2700000',
      response: 'MITIGATE',
      residualProbability: 1,
      residualImpact: 3,
      mitigation: 'External readiness audit booked for Q2; remediation budget ring-fenced.',
      unit: units.shared.id,
    },
  ] as const;

  let riskCount = 0;
  for (const spec of riskSpecs) {
    const exists = await prisma.risk.findFirst({ where: { title: spec.title } });
    if (exists) {
      riskCount += 1;
      continue;
    }
    await prisma.risk.create({
      data: {
        title: spec.title,
        category: spec.category as never,
        businessUnitId: spec.unit,
        probability: spec.probability,
        impact: spec.impact,
        financialImpact: spec.financialImpact,
        response: spec.response as never,
        mitigationPlan: spec.mitigation,
        residualProbability: spec.residualProbability,
        residualImpact: spec.residualImpact,
        ownerId: userByEmail.get('finance.manager@ffp.local')?.id ?? null,
        status: 'OPEN',
        reviewDate: new Date(Date.UTC(FISCAL_YEAR, 3, 30)),
      },
    });
    riskCount += 1;
  }
  console.log(`  Risks:               ${riskCount}`);

  // ---- Drivers -----------------------------------------------------------

  const driverSpecs = [
    {
      code: 'SUBS_POST',
      name: 'Postpaid subscribers',
      unit: 'subscribers',
      volumes: new Array(12).fill('2450000'),
      unitRate: '24.80',
      growthRate: '0.0026',
      businessUnitId: units.mobile.id,
    },
    {
      code: 'SUBS_PRE',
      name: 'Prepaid subscribers',
      unit: 'subscribers',
      volumes: new Array(12).fill('7100000'),
      unitRate: '6.40',
      growthRate: '0.0014',
      businessUnitId: units.mobile.id,
    },
    {
      code: 'FIBRE_HP',
      name: 'Fibre homes passed',
      unit: 'premises',
      volumes: new Array(12).fill('118000'),
      unitRate: '41.50',
      growthRate: '0.0180',
      businessUnitId: units.fixed.id,
    },
    {
      code: 'ENT_SITES',
      name: 'Enterprise managed sites',
      unit: 'sites',
      volumes: new Array(12).fill('3820'),
      unitRate: '1150.00',
      growthRate: '0.0045',
      businessUnitId: units.enterprise.id,
    },
  ];

  for (const spec of driverSpecs) {
    await prisma.driver.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        name: spec.name,
        unit: spec.unit,
        businessUnitId: spec.businessUnitId,
        volumes: spec.volumes,
        unitRate: spec.unitRate,
        growthRate: spec.growthRate,
      },
      update: { name: spec.name, unitRate: spec.unitRate },
    });
  }
  console.log(`  Drivers:             ${driverSpecs.length}`);

  console.log('\nSeed complete.\n');
  console.log('  Sign in with:');
  for (const person of people) {
    console.log(`    ${person.role.padEnd(16)} ${person.email.padEnd(30)} ${person.password}`);
  }
  console.log('\n  These are local development credentials. Never use them anywhere real.\n');
}

async function upsertUnit(input: {
  code: string;
  name: string;
  parentId?: string;
  costCentre?: string;
  currency?: string;
}) {
  return prisma.businessUnit.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name,
      parentId: input.parentId ?? null,
      costCentre: input.costCentre ?? null,
      currency: input.currency ?? 'USD',
    },
    update: { name: input.name },
    select: { id: true, code: true },
  });
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
