import type { Permission } from '@ffp/shared';
import { useAuthStore } from '@/store/auth';

/**
 * The UI hides what the caller cannot do. This is presentation only - the server
 * enforces the same matrix independently, and a hidden button is never the
 * control itself.
 */
export function useHasPermission(): (permission: Permission) => boolean {
  const permissions = useAuthStore((state) => state.user?.permissions);
  return (permission: Permission) => (permissions ?? []).includes(permission);
}

export function usePermissions(): Permission[] {
  return useAuthStore((state) => state.user?.permissions) ?? [];
}

export function useCurrentUser() {
  return useAuthStore((state) => state.user);
}
