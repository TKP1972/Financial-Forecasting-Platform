/**
 * Leadership reporting and exports.
 *
 * The dashboard and the leadership pack are deliberately different things: the
 * dashboard answers "where are we now?", the pack is the reviewed artefact taken
 * into a meeting, and it states its own basis and caveats.
 */
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { AppError, PERIODS_PER_YEAR, formatMoney, formatPercent, toMoneyString } from '@ffp/shared';
import {
  buildVarianceReport,
  summariseRegister,
  type RiskEntry,
  type VarianceInput,
} from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  /** Headline numbers for the landing dashboard. */
  app.get('/dashboard', { onRequest: [app.requirePermission('report:read')] }, async (request) => {
    const query = z.object({ cycleId: z.string().optional() }).parse(request.query);

    const cycle = query.cycleId
      ? await prisma.budgetCycle.findUnique({ where: { id: query.cycleId } })
      : await prisma.budgetCycle.findFirst({ orderBy: { fiscalYear: 'desc' } });

    if (!cycle) {
      return {
        data: {
          cycle: null,
          message: 'No budget cycle exists yet. Create one to begin the budgeting process.',
        },
      };
    }

    const [budgets, actualAgg, risks, statusCounts, pursuits] = await Promise.all([
      prisma.budget.findMany({
        where: { cycleId: cycle.id },
        select: { id: true, status: true, totalAmount: true, businessUnitId: true },
      }),
      prisma.actual.aggregate({
        where: { cycleId: cycle.id },
        _sum: { amount: true, commitment: true },
      }),
      prisma.risk.findMany({
        where: { status: { in: ['OPEN', 'MONITORING'] } },
        select: {
          id: true,
          title: true,
          category: true,
          probability: true,
          impact: true,
          financialImpact: true,
          response: true,
          residualProbability: true,
          residualImpact: true,
          status: true,
        },
      }),
      prisma.budget.groupBy({
        by: ['status'],
        where: { cycleId: cycle.id },
        _count: { _all: true },
      }),
      prisma.pursuit.findMany({
        where: { stage: { in: ['QUALIFIED', 'PROPOSAL', 'SUBMITTED', 'NEGOTIATION'] } },
        select: {
          id: true,
          name: true,
          stage: true,
          probabilityOfWin: true,
          pricingModels: { orderBy: { version: 'desc' }, take: 1, select: { totalPrice: true } },
        },
      }),
    ]);

    const approvedTotal = budgets
      .filter((b) => b.status === 'APPROVED' || b.status === 'LOCKED')
      .reduce((acc, b) => acc + Number(b.totalAmount), 0);
    const submittedTotal = budgets.reduce((acc, b) => acc + Number(b.totalAmount), 0);
    const actualTotal = Number(actualAgg._sum.amount ?? 0);
    const commitmentTotal = Number(actualAgg._sum.commitment ?? 0);

    const riskSummary = summariseRegister(
      risks.map((r): RiskEntry => ({
        id: r.id,
        title: r.title,
        category: r.category as never,
        probability: r.probability,
        impact: r.impact,
        financialImpact: r.financialImpact.toString(),
        response: r.response as never,
        residualProbability: r.residualProbability ?? undefined,
        residualImpact: r.residualImpact ?? undefined,
        status: r.status as never,
      })),
    );

    const weightedPipeline = pursuits.reduce(
      (acc, p) => acc + Number(p.pricingModels[0]?.totalPrice ?? 0) * Number(p.probabilityOfWin),
      0,
    );

    return {
      data: {
        cycle: {
          id: cycle.id,
          name: cycle.name,
          fiscalYear: cycle.fiscalYear,
          status: cycle.status,
          baseCurrency: cycle.baseCurrency,
          submissionDeadline: cycle.submissionDeadline,
          daysToSubmission: Math.ceil(
            (cycle.submissionDeadline.getTime() - Date.now()) / 86_400_000,
          ),
        },
        budget: {
          totalSubmitted: toMoneyString(submittedTotal),
          totalApproved: toMoneyString(approvedTotal),
          budgetCount: budgets.length,
          byStatus: statusCounts.map((s) => ({ status: s.status, count: s._count._all })),
          // Progress through the approval workflow, which is what a finance
          // manager actually wants to see mid-cycle.
          approvalProgress:
            budgets.length === 0
              ? 0
              : budgets.filter((b) => b.status === 'APPROVED' || b.status === 'LOCKED').length /
                budgets.length,
        },
        expenditure: {
          actual: toMoneyString(actualTotal),
          commitment: toMoneyString(commitmentTotal),
          consumed: toMoneyString(actualTotal + commitmentTotal),
          remaining: toMoneyString(approvedTotal - actualTotal - commitmentTotal),
          utilisation: approvedTotal === 0 ? null : (actualTotal + commitmentTotal) / approvedTotal,
        },
        risk: {
          openRisks: risks.length,
          totalExposure: riskSummary.totalInherentExposure,
          residualExposure: riskSummary.totalResidualExposure,
          escalations: riskSummary.escalations.slice(0, 5),
          severityCounts: riskSummary.severityCounts,
        },
        pipeline: {
          activePursuits: pursuits.length,
          weightedValue: toMoneyString(weightedPipeline),
        },
      },
    };
  });

  /**
   * The leadership review pack, as structured data.
   * Rendered by the UI and exported to Excel by the endpoint below.
   */
  app.get(
    '/leadership-pack',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const query = z
        .object({
          cycleId: z.string(),
          throughPeriod: z.coerce.number().int().min(1).max(12).optional(),
        })
        .parse(request.query);

      return { data: await buildLeadershipPack(query.cycleId, query.throughPeriod) };
    },
  );

  /**
   * Excel export.
   *
   * Excel rather than PDF because the first thing anyone does with a finance
   * report is re-sort it and add a column. Numbers are written as numbers with
   * proper formats, not as pre-formatted strings, so they stay usable.
   */
  app.get(
    '/leadership-pack.xlsx',
    { onRequest: [app.requirePermission('report:export')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const query = z
        .object({
          cycleId: z.string(),
          throughPeriod: z.coerce.number().int().min(1).max(12).optional(),
        })
        .parse(request.query);

      const pack = await buildLeadershipPack(query.cycleId, query.throughPeriod);
      const workbook = await buildWorkbook(pack);
      const buffer = await workbook.xlsx.writeBuffer();

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'EXPORT',
        entityType: 'BudgetCycle',
        entityId: query.cycleId,
        summary: `Exported the leadership pack for '${pack.cycle.name}' to Excel`,
      });

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header(
          'Content-Disposition',
          `attachment; filename="leadership-pack-FY${pack.cycle.fiscalYear}.xlsx"`,
        )
        .send(Buffer.from(buffer));
    },
  );
}

interface LeadershipPack {
  generatedAt: string;
  cycle: { id: string; name: string; fiscalYear: number; baseCurrency: string; status: string };
  throughPeriod: number;
  periodsInYear: number;
  summary: {
    approvedBudget: string;
    actual: string;
    commitment: string;
    variance: string;
    variancePercent: number | null;
  };
  byBusinessUnit: Array<{
    code: string;
    name: string;
    budget: string;
    actual: string;
    variance: string;
    variancePercent: number | null;
    rag: string;
  }>;
  exceptions: Array<{
    label: string;
    budget: string;
    actual: string;
    variance: string;
    rag: string;
  }>;
  risks: Array<{ title: string; category: string; severity: string; exposure: string }>;
  commentary: string[];
}

async function buildLeadershipPack(
  cycleId: string,
  throughPeriod?: number,
): Promise<LeadershipPack> {
  const cycle = await prisma.budgetCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AppError('NOT_FOUND', `Budget cycle '${cycleId}' was not found.`);

  const periodsInYear = PERIODS_PER_YEAR[cycle.periodType];
  const through = throughPeriod ?? periodsInYear;

  const [budgets, actuals, risks] = await Promise.all([
    prisma.budget.findMany({
      where: { cycleId, status: { in: ['APPROVED', 'LOCKED'] } },
      include: {
        businessUnit: { select: { id: true, code: true, name: true } },
        lines: {
          include: {
            account: { select: { id: true, code: true, name: true, type: true } },
            periods: { orderBy: { periodIndex: 'asc' } },
          },
        },
      },
    }),
    prisma.actual.findMany({ where: { cycleId, periodIndex: { lte: through } } }),
    prisma.risk.findMany({
      where: { status: { in: ['OPEN', 'MONITORING'] } },
      select: {
        id: true,
        title: true,
        category: true,
        probability: true,
        impact: true,
        financialImpact: true,
        response: true,
        residualProbability: true,
        residualImpact: true,
        status: true,
      },
    }),
  ]);

  const actualByKey = new Map<string, { amount: number; commitment: number }>();
  for (const actual of actuals) {
    const key = `${actual.businessUnitId}|${actual.accountId}`;
    const existing = actualByKey.get(key) ?? { amount: 0, commitment: 0 };
    actualByKey.set(key, {
      amount: existing.amount + Number(actual.amount),
      commitment: existing.commitment + Number(actual.commitment),
    });
  }

  const inputs: VarianceInput[] = budgets.flatMap((budget) =>
    budget.lines.map((line) => {
      const budgetToDate = line.periods
        .filter((p) => p.periodIndex <= through)
        .reduce((acc, p) => acc + Number(p.amount), 0);
      const actual = actualByKey.get(`${budget.businessUnitId}|${line.accountId}`) ?? {
        amount: 0,
        commitment: 0,
      };
      return {
        key: `${budget.businessUnitId}:${line.accountId}`,
        label: `${line.account.code} ${line.account.name}`,
        accountType: line.account.type as never,
        businessUnitId: budget.businessUnitId,
        accountId: line.accountId,
        budget: budgetToDate.toFixed(4),
        actual: actual.amount.toFixed(4),
        commitment: actual.commitment.toFixed(4),
      };
    }),
  );

  const report = buildVarianceReport(inputs, { groupBy: 'BUSINESS_UNIT' });
  const unitById = new Map(budgets.map((b) => [b.businessUnitId, b.businessUnit]));
  const riskSummary = summariseRegister(
    risks.map((r): RiskEntry => ({
      id: r.id,
      title: r.title,
      category: r.category as never,
      probability: r.probability,
      impact: r.impact,
      financialImpact: r.financialImpact.toString(),
      response: r.response as never,
      residualProbability: r.residualProbability ?? undefined,
      residualImpact: r.residualImpact ?? undefined,
      status: r.status as never,
    })),
  );

  const commentary: string[] = [];
  if (budgets.length === 0) {
    commentary.push(
      'No approved budgets exist for this cycle, so there is no baseline to report against.',
    );
  } else {
    commentary.push(
      `Reporting on ${budgets.length} approved budget(s) through period ${through} of ${periodsInYear}.`,
    );
    if (report.exceptions.length > 0) {
      commentary.push(
        `${report.exceptions.length} line(s) are outside tolerance and are listed in the exceptions section.`,
      );
    } else {
      commentary.push('No lines are outside the amber tolerance this period.');
    }
    if (riskSummary.escalations.length > 0) {
      commentary.push(
        `${riskSummary.escalations.length} risk(s) are at severe or critical severity and require a decision.`,
      );
    }
  }
  if (actuals.length === 0) {
    commentary.push(
      'No actuals have been imported for this cycle; variance is reported against zero spend.',
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    cycle: {
      id: cycle.id,
      name: cycle.name,
      fiscalYear: cycle.fiscalYear,
      baseCurrency: cycle.baseCurrency,
      status: cycle.status,
    },
    throughPeriod: through,
    periodsInYear,
    summary: {
      approvedBudget: report.totals.budget,
      actual: report.totals.actual,
      commitment: report.totals.commitment,
      variance: report.totals.variance,
      variancePercent: report.totals.variancePercent,
    },
    byBusinessUnit: report.groups.map((group) => {
      const unit = unitById.get(group.key);
      return {
        code: unit?.code ?? group.key,
        name: unit?.name ?? group.label,
        budget: group.budget,
        actual: group.actual,
        variance: group.variance,
        variancePercent: group.variancePercent,
        rag: group.rag,
      };
    }),
    exceptions: report.exceptions.slice(0, 25).map((line) => ({
      label: line.label,
      budget: line.budget,
      actual: line.actual,
      variance: line.variance,
      rag: line.rag,
    })),
    risks: riskSummary.escalations.slice(0, 15).map((risk) => ({
      title: risk.title,
      category: risk.category,
      severity: risk.inherentSeverity,
      exposure: risk.expectedValue,
    })),
    commentary,
  };
}

async function buildWorkbook(pack: LeadershipPack): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Financial Forecasting Platform';
  workbook.created = new Date();

  const currencyFormat = `#,##0.00;[Red](#,##0.00)`;
  const percentFormat = '0.0%';

  const header = (sheet: ExcelJS.Worksheet, row: number) => {
    const r = sheet.getRow(row);
    r.font = { bold: true };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    r.commit();
  };

  // --- Summary ---
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 34 }, { width: 22 }];
  summary.addRow([`Leadership pack — ${pack.cycle.name}`]);
  summary.getRow(1).font = { bold: true, size: 14 };
  summary.addRow([]);
  summary.addRow(['Fiscal year', `FY${pack.cycle.fiscalYear}`]);
  summary.addRow(['Cycle status', pack.cycle.status]);
  summary.addRow(['Reporting through period', `${pack.throughPeriod} of ${pack.periodsInYear}`]);
  summary.addRow(['Currency', pack.cycle.baseCurrency]);
  summary.addRow(['Generated', pack.generatedAt.slice(0, 19).replace('T', ' ')]);
  summary.addRow([]);
  summary.addRow(['Approved budget (to date)', Number(pack.summary.approvedBudget)]);
  summary.addRow(['Actual', Number(pack.summary.actual)]);
  summary.addRow(['Commitment', Number(pack.summary.commitment)]);
  summary.addRow(['Variance (positive = under)', Number(pack.summary.variance)]);
  summary.addRow(['Variance %', pack.summary.variancePercent ?? 0]);
  for (let r = 9; r <= 12; r += 1) summary.getCell(`B${r}`).numFmt = currencyFormat;
  summary.getCell('B13').numFmt = percentFormat;

  summary.addRow([]);
  summary.addRow(['Commentary']);
  summary.getRow(summary.rowCount).font = { bold: true };
  for (const line of pack.commentary) summary.addRow([line]);

  // --- By business unit ---
  const units = workbook.addWorksheet('By business unit');
  units.columns = [
    { header: 'Code', key: 'code', width: 14 },
    { header: 'Business unit', key: 'name', width: 34 },
    { header: 'Budget', key: 'budget', width: 18 },
    { header: 'Actual', key: 'actual', width: 18 },
    { header: 'Variance', key: 'variance', width: 18 },
    { header: 'Variance %', key: 'variancePercent', width: 14 },
    { header: 'RAG', key: 'rag', width: 10 },
  ];
  header(units, 1);
  for (const row of pack.byBusinessUnit) {
    units.addRow({
      code: row.code,
      name: row.name,
      budget: Number(row.budget),
      actual: Number(row.actual),
      variance: Number(row.variance),
      variancePercent: row.variancePercent ?? 0,
      rag: row.rag,
    });
  }
  units.getColumn('budget').numFmt = currencyFormat;
  units.getColumn('actual').numFmt = currencyFormat;
  units.getColumn('variance').numFmt = currencyFormat;
  units.getColumn('variancePercent').numFmt = percentFormat;
  applyRagColours(units, 7);
  units.views = [{ state: 'frozen', ySplit: 1 }];

  // --- Exceptions ---
  const exceptions = workbook.addWorksheet('Exceptions');
  exceptions.columns = [
    { header: 'Line', key: 'label', width: 48 },
    { header: 'Budget', key: 'budget', width: 18 },
    { header: 'Actual', key: 'actual', width: 18 },
    { header: 'Variance', key: 'variance', width: 18 },
    { header: 'RAG', key: 'rag', width: 10 },
  ];
  header(exceptions, 1);
  if (pack.exceptions.length === 0) {
    exceptions.addRow({ label: 'No lines outside tolerance this period.' });
  } else {
    for (const row of pack.exceptions) {
      exceptions.addRow({
        label: row.label,
        budget: Number(row.budget),
        actual: Number(row.actual),
        variance: Number(row.variance),
        rag: row.rag,
      });
    }
    exceptions.getColumn('budget').numFmt = currencyFormat;
    exceptions.getColumn('actual').numFmt = currencyFormat;
    exceptions.getColumn('variance').numFmt = currencyFormat;
    applyRagColours(exceptions, 5);
  }
  exceptions.views = [{ state: 'frozen', ySplit: 1 }];

  // --- Risk ---
  const riskSheet = workbook.addWorksheet('Risk escalations');
  riskSheet.columns = [
    { header: 'Risk', key: 'title', width: 48 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Severity', key: 'severity', width: 14 },
    { header: 'Expected exposure', key: 'exposure', width: 20 },
  ];
  header(riskSheet, 1);
  if (pack.risks.length === 0) {
    riskSheet.addRow({ title: 'No risks at severe or critical severity.' });
  } else {
    for (const risk of pack.risks) {
      riskSheet.addRow({ ...risk, exposure: Number(risk.exposure) });
    }
    riskSheet.getColumn('exposure').numFmt = currencyFormat;
  }
  riskSheet.views = [{ state: 'frozen', ySplit: 1 }];

  return workbook;
}

/** Shade the RAG column so the exception list reads at a glance. */
function applyRagColours(sheet: ExcelJS.Worksheet, column: number): void {
  const colours: Record<string, string> = {
    RED: 'FFF8D7DA',
    AMBER: 'FFFFF3CD',
    GREEN: 'FFD4EDDA',
  };
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const cell = row.getCell(column);
    const argb = colours[String(cell.value)];
    if (argb) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });
}

/** Re-exported for tests and any future text renderer. */
export { formatMoney, formatPercent };
