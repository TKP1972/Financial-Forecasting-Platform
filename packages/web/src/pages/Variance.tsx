import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  NumberField,
  PageHeader,
  RagPill,
  SelectField,
  StatTile,
  TabPanel,
  Tabs,
} from '@/components/ui';
import VarianceDecomposition from '@/components/VarianceDecomposition';
import { getData } from '@/lib/api';
import { humanise, integer, money, money0, percent } from '@/lib/format';
import type { CycleSummary, ProjectionBasis, ProjectionReport, VarianceReport } from '@/types/api';

type GroupBy = 'ACCOUNT' | 'BUSINESS_UNIT' | 'COST_CATEGORY' | 'PERIOD';

const GROUP_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'ACCOUNT', label: 'Account' },
  { value: 'BUSINESS_UNIT', label: 'Business unit' },
  { value: 'COST_CATEGORY', label: 'Cost category' },
  { value: 'PERIOD', label: 'Period' },
];

const BASIS_OPTIONS: Array<{ value: ProjectionBasis; label: string }> = [
  { value: 'RUN_RATE', label: 'Run rate' },
  { value: 'BUDGET_REMAINING', label: 'Budget remaining' },
  { value: 'REFORECAST', label: 'Reforecast' },
];

/** Positive variance means under budget; the direction word carries the meaning. */
function DirectionCell({ direction }: { direction: string }) {
  return <span className="whitespace-nowrap">{humanise(direction)}</span>;
}

function ReportTab({ cycleId, currency }: { cycleId: string; currency: string }) {
  const [groupBy, setGroupBy] = useState<GroupBy>('BUSINESS_UNIT');
  const [throughPeriod, setThroughPeriod] = useState(6);
  const [amber, setAmber] = useState(5);
  const [red, setRed] = useState(10);
  const [includeCommitments, setIncludeCommitments] = useState(true);

  const query = useQuery({
    queryKey: ['variance-report', cycleId, groupBy, throughPeriod, amber, red, includeCommitments],
    queryFn: ({ signal }) =>
      getData<VarianceReport>(
        '/variance/report',
        {
          cycleId,
          groupBy,
          throughPeriod,
          amberThreshold: (amber / 100).toFixed(4),
          redThreshold: (red / 100).toFixed(4),
          includeCommitments,
        },
        signal,
      ),
    enabled: cycleId !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <Card className="mb-4" title="Report controls">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <SelectField
            id="var-groupby"
            label="Group by"
            value={groupBy}
            onChange={(value) => setGroupBy(value as GroupBy)}
            options={GROUP_OPTIONS}
          />
          <NumberField
            id="var-through"
            label="Through period"
            value={throughPeriod}
            onChange={setThroughPeriod}
            min={1}
            max={12}
            hint="Budget is phased, so this is not simply a pro rata split"
          />
          <NumberField
            id="var-amber"
            label="Amber threshold (%)"
            value={amber}
            onChange={setAmber}
            min={0}
            max={100}
            step={0.5}
          />
          <NumberField
            id="var-red"
            label="Red threshold (%)"
            value={red}
            onChange={setRed}
            min={0}
            max={100}
            step={0.5}
          />
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-xs" htmlFor="var-commitments">
              <input
                id="var-commitments"
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600"
                checked={includeCommitments}
                onChange={(event) => setIncludeCommitments(event.target.checked)}
              />
              Treat commitments as consumed
            </label>
          </div>
        </div>
      </Card>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {query.isPending ? (
        <Card bodyClassName="p-0">
          <LoadingTable rows={8} columns={7} />
        </Card>
      ) : query.data ? (
        <>
          {query.data.meta.note ? (
            <div className="mb-4">
              <InlineNote tone="warning">{query.data.meta.note}</InlineNote>
            </div>
          ) : null}

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Budget to date" value={money0(query.data.totals.budget, currency)} />
            <StatTile label="Actual" value={money0(query.data.totals.actual, currency)} />
            <StatTile label="Commitment" value={money0(query.data.totals.commitment, currency)} />
            <StatTile label="Consumed" value={money0(query.data.totals.consumed, currency)} />
            <StatTile
              label="Variance"
              value={money0(query.data.totals.variance, currency)}
              caption="Positive is under budget"
              tone="accent"
            />
            <StatTile
              label="Variance %"
              value={
                query.data.totals.variancePercent === null
                  ? '—'
                  : percent(query.data.totals.variancePercent)
              }
              caption={`${humanise(query.data.totals.direction)} · ${query.data.totals.rag}`}
            />
          </div>

          <Card
            className="mb-4"
            title={`Variance by ${GROUP_OPTIONS.find((option) => option.value === groupBy)?.label.toLowerCase()}`}
            subtitle={`Through period ${query.data.meta.throughPeriod} of ${query.data.meta.periodsInYear} · ${integer(query.data.meta.budgetsIncluded)} approved budget(s)`}
            bodyClassName="p-0"
          >
            {query.data.groups.length === 0 ? (
              <EmptyState
                title="No variance rows"
                description="There is no approved budget for this cycle, so nothing can be measured against. Approve a budget first, then re-run this report."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption>
                    Budget against actual and commitment, in {currency}. RAG banding uses the
                    thresholds above; a favourable variance never bands red, however large.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Group</th>
                      <th scope="col" className="num">
                        Budget
                      </th>
                      <th scope="col" className="num">
                        Actual
                      </th>
                      <th scope="col" className="num">
                        Commitment
                      </th>
                      <th scope="col" className="num">
                        Variance
                      </th>
                      <th scope="col" className="num">
                        Variance %
                      </th>
                      <th scope="col">Direction</th>
                      <th scope="col">RAG</th>
                      <th scope="col" className="num">
                        Lines
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.groups.map((group) => (
                      <tr key={group.key}>
                        <td className="font-medium text-slate-800 dark:text-slate-100">
                          {group.label}
                        </td>
                        <td className="num">{money0(group.budget, currency)}</td>
                        <td className="num">{money0(group.actual, currency)}</td>
                        <td className="num">{money0(group.commitment, currency)}</td>
                        <td className="num font-medium">{money0(group.variance, currency)}</td>
                        <td className="num">
                          {group.variancePercent === null ? '—' : percent(group.variancePercent)}
                        </td>
                        <td>
                          <DirectionCell direction={group.direction} />
                        </td>
                        <td>
                          <RagPill rag={group.rag} />
                        </td>
                        <td className="num">{integer(group.lineCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <th scope="row" className="text-left">
                        Total
                      </th>
                      <td className="num">{money0(query.data.totals.budget, currency)}</td>
                      <td className="num">{money0(query.data.totals.actual, currency)}</td>
                      <td className="num">{money0(query.data.totals.commitment, currency)}</td>
                      <td className="num">{money0(query.data.totals.variance, currency)}</td>
                      <td className="num">
                        {query.data.totals.variancePercent === null
                          ? '—'
                          : percent(query.data.totals.variancePercent)}
                      </td>
                      <td>
                        <DirectionCell direction={query.data.totals.direction} />
                      </td>
                      <td>
                        <RagPill rag={query.data.totals.rag} />
                      </td>
                      <td className="num">{integer(query.data.totals.lineCount)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Exceptions"
            subtitle="Unfavourable lines outside tolerance, worst first — the list a review meeting works through"
            bodyClassName="p-0"
          >
            {query.data.exceptions.length === 0 ? (
              <EmptyState
                title="No lines outside tolerance"
                description="Every line is inside the amber threshold for this period. Tighten the thresholds above if you want a finer view."
              />
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <table className="data-table">
                  <caption className="sr-only">Budget lines outside the amber tolerance</caption>
                  <thead className="sticky top-0 bg-white dark:bg-slate-900">
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col" className="num">
                        Budget
                      </th>
                      <th scope="col" className="num">
                        Actual
                      </th>
                      <th scope="col" className="num">
                        Consumed
                      </th>
                      <th scope="col" className="num">
                        Variance
                      </th>
                      <th scope="col" className="num">
                        Variance %
                      </th>
                      <th scope="col" className="num">
                        Utilisation
                      </th>
                      <th scope="col">RAG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.exceptions.map((line) => (
                      <tr key={line.key}>
                        <td className="min-w-[16rem]">{line.label}</td>
                        <td className="num">{money0(line.budget, currency)}</td>
                        <td className="num">{money0(line.actual, currency)}</td>
                        <td className="num">{money0(line.consumed, currency)}</td>
                        <td className="num font-medium">{money0(line.variance, currency)}</td>
                        <td className="num">
                          {line.variancePercent === null ? '—' : percent(line.variancePercent)}
                        </td>
                        <td className="num">
                          {line.utilisation === null ? '—' : percent(line.utilisation)}
                        </td>
                        <td>
                          <RagPill rag={line.rag} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

function ProjectionTab({ cycleId, currency }: { cycleId: string; currency: string }) {
  const [basis, setBasis] = useState<ProjectionBasis>('RUN_RATE');
  const [periodsElapsed, setPeriodsElapsed] = useState(6);

  const query = useQuery({
    queryKey: ['variance-projection', cycleId, basis, periodsElapsed],
    queryFn: ({ signal }) =>
      getData<ProjectionReport>('/variance/projection', { cycleId, basis, periodsElapsed }, signal),
    enabled: cycleId !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <Card className="mb-4" title="Projection basis">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            id="proj-basis"
            label="Basis"
            value={basis}
            onChange={(value) => setBasis(value as ProjectionBasis)}
            options={BASIS_OPTIONS}
          />
          <NumberField
            id="proj-elapsed"
            label="Periods elapsed"
            value={periodsElapsed}
            onChange={setPeriodsElapsed}
            min={1}
            max={12}
          />
        </div>
        {query.data ? (
          <div className="mt-3">
            <InlineNote>
              <strong className="font-semibold">{humanise(query.data.meta.basis)}: </strong>
              {query.data.meta.basisExplanation}
            </InlineNote>
          </div>
        ) : null}
      </Card>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {query.isPending ? (
        <Card bodyClassName="p-0">
          <LoadingTable rows={8} columns={6} />
        </Card>
      ) : query.data ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile label="Full-year budget" value={money0(query.data.totals.budget, currency)} />
            <StatTile
              label="Actual to date"
              value={money0(query.data.totals.actualToDate, currency)}
            />
            <StatTile
              label="Projected outturn"
              value={money0(query.data.totals.projectedOutturn, currency)}
              tone="accent"
            />
            <StatTile
              label="Projected variance"
              value={money0(query.data.totals.projectedVariance, currency)}
              caption="Positive is an expected underspend"
            />
            <StatTile
              label="Projected variance %"
              value={
                query.data.totals.projectedVariancePercent === null
                  ? '—'
                  : percent(query.data.totals.projectedVariancePercent)
              }
              caption={`${integer(query.data.meta.periodsElapsed)} of ${integer(query.data.meta.periodsInYear)} periods elapsed`}
            />
          </div>

          <Card title="Projected outturn by line" bodyClassName="p-0">
            {query.data.lines.length === 0 ? (
              <EmptyState
                title="Nothing to project"
                description="No approved budget exists for this cycle, so there is no baseline to project forward. Approve a budget first."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption>
                    Where each line lands at year end on the{' '}
                    {humanise(query.data.meta.basis).toLowerCase()} basis, in {currency}.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col" className="num">
                        Full-year budget
                      </th>
                      <th scope="col" className="num">
                        Budget to date
                      </th>
                      <th scope="col" className="num">
                        Actual to date
                      </th>
                      <th scope="col" className="num">
                        Variance to date
                      </th>
                      <th scope="col" className="num">
                        Projected remaining
                      </th>
                      <th scope="col" className="num">
                        Projected outturn
                      </th>
                      <th scope="col" className="num">
                        Projected variance
                      </th>
                      <th scope="col">Direction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.lines.map((line) => (
                      <tr key={line.key}>
                        <td className="min-w-[16rem]">
                          {line.label}
                          {line.warnings.length > 0 ? (
                            <span className="block text-2xs text-slate-600 dark:text-slate-400">
                              {line.warnings.join(' ')}
                            </span>
                          ) : null}
                        </td>
                        <td className="num">{money0(line.budget, currency)}</td>
                        <td className="num">{money0(line.budgetToDate, currency)}</td>
                        <td className="num">{money0(line.actualToDate, currency)}</td>
                        <td className="num">{money0(line.varianceToDate, currency)}</td>
                        <td className="num">{money0(line.projectedRemaining, currency)}</td>
                        <td className="num font-medium">
                          {money0(line.projectedOutturn, currency)}
                        </td>
                        <td className="num">
                          {money(line.projectedVariance, { currency, decimals: 0 })}
                        </td>
                        <td>
                          <DirectionCell direction={line.direction} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

export default function Variance() {
  const [tab, setTab] = useState<'report' | 'projection' | 'decomposition'>('report');
  const [cycleId, setCycleId] = useState('');

  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: ({ signal }) => getData<CycleSummary[]>('/cycles', undefined, signal),
  });

  // Default to the most recent cycle so the page is useful on arrival.
  useEffect(() => {
    if (cycleId === '' && cycles.data && cycles.data.length > 0) {
      setCycleId(cycles.data[0]?.id ?? '');
    }
  }, [cycles.data, cycleId]);

  const currency = cycles.data?.find((cycle) => cycle.id === cycleId)?.baseCurrency ?? 'USD';

  return (
    <>
      <PageHeader
        title="Variance"
        description="Where the budget stops being a plan and starts being a control. Commitments count as consumed: a holder with 100k left and 90k on purchase orders does not have 100k available."
      />

      <Card className="mb-4">
        <div className="max-w-md">
          <SelectField
            id="var-cycle"
            label="Budget cycle"
            value={cycleId}
            onChange={setCycleId}
            options={[
              { value: '', label: cycles.isPending ? 'Loading…' : 'Select a cycle' },
              ...(cycles.data ?? []).map((cycle) => ({
                value: cycle.id,
                label: `${cycle.name} (FY${cycle.fiscalYear})`,
              })),
            ]}
          />
        </div>
      </Card>

      {cycleId === '' ? (
        <Card>
          <EmptyState
            title="Choose a budget cycle"
            description="Variance is always reported against one cycle's approved budgets. Pick one above to begin."
          />
        </Card>
      ) : (
        <>
          <Tabs
            label="Variance views"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'report', label: 'Budget vs actual' },
              { id: 'projection', label: 'Full-year projection' },
              { id: 'decomposition', label: 'What drove it' },
            ]}
          />
          {tab === 'report' ? (
            <TabPanel id="report">
              <ReportTab cycleId={cycleId} currency={currency} />
            </TabPanel>
          ) : tab === 'projection' ? (
            <TabPanel id="projection">
              <ProjectionTab cycleId={cycleId} currency={currency} />
            </TabPanel>
          ) : (
            <TabPanel id="decomposition">
              {/*
                Not scoped to the selected cycle: it decomposes figures the user
                supplies, because a budget line stores an amount rather than a
                quantity and a rate. Sitting here anyway - it is the question a
                reader asks immediately after seeing a variance.
              */}
              <VarianceDecomposition />
            </TabPanel>
          )}
        </>
      )}
    </>
  );
}
