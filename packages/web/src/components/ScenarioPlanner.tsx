/**
 * Driver-based scenario planning: the "what if" screen.
 *
 * `revenue = subscribers x ARPU; what if subscribers grow 2% instead of 5%?`
 * is the most common question in corporate planning, and until this existed the
 * platform could answer it and could not be asked. The engine's
 * `compareScenarios`, the `POST /forecasts/scenarios/compare` endpoint and the
 * seeded `drivers` table were all in place; nothing in the interface led to any
 * of them.
 *
 * Scenarios are a **calculator, not a record**. The engine is deterministic, so
 * the same drivers and adjustments always give the same answer - the inputs are
 * the record and the result is re-derivable. Nothing is persisted. See the note
 * on the `Scenario` model in schema.prisma for the one case that would change
 * that: a scenario cited in something governed.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingCard,
  NumberField,
  StatTile,
  TextField,
} from '@/components/ui';
import { getData, postData } from '@/lib/api';
import { money0, percent } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type { DriverDefinition, ScenarioComparison } from '@/types/api';

/**
 * A case as the planner holds it while being edited.
 *
 * `factor` is a multiplier on every selected driver's volume: 0.9 is a 10%
 * downside. Kept as a percentage in the UI because nobody thinks in multipliers,
 * and converted on the way out.
 */
interface CaseDraft {
  id: string;
  name: string;
  type: 'BASE' | 'BEST' | 'WORST' | 'STRETCH' | 'CUSTOM';
  volumePercent: number;
  probabilityPercent: number;
}

const INITIAL_CASES: CaseDraft[] = [
  { id: 'base', name: 'Base', type: 'BASE', volumePercent: 100, probabilityPercent: 50 },
  { id: 'downside', name: 'Downside', type: 'WORST', volumePercent: 90, probabilityPercent: 30 },
  { id: 'upside', name: 'Upside', type: 'BEST', volumePercent: 108, probabilityPercent: 20 },
];

export default function ScenarioPlanner() {
  const canRun = useHasPermission()('forecast:run');
  const [selected, setSelected] = useState<string[]>([]);
  const [cases, setCases] = useState<CaseDraft[]>(INITIAL_CASES);

  const drivers = useQuery({
    queryKey: ['forecast-drivers'],
    queryFn: ({ signal }) => getData<DriverDefinition[]>('/forecasts/drivers', undefined, signal),
  });

  // Everything is selected on arrival: the useful default is "the whole plan",
  // and deselecting is easier than hunting for what to include.
  const chosen = useMemo(() => {
    const all = drivers.data ?? [];
    return selected.length > 0 ? all.filter((d) => selected.includes(d.code)) : all;
  }, [drivers.data, selected]);

  const probabilityTotal = cases.reduce((acc, c) => acc + c.probabilityPercent, 0);

  const compare = useMutation({
    mutationFn: () =>
      postData<ScenarioComparison>('/forecasts/scenarios/compare', {
        drivers: chosen.map((d) => ({
          code: d.code,
          name: d.name,
          unit: d.unit,
          volumes: d.volumes,
          unitRate: d.unitRate,
          ...(d.growthRate ? { growthRate: d.growthRate } : {}),
        })),
        scenarios: cases.map((c) => ({
          name: c.name,
          type: c.type,
          probability: c.probabilityPercent / 100,
          // An empty adjustment list means "the base case unchanged", which is
          // what a 100% volume case is.
          adjustments:
            c.volumePercent === 100
              ? []
              : chosen.map((d) => ({
                  targetCode: d.code,
                  factor: (c.volumePercent / 100).toFixed(6),
                })),
        })),
      }),
  });

  function updateCase(id: string, patch: Partial<CaseDraft>) {
    setCases((current) => current.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  if (drivers.isPending) return <LoadingCard />;
  if (drivers.isError) {
    return <ErrorState error={drivers.error} onRetry={() => void drivers.refetch()} />;
  }
  if ((drivers.data ?? []).length === 0) {
    return (
      <EmptyState
        title="No drivers defined"
        description="A scenario varies a volume driver — subscribers, sites, homes passed — and multiplies it by a rate. Someone needs to define at least one before cases can be compared."
      />
    );
  }

  const result = compare.data;

  return (
    <>
      <Card className="mb-4" title="Drivers" subtitle="The volumes each case varies.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(drivers.data ?? []).map((driver) => {
            const isOn = selected.length === 0 || selected.includes(driver.code);
            return (
              <label
                key={driver.code}
                className="flex items-start gap-2 rounded-md border border-slate-200 p-2 text-sm dark:border-slate-700"
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => {
                    const all = (drivers.data ?? []).map((d) => d.code);
                    const current = selected.length === 0 ? all : selected;
                    setSelected(
                      current.includes(driver.code)
                        ? current.filter((c) => c !== driver.code)
                        : [...current, driver.code],
                    );
                  }}
                />
                <span>
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {driver.name}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {driver.code} · {driver.unit}
                    {driver.businessUnit ? ` · ${driver.businessUnit.code}` : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Card>

      <Card
        className="mb-4"
        title="Cases"
        subtitle="Volume as a percentage of plan, and how likely each case is."
      >
        <div className="space-y-3">
          {cases.map((c) => (
            <div key={c.id} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <TextField
                id={`case-name-${c.id}`}
                label="Case"
                value={c.name}
                onChange={(value) => updateCase(c.id, { name: value })}
              />
              <NumberField
                id={`case-volume-${c.id}`}
                label="Volume (% of plan)"
                value={c.volumePercent}
                onChange={(value) => updateCase(c.id, { volumePercent: value })}
              />
              <NumberField
                id={`case-prob-${c.id}`}
                label="Likelihood (%)"
                value={c.probabilityPercent}
                onChange={(value) => updateCase(c.id, { probabilityPercent: value })}
              />
            </div>
          ))}
        </div>

        {/*
          The API returns probabilityCoverage so a gap is visible rather than
          silently folded into the weighted figure. Saying so before the run is
          more useful than explaining it afterwards.
        */}
        {probabilityTotal !== 100 ? (
          <div className="mt-3">
            <InlineNote>
              Likelihoods total {probabilityTotal}%, not 100%. The weighted case is still
              calculated, but it is weighted over what you supplied — treat it as covering{' '}
              {probabilityTotal}% of the outcomes you have described.
            </InlineNote>
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun || compare.isPending || chosen.length === 0}
            onClick={() => compare.mutate()}
          >
            {compare.isPending ? 'Comparing…' : 'Compare cases'}
          </button>
          {!canRun ? (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              Comparing cases requires <code>forecast:run</code>.
            </span>
          ) : null}
        </div>

        {compare.isError ? (
          <div className="mt-3">
            <ErrorState error={compare.error} />
          </div>
        ) : null}
      </Card>

      {result ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Base case"
              value={money0(result.base.grandTotal)}
              caption={`${chosen.length} driver(s)`}
            />
            <StatTile
              label="Probability-weighted"
              value={result.expectedValue === null ? '—' : money0(result.expectedValue)}
              caption={
                result.expectedValue === null
                  ? 'Needs a likelihood on every case'
                  : `Covering ${percent(result.probabilityCoverage, { fractionDigits: 0 })} of outcomes`
              }
            />
          </div>

          <Card title="Cases compared" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption>
                  Each case applies its volume percentage to every selected driver, then re-prices
                  it. Nothing here is saved — the same inputs always give the same answer.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col" className="num">
                      vs base
                    </th>
                    <th scope="col" className="num">
                      Change
                    </th>
                    <th scope="col" className="num">
                      Likelihood
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.scenarios.map((scenario) => (
                    <tr key={scenario.name}>
                      <td className="font-medium text-slate-800 dark:text-slate-100">
                        {scenario.name}
                      </td>
                      <td className="num">{money0(scenario.grandTotal)}</td>
                      <td className="num">{money0(scenario.deltaFromBase)}</td>
                      <td className="num">
                        {scenario.deltaPercent === null
                          ? '—'
                          : percent(scenario.deltaPercent, { fractionDigits: 1 })}
                      </td>
                      <td className="num">
                        {scenario.probability === null
                          ? '—'
                          : percent(scenario.probability, { fractionDigits: 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}
