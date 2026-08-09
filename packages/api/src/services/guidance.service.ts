/**
 * The annual budget plan and guideline pack.
 *
 * This is the document a business unit is actually handed at the start of a
 * cycle. It has to stand alone: someone reading it should be able to build their
 * budget without asking finance what rate to use for salary inflation, when the
 * deadline is, or what leadership is trying to achieve.
 *
 * Assembled from live cycle data so it cannot drift from what the platform will
 * validate submissions against.
 */
import {
  AppError,
  buildFiscalYear,
  formatMoney,
  formatPercent,
  toDecimal,
  type PeriodType,
} from '@ffp/shared';
import { prisma } from '../db.js';

export interface GuidancePackAssumption {
  key: string;
  label: string;
  value: string;
  unit: string;
  displayValue: string;
  notes: string | null;
}

export interface GuidancePackTarget {
  businessUnitCode: string;
  businessUnitName: string;
  revenueTarget: string | null;
  costCeiling: string | null;
  headcountCeiling: number | null;
}

export interface GuidancePack {
  version: number;
  title: string;
  publishedAt: string | null;
  cycle: {
    id: string;
    name: string;
    fiscalYear: number;
    periodType: PeriodType;
    status: string;
    baseCurrency: string;
    opensAt: string;
    submissionDeadline: string;
    approvalDeadline: string;
  };
  calendar: Array<{ key: string; label: string; startDate: string; endDateExclusive: string }>;
  strategicPriorities: string[];
  objectives: Array<{
    code: string;
    title: string;
    horizon: string;
    targetShare: string | null;
  }>;
  assumptions: GuidancePackAssumption[];
  targets: GuidancePackTarget[];
  submissionInstructions: string | null;
  notes: string | null;
  /** Chart of accounts extract, so units budget against the right codes. */
  accounts: Array<{ code: string; name: string; type: string }>;
}

export async function buildGuidancePack(cycleId: string): Promise<GuidancePack> {
  const cycle = await prisma.budgetCycle.findUnique({
    where: { id: cycleId },
    include: {
      guidance: true,
      assumptions: { orderBy: { key: 'asc' } },
      targets: {
        include: { businessUnit: { select: { code: true, name: true } } },
        orderBy: { businessUnit: { code: 'asc' } },
      },
    },
  });

  if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${cycleId}' was not found.`);

  const [objectives, accounts] = await Promise.all([
    prisma.strategicObjective.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } }),
    prisma.account.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      select: { code: true, name: true, type: true },
    }),
  ]);

  const periods = buildFiscalYear(cycle.fiscalYear, cycle.periodType);
  const priorities = Array.isArray(cycle.guidance?.strategicPriorities)
    ? (cycle.guidance?.strategicPriorities as string[])
    : [];

  return {
    version: cycle.guidance?.version ?? 0,
    title: cycle.guidance?.title ?? `Budget guidance - FY${cycle.fiscalYear}`,
    publishedAt: cycle.guidance?.publishedAt?.toISOString() ?? null,
    cycle: {
      id: cycle.id,
      name: cycle.name,
      fiscalYear: cycle.fiscalYear,
      periodType: cycle.periodType as PeriodType,
      status: cycle.status,
      baseCurrency: cycle.baseCurrency,
      opensAt: cycle.opensAt.toISOString(),
      submissionDeadline: cycle.submissionDeadline.toISOString(),
      approvalDeadline: cycle.approvalDeadline.toISOString(),
    },
    calendar: periods.map((p) => ({
      key: p.key,
      label: p.label,
      startDate: p.startDate.toISOString(),
      endDateExclusive: p.endDateExclusive.toISOString(),
    })),
    strategicPriorities: priorities,
    objectives: objectives.map((o) => ({
      code: o.code,
      title: o.title,
      horizon: o.horizon,
      targetShare: o.targetShare?.toString() ?? null,
    })),
    assumptions: cycle.assumptions.map((a) => ({
      key: a.key,
      label: a.label,
      value: a.value.toString(),
      unit: a.unit,
      displayValue: displayAssumption(a.value.toString(), a.unit, cycle.baseCurrency),
      notes: a.notes,
    })),
    targets: cycle.targets.map((t) => ({
      businessUnitCode: t.businessUnit.code,
      businessUnitName: t.businessUnit.name,
      revenueTarget: t.revenueTarget?.toString() ?? null,
      costCeiling: t.costCeiling?.toString() ?? null,
      headcountCeiling: t.headcountCeiling,
    })),
    submissionInstructions: cycle.guidance?.submissionInstructions ?? null,
    notes: cycle.guidanceNotes,
    accounts,
  };
}

/** Render an assumption the way a reader expects: 3.5%, not 0.035. */
function displayAssumption(value: string, unit: string, currency: string): string {
  switch (unit) {
    case 'RATE':
      return formatPercent(value, { fractionDigits: 2 });
    case 'AMOUNT':
      return formatMoney(value, { currency });
    case 'COUNT':
      return toDecimal(value).toFixed(0);
    default:
      return value;
  }
}

/**
 * Render the pack as Markdown.
 *
 * Markdown rather than PDF: it is diffable, versionable, readable in a terminal,
 * and converts to PDF or Word with any standard tool. A generated PDF would look
 * more official and be far less useful.
 */
export function renderGuidancePackMarkdown(pack: GuidancePack): string {
  const { cycle } = pack;
  const date = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# ${pack.title}`);
  lines.push('');
  lines.push(
    `**Cycle:** ${cycle.name} · **Fiscal year:** FY${cycle.fiscalYear} · **Currency:** ${cycle.baseCurrency} · **Pack version:** ${pack.version}`,
  );
  if (pack.publishedAt) lines.push(`**Published:** ${date(pack.publishedAt)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 1. Key dates');
  lines.push('');
  lines.push('| Milestone | Date |');
  lines.push('| --- | --- |');
  lines.push(`| Cycle opens | ${date(cycle.opensAt)} |`);
  lines.push(`| Submissions due | **${date(cycle.submissionDeadline)}** |`);
  lines.push(`| Approvals complete | ${date(cycle.approvalDeadline)} |`);
  lines.push('');

  lines.push('## 2. Strategic priorities');
  lines.push('');
  if (pack.strategicPriorities.length === 0) {
    lines.push('_No strategic priorities have been published for this cycle._');
  } else {
    lines.push('Budget submissions are expected to demonstrably serve these priorities.');
    lines.push('');
    pack.strategicPriorities.forEach((priority, i) => lines.push(`${i + 1}. ${priority}`));
  }
  lines.push('');

  if (pack.objectives.length > 0) {
    lines.push('### Strategic objectives to align against');
    lines.push('');
    lines.push('| Code | Objective | Horizon | Target share of budget |');
    lines.push('| --- | --- | --- | --- |');
    for (const o of pack.objectives) {
      const share = o.targetShare ? formatPercent(o.targetShare, { fractionDigits: 1 }) : '—';
      lines.push(`| ${o.code} | ${o.title} | ${horizonLabel(o.horizon)} | ${share} |`);
    }
    lines.push('');
    lines.push(
      '> Every budget line must be linked to an objective and given an alignment strength. Lines left unlinked are reported to leadership as unallocated spend.',
    );
    lines.push('');
  }

  lines.push('## 3. Planning assumptions');
  lines.push('');
  if (pack.assumptions.length === 0) {
    lines.push('_No assumptions have been published. Contact Finance before submitting._');
  } else {
    lines.push(
      'These assumptions are mandatory. Submissions built on different assumptions will be returned.',
    );
    lines.push('');
    lines.push('| Assumption | Value | Notes |');
    lines.push('| --- | --- | --- |');
    for (const a of pack.assumptions) {
      lines.push(`| ${a.label} | **${a.displayValue}** | ${a.notes ?? ''} |`);
    }
  }
  lines.push('');

  lines.push('## 4. Business unit targets');
  lines.push('');
  if (pack.targets.length === 0) {
    lines.push('_No top-down targets have been set for this cycle._');
  } else {
    lines.push('| Business unit | Revenue target | Cost ceiling | Headcount ceiling |');
    lines.push('| --- | --- | --- | --- |');
    for (const t of pack.targets) {
      lines.push(
        `| ${t.businessUnitCode} — ${t.businessUnitName} | ${money(t.revenueTarget, cycle.baseCurrency)} | ${money(t.costCeiling, cycle.baseCurrency)} | ${t.headcountCeiling ?? '—'} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 5. Budget calendar');
  lines.push('');
  lines.push('Budget every line across all of the following periods:');
  lines.push('');
  lines.push('| Period | Label | Starts |');
  lines.push('| --- | --- | --- |');
  for (const period of pack.calendar) {
    lines.push(`| ${period.key} | ${period.label} | ${date(period.startDate)} |`);
  }
  lines.push('');

  lines.push('## 6. How to submit');
  lines.push('');
  lines.push(pack.submissionInstructions ?? defaultInstructions());
  lines.push('');

  lines.push('## 7. Approval route');
  lines.push('');
  lines.push(
    'Budgets move through **Draft → In review → Submitted → Approved → Locked**. Two controls apply and neither can be bypassed:',
  );
  lines.push('');
  lines.push('- **Separation of duties** — you cannot approve a budget you prepared or submitted.');
  lines.push(
    '- **Delegated authority** — approvals above your limit are routed to the next level. Budget Owner up to 250,000; Finance Manager up to 2,000,000; CFO above that.',
  );
  lines.push('');
  lines.push(
    'Every transition is written to a hash-chained audit trail and snapshots the full budget, so an approved budget can always be reproduced exactly as approved.',
  );
  lines.push('');

  if (pack.accounts.length > 0) {
    lines.push('## Appendix A — Chart of accounts');
    lines.push('');
    lines.push('| Code | Account | Type |');
    lines.push('| --- | --- | --- |');
    for (const account of pack.accounts) {
      lines.push(`| ${account.code} | ${account.name} | ${account.type} |`);
    }
    lines.push('');
  }

  if (pack.notes) {
    lines.push('## Appendix B — Additional notes');
    lines.push('');
    lines.push(pack.notes);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `_Generated from the Financial Forecasting Platform on ${new Date().toISOString().slice(0, 10)}. This pack reflects the assumptions and targets currently in force; if they change, a new version is published._`,
  );

  return lines.join('\n');
}

function money(value: string | null, currency: string): string {
  // Both bounds must be set together: Intl.NumberFormat throws when the
  // default minimum (2) exceeds an explicitly lowered maximum.
  return value === null
    ? '—'
    : formatMoney(value, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function horizonLabel(horizon: string): string {
  switch (horizon) {
    case 'H1_CORE':
      return 'H1 — Core';
    case 'H2_ADJACENT':
      return 'H2 — Adjacent';
    case 'H3_TRANSFORMATIONAL':
      return 'H3 — Transformational';
    default:
      return horizon;
  }
}

function defaultInstructions(): string {
  return [
    '1. Build your budget in the platform under **Budgets → New budget**, selecting this cycle and your business unit.',
    '2. Enter an amount for every period. Phase realistically — straight-lining a seasonal cost will be challenged at review.',
    '3. Record the **method** used for each line (incremental, zero-based, driver-based or activity-based) and a short justification. Reviewers ask where numbers came from more than any other question.',
    '4. Link each line to a strategic objective and set its alignment strength.',
    '5. Run **Forecast → Auto** against your historical actuals as a sense check on any line you have simply uplifted.',
    '6. Log material risks in the risk register and, where the exposure is significant, run a Monte Carlo simulation to size contingency.',
    '7. Submit before the deadline. Late submissions are consolidated at the top-down target rather than your bottom-up build.',
  ].join('\n');
}
