import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from '@/components/Layout';
import BudgetDetail from '@/pages/BudgetDetail';
import Budgets from '@/pages/Budgets';
import CycleDetail from '@/pages/CycleDetail';
import Cycles from '@/pages/Cycles';
import Dashboard from '@/pages/Dashboard';
import Forecasting from '@/pages/Forecasting';
import Governance from '@/pages/Governance';
import Login from '@/pages/Login';
import Notifications from '@/pages/Notifications';
import Pricing from '@/pages/Pricing';
import ReferenceData from '@/pages/ReferenceData';
import ResetPassword from '@/pages/ResetPassword';
import Risk from '@/pages/Risk';
import Reports from '@/pages/Reports';
import Variance from '@/pages/Variance';
import { useAuthStore } from '@/store/auth';

/** Everything except /login sits behind this. */
function RequireAuth({ children }: { children: ReactElement }) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const location = useLocation();

  if (!accessToken) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function NotFound() {
  return (
    <div className="card p-8 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        That address does not match any page in the platform. Use the navigation on the left.
      </p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Reached from a link in the reset email, so it must sit outside the
          authenticated shell - the whole point is that nobody can sign in. */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/cycles" element={<Cycles />} />
        <Route path="/cycles/:id" element={<CycleDetail />} />
        <Route path="/budgets" element={<Budgets />} />
        <Route path="/budgets/:id" element={<BudgetDetail />} />
        <Route path="/forecasting" element={<Forecasting />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/variance" element={<Variance />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/governance" element={<Governance />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/reference-data" element={<ReferenceData />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
