/**
 * Fastify application assembly.
 *
 * Order matters: security headers and rate limiting are registered before any
 * route, error handling before the routes that raise errors, and every domain
 * route module is namespaced under /api/v1 so the surface can version cleanly.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { AppError } from '@ffp/shared';
import { config } from './config.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { errorPlugin } from './plugins/error.plugin.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerBudgetRoutes } from './routes/budgets.routes.js';
import { registerCycleRoutes } from './routes/cycles.routes.js';
import { registerForecastRoutes } from './routes/forecasts.routes.js';
import { registerGovernanceRoutes } from './routes/governance.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerImportRoutes } from './routes/import.routes.js';
import { registerNotificationRoutes } from './routes/notifications.routes.js';
import { registerOrgRoutes } from './routes/org.routes.js';
import { registerPlanningRoutes } from './routes/planning.routes.js';
import { registerPricingRoutes } from './routes/pricing.routes.js';
import { registerReportRoutes } from './routes/reports.routes.js';
import { registerRiskRoutes } from './routes/risk.routes.js';
import { registerRollingRoutes } from './routes/rolling.routes.js';
import { registerVarianceRoutes } from './routes/variance.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let a password or token reach the log, even at trace level.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.refreshToken',
        ],
        censor: '[redacted]',
      },
      // Driven by LOG_PRETTY, not NODE_ENV: pino-pretty is a devDependency and
      // is absent from the production image, so a container running with
      // NODE_ENV=development would otherwise fail to boot on a missing module.
      transport: config.LOG_PRETTY
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
    },
    // Reject oversized payloads before they are parsed. Bulk actuals imports are
    // the largest legitimate body, and 8 MB covers a very large one.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
    // disableRequestLogging is not set: false is already the default, and
    // passing it explicitly triggered FSTDEP023 on every boot. The replacement
    // (the logController option) would only be needed to change the behaviour,
    // which we do not - request logging stays on.
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API only; the web app sets its own policy.
  });

  await app.register(cors, {
    origin: config.corsOrigins.length === 1 ? config.corsOrigins[0] : [...config.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Health checks are polled by the container runtime; do not rate-limit them.
    allowList: (request) => request.url.startsWith('/health'),
  });

  /**
   * Several endpoints are pure actions that take no body at all
   * (POST /governance/audit/verify, POST /budgets/:id/... with no comment).
   * Fastify rejects those with "Unsupported Media Type" whenever the client
   * sends any content type other than JSON - which many HTTP clients do by
   * default on a bodyless POST. Accept an empty body regardless of the header,
   * and reject only a genuinely unparseable one.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch {
      done(
        new AppError(
          'VALIDATION_ERROR',
          'Request body could not be parsed. Send JSON with Content-Type: application/json.',
        ),
        undefined,
      );
    }
  });

  await app.register(sensible);
  await app.register(errorPlugin);
  await app.register(authPlugin);

  await app.register(registerHealthRoutes);

  await app.register(
    async (api) => {
      api.get('/', async () => ({
        name: 'Financial Forecasting Platform API',
        version: 'v1',
        modules: [
          { path: '/api/v1/auth', description: 'Authentication and session management' },
          {
            path: '/api/v1/org',
            description: 'Business units, chart of accounts, strategic objectives',
          },
          {
            path: '/api/v1/cycles',
            description: 'Budget cycles, assumptions and the guideline pack',
          },
          { path: '/api/v1/budgets', description: 'Budget preparation, workflow and approval' },
          { path: '/api/v1/forecasts', description: 'Time-series and driver-based forecasting' },
          {
            path: '/api/v1/planning',
            description:
              'Connected planning graph, workforce modelling, cost behaviour and planning-bias detection',
          },
          { path: '/api/v1/pricing', description: 'Pursuits, cost build-up and price-to-win' },
          { path: '/api/v1/risk', description: 'Risk register and Monte Carlo simulation' },
          {
            path: '/api/v1/variance',
            description: 'Actuals, variance analysis and outturn projection',
          },
          { path: '/api/v1/reports', description: 'Leadership packs and exports' },
          { path: '/api/v1/governance', description: 'Audit trail, chain verification and users' },
          {
            path: '/api/v1/notifications',
            description: 'Notification inbox, preferences and deadline reminders',
          },
          {
            path: '/api/v1/import',
            description: 'Reference-data import for business units and the chart of accounts',
          },
        ],
      }));

      await api.register(registerAuthRoutes, { prefix: '/auth' });
      await api.register(registerOrgRoutes, { prefix: '/org' });
      await api.register(registerCycleRoutes, { prefix: '/cycles' });
      await api.register(registerBudgetRoutes, { prefix: '/budgets' });
      await api.register(registerForecastRoutes, { prefix: '/forecasts' });
      await api.register(registerPlanningRoutes, { prefix: '/planning' });
      // Rolling-forecast and MTP routes are namespaced under their own resources.
      await api.register(registerRollingRoutes);
      await api.register(registerPricingRoutes, { prefix: '/pricing' });
      await api.register(registerRiskRoutes, { prefix: '/risk' });
      await api.register(registerVarianceRoutes, { prefix: '/variance' });
      await api.register(registerReportRoutes, { prefix: '/reports' });
      await api.register(registerGovernanceRoutes, { prefix: '/governance' });
      await api.register(registerNotificationRoutes, { prefix: '/notifications' });
      await api.register(registerImportRoutes, { prefix: '/import' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
