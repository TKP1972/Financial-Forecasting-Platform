/**
 * Pursuit pricing and cost estimating.
 *
 * Margin is gated behind its own permission: an analyst can build a cost volume
 * without being able to see the profit position on a live pursuit.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  can,
  createPursuitSchema,
  priceToWinSchema,
  pricingModelSchema,
} from '@ffp/shared';
import {
  buildPricingModel,
  expectedValue,
  runSensitivity,
  solvePriceToWin,
  type PricingModelInput,
  type PricingResult,
} from '@ffp/engine';
import { z } from 'zod';
import { registerRateCardRoutes } from './ratecards.routes.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';
import {
  approvePricingModel,
  withdrawPricingApproval,
} from '../services/pricing-approval.service.js';
import type { AuthenticatedUser } from '../services/auth.service.js';

/** Translate the wire contract into the engine's input shape. */
function toEngineInput(input: z.infer<typeof pricingModelSchema>): PricingModelInput {
  return {
    name: input.name,
    contractType: input.contractType,
    currency: input.currency ?? config.BASE_CURRENCY,
    years: input.years,
    labour: input.labour.map((line) => ({
      labourCategory: line.labourCategory,
      hoursByYear: line.hoursByYear,
      baseRate: line.baseRate,
      escalationRate: line.escalationRate,
      ...(line.ratesByYear ? { ratesByYear: line.ratesByYear } : {}),
      fte: line.fte,
      location: line.location,
    })),
    directCosts: input.directCosts.map((line) => ({
      description: line.description,
      category: line.category,
      amountByYear: line.amountByYear,
      escalationRate: line.escalationRate,
      isPassThrough: line.isPassThrough,
    })),
    burdens: input.burdens.map((burden) => ({
      pool: burden.pool,
      ratesByYear: burden.ratesByYear,
      ...(burden.appliesTo.length > 0 ? { base: burden.appliesTo } : {}),
    })),
    feeRate: input.feeRate,
    discountRate: input.discountRate,
    costOfCapital: input.costOfCapital,
    assumptions: input.assumptions,
  };
}

/**
 * Remove profitability from a result for users without `pricing:view_margin`.
 * Cost and price remain visible - what is withheld is the margin position.
 */
function redactMargin(result: PricingResult, actor: AuthenticatedUser): PricingResult {
  if (can(actor.role, 'pricing:view_margin')) return result;
  return {
    ...result,
    margin: { ...result.margin, grossProfit: '0.0000', grossMargin: null, markup: null },
    effectiveFeeRate: null,
    npv: '0.0000',
    irr: null,
    years: result.years.map((year) => ({ ...year, profit: '0.0000', fee: '0.0000' })),
    totals: { ...result.totals, profit: '0.0000', fee: '0.0000' },
  };
}

export async function registerPricingRoutes(app: FastifyInstance): Promise<void> {
  // Rate cards live under /pricing/rate-cards - they exist to feed cost volumes.
  await app.register(registerRateCardRoutes, { prefix: '/rate-cards' });

  // ---- Pursuits ----------------------------------------------------------

  app.get('/pursuits', { onRequest: [app.requirePermission('pricing:read')] }, async (request) => {
    const actor = requireUser(request);
    const query = z
      .object({ stage: z.string().optional(), businessUnitId: z.string().optional() })
      .parse(request.query);

    const pursuits = await prisma.pursuit.findMany({
      where: {
        ...(query.stage ? { stage: query.stage as never } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        businessUnit: { select: { id: true, code: true, name: true } },
        pricingModels: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            totalPrice: true,
            grossMargin: true,
            version: true,
            approvedAt: true,
          },
        },
      },
    });

    return {
      data: pursuits.map((p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
        stage: p.stage,
        contractType: p.contractType,
        probabilityOfWin: p.probabilityOfWin.toString(),
        durationMonths: p.durationMonths,
        expectedAwardDate: p.expectedAwardDate,
        businessUnit: p.businessUnit,
        latestPrice: p.pricingModels[0]?.totalPrice.toString() ?? null,
        // Gated exactly as redactMargin gates every other margin-bearing
        // response. This one read grossMargin straight out of Prisma and
        // returned it, so a Viewer or an Analyst received the profit position
        // on every pursuit while the screen rendered "Restricted" over it.
        // Price stays: the restriction is on profit, not on the ability to see
        // what a pursuit is worth.
        latestMargin: can(actor.role, 'pricing:view_margin')
          ? (p.pricingModels[0]?.grossMargin?.toString() ?? null)
          : null,
        // Not gated by view_margin: whether a committed price carries a
        // sign-off is a governance fact, and hiding it would conceal the
        // control rather than the commercial position it protects.
        latestModelId: p.pricingModels[0]?.id ?? null,
        latestApprovedAt: p.pricingModels[0]?.approvedAt ?? null,
      })),
    };
  });

  app.post(
    '/pursuits',
    { onRequest: [app.requirePermission('pricing:write')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = createPursuitSchema.parse(request.body);

      const pursuit = await prisma.pursuit.create({
        data: {
          name: input.name,
          client: input.client,
          businessUnitId: input.businessUnitId,
          stage: input.stage as never,
          contractType: input.contractType as never,
          probabilityOfWin: input.probabilityOfWin,
          expectedAwardDate: input.expectedAwardDate ? new Date(input.expectedAwardDate) : null,
          durationMonths: input.durationMonths,
          notes: input.notes ?? null,
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'Pursuit',
        entityId: pursuit.id,
        summary: `Created pursuit '${pursuit.name}' for ${pursuit.client}`,
      });

      return reply.status(201).send({ data: pursuit });
    },
  );

  // ---- Pricing models ----------------------------------------------------

  /** Price a model without saving it - the interactive path while estimating. */
  app.post(
    '/calculate',
    { onRequest: [app.requirePermission('pricing:read')] },
    async (request) => {
      const actor = requireUser(request);
      const input = pricingModelSchema.parse(request.body);
      const result = buildPricingModel(toEngineInput(input));
      return { data: redactMargin(result, actor) };
    },
  );

  /** Price and persist. Versioned per pursuit so bid iterations are traceable. */
  app.post(
    '/models',
    { onRequest: [app.requirePermission('pricing:write')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = pricingModelSchema.parse(request.body);
      const result = buildPricingModel(toEngineInput(input));

      const previous = input.pursuitId
        ? await prisma.pricingModel.findFirst({
            where: { pursuitId: input.pursuitId },
            orderBy: { version: 'desc' },
            select: { version: true },
          })
        : null;

      const model = await prisma.pricingModel.create({
        data: {
          pursuitId: input.pursuitId ?? null,
          name: input.name,
          contractType: input.contractType as never,
          currency: input.currency ?? config.BASE_CURRENCY,
          years: input.years,
          input: input as never,
          result: JSON.parse(JSON.stringify(result)) as never,
          totalPrice: result.totals.price,
          totalCost: result.totals.totalCost,
          grossMargin: result.margin.grossMargin,
          npv: result.npv,
          irr: result.irr,
          version: (previous?.version ?? 0) + 1,
          createdById: actor.id,
        },
        select: { id: true, version: true },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'PricingModel',
        entityId: model.id,
        summary: `Priced '${input.name}' v${model.version}: ${result.totals.price} ${input.currency} at ${result.margin.grossMargin === null ? 'n/a' : (result.margin.grossMargin * 100).toFixed(1)}% margin`,
        changes: {
          price: result.totals.price,
          cost: result.totals.totalCost,
          margin: result.margin.grossMargin,
        },
      });

      return reply.status(201).send({
        data: { id: model.id, version: model.version, result: redactMargin(result, actor) },
      });
    },
  );

  app.get(
    '/models/:id',
    { onRequest: [app.requirePermission('pricing:read')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const model = await prisma.pricingModel.findUnique({
        where: { id },
        include: {
          pursuit: { select: { id: true, name: true, client: true, stage: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!model) throw new AppError('NOT_FOUND', `Pricing model '${id}' was not found.`);

      return {
        data: {
          id: model.id,
          name: model.name,
          version: model.version,
          contractType: model.contractType,
          currency: model.currency,
          years: model.years,
          pursuit: model.pursuit,
          input: model.input,
          result: redactMargin(model.result as unknown as PricingResult, actor),
          createdAt: model.createdAt,
          // Approval state is not margin: who signed off a price, and whether
          // anyone has, is exactly what a Viewer needs to see. Withholding it
          // would hide the control rather than the commercial position.
          approvedAt: model.approvedAt,
          approvedBy: model.approvedBy
            ? {
                id: model.approvedBy.id,
                name: `${model.approvedBy.firstName} ${model.approvedBy.lastName}`,
              }
            : null,
          createdById: model.createdById,
        },
      };
    },
  );

  // ---- Commercial sign-off --------------------------------------------------

  /**
   * Approve a priced bid.
   *
   * Separation of duties and delegated authority live in the service, which
   * calls the same functions the budget approval calls rather than restating
   * the rules. See pricing-approval.service.ts for why authority is checked
   * against total price.
   */
  app.post(
    '/models/:id/approve',
    { onRequest: [app.requirePermission('pricing:approve')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { comment } = z
        .object({ comment: z.string().max(500).optional() })
        .parse(request.body ?? {});

      return { data: await approvePricingModel(id, actor, comment) };
    },
  );

  /** Withdraw a sign-off, so a price whose assumptions have moved stops being approved. */
  app.post(
    '/models/:id/withdraw-approval',
    { onRequest: [app.requirePermission('pricing:approve')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { reason } = z
        .object({ reason: z.string().max(500).optional() })
        .parse(request.body ?? {});

      return { data: await withdrawPricingApproval(id, actor, reason) };
    },
  );

  /** Goal-seek the fee rate that hits a target margin or a target price. */
  app.post(
    '/price-to-win',
    { onRequest: [app.requirePermission('pricing:view_margin')] },
    async (request) => {
      const input = priceToWinSchema.parse(request.body);
      const solved = solvePriceToWin(toEngineInput(input.model), {
        kind: input.target.kind,
        value: input.target.value,
      });

      return {
        data: {
          feeRate: solved.feeRate,
          converged: solved.converged,
          iterations: solved.iterations,
          residual: solved.residual,
          result: solved.achieved,
          ...(solved.converged
            ? {}
            : {
                warning:
                  'The solver could not bracket the target. The nearest achievable position is returned; the target is likely unreachable with this cost base.',
              }),
        },
      };
    },
  );

  /** What-if table for a price review. */
  app.post(
    '/sensitivity',
    { onRequest: [app.requirePermission('pricing:view_margin')] },
    async (request) => {
      const { model, cases } = z
        .object({
          model: pricingModelSchema,
          cases: z
            .array(
              z.object({
                label: z.string().min(1).max(120),
                labourRateFactor: z.number().min(0).max(5).optional(),
                hoursFactor: z.number().min(0).max(5).optional(),
                burdenRateShift: z.number().min(-1).max(1).optional(),
                feeRate: z.string().optional(),
              }),
            )
            .min(1)
            .max(20),
        })
        .parse(request.body);

      return { data: runSensitivity(toEngineInput(model), cases) };
    },
  );

  /** Bid/no-bid economics: expected profit and the break-even win probability. */
  app.post(
    '/expected-value',
    { onRequest: [app.requirePermission('pricing:view_margin')] },
    async (request) => {
      const input = z
        .object({
          price: z.string(),
          margin: z.string(),
          probabilityOfWin: z.number().min(0).max(1),
          bidCost: z.string().default('0'),
        })
        .parse(request.body);

      return {
        data: expectedValue(input.price, input.margin, input.probabilityOfWin, input.bidCost),
      };
    },
  );
}
