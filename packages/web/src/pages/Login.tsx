import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { apiRequest, errorMessage, login } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useThemeStore } from '@/store/theme';

/** Seeded local accounts, offered as quick-fill so a reviewer can switch roles fast. */
const DEMO_ACCOUNTS = [
  { email: 'admin@ffp.local', password: 'Adm1n!Local2026', role: 'Administrator' },
  { email: 'cfo@ffp.local', password: 'Cfo!Local2026x', role: 'CFO' },
  { email: 'finance.manager@ffp.local', password: 'FinMgr!Local26', role: 'Finance Manager' },
  { email: 'analyst@ffp.local', password: 'Analyst!Local26', role: 'Analyst' },
  { email: 'viewer@ffp.local', password: 'Viewer!Local26x', role: 'Viewer' },
] as const;

export default function Login() {
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const setSession = useAuthStore((state) => state.setSession);
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggle);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  if (accessToken) return <Navigate to="/" replace />;

  async function requestReset(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        anonymous: true,
      });
    } catch (caught) {
      // Only a rate limit or an outage can land here; a rejected *address*
      // deliberately succeeds. Surfacing that distinction is the point.
      setError(errorMessage(caught));
      return;
    } finally {
      setBusy(false);
    }
    setResetSent(true);
  }

  async function submit(withEmail: string, withPassword: string) {
    setBusy(true);
    setError(null);
    try {
      const session = await login(withEmail, withPassword);
      setSession(session);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(email.trim(), password);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded bg-accent-600 text-xs font-bold text-white"
            >
              FF
            </span>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">
                Financial Forecasting Platform
              </h1>
              <p className="text-2xs text-slate-500 dark:text-slate-400">
                Budgeting, forecasting, pricing, risk and expenditure control
              </p>
            </div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={toggleTheme}>
            <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
            <span className="sr-only">Switch theme</span>
          </button>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-5" noValidate>
          <div>
            <label className="field-label" htmlFor="login-email">
              Email address
            </label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
            >
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
            {resetSent ? (
              // Deliberately the same message whether or not the address exists.
              // Confirming which addresses have accounts would turn this box into
              // a way to enumerate the finance team.
              <p className="text-2xs text-slate-600 dark:text-slate-300">
                If that address has an account, a reset link has been sent to it. The link is
                single-use and expires in one hour.
              </p>
            ) : (
              <button
                type="button"
                className="text-2xs text-accent-700 underline hover:no-underline disabled:opacity-50 dark:text-accent-300"
                disabled={busy || email.trim() === ''}
                onClick={() => void requestReset()}
              >
                {email.trim() === ''
                  ? 'Enter your email address to reset your password'
                  : 'Forgot your password?'}
              </button>
            )}
          </div>
        </form>

        <section className="card mt-4 p-4" aria-labelledby="demo-accounts">
          <h2 id="demo-accounts" className="card-title">
            Local demo accounts
          </h2>
          <p className="card-subtitle mt-0.5">
            Seeded for this environment. Selecting one fills the form and signs in, so you can see
            how the interface changes with each role&apos;s permissions.
          </p>
          <ul className="mt-3 space-y-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(account.password);
                    void submit(account.email, account.password);
                  }}
                  className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-xs transition-colors hover:border-accent-400 hover:bg-accent-50 disabled:opacity-50 dark:border-slate-700 dark:hover:border-accent-500 dark:hover:bg-slate-800"
                >
                  <span className="font-medium">{account.role}</span>
                  <span className="font-mono text-2xs text-slate-500 dark:text-slate-400">
                    {account.email}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
