/**
 * @vitest-environment jsdom
 *
 * The session store.
 *
 * Needs a DOM despite testing no components: zustand's `persist` middleware
 * reaches for localStorage when the module loads, so the store is not pure.
 * That is worth knowing rather than working around — it means the store cannot
 * be imported in a plain Node context either.
 *
 * Small, and load-bearing: it holds the tokens every request carries and the
 * permission list every screen reads. The behaviours worth pinning are the ones
 * that would be silently wrong rather than obviously broken — a `clear()` that
 * leaves a token behind logs nobody out, and a refresh that keeps the old token
 * breaks the next refresh rather than this one.
 *
 * Tested through the store's own API rather than through React. The hooks that
 * read it are covered in permissions.test.tsx.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore, isAuthenticated, type SessionPayload } from './auth.js';

const SESSION: SessionPayload = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 900,
  user: {
    id: 'user-1',
    email: 'analyst@ffp.local',
    firstName: 'Ada',
    lastName: 'Nwosu',
    role: 'ANALYST',
    businessUnitId: 'bu-1',
    // No override; an analyst's default is '0'. The pair is deliberately
    // unequal here - null stored, '0' applied - because that is the shape the
    // two fields exist to keep distinguishable.
    approvalLimit: null,
    effectiveApprovalLimit: '0',
    permissions: ['budget:read', 'budget:write'],
  },
};

beforeEach(() => {
  useAuthStore.getState().clear();
  localStorage.clear();
});

describe('setSession', () => {
  it('stores both tokens and the user', () => {
    useAuthStore.getState().setSession(SESSION);

    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('access-1');
    expect(state.refreshToken).toBe('refresh-1');
    expect(state.user?.email).toBe('analyst@ffp.local');
  });

  it('replaces the refresh token rather than keeping the old one', () => {
    // Refresh tokens are single-use and rotate on every refresh. Keeping a
    // stale one would fail the *next* refresh, which is a confusing place for
    // the failure to appear.
    useAuthStore.getState().setSession(SESSION);
    useAuthStore.getState().setSession({
      ...SESSION,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });

    expect(useAuthStore.getState().refreshToken).toBe('refresh-2');
    expect(useAuthStore.getState().accessToken).toBe('access-2');
  });

  it('carries the permission list the UI gates on', () => {
    useAuthStore.getState().setSession(SESSION);
    expect(useAuthStore.getState().user?.permissions).toEqual(['budget:read', 'budget:write']);
  });
});

describe('clear', () => {
  it('leaves nothing behind', () => {
    useAuthStore.getState().setSession(SESSION);
    useAuthStore.getState().clear();

    const state = useAuthStore.getState();
    // Asserted field by field rather than as a whole object: a clear() that
    // forgot one field would still log the user out visually while leaving a
    // usable token in storage.
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.user).toBeNull();
  });
});

describe('isAuthenticated', () => {
  it('is false with no session', () => {
    expect(isAuthenticated()).toBe(false);
  });

  it('is true once a session is set, and false again after clearing', () => {
    useAuthStore.getState().setSession(SESSION);
    expect(isAuthenticated()).toBe(true);

    useAuthStore.getState().clear();
    expect(isAuthenticated()).toBe(false);
  });

  it('keys on the access token, not on the user', () => {
    // The guard that decides whether to show the app at all. If it keyed on
    // `user` it would admit a session whose token had been cleared.
    useAuthStore.getState().setSession(SESSION);
    useAuthStore.setState({ accessToken: null });

    expect(useAuthStore.getState().user).not.toBeNull();
    expect(isAuthenticated()).toBe(false);
  });
});
