import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingCard,
  PageHeader,
  StatusPill,
} from '@/components/ui';
import { downloadFile, errorMessage, getData } from '@/lib/api';
import { formatDate, humanise, integer, money, money0, percent } from '@/lib/format';
import type { CycleDetail as CycleDetailData, GuidancePack } from '@/types/api';

/** Assumption values are rates, amounts, counts or index points - each reads differently. */
function assumptionDisplay(value: string, unit: string, currency: string): string {
  switch (unit) {
    case 'RATE':
      return percent(value, { fractionDigits: 2 });
    case 'AMOUNT':
      return money(value, { currency });
    case 'COUNT':
      return integer(Number(value));
    default:
      return value;
  }
}

function GuidancePackPanel({ cycleId, currency }: { cycleId: string; currency: string }) {
  const query = useQuery({
    queryKey: ['guidance-pack', cycleId],
    queryFn: ({ signal }) =>
      getData<GuidancePack>(`/cycles/${cycleId}/guidance-pack`, undefined, signal),
  });

  if (query.isPending) return <LoadingCard rows={6} label="Loading the guidance pack" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const pack = query.data;

  return (
    <Card
      title={pack.title}
      subtitle={
        pack.publishedAt
          ? `Version ${pack.version}, published ${formatDate(pack.publishedAt)}`
          : 'Not yet published — this is the pack as it currently stands.'
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold">Strategic priorities</h3>
          {pack.strategicPriorities.length === 0 ? (
            <p className="text-xs text-slate-600 dark:text-slate-400">
              No priorities have been published for this cycle.
            </p>
          ) : (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-300">
              {pack.strategicPriorities.map((priority) => (
                <li key={priority}>{priority}</li>
              ))}
            </ol>
          )}

          <h3 className="mb-2 mt-5 text-xs font-semibold">Strategic objectives</h3>
          <table className="data-table">
            <caption className="sr-only">
              Strategic objectives and their intended share of budget
            </caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Objective</th>
                <th scope="col">Horizon</th>
                <th scope="col" className="num">
                  Target share
                </th>
              </tr>
            </thead>
            <tbody>
              {pack.objectives.map((objective) => (
                <tr key={objective.code}>
                  <td className="font-mono text-2xs">{objective.code}</td>
                  <td>{objective.title}</td>
                  <td>{humanise(objective.horizon)}</td>
                  <td className="num">
                    {objective.targetShare ? percent(objective.targetShare) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold">Submission instructions</h3>
          <p className="whitespace-pre-line text-xs text-slate-700 dark:text-slate-300">
            {pack.submissionInstructions ?? 'No submission instructions have been published.'}
          </p>

          <h3 className="mb-2 mt-5 text-xs font-semibold">Chart of accounts extract</h3>
          <div className="max-h-64 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
            <table className="data-table">
              <caption className="sr-only">Accounts available for budgeting in this cycle</caption>
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Account</th>
                  <th scope="col">Type</th>
                </tr>
              </thead>
              <tbody>
                {pack.accounts.map((account) => (
                  <tr key={account.code}>
                    <td className="font-mono text-2xs">{account.code}</td>
                    <td>{account.name}</td>
                    <td>{humanise(account.type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {pack.assumptions.length > 0 ? (
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold">Assumptions as published</h3>
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">Planning assumptions in the published pack</caption>
              <thead>
                <tr>
                  <th scope="col">Assumption</th>
                  <th scope="col" className="num">
                    Value
                  </th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {pack.assumptions.map((assumption) => (
                  <tr key={assumption.key}>
                    <td>{assumption.label}</td>
                    <td className="num font-medium">
                      {assumption.displayValue ||
                        assumptionDisplay(assumption.value, assumption.unit, currency)}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">
                      {assumption.notes ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Card>
  );
}

export default function CycleDetail() {
  const { id = '' } = useParams();
  const [showPack, setShowPack] = useState(false);

  const query = useQuery({
    queryKey: ['cycle', id],
    queryFn: ({ signal }) => getData<CycleDetailData>(`/cycles/${id}`, undefined, signal),
    enabled: id !== '',
  });

  const download = useMutation({
    mutationFn: () => downloadFile(`/cycles/${id}/guidance-pack.md`, `budget-guidance-${id}.md`),
  });

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Budget cycle" />
        <LoadingCard rows={8} />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Budget cycle" />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }

  const cycle = query.data;
  const currency = cycle.baseCurrency;

  return (
    <>
      <PageHeader
        title={cycle.name}
        description={`FY${cycle.fiscalYear} · ${humanise(cycle.periodType)}ly periods · base currency ${currency}`}
        actions={
          <>
            <Link to="/cycles" className="btn btn-ghost">
              All cycles
            </Link>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowPack((open) => !open)}
            >
              {showPack ? 'Hide guidance pack' : 'View guidance pack'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              {download.isPending ? 'Preparing…' : 'Download Markdown pack'}
            </button>
          </>
        }
      />

      {download.isError ? (
        <div className="mb-4">
          <InlineNote tone="warning">{errorMessage(download.error)}</InlineNote>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Status
          </p>
          <p className="mt-1">
            <StatusPill status={cycle.status} />
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Opens
          </p>
          <p className="mt-1 text-sm font-semibold tabular-nums">{formatDate(cycle.opensAt)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Submission deadline
          </p>
          <p className="mt-1 text-sm font-semibold tabular-nums">
            {formatDate(cycle.submissionDeadline)}
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Approval deadline
          </p>
          <p className="mt-1 text-sm font-semibold tabular-nums">
            {formatDate(cycle.approvalDeadline)}
          </p>
        </div>
      </div>

      {showPack ? (
        <div className="mb-4">
          <GuidancePackPanel cycleId={cycle.id} currency={currency} />
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Planning assumptions"
          subtitle="Published centrally so every unit budgets on the same basis"
          bodyClassName="p-0"
        >
          {cycle.assumptions.length === 0 ? (
            <EmptyState
              title="No assumptions published"
              description="Until assumptions are published, units will each pick their own inflation and escalation rates. Publish a guidance pack to fix them."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption>Assumptions every budget in this cycle must be built on.</caption>
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Assumption</th>
                    <th scope="col" className="num">
                      Value
                    </th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {cycle.assumptions.map((assumption) => (
                    <tr key={assumption.id}>
                      <td className="font-mono text-2xs">{assumption.key}</td>
                      <td>{assumption.label}</td>
                      <td className="num font-medium">
                        {assumptionDisplay(assumption.value, assumption.unit, currency)}
                      </td>
                      <td className="max-w-xs text-slate-600 dark:text-slate-400">
                        {assumption.notes ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Top-down targets"
          subtitle="Revenue targets and cost ceilings handed to each business unit"
          bodyClassName="p-0"
        >
          {cycle.targets.length === 0 ? (
            <EmptyState
              title="No targets set"
              description="Leadership has not issued revenue targets or cost ceilings for this cycle. Publish them with the guidance pack so units budget against a number."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption>Targets by business unit, in {currency}.</caption>
                <thead>
                  <tr>
                    <th scope="col">Business unit</th>
                    <th scope="col" className="num">
                      Revenue target
                    </th>
                    <th scope="col" className="num">
                      Cost ceiling
                    </th>
                    <th scope="col" className="num">
                      Headcount ceiling
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cycle.targets.map((target) => (
                    <tr key={target.id}>
                      <td>
                        <span className="font-mono text-2xs text-slate-600 dark:text-slate-400">
                          {target.businessUnit.code}
                        </span>{' '}
                        {target.businessUnit.name}
                      </td>
                      <td className="num">{money0(target.revenueTarget, currency)}</td>
                      <td className="num">{money0(target.costCeiling, currency)}</td>
                      <td className="num">
                        {target.headcountCeiling === null ? '—' : integer(target.headcountCeiling)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Fiscal calendar"
        subtitle={`${cycle.periods.length} periods, generated centrally so budget and actuals join on the same period key`}
        bodyClassName="p-4"
      >
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {cycle.periods.map((period) => (
            <li
              key={period.key}
              className="rounded border border-slate-200 px-2.5 py-2 dark:border-slate-800"
            >
              <p className="font-mono text-2xs text-slate-600 dark:text-slate-400">{period.key}</p>
              <p className="text-xs font-medium">{period.label}</p>
              <p className="text-2xs text-slate-600 dark:text-slate-400">
                Q{period.quarter} · from {formatDate(period.startDate)}
              </p>
            </li>
          ))}
        </ol>
      </Card>

      <Card
        className="mt-4"
        title="Budgets in this cycle"
        subtitle={`${integer(cycle.budgets.length)} budget(s)`}
        bodyClassName="p-0"
      >
        {cycle.budgets.length === 0 ? (
          <EmptyState
            title="No budgets yet"
            description="Business units have not started preparing budgets for this cycle."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>Budgets prepared against this cycle.</caption>
              <thead>
                <tr>
                  <th scope="col">Budget</th>
                  <th scope="col">Business unit</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {cycle.budgets.map((budget) => (
                  <tr key={budget.id}>
                    <td>
                      <Link
                        to={`/budgets/${budget.id}`}
                        className="font-medium text-accent-700 hover:underline dark:text-accent-300"
                      >
                        {budget.name}
                      </Link>
                    </td>
                    <td>
                      <span className="font-mono text-2xs text-slate-600 dark:text-slate-400">
                        {budget.businessUnit.code}
                      </span>{' '}
                      {budget.businessUnit.name}
                    </td>
                    <td>
                      <StatusPill status={budget.status} />
                    </td>
                    <td className="num">{money0(budget.totalAmount, currency)}</td>
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
