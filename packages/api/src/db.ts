/**
 * Prisma client singleton.
 *
 * Hot reload in development would otherwise open a new connection pool on every
 * file change and exhaust Postgres' connection limit within a few minutes.
 */
import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!config.isProduction) globalForPrisma.prisma = prisma;

export type Db = typeof prisma;

/** Prisma transaction client - the subset available inside `$transaction`. */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
