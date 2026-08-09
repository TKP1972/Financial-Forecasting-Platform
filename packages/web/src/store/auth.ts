import type { Permission, Role } from '@ffp/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  businessUnitId: string | null;
  approvalLimit: string | null;
  permissions: Permission[];
}

export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
}

interface AuthState {
  accessToken: string | null;
  /** Single-use and rotated on every refresh - always store the newest one. */
  refreshToken: string | null;
  user: SessionUser | null;
  setSession: (session: SessionPayload) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setSession: (session) =>
        set({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          user: session.user,
        }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    { name: 'ffp.auth' },
  ),
);

export const isAuthenticated = (): boolean => useAuthStore.getState().accessToken !== null;
