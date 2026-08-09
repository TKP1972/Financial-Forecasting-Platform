/**
 * Process entry point.
 *
 * Handles graceful shutdown explicitly: an in-flight budget approval must be
 * allowed to finish its transaction rather than being cut off mid-commit.
 */
import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { configureTransports, startWorkers } from './workers.js';

async function main(): Promise<void> {
  const app = await buildApp();

  configureTransports(app);
  const workers = startWorkers(app);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown requested, draining connections');
    try {
      workers.stop();
      await app.close();
      await prisma.$disconnect();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  try {
    await prisma.$connect();
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
    app.log.info(
      { port: config.API_PORT, env: config.NODE_ENV },
      'Financial Forecasting Platform API ready',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
