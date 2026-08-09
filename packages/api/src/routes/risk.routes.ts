/**
 * Risk register and Monte Carlo simulation.
 */
import type { FastifyInstance } from 'fastify';
import { AppError, can, createRiskSchema, monteCarloSchema } from '@ffp/shared';
import { runMonteCarlo, summariseRegister, type RiskEntry } from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

export async function registerRiskRoutes(app: FastifyInstance): Promise<void> {
  /** The register, scored: expected values, heat map and the escalation list. */
  app.get('/register', { onRequest: [app.requirePermission('risk:read')] }, async (request) => {
    const query = z
      .object({
        businessUnitId: z.string().optional(),
        budgetId: z.string().optional(),
        pursuitId: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);

    const risks = await prisma.risk.findMany({
      where: {
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.budgetId ? { budgetId: query.budgetId } : {}),
        ...(query.pursuitId ? { pursuitId: query.pursuitId } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { id: true, firstName: true, lastName: true } } },
    });

    const entries: RiskEntry[] = risks.map((risk) => ({
      id: risk.id,
      title: risk.title,
      category: risk.category as never,
      probability: risk.probability,
      impact: risk.impact,
      financialImpact: risk.financialImpact.toString(),
      response: risk.response as never,
      residualProbability: risk.residualProbability ?? undefined,
      residualImpact: risk.residualImpact ?? undefined,
      status: risk.status as never,
      ownerId: risk.ownerId ?? undefined,
    }));

    const summary = summariseRegister(entries);
    const ownerById = new Map(risks.map((r) => [r.id, r.owner]));

    return {
      data: {
        ...summary,
        risks: summary.risks.map((risk) => ({ ...risk, owner: ownerById.get(risk.id) ?? null })),
      },
    };
  });

  app.post(
    '/risks',
    { onRequest: [app.requirePermission('risk:write')] },
    async (request, reply) => {
      const actor = requireUser(request);
      const input = createRiskSchema.parse(request.body);

      // Residual scores must not exceed inherent ones: mitigation reduces exposure,
      // it does not increase it. Catching this here keeps the register credible.
      if (
        input.residualProbability !== undefined &&
        input.residualProbability > input.probability
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Residual probability cannot exceed inherent probability. If the risk has worsened, raise the inherent score instead.',
        );
      }
      if (input.residualImpact !== undefined && input.residualImpact > input.impact) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Residual impact cannot exceed inherent impact. If the risk has worsened, raise the inherent score instead.',
        );
      }

      const risk = await prisma.risk.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          category: input.category as never,
          businessUnitId: input.businessUnitId ?? null,
          budgetId: input.budgetId ?? null,
          pursuitId: input.pursuitId ?? null,
          probability: input.probability,
          impact: input.impact,
          financialImpact: input.financialImpact,
          response: input.response as never,
          mitigationPlan: input.mitigationPlan ?? null,
          residualProbability: input.residualProbability ?? null,
          residualImpact: input.residualImpact ?? null,
          ownerId: input.ownerId ?? null,
          status: input.status as never,
          reviewDate: input.reviewDate ? new Date(input.reviewDate) : null,
        },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'CREATE',
        entityType: 'Risk',
        entityId: risk.id,
        summary: `Logged risk '${risk.title}' (P${risk.probability} x I${risk.impact}, exposure ${risk.financialImpact.toString()})`,
      });

      return reply.status(201).send({ data: risk });
    },
  );

  app.patch('/risks/:id', { onRequest: [app.requirePermission('risk:write')] }, async (request) => {
    const actor = requireUser(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = createRiskSchema.partial().parse(request.body);

    const existing = await prisma.risk.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', `Risk '${id}' was not found.`);

    // Accepting a risk is a decision with financial consequences, so it needs
    // the explicit permission rather than ordinary edit rights.
    if (
      input.response === 'ACCEPT' &&
      existing.response !== 'ACCEPT' &&
      !can(actor.role, 'risk:accept')
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Formally accepting a risk requires the Finance Manager role or higher.',
      );
    }

    const updated = await prisma.risk.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.probability !== undefined ? { probability: input.probability } : {}),
        ...(input.impact !== undefined ? { impact: input.impact } : {}),
        ...(input.financialImpact !== undefined ? { financialImpact: input.financialImpact } : {}),
        ...(input.response !== undefined ? { response: input.response as never } : {}),
        ...(input.mitigationPlan !== undefined ? { mitigationPlan: input.mitigationPlan } : {}),
        ...(input.residualProbability !== undefined
          ? { residualProbability: input.residualProbability }
          : {}),
        ...(input.residualImpact !== undefined ? { residualImpact: input.residualImpact } : {}),
        ...(input.status !== undefined ? { status: input.status as never } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });

    await appendAuditEntry({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'UPDATE',
      entityType: 'Risk',
      entityId: id,
      summary: `Updated risk '${updated.title}'`,
      changes: { status: { from: existing.status, to: updated.status } },
    });

    return { data: updated };
  });

  /**
   * Run a Monte Carlo simulation and store it with its seed.
   *
   * The seed is the point: a contingency figure quoted to a board has to be
   * reproducible on demand, months later, by anyone who asks.
   */
  app.post(
    '/simulate',
    { onRequest: [app.requirePermission('risk:simulate')] },
    async (request) => {
      const actor = requireUser(request);
      const input = monteCarloSchema.parse(request.body);
      const body = z
        .object({ budgetId: z.string().optional(), pursuitId: z.string().optional() })
        .parse(request.body);

      const result = runMonteCarlo({
        name: input.name,
        iterations: input.iterations,
        seed: input.seed,
        baseValue: input.baseValue,
        inputs: input.inputs.map((spec) => ({
          code: spec.code,
          label: spec.label,
          distribution: spec.distribution,
          min: spec.min,
          mode: spec.mode,
          max: spec.max,
          mean: spec.mean,
          stdDev: spec.stdDev,
          outcomes: spec.outcomes,
        })),
        riskEvents: input.riskEvents,
        confidenceLevels: input.confidenceLevels,
      });

      const percentile = (level: number) =>
        result.percentiles.find((p) => Math.abs(p.level - level) < 1e-9)?.value ?? result.median;

      const simulation = await prisma.simulation.create({
        data: {
          name: result.name,
          budgetId: body.budgetId ?? null,
          pursuitId: body.pursuitId ?? null,
          iterations: result.iterations,
          seed: result.seed,
          baseValue: result.baseValue,
          input: JSON.parse(JSON.stringify(input)) as never,
          result: JSON.parse(JSON.stringify(result)) as never,
          p50: percentile(0.5),
          p80: percentile(0.8),
          p90: percentile(0.9),
          contingency: result.contingency,
          createdById: actor.id,
        },
        select: { id: true },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'SIMULATE',
        entityType: 'Simulation',
        entityId: simulation.id,
        summary: `Ran ${result.iterations} iterations (seed ${result.seed}); P80 ${percentile(0.8)}, contingency ${result.contingency}`,
        changes: { seed: result.seed, iterations: result.iterations, p80: percentile(0.8) },
      });

      return { data: { id: simulation.id, ...result } };
    },
  );

  app.get(
    '/simulations/:id',
    { onRequest: [app.requirePermission('risk:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const simulation = await prisma.simulation.findUnique({ where: { id } });
      if (!simulation) throw new AppError('NOT_FOUND', `Simulation '${id}' was not found.`);

      return {
        data: {
          ...simulation,
          baseValue: simulation.baseValue.toString(),
          p50: simulation.p50.toString(),
          p80: simulation.p80.toString(),
          p90: simulation.p90.toString(),
          contingency: simulation.contingency.toString(),
        },
      };
    },
  );

  app.get('/simulations', { onRequest: [app.requirePermission('risk:read')] }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
      .parse(request.query);

    const simulations = await prisma.simulation.findMany({
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: {
        id: true,
        name: true,
        iterations: true,
        seed: true,
        p50: true,
        p80: true,
        contingency: true,
        createdAt: true,
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return {
      data: simulations.map((s) => ({
        ...s,
        p50: s.p50.toString(),
        p80: s.p80.toString(),
        contingency: s.contingency.toString(),
      })),
    };
  });
}
