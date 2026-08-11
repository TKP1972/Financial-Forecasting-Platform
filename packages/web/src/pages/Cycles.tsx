import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingTable,
  PageHeader,
  SelectField,
  StatusPill,
} from '@/components/ui';
import { getData } from '@/lib/api';
import { formatDate, humanise, integer } from '@/lib/format';
import type { CycleSummary } from '@/types/api';

function DeadlineCell({ days, date }: { days: number; date: string }) {
  const overdue = days < 0;
  return (
    <div>
      <span className="tabular-nums">{formatDate(date)}</span>
      <span className="ml-2 text-2xs text-slate-600 dark:text-slate-400">
        {overdue ? `${integer(Math.abs(days))} days ago` : `in ${integer(days)} days`}
      </span>
    </div>
  );
}

/**
 * Cycles in progress, rather than every cycle ever run.
 *
 * Nothing in this platform is deleted - a closed cycle stays readable forever,
 * which is the point of DEL-01. The consequence is that this list only grows,
 * and after a few fiscal years most of it is finished work nobody is looking
 * for. The filter defaults to what is live and keeps the rest one selection
 * away.
 */
const ACTIVE_STATUSES = 'PLANNING,OPEN,CONSOLIDATING';

const VIEWS = [
  { value: ACTIVE_STATUSES, label: 'In progress' },
  { value: 'CLOSED', label: 'Closed' },
  { value: '', label: 'All cycles' },
];

export default function Cycles() {
  const [view, setView] = useState(ACTIVE_STATUSES);

  const query = useQuery({
    queryKey: ['cycles', view],
    queryFn: ({ signal }) =>
      getData<CycleSummary[]>('/cycles', view ? { status: view } : undefined, signal),
  });

  return (
    <>
      <PageHeader
        title="Budget cycles"
        description="A cycle fixes the fiscal calendar, the planning assumptions every unit budgets against, the top-down targets and the deadlines."
      />

      <Card className="mb-4">
        <div className="max-w-xs">
          <SelectField
            id="cycle-view"
            label="Show"
            value={view}
            onChange={setView}
            options={VIEWS}
          />
        </div>
      </Card>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      <Card bodyClassName="p-0">
        {query.isPending ? (
          <LoadingTable rows={4} columns={6} />
        ) : query.data && query.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>
                {view === ACTIVE_STATUSES
                  ? 'Cycles in progress, most recent fiscal year first, with their deadlines and the volume of work they carry.'
                  : view === 'CLOSED'
                    ? 'Closed cycles. Kept in full - a closed cycle is still readable, and its budgets remain the baseline any variance was reported against.'
                    : 'Every budget cycle, most recent fiscal year first, with its deadlines and the volume of work it carries.'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Cycle</th>
                  <th scope="col">Status</th>
                  <th scope="col">Opens</th>
                  <th scope="col">Submission deadline</th>
                  <th scope="col">Approval deadline</th>
                  <th scope="col" className="num">
                    Budgets
                  </th>
                  <th scope="col" className="num">
                    Assumptions
                  </th>
                  <th scope="col">Guidance</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((cycle) => (
                  <tr key={cycle.id}>
                    <td>
                      <Link
                        to={`/cycles/${cycle.id}`}
                        className="font-medium text-accent-700 hover:underline dark:text-accent-300"
                      >
                        {cycle.name}
                      </Link>
                      <div className="text-2xs text-slate-600 dark:text-slate-400">
                        FY{cycle.fiscalYear} · {humanise(cycle.periodType)}ly · {cycle.baseCurrency}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={cycle.status} />
                    </td>
                    <td className="tabular-nums">{formatDate(cycle.opensAt)}</td>
                    <td>
                      <DeadlineCell days={cycle.daysToSubmission} date={cycle.submissionDeadline} />
                    </td>
                    <td className="tabular-nums">{formatDate(cycle.approvalDeadline)}</td>
                    <td className="num">{integer(cycle.budgetCount)}</td>
                    <td className="num">{integer(cycle.assumptionCount)}</td>
                    <td className="text-2xs">
                      {cycle.guidancePublishedAt
                        ? `Published ${formatDate(cycle.guidancePublishedAt)}`
                        : 'Not published'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={view === '' ? 'No budget cycles yet' : 'Nothing matches this filter'}
            description={
              view === ''
                ? 'A cycle has to exist before budgets can be prepared. Someone with cycle management rights needs to open one for the coming fiscal year.'
                : view === 'CLOSED'
                  ? 'No cycle has been closed yet. Closed cycles stay here permanently once they are.'
                  : 'No cycle is currently in progress. Switch to "All cycles" to see closed ones, or open a new cycle for the coming fiscal year.'
            }
          />
        )}
      </Card>
    </>
  );
}
