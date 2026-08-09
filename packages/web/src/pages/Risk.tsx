import {
  DISTRIBUTIONS,
  RISK_SEVERITIES,
  type DistributionType,
  type RiskSeverity,
} from '@ffp/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingCard,
  NumberField,
  PageHeader,
  SelectField,
  SeverityPill,
  StatTile,
  StatusPill,
  TextField,
} from '@/components/ui';
import { getData, postData } from '@/lib/api';
import {
  IMPACT_LABELS,
  PROBABILITY_LABELS,
  SEVERITY_CLASSES,
  chartValue,
  decimal,
  humanise,
  integer,
  money,
  money0,
  percent,
  severityFor,
} from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type { MonteCarloResult, RiskRegister } from '@/types/api';

interface UncertainInputDraft {
  code: string;
  label: string;
  distribution: DistributionType;
  min: number;
  mode: number;
  max: number;
}

const INITIAL_INPUTS: UncertainInputDraft[] = [
  {
    code: 'ENERGY',
    label: 'Energy and site power',
    distribution: 'PERT',
    min: -2_000_000,
    mode: 1_500_000,
    max: 8_500_000,
  },
  {
    code: 'LABOUR',
    label: 'Salary inflation above assumption',
    distribution: 'TRIANGULAR',
    min: -1_000_000,
    mode: 900_000,
    max: 4_200_000,
  },
  {
    code: 'VENDOR',
    label: 'Vendor price movement',
    distribution: 'PERT',
    min: -3_000_000,
    mode: 0,
    max: 6_000_000,
  },
];

/** Heat map cell shading. Uses the severity palette, the same one the pills use. */
function HeatMap({ heatMap }: { heatMap: number[][] }) {
  const impacts = [5, 4, 3, 2, 1];
  const probabilities = [1, 2, 3, 4, 5];

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="px-1 py-2 text-left text-xs text-slate-500 dark:text-slate-400">
          Count of risks at each probability and impact combination. Each cell states its severity
          band in text as well as colour.
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="p-1 text-left text-2xs font-semibold text-slate-500 dark:text-slate-400"
            >
              Impact ↓ / Probability →
            </th>
            {probabilities.map((probability) => (
              <th
                key={probability}
                scope="col"
                className="p-1 text-center text-2xs font-semibold text-slate-600 dark:text-slate-300"
              >
                {probability}
                <span className="block font-normal text-slate-500 dark:text-slate-400">
                  {PROBABILITY_LABELS[probability]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {impacts.map((impact) => (
            <tr key={impact}>
              <th
                scope="row"
                className="p-1 text-left text-2xs font-semibold text-slate-600 dark:text-slate-300"
              >
                {impact}
                <span className="block font-normal text-slate-500 dark:text-slate-400">
                  {IMPACT_LABELS[impact]}
                </span>
              </th>
              {probabilities.map((probability) => {
                const count = heatMap[impact - 1]?.[probability - 1] ?? 0;
                const severity = severityFor(impact * probability);
                return (
                  <td key={probability} className="p-0.5">
                    <div
                      className={`flex h-14 flex-col items-center justify-center rounded ${SEVERITY_CLASSES[severity]} ${
                        count === 0 ? 'opacity-40' : ''
                      }`}
                    >
                      <span className="text-sm font-semibold tabular-nums">{count}</span>
                      <span className="text-[10px] uppercase tracking-wide">
                        {humanise(severity)}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonteCarloPanel({ canSimulate }: { canSimulate: boolean }) {
  const [baseValue, setBaseValue] = useState('402000000');
  const [iterations, setIterations] = useState(10000);
  const [seed, setSeed] = useState(20260101);
  const [inputs, setInputs] = useState<UncertainInputDraft[]>(INITIAL_INPUTS);

  const simulate = useMutation({
    mutationFn: () =>
      postData<MonteCarloResult>('/risk/simulate', {
        name: 'Cost uncertainty simulation',
        iterations,
        seed,
        baseValue,
        inputs: inputs.map((input) => ({
          code: input.code,
          label: input.label,
          distribution: input.distribution,
          min: input.min,
          mode: input.mode,
          max: input.max,
        })),
        confidenceLevels: [0.1, 0.5, 0.8, 0.9, 0.95],
      }),
  });

  const result = simulate.data;

  const histogram =
    result?.histogram.map((bucket) => ({
      label: money0(bucket.lowerBound),
      lower: chartValue(bucket.lowerBound),
      count: bucket.count,
    })) ?? [];

  const tornado =
    result?.sensitivity
      .slice()
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
      .map((row) => ({
        label: row.label,
        correlation: row.correlation,
        contribution: row.contribution,
      })) ?? [];

  const percentileValue = (level: number) =>
    result?.percentiles.find((entry) => Math.abs(entry.level - level) < 1e-9)?.value ?? null;

  return (
    <Card
      title="Monte Carlo simulation"
      subtitle="Every run is driven by an explicit seed and reports it back, so a contingency figure quoted to a board can be regenerated on demand."
    >
      {!canSimulate ? (
        <InlineNote>
          Running a simulation requires the risk:simulate permission. Your role can read published
          results but not produce new ones.
        </InlineNote>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          id="mc-base"
          label="Base estimate"
          value={baseValue}
          onChange={setBaseValue}
          inputClassName="input num"
          hint="Deterministic estimate the uncertainties are added to"
        />
        <NumberField
          id="mc-iterations"
          label="Iterations"
          value={iterations}
          onChange={setIterations}
          min={1000}
          max={200000}
          step={1000}
        />
        <NumberField
          id="mc-seed"
          label="Seed"
          value={seed}
          onChange={setSeed}
          min={0}
          hint="Fixed for reproducibility"
        />
        <div className="flex items-end pb-1">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSimulate || simulate.isPending}
            onClick={() => simulate.mutate()}
          >
            {simulate.isPending ? 'Simulating…' : 'Run simulation'}
          </button>
        </div>
      </div>

      <h3 className="mb-2 mt-5 text-xs font-semibold">Uncertain inputs</h3>
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption className="sr-only">Distributions sampled during the simulation</caption>
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">Distribution</th>
              <th scope="col" className="num">
                Minimum
              </th>
              <th scope="col" className="num">
                Most likely
              </th>
              <th scope="col" className="num">
                Maximum
              </th>
            </tr>
          </thead>
          <tbody>
            {inputs.map((input, index) => (
              <tr key={input.code}>
                <td>
                  <label className="sr-only" htmlFor={`mc-label-${input.code}`}>
                    Label for input {input.code}
                  </label>
                  <input
                    id={`mc-label-${input.code}`}
                    className="input"
                    value={input.label}
                    onChange={(event) =>
                      setInputs((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, label: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <label className="sr-only" htmlFor={`mc-dist-${input.code}`}>
                    Distribution for {input.label}
                  </label>
                  <select
                    id={`mc-dist-${input.code}`}
                    className="input"
                    value={input.distribution}
                    onChange={(event) =>
                      setInputs((current) =>
                        current.map((item, i) =>
                          i === index
                            ? { ...item, distribution: event.target.value as DistributionType }
                            : item,
                        ),
                      )
                    }
                  >
                    {DISTRIBUTIONS.filter(
                      (value) =>
                        value !== 'DISCRETE' && value !== 'NORMAL' && value !== 'LOGNORMAL',
                    ).map((value) => (
                      <option key={value} value={value}>
                        {humanise(value)}
                      </option>
                    ))}
                  </select>
                </td>
                {(['min', 'mode', 'max'] as const).map((key) => (
                  <td key={key}>
                    <label className="sr-only" htmlFor={`mc-${key}-${input.code}`}>
                      {key} for {input.label}
                    </label>
                    <input
                      id={`mc-${key}-${input.code}`}
                      type="number"
                      className="input num w-32"
                      value={input[key]}
                      onChange={(event) =>
                        setInputs((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, [key]: Number(event.target.value) } : item,
                          ),
                        )
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {simulate.isError ? (
        <div className="mt-3">
          <ErrorState error={simulate.error} />
        </div>
      ) : null}

      {result ? (
        <>
          {result.warnings.length > 0 ? (
            <div className="mt-4">
              <InlineNote tone="warning">
                <ul className="list-disc space-y-1 pl-4">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </InlineNote>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="P10"
              value={money0(percentileValue(0.1))}
              caption="Optimistic outcome"
            />
            <StatTile
              label="P50 (median)"
              value={money0(percentileValue(0.5))}
              caption="As likely over as under"
            />
            <StatTile
              label="P80"
              value={money0(percentileValue(0.8))}
              caption="Conventional funding level"
              tone="accent"
            />
            <StatTile
              label="P90"
              value={money0(percentileValue(0.9))}
              caption="Conservative outcome"
            />
            <StatTile
              label="Contingency"
              value={money0(result.contingency)}
              caption="P80 less the deterministic estimate"
              tone="accent"
            />
            <StatTile
              label="Underrun probability"
              value={percent(result.probabilityOfUnderrun)}
              caption={`${integer(result.iterations)} iterations, seed ${result.seed}`}
            />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold">Outcome distribution</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={histogram} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                    <CartesianGrid
                      stroke="var(--chart-grid)"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="lower"
                      tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                      stroke="var(--chart-grid)"
                      tickFormatter={(value: number) =>
                        new Intl.NumberFormat('en-US', {
                          notation: 'compact',
                          maximumFractionDigits: 1,
                        }).format(value)
                      }
                      minTickGap={28}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                      stroke="var(--chart-grid)"
                      width={48}
                      label={{
                        value: 'Iterations',
                        angle: -90,
                        position: 'insideLeft',
                        style: { fontSize: 10, fill: 'var(--chart-axis)' },
                      }}
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--chart-grid)', fillOpacity: 0.3 }}
                      contentStyle={{ fontSize: 11 }}
                      formatter={(value) =>
                        [integer(Number(value)), 'Iterations'] as [string, string]
                      }
                      labelFormatter={(value) => `From ${money0(String(value))}`}
                    />
                    <Bar
                      dataKey="count"
                      fill="var(--series-1)"
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-2xs text-slate-500 dark:text-slate-400">
                Mean {money0(result.mean)} · standard deviation {money0(result.standardDeviation)} ·
                range {money0(result.min)} to {money0(result.max)}.
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold">Sensitivity (tornado)</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={tornado}
                    layout="vertical"
                    margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid
                      stroke="var(--chart-grid)"
                      strokeDasharray="3 3"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      domain={[-1, 1]}
                      ticks={[-1, -0.5, 0, 0.5, 1]}
                      tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                      stroke="var(--chart-grid)"
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={150}
                      tick={{ fontSize: 10, fill: 'var(--chart-axis)' }}
                      stroke="var(--chart-grid)"
                    />
                    <ReferenceLine x={0} stroke="var(--chart-axis)" />
                    <Tooltip
                      cursor={{ fill: 'var(--chart-grid)', fillOpacity: 0.3 }}
                      contentStyle={{ fontSize: 11 }}
                      formatter={(value) =>
                        [decimal(Number(value)), 'Rank correlation'] as [string, string]
                      }
                    />
                    <Bar dataKey="correlation" radius={[2, 2, 2, 2]} isAnimationActive={false}>
                      {tornado.map((row) => (
                        <Cell
                          key={row.label}
                          fill={row.correlation >= 0 ? 'var(--series-1)' : 'var(--series-2)'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="data-table mt-2">
                <caption className="sr-only">
                  Spearman rank correlation of each input against the outcome
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Input</th>
                    <th scope="col" className="num">
                      Correlation
                    </th>
                    <th scope="col" className="num">
                      Contribution
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tornado.map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td className="num">{decimal(row.correlation)}</td>
                      <td className="num">{percent(row.contribution)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-4">
          <EmptyState
            title="No simulation run yet"
            description="Set the base estimate and the uncertainties above, then run. The distribution, the confidence percentiles and the contingency they imply appear here."
          />
        </div>
      )}
    </Card>
  );
}

export default function Risk() {
  const has = useHasPermission();
  const [statusFilter, setStatusFilter] = useState('');

  const register = useQuery({
    queryKey: ['risk-register', statusFilter],
    queryFn: ({ signal }) =>
      getData<RiskRegister>('/risk/register', { status: statusFilter || undefined }, signal),
  });

  return (
    <>
      <PageHeader
        title="Risk"
        description="The register, scored on the standard 5×5 matrix, plus what a heat map alone never tells you: the expected monetary value of each risk and how much exposure mitigation actually removes."
      />

      {register.isError ? (
        <div className="mb-4">
          <ErrorState error={register.error} onRetry={() => void register.refetch()} />
        </div>
      ) : null}

      {register.isPending ? (
        <LoadingCard rows={8} label="Loading the risk register" />
      ) : register.data ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Inherent exposure"
              value={money0(register.data.totalInherentExposure)}
              caption="Probability-weighted, before mitigation"
            />
            <StatTile
              label="Residual exposure"
              value={money0(register.data.totalResidualExposure)}
              caption="After the mitigation plans in place"
            />
            <StatTile
              label="Mitigation benefit"
              value={money0(register.data.totalMitigationBenefit)}
              caption="Exposure the plans remove"
              tone="accent"
            />
            <StatTile
              label="Escalations"
              value={integer(register.data.escalations.length)}
              caption="Severe or critical, still open"
            />
          </div>

          <div className="mb-4 grid gap-4 xl:grid-cols-2">
            <Card title="Heat map" subtitle="Rows are impact, columns are probability">
              <HeatMap heatMap={register.data.heatMap} />
            </Card>

            <Card
              title="Escalations"
              subtitle="Severe and critical risks that need a decision"
              bodyClassName="p-0"
            >
              {register.data.escalations.length === 0 ? (
                <EmptyState
                  title="Nothing at escalation level"
                  description="No open risk is scored severe or critical. That is the desired state — check the register below if you expected otherwise."
                />
              ) : (
                <div className="max-h-[26rem] overflow-y-auto">
                  <table className="data-table">
                    <caption className="sr-only">Risks at severe or critical severity</caption>
                    <thead className="sticky top-0 bg-white dark:bg-slate-900">
                      <tr>
                        <th scope="col">Risk</th>
                        <th scope="col">Severity</th>
                        <th scope="col" className="num">
                          Expected value
                        </th>
                        <th scope="col">Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.data.escalations.map((risk) => (
                        <tr key={risk.id}>
                          <td className="font-medium text-slate-800 dark:text-slate-100">
                            {risk.title}
                          </td>
                          <td>
                            <SeverityPill severity={risk.inherentSeverity} />
                          </td>
                          <td className="num">{money0(risk.expectedValue)}</td>
                          <td>{humanise(risk.response)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <Card
            className="mb-4"
            title="Risk register"
            subtitle={`${integer(register.data.risks.length)} risk(s)`}
            actions={
              <div className="w-52">
                <SelectField
                  id="risk-status"
                  label="Status"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: '', label: 'All statuses' },
                    { value: 'OPEN', label: 'Open' },
                    { value: 'MONITORING', label: 'Monitoring' },
                    { value: 'MITIGATED', label: 'Mitigated' },
                    { value: 'REALISED', label: 'Realised' },
                    { value: 'CLOSED', label: 'Closed' },
                  ]}
                />
              </div>
            }
            bodyClassName="p-0"
          >
            {register.data.risks.length === 0 ? (
              <EmptyState
                title="No risks recorded"
                description="Nothing has been logged against this filter. Widen the status filter, or ask an analyst to log the risks the budget assumes away."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption>
                    Inherent and residual scoring for every risk. Expected value is the probability
                    band applied to the financial impact, not the impact itself.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Risk</th>
                      <th scope="col">Category</th>
                      <th scope="col" className="num">
                        P
                      </th>
                      <th scope="col" className="num">
                        I
                      </th>
                      <th scope="col">Inherent severity</th>
                      <th scope="col">Residual severity</th>
                      <th scope="col" className="num">
                        Financial impact
                      </th>
                      <th scope="col" className="num">
                        Expected value
                      </th>
                      <th scope="col">Response</th>
                      <th scope="col">Status</th>
                      <th scope="col">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.data.risks.map((risk) => (
                      <tr key={risk.id}>
                        <td className="min-w-[16rem] font-medium text-slate-800 dark:text-slate-100">
                          {risk.title}
                        </td>
                        <td>{humanise(risk.category)}</td>
                        <td className="num">{risk.probability}</td>
                        <td className="num">{risk.impact}</td>
                        <td>
                          <SeverityPill severity={risk.inherentSeverity} />
                        </td>
                        <td>
                          {risk.residualSeverity ? (
                            <SeverityPill severity={risk.residualSeverity} />
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">Not assessed</span>
                          )}
                        </td>
                        <td className="num">{money(risk.financialImpact)}</td>
                        <td className="num font-medium">{money(risk.expectedValue)}</td>
                        <td>{humanise(risk.response)}</td>
                        <td>
                          <StatusPill status={risk.status} />
                        </td>
                        <td>
                          {risk.owner ? `${risk.owner.firstName} ${risk.owner.lastName}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="mb-4" title="Exposure by category" bodyClassName="p-0">
            <table className="data-table">
              <caption className="sr-only">Risk count and exposure by category</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="num">
                    Risks
                  </th>
                  <th scope="col" className="num">
                    Inherent exposure
                  </th>
                </tr>
              </thead>
              <tbody>
                {register.data.byCategory.map((row) => (
                  <tr key={row.category}>
                    <td>{humanise(row.category)}</td>
                    <td className="num">{integer(row.count)}</td>
                    <td className="num">{money0(row.exposure)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <th scope="row" className="text-left">
                    By severity band
                  </th>
                  <td colSpan={2}>
                    <div className="flex flex-wrap gap-2">
                      {RISK_SEVERITIES.map((severity: RiskSeverity) => (
                        <span key={severity} className="inline-flex items-center gap-1">
                          <SeverityPill severity={severity} />
                          <span className="tabular-nums">
                            {integer(register.data.severityCounts[severity] ?? 0)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </>
      ) : null}

      <MonteCarloPanel canSimulate={has('risk:simulate')} />
    </>
  );
}
