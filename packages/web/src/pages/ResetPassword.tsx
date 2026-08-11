import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest, errorMessage } from '@/lib/api';

/**
 * Complete a password reset.
 *
 * The link in the notification lands here with the token in the query string.
 * Unlike the request step, this page reports failure precisely: the visitor is
 * holding a token, and telling them it has expired is not a leak - leaving them
 * to guess is a support call.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // Checked here as well as by the API so a typo costs a keystroke rather than
    // the token - each attempt against the server consumes it on success.
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<{ sessionsRevoked: number }>('/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
        anonymous: true,
      });
      setDone(result.sessionsRevoked);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded bg-accent-600 text-xs font-bold text-white"
          >
            FF
          </span>
          <h1 className="text-sm font-semibold tracking-tight">Choose a new password</h1>
        </div>

        {done !== null ? (
          <div className="card space-y-3 p-5">
            <p className="text-xs text-slate-700 dark:text-slate-300">
              Your password has been changed
              {done > 0
                ? `, and ${done} other signed-in session${done === 1 ? '' : 's'} ${
                    done === 1 ? 'was' : 'were'
                  } ended.`
                : '.'}
            </p>
            <p className="text-2xs text-slate-600 dark:text-slate-400">
              Every session is ended on a reset, on the assumption that the reason for resetting was
              that someone else had access.
            </p>
            <button
              type="button"
              className="btn btn-primary w-full py-2"
              onClick={() => navigate('/login', { replace: true })}
            >
              Sign in
            </button>
          </div>
        ) : token === '' ? (
          <div className="card space-y-3 p-5">
            <p className="text-xs text-slate-700 dark:text-slate-300">
              This page needs a reset link. Request one from the sign-in page.
            </p>
            <Link to="/login" className="btn btn-secondary">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="card space-y-4 p-5" noValidate>
            <div>
              <label className="field-label" htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
              />
              <p className="mt-1 text-2xs text-slate-600 dark:text-slate-400">
                At least 12 characters, with upper and lower case, a digit and a symbol.
              </p>
            </div>

            <div>
              <label className="field-label" htmlFor="confirm-password">
                Confirm new password
              </label>
              <input
                id="confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
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
              {busy ? 'Setting…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
