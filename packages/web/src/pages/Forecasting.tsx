import { FORECAST_METHODS, FORECAST_METHOD_LABELS, type ForecastMethod } from '@ffp/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AccessibleChart,
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingCard,
  NumberField,
  PageHeader,
  SelectField,
  StatTile,
} from '@/components/ui';
import { getData, postData } from '@/lib/api';
import { chartValue, decimal, humanise, integer, money0, percent } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type { Account, BusinessUnit, ForecastRunResult, HistoryPoint } from '@/types/api';

type MethodChoice = ForecastMethod | 'AUTO';

interface ChartRow {
  periodKey: string;
  actual: number | null;
  forecast: number | null;
  band: [number, number] | null;
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: unknown; name?: string }>;
  label?: string | number;
  currency: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800">
      <p className="mb-1 font-semibold">{String(label)}</p>
      <ul className="space-y-0.5">
        {payload.map((entry) => {
          const value = entry.value;
          let text: string;
          if (Array.isArray(value)) {
            text = `${money0(String(value[0]), currency)} – ${money0(String(value[1]), currency)}`;
          } else if (typeof value === 'number') {
            text = money0(String(value), currency);
          } else {
            return null;
          }
          return (
            <li key={String(entry.dataKey)} className="flex justify-between gap-4">
              <span className="text-slate-600 dark:text-slate-400">{entry.name}</span>
              <span className="tabular-nums">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function Forecasting() {
  const has = useHasPermission();
  const canRun = has('forecast:run');

  const [businessUnitId, setBusinessUnitId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [method, setMethod] = useState<MethodChoice>('AUTO');
  const [horizon, setHorizon] = useState(6);
  const [seasonLength, setSeasonLength] = useState(12);
  const [useSeasonality, setUseSeasonality] = useState(true);

  const units = useQuery({
    queryKey: ['business-units'],
    queryFn: ({ signal }) => getData<BusinessUnit[]>('/org/business-units', undefined, signal),
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => getData<Account[]>('/org/accounts', undefined, signal),
  });

  const history = useQuery({
    queryKey: ['forecast-history', businessUnitId, accountId],
    queryFn: ({ signal }) =>
      getData<HistoryPoint[]>('/forecasts/history', { businessUnitId, accountId }, signal),
    enabled: businessUnitId !== '' && accountId !== '',
  });

  const run = useMutation({
    mutationFn: (points: HistoryPoint[]) =>
      postData<ForecastRunResult>('/forecasts/run', {
        businessUnitId,
        accountId,
        method,
        history: points,
        horizon,
        ...(useSeasonality && points.length >= seasonLength * 2 ? { seasonLength } : {}),
        confidenceLevel: 0.95,
      }),
  });

  const result = run.data;
  const currency = 'USD';

  const chartData = useMemo<ChartRow[]>(() => {
    const points = history.data ?? [];
    const rows: ChartRow[] = points.map((point) => ({
      periodKey: point.periodKey,
      actual: chartValue(point.value),
      forecast: null,
      band: null,
    }));

    if (result) {
      // Anchor the forecast to the final actual so the two lines meet.
      const last = rows[rows.length - 1];
      if (last) {
        last.forecast = last.actual;
        last.band = last.actual === null ? null : [last.actual, last.actual];
      }
      result.periodKeys.forEach((periodKey, index) => {
        const point = chartValue(result.point[index]);
        const lower = result.interval ? chartValue(result.interval.lower[index]) : point;
        const upper = result.interval ? chartValue(result.interval.upper[index]) : point;
        rows.push({ periodKey, actual: null, forecast: point, band: [lower, upper] });
      });
    }

    return rows;
  }, [history.data, result]);

  const pointCount = history.data?.length ?? 0;
  const ready = businessUnitId !== '' && accountId !== '' && pointCount >= 2;

  return (
    <>
      <PageHeader
        title="Forecasting"
        description="Build a forecast from recorded actuals. AUTO backtests every applicable method by rolling-origin cross-validation and shows the full candidate table, so the choice of method can be challenged."
      />

      <Card className="mb-4" title="Series and method">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <SelectField
            id="fc-unit"
            label="Business unit"
            value={businessUnitId}
            onChange={setBusinessUnitId}
            options={[
              { value: '', label: units.isPending ? 'Loading…' : 'Select a unit' },
              ...(units.data ?? []).map((unit) => ({
                value: unit.id,
                label: `${unit.code} — ${unit.name}`,
              })),
            ]}
          />
          <SelectField
            id="fc-account"
            label="Account"
            value={accountId}
            onChange={setAccountId}
            options={[
              { value: '', label: accounts.isPending ? 'Loading…' : 'Select an account' },
              ...(accounts.data ?? []).map((account) => ({
                value: account.id,
                label: `${account.code} — ${account.name}`,
              })),
            ]}
          />
          <SelectField
            id="fc-method"
            label="Method"
            value={method}
            onChange={(value) => setMethod(value as MethodChoice)}
            options={[
              { value: 'AUTO', label: 'AUTO — backtest and select' },
              ...FORECAST_METHODS.filter((value) => value !== 'DRIVER_BASED').map((value) => ({
                value,
                label: FORECAST_METHOD_LABELS[value],
              })),
            ]}
          />
          <NumberField
            id="fc-horizon"
            label="Horizon (periods)"
            value={horizon}
            onChange={setHorizon}
            min={1}
            max={60}
          />
          <NumberField
            id="fc-season"
            label="Season length"
            value={seasonLength}
            onChange={setSeasonLength}
            min={2}
            max={24}
            hint={useSeasonality ? 'Needs two full seasons of history' : 'Currently ignored'}
          />
          <div className="flex flex-col justify-end gap-2 pb-1">
            <label className="flex items-center gap-2 text-xs" htmlFor="fc-seasonal">
              <input
                id="fc-seasonal"
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600"
                checked={useSeasonality}
                onChange={(event) => setUseSeasonality(event.target.checked)}
              />
              Apply seasonality
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canRun || !ready || run.isPending}
              onClick={() => run.mutate(history.data ?? [])}
              title={canRun ? undefined : 'Running a forecast requires the forecast:run permission'}
            >
              {run.isPending ? 'Running…' : 'Run forecast'}
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {!canRun ? (
            <InlineNote>
              Your role can view forecasts but not run them. Ask an analyst or budget owner to
              produce the run you need.
            </InlineNote>
          ) : null}
          {businessUnitId && accountId ? (
            history.isPending ? (
              <InlineNote>Loading history…</InlineNote>
            ) : history.isError ? (
              <ErrorState error={history.error} onRetry={() => void history.refetch()} />
            ) : (
              <InlineNote tone={pointCount < 2 ? 'warning' : 'neutral'}>
                {pointCount < 2
                  ? 'This series has fewer than two recorded actuals, which is not enough to forecast from. Pick another account, or import actuals first.'
                  : `${integer(pointCount)} historical points loaded, from ${history.data?.[0]?.periodKey} to ${history.data?.[pointCount - 1]?.periodKey}.`}
              </InlineNote>
            )
          ) : (
            <InlineNote>
              Choose a business unit and an account to load its recorded actuals as the forecast
              base.
            </InlineNote>
          )}
          {run.isError ? <ErrorState error={run.error} /> : null}
        </div>
      </Card>

      {result && result.warnings.length > 0 ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="text-sm font-semibold">
            {result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'} from this run
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile
            label="Method used"
            value={FORECAST_METHOD_LABELS[result.method]}
            caption={
              result.selectionCriterion
                ? `Selected on ${result.selectionCriterion}`
                : 'Chosen manually'
            }
            tone="accent"
          />
          <StatTile
            label="MASE"
            value={decimal(result.accuracy.mase)}
            caption="Below 1 beats a naive forecast"
          />
          <StatTile
            label="MAPE"
            value={result.accuracy.mape === null ? '—' : percent(result.accuracy.mape)}
            caption="Undefined when an actual is zero"
          />
          <StatTile
            label="RMSE"
            value={money0(String(result.accuracy.rmse), currency)}
            caption="Penalises large misses"
          />
          <StatTile
            label="Bias"
            value={money0(String(result.accuracy.bias), currency)}
            caption={
              result.accuracy.biasPercent === null
                ? 'Mean error over the fit window'
                : `${percent(result.accuracy.biasPercent)} of mean actual`
            }
          />
        </div>
      ) : null}

      <Card
        title="Actual history and forecast"
        subtitle={
          result?.interval
            ? `Shaded band is the ${percent(result.interval.level, { fractionDigits: 0 })} prediction interval`
            : 'Run a forecast to project this series forward'
        }
      >
        {history.isPending && businessUnitId && accountId ? (
          <LoadingCard rows={6} label="Loading history" />
        ) : chartData.length === 0 ? (
          <EmptyState
            title="Nothing to plot yet"
            description="Select a business unit and account above. The chart draws the recorded actuals, and adds the forecast with its confidence band once you run one."
          />
        ) : (
          <AccessibleChart
            className="h-80"
            title="Actuals and forecast by period"
            summary={`Recorded actuals followed by the forecast, with its confidence band where one was produced. ${chartData.filter((r) => r.actual !== null).length} periods of history and ${chartData.filter((r) => r.forecast !== null).length} forecast periods.`}
            columns={['Period', 'Actual', 'Forecast', 'Band low', 'Band high']}
            rows={chartData.map((row) => [
              row.periodKey,
              row.actual === null ? '—' : money0(String(row.actual)),
              row.forecast === null ? '—' : money0(String(row.forecast)),
              row.band === null ? '—' : money0(String(row.band[0])),
              row.band === null ? '—' : money0(String(row.band[1])),
            ])}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="periodKey"
                  tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                  stroke="var(--chart-grid)"
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                  stroke="var(--chart-grid)"
                  width={72}
                  tickFormatter={(value: number) =>
                    new Intl.NumberFormat('en-US', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(value)
                  }
                />
                <Tooltip content={<ChartTooltip currency={currency} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area
                  type="monotone"
                  dataKey="band"
                  name="Prediction interval"
                  stroke="none"
                  fill="var(--series-band)"
                  fillOpacity={0.25}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  name="Actual"
                  stroke="var(--series-1)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="forecast"
                  name="Forecast"
                  stroke="var(--series-2)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </AccessibleChart>
        )}
      </Card>

      {result ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card
            title="Forecast values"
            subtitle="Point forecast with its interval, per period"
            bodyClassName="p-0"
          >
            <div className="max-h-96 overflow-y-auto">
              <table className="data-table">
                <caption className="sr-only">
                  Forecast point values and prediction interval by period
                </caption>
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col" className="num">
                      Lower
                    </th>
                    <th scope="col" className="num">
                      Forecast
                    </th>
                    <th scope="col" className="num">
                      Upper
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.periodKeys.map((periodKey, index) => (
                    <tr key={periodKey}>
                      <td className="font-mono text-2xs">{periodKey}</td>
                      <td className="num">
                        {result.interval ? money0(result.interval.lower[index], currency) : '—'}
                      </td>
                      <td className="num font-medium">{money0(result.point[index], currency)}</td>
                      <td className="num">
                        {result.interval ? money0(result.interval.upper[index], currency) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="Backtest candidates"
            subtitle={
              result.candidates
                ? `Every method evaluated by rolling-origin backtesting, best first, ranked on ${result.selectionCriterion ?? 'MASE'}`
                : 'Only produced when the method is AUTO'
            }
            bodyClassName="p-0"
          >
            {!result.candidates || result.candidates.length === 0 ? (
              <EmptyState
                title="No candidate table"
                description="You chose a specific method, so nothing was backtested against it. Re-run with AUTO to see how the alternatives would have performed."
              />
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <table className="data-table">
                  <caption className="sr-only">
                    Backtest scores for every candidate forecasting method
                  </caption>
                  <thead className="sticky top-0 bg-white dark:bg-slate-900">
                    <tr>
                      <th scope="col">Method</th>
                      <th scope="col" className="num">
                        Score
                      </th>
                      <th scope="col" className="num">
                        MASE
                      </th>
                      <th scope="col" className="num">
                        RMSE
                      </th>
                      <th scope="col" className="num">
                        Folds
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((candidate) => {
                      const selected = candidate.method === result.method;
                      return (
                        <tr
                          key={candidate.method}
                          className={selected ? 'bg-accent-50 dark:bg-accent-900/20' : undefined}
                        >
                          <td>
                            {FORECAST_METHOD_LABELS[candidate.method]}
                            {selected ? (
                              <span className="ml-2 pill bg-accent-100 text-accent-800 dark:bg-accent-900/50 dark:text-accent-200">
                                Selected
                              </span>
                            ) : null}
                            {candidate.error ? (
                              <div className="text-2xs text-slate-600 dark:text-slate-400">
                                {candidate.error}
                              </div>
                            ) : null}
                          </td>
                          <td className="num">{decimal(candidate.score)}</td>
                          <td className="num">{decimal(candidate.accuracy.mase)}</td>
                          <td className="num">{decimal(candidate.accuracy.rmse, 0)}</td>
                          <td className="num">{integer(candidate.foldCount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Fitted parameters" subtitle="What the engine settled on for this run">
            {Object.keys(result.parameters).length === 0 ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                This method has no fitted parameters.
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(result.parameters).map(([key, value]) => (
                  <div
                    key={key}
                    className="rounded border border-slate-200 px-2.5 py-1.5 dark:border-slate-800"
                  >
                    <dt className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                      {humanise(key)}
                    </dt>
                    <dd className="text-xs font-medium tabular-nums">{decimal(value, 4)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card title="Fit diagnostics" subtitle="In-sample quality over the fitted window">
            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-600 dark:text-slate-400">Observations</dt>
                <dd className="tabular-nums font-medium">{integer(result.accuracy.n)}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-400">MAE</dt>
                <dd className="tabular-nums font-medium">
                  {money0(String(result.accuracy.mae), currency)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-400">sMAPE</dt>
                <dd className="tabular-nums font-medium">{percent(result.accuracy.smape)}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-400">R²</dt>
                <dd className="tabular-nums font-medium">{decimal(result.accuracy.rSquared)}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-400">Run id</dt>
                <dd className="font-mono text-2xs">{result.id}</dd>
              </div>
            </dl>
          </Card>
        </div>
      ) : null}
    </>
  );
}
