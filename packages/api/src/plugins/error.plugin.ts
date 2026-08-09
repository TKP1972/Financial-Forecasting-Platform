/**
 * Uniform error handling.
 *
 * Clients receive a stable `{ error: { code, message, details? } }` envelope and
 * nothing else. Stack traces, SQL fragments and Prisma internals stay in the
 * server log: an error message is an information disclosure channel.
 */
import fp from 'fastify-plugin';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import {
  AppError,
  DelegatedAuthorityError,
  SeparationOfDutiesError,
  type ErrorCode,
} from '@ffp/shared';

interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

function body(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export const errorPlugin = fp(
  async (app) => {
    app.setNotFoundHandler((request, reply) => {
      reply
        .status(404)
        .send(body('NOT_FOUND', `No route matches ${request.method} ${request.url}.`));
    });

    app.setErrorHandler((error, request, reply) => {
      // Validation: report every failing field at once rather than one per round trip.
      if (error instanceof ZodError) {
        request.log.info({ issues: error.issues }, 'request validation failed');
        return reply.status(400).send(
          body(
            'VALIDATION_ERROR',
            'The request contains invalid or missing fields.',
            error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
              code: issue.code,
            })),
          ),
        );
      }

      if (error instanceof SeparationOfDutiesError) {
        request.log.warn({ err: error }, 'separation of duties violation');
        return reply.status(403).send(body('SEPARATION_OF_DUTIES', error.message));
      }

      if (error instanceof DelegatedAuthorityError) {
        request.log.warn({ err: error }, 'delegated authority exceeded');
        return reply.status(403).send(
          body('DELEGATED_AUTHORITY_EXCEEDED', error.message, {
            limit: error.limit,
            amount: error.amount,
          }),
        );
      }

      if (error instanceof AppError) {
        const level = error.statusCode >= 500 ? 'error' : 'info';
        request.log[level]({ err: error, code: error.code }, 'application error');
        return reply.status(error.statusCode).send(body(error.code, error.message, error.details));
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return reply.status(prismaStatus(error)).send(prismaBody(error, request.log));
      }

      if (error instanceof Prisma.PrismaClientValidationError) {
        request.log.error({ err: error }, 'prisma validation error');
        return reply
          .status(400)
          .send(body('VALIDATION_ERROR', 'The request could not be processed as submitted.'));
      }

      // Fastify's own errors (payload too large, bad JSON, rate limit).
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 429) {
        return reply
          .status(429)
          .send(body('RATE_LIMITED', 'Too many requests. Please slow down and retry shortly.'));
      }
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        request.log.info({ err: error }, 'client error');
        const message =
          error instanceof Error ? error.message : 'The request could not be processed.';
        return reply.status(statusCode).send(body('VALIDATION_ERROR', message));
      }

      request.log.error({ err: error }, 'unhandled error');
      return reply
        .status(500)
        .send(
          body('INTERNAL_ERROR', 'An unexpected error occurred. The incident has been logged.'),
        );
    });
  },
  { name: 'error-plugin' },
);

function prismaStatus(error: Prisma.PrismaClientKnownRequestError): number {
  switch (error.code) {
    case 'P2002':
      return 409;
    case 'P2003':
      return 409;
    case 'P2025':
      return 404;
    default:
      return 400;
  }
}

function prismaBody(
  error: Prisma.PrismaClientKnownRequestError,
  log: { warn: (obj: unknown, msg: string) => void },
): ErrorBody {
  log.warn({ code: error.code, meta: error.meta }, 'prisma error');

  switch (error.code) {
    case 'P2002': {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(', ') : String(target ?? 'field');
      return body('CONFLICT', `A record with this ${fields} already exists.`);
    }
    case 'P2003':
      return body(
        'CONFLICT',
        'This record is referenced by other data and cannot be changed or removed.',
      );
    case 'P2025':
      return body('NOT_FOUND', 'The requested record does not exist.');
    default:
      return body('VALIDATION_ERROR', 'The request could not be completed.');
  }
}
