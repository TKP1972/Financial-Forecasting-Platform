/**
 * Application error taxonomy.
 *
 * Every error carries a stable machine-readable `code` and an HTTP status, so the
 * API can serialise consistently and the front end can branch on `code` rather
 * than string-matching messages.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE_TRANSITION',
  'SEPARATION_OF_DUTIES',
  'DELEGATED_AUTHORITY_EXCEEDED',
  'PERIOD_LOCKED',
  'CALCULATION_ERROR',
  'INSUFFICIENT_DATA',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  SEPARATION_OF_DUTIES: 403,
  DELEGATED_AUTHORITY_EXCEEDED: 403,
  PERIOD_LOCKED: 423,
  CALCULATION_ERROR: 422,
  INSUFFICIENT_DATA: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const ValidationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, { details });

export const NotFoundError = (resource: string, id?: string) =>
  new AppError(
    'NOT_FOUND',
    id ? `${resource} '${id}' was not found.` : `${resource} was not found.`,
  );

export const ForbiddenError = (message = 'You do not have permission to perform this action.') =>
  new AppError('FORBIDDEN', message);

export const UnauthenticatedError = (message = 'Authentication is required.') =>
  new AppError('UNAUTHENTICATED', message);

export const ConflictError = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, { details });

export const InvalidTransitionError = (from: string, to: string, allowed: readonly string[]) =>
  new AppError('INVALID_STATE_TRANSITION', `Cannot move from ${from} to ${to}.`, {
    details: { from, to, allowed },
  });

export const PeriodLockedError = (period: string) =>
  new AppError(
    'PERIOD_LOCKED',
    `Period ${period} is locked and can no longer be edited. Raise a reforecast instead.`,
  );

export const CalculationError = (message: string, details?: unknown) =>
  new AppError('CALCULATION_ERROR', message, { details });

export const InsufficientDataError = (message: string, details?: unknown) =>
  new AppError('INSUFFICIENT_DATA', message, { details });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalise anything thrown into an AppError, without leaking internals. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return new AppError(code as ErrorCode, value.message, { cause: value });
    }
    return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: value });
  }
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
}
