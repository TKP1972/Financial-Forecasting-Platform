import { RISK_SEVERITIES } from '@ffp/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingCard,
  PageHeader,
  ProgressBar,
  SeverityPill,
  StatTile,
  StatusPill,
} from '@/components/ui';
import { getData } from '@/lib/api';
import { formatDate, humanise, integer, money, money0, percent } from '@/lib/format';
import type { DashboardData } from '@/types/api';

export default function Dashboard() {
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => getData<DashboardData>('/reports/dashboard', undefined, signal),
  });

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Dashboard" description="Where the current budget cycle stands today." />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <LoadingCard rows={2} />
          <LoadingCard rows={2} />
          <LoadingCard rows={2} />
        </div>
      </>
    );
  }

  if (query.isError) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }

  const data = query.data;
  const currency = data.cycle?.baseCurrency ?? 'USD';

  if (!data.cycle) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <EmptyState
            title="No budget cycle exists yet"
            description={
              data.message ??
              'Create a budget cycle to fix the fiscal calendar, publish planning assumptions and open the process to business units.'
            }
            action={
              <Link to="/cycles" className="btn btn-primary mt-2">
                Go to budget cycles
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const { budget, expenditure, risk, pipeline } = data;
  const deadlinePassed = data.cycle.daysToSubmission < 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${data.cycle.name} · FY${data.cycle.fiscalYear} · ${humanise(data.cycle.status)} · reported in ${currency}`}
        actions={
          <Link to={`/cycles/${data.cycle.id}`} className="btn btn-secondary">
            Open cycle
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          label="Approved budget"
          value={money0(budget?.totalApproved, currency)}
          caption={`${integer(budget?.budgetCount ?? 0)} budget(s) in cycle`}
          tone="accent"
        />
        <StatTile
          label="Actual spend"
          value={money0(expenditure?.actual, currency)}
          caption="Recorded to date"
        />
        <StatTile
          label="Commitment"
          value={money0(expenditure?.commitment, currency)}
          caption="Committed, not yet incurred"
        />
        <StatTile
          label="Remaining"
          value={money0(expenditure?.remaining, currency)}
          caption="Approved less actual and commitment"
        />
        <StatTile
          label="Utilisation"
          value={
            expenditure?.utilisation === null || expenditure?.utilisation === undefined
              ? '—'
              : percent(expenditure.utilisation)
          }
          caption="Of approved budgets, by the units that hold them"
        />
        {/*
          Shown only when there is some, because a zero here is the normal state
          and a permanent empty tile trains people to stop reading it.

          Utilisation deliberately excludes this spend - it is consumption of a
          budget nobody has approved yet, so it is not consumption *of* an
          approved budget. That makes it easy to lose, which is exactly why it
          gets its own tile rather than a footnote.
        */}
        {expenditure && Number(expenditure.unapprovedActual) > 0 ? (
          <StatTile
            label="Spent against unapproved budgets"
            value={money0(expenditure.unapprovedActual, currency)}
            caption="Real spend, outside the utilisation figure"
          />
        ) : null}
        <StatTile
          label="Days to submission"
          value={integer(Math.abs(data.cycle.daysToSubmission))}
          caption={
            deadlinePassed
              ? `Deadline passed ${formatDate(data.cycle.submissionDeadline)}`
              : `Due ${formatDate(data.cycle.submissionDeadline)}`
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card
          title="Approval progress"
          subtitle="Budgets approved or locked, as a share of the cycle"
        >
          <ProgressBar value={budget?.approvalProgress ?? 0} label="Approved or locked" />
          <table className="data-table mt-4">
            <caption className="sr-only">Budget count by workflow status</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Budgets
                </th>
              </tr>
            </thead>
            <tbody>
              {(budget?.byStatus ?? []).length === 0 ? (
                <tr>
                  <td colSpan={2} className="text-slate-600">
                    No budgets have been created in this cycle yet.
                  </td>
                </tr>
              ) : (
                (budget?.byStatus ?? []).map((row) => (
                  <tr key={row.status}>
                    <td>
                      <StatusPill status={row.status} />
                    </td>
                    <td className="num font-medium">{integer(row.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="border-b-0 pt-2">
                  Total submitted value
                </th>
                <td className="num border-b-0 pt-2 font-semibold">
                  {money0(budget?.totalSubmitted, currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <Card
          title="Risk exposure"
          subtitle={`${integer(risk?.openRisks ?? 0)} open or monitored risks`}
          actions={
            <Link to="/risk" className="btn btn-ghost">
              Register
            </Link>
          }
        >
          <dl className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                Inherent exposure
              </dt>
              <dd className="text-sm font-semibold tabular-nums">
                {money0(risk?.totalExposure, currency)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                Residual exposure
              </dt>
              <dd className="text-sm font-semibold tabular-nums">
                {money0(risk?.residualExposure, currency)}
              </dd>
            </div>
          </dl>
          <table className="data-table">
            <caption className="sr-only">Open risk count by inherent severity</caption>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col" className="num">
                  Risks
                </th>
              </tr>
            </thead>
            <tbody>
              {RISK_SEVERITIES.map((severity) => (
                <tr key={severity}>
                  <td>
                    <SeverityPill severity={severity} />
                  </td>
                  <td className="num font-medium">
                    {integer(risk?.severityCounts?.[severity] ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Weighted pipeline" subtitle="Active pursuits, weighted by probability of win">
          <p className="text-2xl font-semibold tabular-nums tracking-tight text-accent-700 dark:text-accent-300">
            {money0(pipeline?.weightedValue, currency)}
          </p>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            Across {integer(pipeline?.activePursuits ?? 0)} qualified, proposal, submitted or
            negotiating pursuits. Each pursuit&apos;s latest priced value is multiplied by its win
            probability.
          </p>
          <Link to="/pricing" className="btn btn-secondary mt-3">
            Open pricing workbench
          </Link>
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Top escalations"
        subtitle="Risks at severe or critical severity that need a decision"
        bodyClassName="p-0"
      >
        {(risk?.escalations ?? []).length === 0 ? (
          <EmptyState
            title="Nothing to escalate"
            description="No open risk is currently scored severe or critical. Review the register if you expect one to be."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>Highest-severity open risks, with expected monetary exposure.</caption>
              <thead>
                <tr>
                  <th scope="col">Risk</th>
                  <th scope="col">Category</th>
                  <th scope="col">Severity</th>
                  <th scope="col" className="num">
                    Score
                  </th>
                  <th scope="col" className="num">
                    Expected exposure
                  </th>
                </tr>
              </thead>
              <tbody>
                {(risk?.escalations ?? []).map((escalation) => (
                  <tr key={escalation.id}>
                    <td className="font-medium text-slate-800 dark:text-slate-100">
                      {escalation.title}
                    </td>
                    <td>{humanise(escalation.category)}</td>
                    <td>
                      <SeverityPill severity={escalation.inherentSeverity} />
                    </td>
                    <td className="num">{escalation.inherentScore}</td>
                    <td className="num">{money(escalation.expectedValue, { currency })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
