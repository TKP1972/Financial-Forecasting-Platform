import { ROLE_LABELS } from '@ffp/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { apiRequest, logout } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useThemeStore } from '@/store/theme';

const NAV = [
  { to: '/', label: 'Dashboard', end: true, icon: '▤' },
  { to: '/cycles', label: 'Budget cycles', icon: '◷' },
  { to: '/budgets', label: 'Budgets', icon: '▦' },
  { to: '/forecasting', label: 'Forecasting', icon: '◠' },
  { to: '/pricing', label: 'Pricing', icon: '⌗' },
  { to: '/risk', label: 'Risk', icon: '◆' },
  { to: '/variance', label: 'Variance', icon: '⇅' },
  { to: '/reports', label: 'Reports', icon: '▤' },
  { to: '/governance', label: 'Governance', icon: '⛨' },
  { to: '/reference-data', label: 'Reference data', icon: '⌸' },
  // Last, and reachable by every role including a Viewer: it is the screen that
  // explains the other ten, and the one a person opening this for the first
  // time needs before any of them make sense.
  { to: '/about', label: 'About', icon: '◎' },
] as const;

/**
 * Unread count in the header.
 *
 * Polled rather than pushed: a WebSocket for a number that changes a few times a
 * day is infrastructure to keep alive for no benefit, and polling degrades
 * gracefully through the same nginx proxy as everything else.
 */
function NotificationBell() {
  const unread = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: ({ signal }) =>
      apiRequest<{ unread: number }>('/notifications', { query: { pageSize: 1 }, signal }),
    refetchInterval: 60_000,
    // A failed poll must not surface as an error banner across the whole app.
    retry: false,
  });

  const count = unread.data?.unread ?? 0;

  return (
    <NavLink to="/notifications" className="btn btn-secondary relative" title="Notifications">
      <span aria-hidden="true">✉</span>
      <span className="hidden lg:inline">Inbox</span>
      {count > 0 ? (
        <span className="ml-1 rounded-full bg-accent-600 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
      <span className="sr-only">
        {count === 0 ? 'Notifications, none unread' : `Notifications, ${count} unread`}
      </span>
    </NavLink>
  );
}

function ThemeToggle() {
  const theme = useThemeStore((state) => state.theme);
  const toggle = useThemeStore((state) => state.toggle);
  return (
    <button
      type="button"
      onClick={toggle}
      className="btn btn-secondary"
      aria-pressed={theme === 'dark'}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
      <span className="sr-only">
        {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      </span>
      <span className="hidden lg:inline">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}

export default function Layout() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-xs dark:focus:bg-slate-800"
      >
        Skip to content
      </a>

      <aside
        id="main-nav"
        className={`${
          navOpen ? 'block' : 'hidden'
        } border-b border-slate-200 bg-slate-50 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-900`}
      >
        <div className="flex h-14 items-center gap-2 px-4">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded bg-accent-600 text-2xs font-bold text-white"
          >
            FF
          </span>
          <span className="text-xs font-semibold tracking-tight">Forecasting Platform</span>
        </div>
        <nav className="space-y-0.5 px-2 pb-4" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
            >
              <span aria-hidden="true" className="w-4 text-center text-slate-400">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <button
            type="button"
            className="btn btn-ghost lg:hidden"
            aria-expanded={navOpen}
            aria-controls="main-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
            <span className="sr-only">Toggle navigation</span>
          </button>

          <div className="ml-auto flex items-center gap-3">
            <NotificationBell />
            <ThemeToggle />
            {user ? (
              <>
                <div className="hidden text-right sm:block">
                  <p className="text-xs font-medium text-slate-800 dark:text-slate-100">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-2xs text-slate-600 dark:text-slate-400">{user.email}</p>
                </div>
                <span className="pill bg-accent-100 text-accent-800 dark:bg-accent-900/50 dark:text-accent-200">
                  {ROLE_LABELS[user.role]}
                </span>
                <button type="button" className="btn btn-secondary" onClick={handleSignOut}>
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
