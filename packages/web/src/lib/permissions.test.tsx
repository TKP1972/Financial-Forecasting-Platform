/**
 * @vitest-environment jsdom
 *
 * The hooks that decide what the UI shows.
 *
 * These are **presentation only**. The server enforces the same matrix
 * independently, and a hidden button is never the control — that is stated in
 * permissions.ts itself and is worth restating here, because a test suite that
 * treats these as security would be testing the wrong thing.
 *
 * What they *are* is the difference between a usable screen and one offering
 * actions that will be refused. The failure worth catching is a hook that
 * returns true too readily: a user shown a button they cannot use learns to
 * distrust the interface.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuthStore, type SessionPayload } from '@/store/auth';
import { useCurrentUser, useHasPermission, usePermissions } from './permissions.js';

function session(permissions: string[], overrides: Record<string, unknown> = {}): SessionPayload {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 900,
    user: {
      id: 'user-1',
      email: 'owner@ffp.local',
      firstName: 'Bem',
      lastName: 'Adeyemi',
      role: 'BUDGET_OWNER',
      businessUnitId: 'bu-1',
      approvalLimit: '250000',
      effectiveApprovalLimit: '250000',
      permissions: permissions as never,
      ...overrides,
    },
  };
}

beforeEach(() => {
  useAuthStore.getState().clear();
});

describe('useHasPermission', () => {
  it('is true for a permission the user holds', () => {
    useAuthStore.getState().setSession(session(['budget:read', 'budget:submit']));

    const { result } = renderHook(() => useHasPermission());
    expect(result.current('budget:submit')).toBe(true);
  });

  it('is false for one they do not', () => {
    // A Budget Owner can submit but not approve. Showing an approve button
    // here would offer an action the server refuses.
    useAuthStore.getState().setSession(session(['budget:read', 'budget:submit']));

    const { result } = renderHook(() => useHasPermission());
    expect(result.current('budget:approve')).toBe(false);
  });

  it('is false when nobody is signed in', () => {
    // The important default. An undefined permission list must read as "no
    // permissions", never as "unknown, so allow".
    const { result } = renderHook(() => useHasPermission());
    expect(result.current('budget:read')).toBe(false);
    expect(result.current('settings:manage')).toBe(false);
  });

  it('is false for a user with an empty permission list', () => {
    useAuthStore.getState().setSession(session([]));

    const { result } = renderHook(() => useHasPermission());
    expect(result.current('budget:read')).toBe(false);
  });

  it('matches exactly, without prefix leakage', () => {
    // 'budget:read' must not imply 'budget:readAll' or vice versa. Substring
    // matching in a permission check is a classic way to grant more than
    // intended.
    useAuthStore.getState().setSession(session(['budget:read']));

    const { result } = renderHook(() => useHasPermission());
    expect(result.current('budget:read')).toBe(true);
    expect(result.current('budget:write')).toBe(false);
    expect(result.current('budget' as never)).toBe(false);
  });
});

describe('usePermissions', () => {
  it('returns the list the session carries', () => {
    useAuthStore.getState().setSession(session(['risk:read', 'risk:write']));

    const { result } = renderHook(() => usePermissions());
    expect(result.current).toEqual(['risk:read', 'risk:write']);
  });

  it('returns an empty array rather than undefined when signed out', () => {
    // Callers map over this. Returning undefined would crash the render
    // instead of showing an empty screen.
    const { result } = renderHook(() => usePermissions());
    expect(result.current).toEqual([]);
  });
});

describe('useCurrentUser', () => {
  it('returns the signed-in user', () => {
    useAuthStore.getState().setSession(session(['budget:read']));

    const { result } = renderHook(() => useCurrentUser());
    expect(result.current?.role).toBe('BUDGET_OWNER');
    expect(result.current?.approvalLimit).toBe('250000');
  });

  it('is null when signed out', () => {
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current).toBeNull();
  });
});
