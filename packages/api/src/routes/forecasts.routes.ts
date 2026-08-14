/**
 * Forecasting endpoints.
 *
 * Runs are persisted with their full input, output and (for AUTO) the whole
 * backtest candidate table. A forecast that informed a budget must be
 * reproducible and defensible, not a number someone remembers generating.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  driverSchema,
  forecastRequestSchema,
  queryBoolean,
  scenarioSchema,
  toMoneyString,
} from '@ffp/shared';
import {
  autoForecast,
  buildDriverBundle,
  compareScenarios,
  forecast as runForecast,
  type HistoricalPoint,
} from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

export async function registerForecastRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Run a forecast. `method: "AUTO"` backtests every applicable method and picks
   * the winner, returning the full comparison so the choice can be challenged.
   */
  app.post('/run', { onRequest: [app.requirePermission('forecast:run')] }, async (request) => {
    const actor = requireUser(request);
    const input = forecastRequestSchema.parse(request.body);

    const history: HistoricalPoint[] = input.history.map((point) => ({
      periodKey: point.periodKey,
      value: Number(point.value),
    }));

    const options = {
      horizon: input.horizon,
      seasonLength: input.seasonLength,
      alpha: input.alpha,
      beta: input.beta,
      gamma: input.gamma,
      window: input.window,
      confidenceLevel: input.confidenceLevel,
    };

    const result =
      input.method === 'AUTO'
        ? autoForecast(history, options)
        : runForecast(history, input.method as never, options);

    const candidates = 'candidates' in result ? result.candidates : null;

    const run = await prisma.forecastRun.create({
      data: {
        name: input.name ?? `Forecast ${new Date().toISOString().slice(0, 10)}`,
        businessUnitId: input.businessUnitId ?? null,
        accountId: input.accountId ?? null,
        method: result.method as never,
        autoSelected: input.method === 'AUTO',
        horizon: input.horizon,
        seasonLength: input.seasonLength ?? null,
        confidenceLevel: input.confidenceLevel,
        history: input.history,
        result: serialisable(result),
        candidates: candidates ? serialisable(candidates) : undefined,
        parameters: result.parameters,
        mape: result.accuracy.mape,
        mase: result.accuracy.mase,
        rmse: result.accuracy.rmse,
        createdById: actor.id,
      },
      select: { id: true },
    });

    await appendAuditEntry({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'RECALCULATE',
      entityType: 'ForecastRun',
      entityId: run.id,
      summary: `Ran a ${result.method} forecast over ${input.horizon} periods (MASE ${result.accuracy.mase?.toFixed(3) ?? 'n/a'})`,
      changes: { method: result.method, autoSelected: input.method === 'AUTO' },
    });

    return {
      data: {
        id: run.id,
        method: result.method,
        parameters: result.parameters,
        periodKeys: result.periodKeys,
        // Point forecasts are money: hand them back as decimal strings so the
        // client never has to re-derive them from a float.
        point: result.point.map((v) => toMoneyString(v)),
        interval: result.interval
          ? {
              level: result.interval.level,
              lower: result.interval.lower.map((v) => toMoneyString(v)),
              upper: result.interval.upper.map((v) => toMoneyString(v)),
            }
          : null,
        fitted: result.fitted.map((v) => (v === null ? null : toMoneyString(v))),
        accuracy: result.accuracy,
        warnings: result.warnings,
        candidates,
        selectionCriterion: 'selectionCriterion' in result ? result.selectionCriterion : null,
      },
    };
  });

  app.get('/runs', { onRequest: [app.requirePermission('forecast:read')] }, async (request) => {
    const query = z
      .object({
        businessUnitId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const runs = await prisma.forecastRun.findMany({
      where: query.businessUnitId ? { businessUnitId: query.businessUnitId } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: {
        id: true,
        name: true,
        method: true,
        autoSelected: true,
        horizon: true,
        mape: true,
        mase: true,
        rmse: true,
        publishedAt: true,
        createdAt: true,
        businessUnit: { select: { id: true, code: true, name: true } },
        account: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return {
      data: runs.map((run) => ({
        ...run,
        mape: run.mape?.toString() ?? null,
        mase: run.mase?.toString() ?? null,
        rmse: run.rmse?.toString() ?? null,
      })),
    };
  });

  app.get('/runs/:id', { onRequest: [app.requirePermission('forecast:read')] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.forecastRun.findUnique({
      where: { id },
      include: { scenarios: true },
    });
    if (!run) throw new AppError('NOT_FOUND', `Forecast run '${id}' was not found.`);

    return {
      data: {
        ...run,
        confidenceLevel: run.confidenceLevel.toString(),
        mape: run.mape?.toString() ?? null,
        mase: run.mase?.toString() ?? null,
        rmse: run.rmse?.toString() ?? null,
      },
    };
  });

  app.post(
    '/runs/:id/publish',
    { onRequest: [app.requirePermission('forecast:publish')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const run = await prisma.forecastRun.update({
        where: { id },
        data: { publishedAt: new Date() },
        select: { id: true, name: true, publishedAt: true },
      });

      await appendAuditEntry({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'APPROVE',
        entityType: 'ForecastRun',
        entityId: id,
        summary: `Published forecast '${run.name}' for use in budgeting`,
      });

      return { data: run };
    },
  );

  /**
   * The stored driver definitions.
   *
   * The `drivers` table was seeded from the beginning and read by nothing: the
   * two endpoints below take drivers in the request body, so the engine could
   * build a driver forecast and compare scenarios while no user could reach
   * either. This is the missing half - it hands a client the definitions to
   * feed back in.
   *
   * The shape deliberately matches `driverSchema`, so a caller can take this
   * response, adjust it, and post it to `/drivers/build` or
   * `/scenarios/compare` without reshaping anything.
   */
  app.get('/drivers', { onRequest: [app.requirePermission('forecast:read')] }, async (request) => {
    const query = z
      .object({
        businessUnitId: z.string().optional(),
        includeInactive: queryBoolean.default(false),
      })
      .parse(request.query);

    const drivers = await prisma.driver.findMany({
      where: {
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
      },
      orderBy: { code: 'asc' },
      include: { businessUnit: { select: { id: true, code: true, name: true } } },
    });

    return {
      data: drivers.map((driver) => ({
        id: driver.id,
        code: driver.code,
        name: driver.name,
        unit: driver.unit,
        description: driver.description,
        businessUnit: driver.businessUnit,
        // Stored as JSON because a driver carries either one rate or one per
        // period. Passed through as-is so it round-trips to the build and
        // compare endpoints unchanged.
        volumes: driver.volumes,
        unitRate: driver.unitRate,
        growthRate: driver.growthRate?.toString() ?? null,
        isActive: driver.isActive,
      })),
    };
  });

  /** Driver-based build-up: volumes x rates, with growth and escalation. */
  app.post(
    '/drivers/build',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const { drivers } = z
        .object({ drivers: z.array(driverSchema).min(1).max(100) })
        .parse(request.body);

      const bundle = buildDriverBundle(
        drivers.map((driver) => ({
          code: driver.code,
          name: driver.name,
          unit: driver.unit,
          volumes: driver.volumes,
          unitRate: driver.unitRate,
          volumeGrowthRate: driver.growthRate,
        })),
      );

      return { data: bundle };
    },
  );

  /** Compare scenarios against a driver bundle, with a probability-weighted case. */
  app.post(
    '/scenarios/compare',
    { onRequest: [app.requirePermission('forecast:run')] },
    async (request) => {
      const { drivers, scenarios } = z
        .object({
          drivers: z.array(driverSchema).min(1).max(100),
          scenarios: z.array(scenarioSchema).min(1).max(20),
        })
        .parse(request.body);

      const comparison = compareScenarios(
        drivers.map((driver) => ({
          code: driver.code,
          name: driver.name,
          unit: driver.unit,
          volumes: driver.volumes,
          unitRate: driver.unitRate,
          volumeGrowthRate: driver.growthRate,
        })),
        scenarios.map((scenario) => ({
          name: scenario.name,
          type: scenario.type,
          description: scenario.description,
          probability: scenario.probability,
          adjustments: scenario.adjustments.map((a) => ({
            targetCode: a.targetCode,
            factor: a.factor,
            appliesFromPeriod: a.appliesFromPeriod,
          })),
        })),
      );

      return { data: comparison };
    },
  );

  /**
   * Build a forecastable history straight from recorded actuals, so a budget
   * owner does not have to export to a spreadsheet and paste numbers back in.
   */
  app.get('/history', { onRequest: [app.requirePermission('forecast:read')] }, async (request) => {
    const query = z
      .object({
        businessUnitId: z.string(),
        accountId: z.string(),
        cycleId: z.string().optional(),
      })
      .parse(request.query);

    const actuals = await prisma.actual.findMany({
      where: {
        businessUnitId: query.businessUnitId,
        accountId: query.accountId,
        ...(query.cycleId ? { cycleId: query.cycleId } : {}),
      },
      orderBy: [{ periodKey: 'asc' }],
      select: { periodKey: true, amount: true },
    });

    return {
      data: actuals.map((a) => ({ periodKey: a.periodKey, value: a.amount.toString() })),
      meta: { pointCount: actuals.length },
    };
  });
}

/** Strip non-JSON-safe values before persisting an engine result. */
function serialisable<T>(value: T): never {
  return JSON.parse(JSON.stringify(value)) as never;
}
