import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingTable,
  PageHeader,
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
      <span className="ml-2 text-2xs text-slate-500 dark:text-slate-400">
        {overdue ? `${integer(Math.abs(days))} days ago` : `in ${integer(days)} days`}
      </span>
    </div>
  );
}

export default function Cycles() {
  const query = useQuery({
    queryKey: ['cycles'],
    queryFn: ({ signal }) => getData<CycleSummary[]>('/cycles', undefined, signal),
  });

  return (
    <>
      <PageHeader
        title="Budget cycles"
        description="A cycle fixes the fiscal calendar, the planning assumptions every unit budgets against, the top-down targets and the deadlines."
      />

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
                Every budget cycle, most recent fiscal year first, with its deadlines and the volume
                of work it carries.
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
                      <div className="text-2xs text-slate-500 dark:text-slate-400">
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
            title="No budget cycles yet"
            description="A cycle has to exist before budgets can be prepared. Someone with cycle management rights needs to open one for the coming fiscal year."
          />
        )}
      </Card>
    </>
  );
}
