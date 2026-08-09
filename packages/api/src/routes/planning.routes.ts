/**
 * Connected planning, workforce modelling, cost behaviour and planning bias.
 *
 * These four sit together because they are the capabilities that turn a set of
 * independent numbers into a model that reasons about itself: what depends on
 * what, what drives headcount, what actually varies with volume, and whether the
 * people producing the numbers are consistently wrong in one direction.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  COST_BEHAVIOURS,
  Decimal,
  SPEND_CATEGORIES,
  type CostBehaviour,
  type SpendCategory,
} from '@ffp/shared';
import {
  analyseContribution,
  analyseCostBehaviour,
  analyseImpact,
  applyStaffingRamp,
  assessPlanningBias,
  buildWorkforceForecast,
  evaluateGraph,
  flexBudget,
  topologicalOrder,
  type BiasObservation,
  type CostLine,
  type NodeInput,
  type PlanNode,
} from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

const moneyish = z.union([z.string(), z.number()]);

const costLineSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(240),
  amount: moneyish,
  spendCategory: z.enum(SPEND_CATEGORIES).optional(),
  behaviour: z.enum(COST_BEHAVIOURS).optional(),
  variableShare: z.number().min(0).max(1).optional(),
});

const workforceSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  volumes: z.array(z.number().min(0)).min(1).max(120),
  averageHandleTimeSeconds: z.number().positive().max(86400),
  occupancy: z.number().positive().max(1),
  shrinkage: z.number().min(0).max(0.99),
  hoursPerFtePerPeriod: z.number().positive().max(1000).optional(),
  costPerFtePerPeriod: moneyish,
  costEscalationRate: z.string().optional(),
  volumeGrowthRate: z.string().optional(),
  roundToWholeFte: z.boolean().optional(),
  ramp: z
    .object({
      leadTimePeriods: z.number().int().min(0).max(24),
      rampPeriods: z.number().int().min(0).max(24),
      rampProductivity: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

/**
 * A plan-graph node as it arrives over the wire.
 *
 * The engine accepts an arbitrary compute function, which cannot cross HTTP.
 * The API therefore exposes a fixed vocabulary of operations instead of an
 * expression language: an interpreter would need its own parser, its own error
 * reporting and its own sandbox, and every one of those is a place for a
 * user-supplied string to become a security problem.
 */
const OPERATIONS = [
  'SUM',
  'PRODUCT',
  'DIFFERENCE',
  'QUOTIENT',
  /** opening + additions - (opening x churn) */
  'BALANCE_WITH_CHURN',
  /** previous + value */
  'CUMULATIVE',
] as const;

const nodeInputSchema = z.object({
  as: z.string().min(1).max(48),
  from: z.string().min(1).max(64),
  lag: z.number().int().min(0).max(60).optional(),
  initial: moneyish.optional(),
});

const planNodeSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  kind: z.enum(['INPUT', 'FORMULA', 'BALANCE']),
  unit: z.string().max(48).optional(),
  isMonetary: z.boolean().optional(),
  values: z.array(moneyish).max(120).optional(),
  inputs: z.array(nodeInputSchema).max(20).optional(),
  operation: z.enum(OPERATIONS).optional(),
});

const planGraphSchema = z.object({
  name: z.string().min(1).max(160),
  periodCount: z.number().int().min(1).max(120),
  nodes: z.array(planNodeSchema).min(1).max(200),
});

/** Turn the declared operation into the engine's compute function. */
function toPlanNode(node: z.infer<typeof planNodeSchema>): PlanNode {
  const inputs: NodeInput[] = (node.inputs ?? []).map((i) => ({
    as: i.as,
    from: i.from,
    lag: i.lag,
    initial: i.initial,
  }));

  if (node.kind === 'INPUT') {
    return {
      code: node.code,
      name: node.name,
      kind: 'INPUT',
      unit: node.unit,
      isMonetary: node.isMonetary,
      values: node.values ?? [],
    };
  }

  if (!node.operation) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Node '${node.code}' is a ${node.kind} node and must declare an operation. Supported: ${OPERATIONS.join(', ')}.`,
    );
  }

  const operation = node.operation;
  const order = inputs.map((i) => i.as);

  return {
    code: node.code,
    name: node.name,
    kind: node.kind,
    unit: node.unit,
    isMonetary: node.isMonetary,
    inputs,
    compute: (resolved, context) => {
      const at = (name: string) => resolved[name];
      const values = order.map((name) => at(name)).filter((v) => v !== undefined);
      const first = values[0];

      switch (operation) {
        case 'SUM':
          return values.reduce<Decimal>((acc, v) => acc.plus(v), new Decimal(0));
        case 'PRODUCT':
          return values.length === 0 ? new Decimal(0) : values.reduce((acc, v) => acc.times(v));
        case 'DIFFERENCE':
          if (!first) return new Decimal(0);
          return values.slice(1).reduce<Decimal>((acc, v) => acc.minus(v), first);
        case 'QUOTIENT': {
          const divisor = values[1];
          if (!first || !divisor || divisor.isZero()) {
            throw new Error('QUOTIENT needs two inputs and a non-zero divisor');
          }
          return first.dividedBy(divisor);
        }
        case 'BALANCE_WITH_CHURN': {
          const opening = at('opening');
          const adds = at('adds');
          const churn = at('churn');
          if (!opening || !adds || !churn) {
            throw new Error("BALANCE_WITH_CHURN needs inputs named 'opening', 'adds' and 'churn'");
          }
          return opening.minus(opening.times(churn)).plus(adds);
        }
        case 'CUMULATIVE': {
          const value = first;
          if (!value) throw new Error('CUMULATIVE needs one input');
          return (context.previous ?? value.times(0)).plus(value);
        }
        default: {
          const exhaustive: never = operation;
          throw new Error(`Unsupported operation ${String(exhaustive)}`);
        }
      }
    },
  };
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

export async function registerPlanningRoutes(app: FastifyInstance): Promise<void> {
  /** The vocabulary a client needs to build a plan graph. */
  app.get('/vocabulary', { onRequest: [app.authenticate] }, async () => ({
    data: {
      operations: OPERATIONS,
      spendCategories: SPEND_CATEGORIES,
      costBehaviours: COST_BEHAVIOURS,
      nodeKinds: ['INPUT', 'FORMULA', 'BALANCE'],
      note: 'Formula nodes declare an operation over named inputs. Read an earlier period with lag >= 1; only same-period references create a dependency edge, so a stock balance reading its own previous value is not a cycle.',
    },
  }));

  /** Validate a graph and return its evaluation order without computing it. */
  app.post(
    '/graph/validate',
    { onRequest: [app.requirePermission('forecast:read')] },
    async (request) => {
      const input = planGraphSchema.parse(request.body);
      const nodes = input.nodes.map(toPlanNode);
      return { data: { valid: true, evaluationOrder: topologicalOrder(nodes) } };
    },
  );

  app.post(
    '/graph/evaluate',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const input = planGraphSchema.parse(request.body);
      const result = evaluateGraph({
        name: input.name,
        periodCount: input.periodCount,
        nodes: input.nodes.map(toPlanNode),
      });
      return { data: result };
    },
  );

  /**
   * Perturb one input and report everything downstream that moves. The
   * connected-planning question - "what happens if churn runs two points
   * higher?" - answered in one call.
   */
  app.post(
    '/graph/impact',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const { graph, change } = z
        .object({
          graph: planGraphSchema,
          change: z.object({
            nodeCode: z.string().min(1),
            factor: moneyish.optional(),
            values: z.array(moneyish).max(120).optional(),
          }),
        })
        .parse(request.body);

      const result = analyseImpact(
        { name: graph.name, periodCount: graph.periodCount, nodes: graph.nodes.map(toPlanNode) },
        change,
      );

      return {
        data: {
          changedNode: result.changedNode,
          affectedNodes: result.affectedNodes,
          deltas: result.deltas,
          baseline: result.baseline.byCode,
          adjusted: result.adjusted.byCode,
        },
      };
    },
  );

  // ---- Workforce ---------------------------------------------------------

  app.post(
    '/workforce',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const input = workforceSchema.parse(request.body);
      const forecast = buildWorkforceForecast(input);

      const ramp = input.ramp
        ? applyStaffingRamp(
            forecast.periods.map((p) => Number(p.requiredFte)),
            input.ramp,
          )
        : null;

      return { data: { ...forecast, ramp } };
    },
  );

  // ---- Cost behaviour ----------------------------------------------------

  app.post(
    '/cost-behaviour',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const { lines } = z.object({ lines: z.array(costLineSchema).max(2000) }).parse(request.body);
      return { data: analyseCostBehaviour(lines as CostLine[]) };
    },
  );

  app.post(
    '/contribution',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const { revenue, lines } = z
        .object({ revenue: moneyish, lines: z.array(costLineSchema).max(2000) })
        .parse(request.body);
      return { data: analyseContribution(revenue, lines as CostLine[]) };
    },
  );

  app.post(
    '/flex-budget',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const { lines, budgetedVolume, actualVolume } = z
        .object({
          lines: z.array(costLineSchema).max(2000),
          budgetedVolume: moneyish,
          actualVolume: moneyish,
        })
        .parse(request.body);
      return { data: flexBudget(lines as CostLine[], budgetedVolume, actualVolume) };
    },
  );

  /**
   * Cost behaviour of an approved budget, using the classification recorded on
   * its lines (or inherited from the account).
   */
  app.get(
    '/budgets/:id/cost-behaviour',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const budget = await prisma.budget.findUnique({
        where: { id },
        include: {
          lines: {
            include: {
              account: {
                select: {
                  code: true,
                  name: true,
                  spendCategory: true,
                  costBehaviour: true,
                  variableShare: true,
                },
              },
            },
          },
        },
      });
      if (!budget) throw new AppError('NOT_FOUND', `Budget '${id}' was not found.`);

      const lines: CostLine[] = budget.lines.map((line) => ({
        key: line.id,
        label: line.description ?? line.account.name,
        amount: line.totalAmount.toString(),
        // Line-level classification wins; otherwise inherit the account default.
        spendCategory: (line.spendCategory ?? line.account.spendCategory ?? undefined) as
          SpendCategory | undefined,
        behaviour: (line.costBehaviour ?? line.account.costBehaviour ?? undefined) as
          CostBehaviour | undefined,
        variableShare:
          line.variableShare !== null
            ? Number(line.variableShare)
            : line.account.variableShare !== null
              ? Number(line.account.variableShare)
              : undefined,
      }));

      return { data: analyseCostBehaviour(lines) };
    },
  );

  // ---- Planning bias -----------------------------------------------------

  /**
   * Who is systematically wrong, and in which direction.
   *
   * Compares approved budget against actuals per business unit across every
   * cycle with data. One observation per unit per cycle, so a single bad month
   * cannot masquerade as a pattern.
   */
  app.get(
    '/planning-bias',
    { onRequest: [app.requirePermission('report:read')] },
    async (request) => {
      const actor = requireUser(request);
      const query = z
        .object({
          minimumObservations: z.coerce.number().int().min(1).max(20).default(3),
          materialityThreshold: z.coerce.number().min(0).max(1).default(0.05),
          groupBy: z.enum(['BUSINESS_UNIT', 'ACCOUNT']).default('BUSINESS_UNIT'),
        })
        .parse(request.query);

      const budgets = await prisma.budget.findMany({
        where: { status: { in: ['APPROVED', 'LOCKED'] } },
        include: {
          businessUnit: { select: { id: true, code: true, name: true } },
          cycle: { select: { id: true, name: true, fiscalYear: true } },
          lines: {
            include: { account: { select: { id: true, code: true, name: true, type: true } } },
          },
        },
      });

      if (budgets.length === 0) {
        return {
          data: {
            subjects: [],
            flagged: [],
            portfolioMeanPercentageError: null,
            totalCumulativeImpact: '0.0000',
            observations: [
              'No approved budgets exist yet, so there is no budget-versus-actual history to detect bias in.',
            ],
          },
        };
      }

      const actuals = await prisma.actual.groupBy({
        by: ['cycleId', 'businessUnitId', 'accountId'],
        _sum: { amount: true },
      });

      const actualByKey = new Map(
        actuals.map((a) => [
          `${a.cycleId}|${a.businessUnitId}|${a.accountId}`,
          Number(a._sum.amount ?? 0),
        ]),
      );

      const observations: BiasObservation[] = [];

      for (const budget of budgets) {
        if (query.groupBy === 'BUSINESS_UNIT') {
          // One observation per unit per cycle: sum the whole budget and the
          // matching actuals. Per-line comparison would treat reallocation
          // between lines as bias, which it is not.
          let budgetTotal = 0;
          let actualTotal = 0;
          for (const line of budget.lines) {
            if (line.account.type === 'REVENUE') continue;
            budgetTotal += Number(line.totalAmount);
            actualTotal +=
              actualByKey.get(`${budget.cycleId}|${budget.businessUnitId}|${line.accountId}`) ?? 0;
          }
          if (budgetTotal === 0) continue;
          observations.push({
            subjectId: budget.businessUnitId,
            subjectName: `${budget.businessUnit.code} - ${budget.businessUnit.name}`,
            periodLabel: budget.cycle.name,
            budget: budgetTotal.toFixed(4),
            actual: actualTotal.toFixed(4),
          });
        } else {
          for (const line of budget.lines) {
            const actual =
              actualByKey.get(`${budget.cycleId}|${budget.businessUnitId}|${line.accountId}`) ?? 0;
            if (Number(line.totalAmount) === 0) continue;
            observations.push({
              subjectId: line.accountId,
              subjectName: `${line.account.code} ${line.account.name}`,
              periodLabel: `${budget.cycle.name} / ${budget.businessUnit.code}`,
              budget: line.totalAmount.toString(),
              actual: actual.toFixed(4),
              isRevenue: line.account.type === 'REVENUE',
            });
          }
        }
      }

      const report = assessPlanningBias(observations, {
        minimumObservations: query.minimumObservations,
        materialityThreshold: query.materialityThreshold,
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'RECALCULATE',
        entityType: 'PlanningBias',
        summary: `Ran planning-bias analysis over ${observations.length} observation(s); ${report.flagged.length} subject(s) flagged`,
        changes: { groupBy: query.groupBy, observations: observations.length },
      });

      return {
        data: {
          ...report,
          meta: {
            groupBy: query.groupBy,
            observationCount: observations.length,
            budgetsAnalysed: budgets.length,
            note:
              observations.length < query.minimumObservations * 2
                ? 'There is limited budget-versus-actual history. Bias detection becomes meaningful once several cycles have closed.'
                : null,
          },
        },
      };
    },
  );
}
