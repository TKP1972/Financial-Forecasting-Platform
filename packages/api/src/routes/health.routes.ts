/**
 * Health endpoints.
 *
 * Liveness and readiness are separate on purpose. Liveness must not touch the
 * database: if Postgres is briefly unavailable the container should keep running
 * and recover, not be killed and restarted by the orchestrator.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        checks: { database: 'ok' },
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      };
    } catch (error) {
      return reply.status(503).send({
        status: 'not-ready',
        checks: { database: 'unavailable' },
        message: error instanceof Error ? error.message : 'database unreachable',
      });
    }
  });
}
