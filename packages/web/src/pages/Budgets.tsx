import { BUDGET_STATUSES } from '@ffp/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
import { apiRequest } from '@/lib/api';
import { formatDate, humanise, integer, money0 } from '@/lib/format';
import type { BudgetListItem, CycleSummary, Paged } from '@/types/api';

const PAGE_SIZE = 25;

export default function Budgets() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [cycleId, setCycleId] = useState('');

  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: ({ signal }) =>
      apiRequest<{ data: CycleSummary[] }>('/cycles', { signal }).then((body) => body.data),
  });

  const query = useQuery({
    queryKey: ['budgets', page, status, cycleId],
    queryFn: ({ signal }) =>
      apiRequest<Paged<BudgetListItem>>('/budgets', {
        query: {
          page,
          pageSize: PAGE_SIZE,
          status: status || undefined,
          cycleId: cycleId || undefined,
        },
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Every budget in the platform, with the workflow position it currently holds. Open one to see its lines, its version history and the actions available to you."
      />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            id="filter-cycle"
            label="Budget cycle"
            value={cycleId}
            onChange={(value) => {
              setCycleId(value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'All cycles' },
              ...(cycles.data ?? []).map((cycle) => ({
                value: cycle.id,
                label: `${cycle.name} (FY${cycle.fiscalYear})`,
              })),
            ]}
          />
          <SelectField
            id="filter-status"
            label="Workflow status"
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'All statuses' },
              ...BUDGET_STATUSES.map((value) => ({ value, label: humanise(value) })),
            ]}
          />
        </div>
      </Card>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      <Card bodyClassName="p-0">
        {query.isPending ? (
          <LoadingTable rows={8} columns={7} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No budgets match these filters"
            description="Clear the cycle or status filter to widen the search. If the platform is newly seeded, a budget owner needs to create the first budget."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>
                Budgets, most recently updated first. Totals are the sum of every period of every
                line.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Budget</th>
                  <th scope="col">Business unit</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Lines
                  </th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col">Prepared by</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((budget) => (
                  <tr key={budget.id}>
                    <td>
                      <Link
                        to={`/budgets/${budget.id}`}
                        className="font-medium text-accent-700 hover:underline dark:text-accent-300"
                      >
                        {budget.name}
                      </Link>
                      <div className="text-2xs text-slate-600 dark:text-slate-400">
                        v{budget.version}
                      </div>
                    </td>
                    <td>
                      <span className="font-mono text-2xs text-slate-600 dark:text-slate-400">
                        {budget.businessUnit.code}
                      </span>{' '}
                      {budget.businessUnit.name}
                    </td>
                    <td>FY{budget.cycle.fiscalYear}</td>
                    <td>
                      <StatusPill status={budget.status} />
                    </td>
                    <td className="num">{integer(budget.lineCount)}</td>
                    <td className="num font-medium">
                      {money0(budget.totalAmount, budget.currency)}
                    </td>
                    <td>
                      {budget.preparedBy
                        ? `${budget.preparedBy.firstName} ${budget.preparedBy.lastName}`
                        : '—'}
                    </td>
                    <td className="tabular-nums">{formatDate(budget.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 text-xs dark:border-slate-800">
            <p className="text-slate-600 dark:text-slate-400">
              Showing {integer((meta.page - 1) * meta.pageSize + 1)}–
              {integer(Math.min(meta.page * meta.pageSize, meta.total))} of {integer(meta.total)}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={meta.page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <span className="tabular-nums text-slate-600 dark:text-slate-400">
                Page {meta.page} of {Math.max(1, meta.totalPages)}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={meta.page >= meta.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
