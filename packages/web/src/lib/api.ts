import type { ErrorCode } from '@ffp/shared';
import { useAuthStore, type SessionPayload } from '@/store/auth';

export const API_BASE = '/api/v1';

/**
 * Every failure the API can return, in one shape.
 * `code` is the stable machine-readable discriminator; `message` is written for
 * a human and is always safe to show.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Pull a displayable message out of anything thrown by a query or mutation. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

interface ErrorEnvelope {
  error?: { code?: ErrorCode; message?: string; details?: unknown };
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorEnvelope | null = null;
  try {
    body = (await response.json()) as ErrorEnvelope;
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? 'INTERNAL_ERROR';
  const message =
    body?.error?.message ?? `The request failed (${response.status} ${response.statusText}).`;
  return new ApiError(code, message, response.status, body?.error?.details);
}

/**
 * Refresh is single-flight: several queries hitting a stale token at once must
 * not each burn a refresh token, because they rotate and are single-use.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const { refreshToken, setSession, clear } = useAuthStore.getState();
  if (!refreshToken) {
    clear();
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      clear();
      return false;
    }
    const session = (await response.json()) as SessionPayload;
    setSession(session);
    return true;
  } catch {
    clear();
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the bearer token and the refresh dance - used by login itself. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function rawRequest(path: string, options: RequestOptions, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * One request, with a single automatic refresh-and-retry on 401.
 * If the refresh itself fails the session is cleared, which the router turns
 * into a redirect to the sign-in page.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await rawRequest(
      path,
      options,
      options.anonymous ? null : useAuthStore.getState().accessToken,
    );
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      'Could not reach the API. Check that the server is running.',
      0,
    );
  }

  if (response.status === 401 && !options.anonymous) {
    const refreshed = await refreshOnce();
    if (!refreshed) {
      throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', 401);
    }
    try {
      response = await rawRequest(path, options, useAuthStore.getState().accessToken);
    } catch {
      throw new ApiError(
        'NETWORK_ERROR',
        'Could not reach the API. Check that the server is running.',
        0,
      );
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** GET helper for endpoints that wrap their payload in `{ data }`. */
export async function getData<T>(
  path: string,
  query?: RequestOptions['query'],
  signal?: AbortSignal,
): Promise<T> {
  const body = await apiRequest<{ data: T }>(path, { query, ...(signal ? { signal } : {}) });
  return body.data;
}

/** POST helper for the same envelope. */
export async function postData<T>(path: string, body?: unknown): Promise<T> {
  const result = await apiRequest<{ data: T }>(path, { method: 'POST', body });
  return result.data;
}

/** Fetch an authenticated file and hand it to the browser as a download. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let response = await rawRequest(path, {}, useAuthStore.getState().accessToken);
  if (response.status === 401) {
    const refreshed = await refreshOnce();
    if (!refreshed) {
      throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', 401);
    }
    response = await rawRequest(path, {}, useAuthStore.getState().accessToken);
  }
  if (!response.ok) throw await toApiError(response);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function login(email: string, password: string): Promise<SessionPayload> {
  return apiRequest<SessionPayload>('/auth/login', {
    method: 'POST',
    body: { email, password },
    anonymous: true,
  });
}

export async function logout(): Promise<void> {
  const { refreshToken } = useAuthStore.getState();
  try {
    await apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } });
  } catch {
    // A failed sign-out must never trap the user in the application.
  } finally {
    useAuthStore.getState().clear();
  }
}
