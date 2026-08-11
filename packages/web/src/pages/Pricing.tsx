import {
  BURDEN_POOL_LABELS,
  CONTRACT_TYPES,
  COST_CATEGORIES,
  type BurdenPool,
  type ContractType,
  type CostCategory,
} from '@ffp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  NumberField,
  PageHeader,
  SelectField,
  StatTile,
  StatusPill,
  Tabs,
  TabPanel,
  TextField,
} from '@/components/ui';
import { getData, postData } from '@/lib/api';
import { decimal, formatDate, humanise, integer, money, money0, percent } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type {
  PriceToWinResult,
  PricingApprovalResult,
  PricingResult,
  PursuitListItem,
} from '@/types/api';

interface LabourDraft {
  labourCategory: string;
  hoursByYear: number[];
  baseRate: string;
  escalationRate: string;
}

interface DirectCostDraft {
  description: string;
  category: CostCategory;
  amountYear1: string;
  escalationRate: string;
  isPassThrough: boolean;
}

interface BurdenDraft {
  pool: BurdenPool;
  rate: string;
  enabled: boolean;
}

interface ModelDraft {
  name: string;
  contractType: ContractType;
  years: number;
  feeRate: string;
  discountRate: string;
  costOfCapital: string;
  labour: LabourDraft[];
  directCosts: DirectCostDraft[];
  burdens: BurdenDraft[];
}

/** Starting point mirrors the seeded managed-service bid, so the page is useful immediately. */
const INITIAL_MODEL: ModelDraft = {
  name: 'National Grid Framework — working estimate',
  contractType: 'MANAGED_SERVICE',
  years: 5,
  feeRate: '0.115',
  discountRate: '0.02',
  costOfCapital: '0.098',
  labour: [
    {
      labourCategory: 'Network Engineer',
      hoursByYear: [18720, 18720, 17680, 17680, 17680],
      baseRate: '68.50',
      escalationRate: '0.055',
    },
    {
      labourCategory: 'Field Technician',
      hoursByYear: [37440, 37440, 35360, 35360, 35360],
      baseRate: '41.20',
      escalationRate: '0.055',
    },
    {
      labourCategory: 'Service Desk Analyst',
      hoursByYear: [12480, 12480, 12480, 12480, 12480],
      baseRate: '28.75',
      escalationRate: '0.048',
    },
    {
      labourCategory: 'Programme Manager',
      hoursByYear: [2080, 2080, 2080, 2080, 2080],
      baseRate: '95.00',
      escalationRate: '0.05',
    },
  ],
  directCosts: [
    {
      description: 'Edge routers and CPE',
      category: 'EQUIPMENT',
      amountYear1: '4200000',
      escalationRate: '0.02',
      isPassThrough: false,
    },
    {
      description: 'Backhaul circuit lease',
      category: 'SUBCONTRACT',
      amountYear1: '2880000',
      escalationRate: '0.038',
      isPassThrough: false,
    },
    {
      description: 'Site power and cooling',
      category: 'FACILITIES',
      amountYear1: '1150000',
      escalationRate: '0.092',
      isPassThrough: false,
    },
    {
      description: 'Client-directed spectrum fees',
      category: 'OTHER_DIRECT',
      amountYear1: '640000',
      escalationRate: '0.03',
      isPassThrough: true,
    },
  ],
  burdens: [
    { pool: 'FRINGE', rate: '0.3150', enabled: true },
    { pool: 'OVERHEAD', rate: '0.2280', enabled: true },
    { pool: 'MATERIAL_HANDLING', rate: '0.0450', enabled: false },
    { pool: 'GA', rate: '0.0940', enabled: true },
    { pool: 'COM', rate: '0.0080', enabled: false },
  ],
};

function toRequestBody(draft: ModelDraft) {
  return {
    name: draft.name,
    contractType: draft.contractType,
    currency: 'USD',
    years: draft.years,
    labour: draft.labour.map((line) => ({
      labourCategory: line.labourCategory,
      hoursByYear: line.hoursByYear.slice(0, draft.years),
      baseRate: line.baseRate,
      escalationRate: line.escalationRate,
    })),
    directCosts: draft.directCosts.map((line) => ({
      description: line.description,
      category: line.category,
      // A single year-one amount with an escalation rate: the engine repeats and
      // compounds it, which is how these are quoted in practice.
      amountByYear: [line.amountYear1],
      escalationRate: line.escalationRate,
      isPassThrough: line.isPassThrough,
    })),
    burdens: draft.burdens
      .filter((burden) => burden.enabled)
      .map((burden) => ({ pool: burden.pool, ratesByYear: [burden.rate], appliesTo: [] })),
    feeRate: draft.feeRate,
    discountRate: draft.discountRate,
    costOfCapital: draft.costOfCapital,
    assumptions: [],
  };
}

function CostVolumeTable({ result }: { result: PricingResult }) {
  const currency = result.currency;
  const pools = Array.from(
    new Set(result.years.flatMap((year) => year.burdens.map((burden) => burden.pool))),
  ) as BurdenPool[];

  const poolTotal = (pool: BurdenPool) =>
    result.byBurdenPool.find((row) => row.key === pool || row.label === BURDEN_POOL_LABELS[pool])
      ?.amount ?? null;

  const row = (
    label: string,
    pick: (year: PricingResult['years'][number]) => string,
    total: string,
    options: { bold?: boolean; indent?: boolean; sub?: string } = {},
  ) => (
    <tr key={label} className={options.bold ? 'font-semibold' : undefined}>
      <th scope="row" className={`text-left font-normal ${options.bold ? 'font-semibold' : ''}`}>
        <span className={options.indent ? 'pl-4' : ''}>{label}</span>
        {options.sub ? (
          <span className="block pl-4 text-2xs font-normal text-slate-600 dark:text-slate-400">
            {options.sub}
          </span>
        ) : null}
      </th>
      {result.years.map((year) => (
        <td key={year.year} className="num">
          {money0(pick(year), currency)}
        </td>
      ))}
      <td className="num border-l border-slate-200 dark:border-slate-700">
        {money0(total, currency)}
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <caption>
          Multi-year cost volume in {currency}. Burden pools are applied in order, each on the base
          shown beneath it — the order and the base are what a price review actually checks.
        </caption>
        <thead>
          <tr>
            <th scope="col">Cost element</th>
            {result.years.map((year) => (
              <th key={year.year} scope="col" className="num">
                Year {year.year}
              </th>
            ))}
            <th scope="col" className="num border-l border-slate-200 dark:border-slate-700">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="text-left font-normal">
              Labour hours
            </th>
            {result.years.map((year) => (
              <td key={year.year} className="num">
                {integer(year.labourHours)}
              </td>
            ))}
            <td className="num border-l border-slate-200 dark:border-slate-700">
              {integer(result.totals.labourHours)}
            </td>
          </tr>
          {row('Direct labour', (year) => year.directLabour, result.totals.directLabour)}
          {row('Material', (year) => year.material, result.totals.material)}
          {row('Subcontract', (year) => year.subcontract, result.totals.subcontract)}
          {row('Other direct', (year) => year.otherDirect, result.totals.otherDirect)}
          {row(
            'Pass-through (no burden, no fee)',
            (year) => year.passThrough,
            result.totals.passThrough,
          )}
          {row('Total direct cost', (year) => year.totalDirect, result.totals.totalDirect, {
            bold: true,
          })}

          {pools.map((pool) => {
            const first = result.years[0]?.burdens.find((burden) => burden.pool === pool);
            const total = poolTotal(pool);
            return (
              <tr key={pool}>
                <th scope="row" className="text-left font-normal">
                  <span className="pl-4">{BURDEN_POOL_LABELS[pool]}</span>
                  <span className="block pl-4 text-2xs text-slate-600 dark:text-slate-400">
                    {first
                      ? `${percent(first.rate, { fractionDigits: 2 })} on ${first.baseElements
                          .map((element) => humanise(element))
                          .join(' + ')}`
                      : ''}
                  </span>
                </th>
                {result.years.map((year) => {
                  const applied = year.burdens.find((burden) => burden.pool === pool);
                  return (
                    <td key={year.year} className="num">
                      {applied ? money0(applied.amount, currency) : '—'}
                      {applied ? (
                        <span className="block text-2xs text-slate-600 dark:text-slate-400">
                          base {money0(applied.base, currency)}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="num border-l border-slate-200 dark:border-slate-700">
                  {total === null ? '—' : money0(total, currency)}
                </td>
              </tr>
            );
          })}

          {row('Total indirect (burden)', (year) => year.totalBurden, result.totals.totalBurden, {
            bold: true,
          })}
          {row('Total cost', (year) => year.totalCost, result.totals.totalCost, { bold: true })}
          {row('Fee', (year) => year.fee, result.totals.fee)}
          {row('Discount', (year) => year.discount, result.totals.discount)}
          {row('Price', (year) => year.price, result.totals.price, { bold: true })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Commercial sign-off on the latest priced version of a pursuit.
 *
 * Approval is per version, so a re-price starts unapproved and this reverts to
 * "Not signed off" without anyone having to remember to clear it.
 *
 * The refusal is explained rather than hidden. A Finance Manager whose
 * delegated authority is below the bid price gets a specific message from the
 * API, and it is shown here verbatim - a control that silently does nothing
 * reads as a broken button, and someone told only "forbidden" goes looking for
 * a permissions problem they do not have.
 */
function SignOffCell({ pursuit }: { pursuit: PursuitListItem }) {
  const canApprove = useHasPermission()('pricing:approve');
  const queryClient = useQueryClient();

  const mutate = useMutation({
    mutationFn: (action: 'approve' | 'withdraw-approval') =>
      postData<PricingApprovalResult>(`/pricing/models/${pursuit.latestModelId}/${action}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pursuits'] }),
  });

  if (!pursuit.latestModelId) {
    return <span className="text-slate-400 dark:text-slate-600">No priced version</span>;
  }

  const approved = pursuit.latestApprovedAt !== null;

  return (
    <div className="flex flex-col gap-1">
      <span
        className={
          approved
            ? 'font-medium text-emerald-700 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'
        }
      >
        {approved ? `Signed off ${formatDate(pursuit.latestApprovedAt)}` : 'Not signed off'}
      </span>
      {canApprove ? (
        <button
          type="button"
          className="btn btn-secondary w-fit"
          disabled={mutate.isPending}
          onClick={() => mutate.mutate(approved ? 'withdraw-approval' : 'approve')}
        >
          {mutate.isPending ? 'Working…' : approved ? 'Withdraw approval' : 'Approve price'}
        </button>
      ) : null}
      {mutate.isError ? (
        <span className="text-xs text-rose-700 dark:text-rose-400">
          {mutate.error instanceof Error ? mutate.error.message : 'Could not update the sign-off.'}
        </span>
      ) : null}
    </div>
  );
}

function PriceToWinPanel({ draft }: { draft: ModelDraft }) {
  const [targetMargin, setTargetMargin] = useState(18);

  const solve = useMutation({
    mutationFn: () =>
      postData<PriceToWinResult>('/pricing/price-to-win', {
        model: toRequestBody(draft),
        target: { kind: 'MARGIN', value: (targetMargin / 100).toFixed(6) },
      }),
  });

  return (
    <Card
      title="Price to win"
      subtitle="Solve for the fee rate that lands on a target gross margin. Bisection over fee, so it converges or says it could not."
    >
      <div className="flex flex-wrap items-end gap-3">
        <NumberField
          id="ptw-margin"
          label="Target gross margin (%)"
          value={targetMargin}
          onChange={setTargetMargin}
          min={0}
          max={90}
          step={0.5}
          className="w-44"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => solve.mutate()}
          disabled={solve.isPending}
        >
          {solve.isPending ? 'Solving…' : 'Solve for fee rate'}
        </button>
      </div>

      {solve.isError ? (
        <div className="mt-3">
          <ErrorState error={solve.error} />
        </div>
      ) : null}

      {solve.data ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Solved fee rate"
              value={percent(solve.data.feeRate, { fractionDigits: 2 })}
              tone="accent"
            />
            <StatTile
              label="Achieved margin"
              value={
                solve.data.result.margin.grossMargin === null
                  ? '—'
                  : percent(solve.data.result.margin.grossMargin)
              }
            />
            <StatTile
              label="Resulting price"
              value={money0(solve.data.result.totals.price, solve.data.result.currency)}
            />
            <StatTile
              label="Solver"
              value={solve.data.converged ? 'Converged' : 'Not converged'}
              caption={`${integer(solve.data.iterations)} iterations · residual ${decimal(Number(solve.data.residual), 6)}`}
            />
          </div>
          {solve.data.warning ? (
            <div className="mt-3">
              <InlineNote tone="warning">{solve.data.warning}</InlineNote>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
          Enter the margin the pursuit needs to clear and solve. The fee rate returned is the one
          that produces exactly that margin on the cost base currently in the workbench.
        </p>
      )}
    </Card>
  );
}

export default function Pricing() {
  const has = useHasPermission();
  const canViewMargin = has('pricing:view_margin');
  const [tab, setTab] = useState<'workbench' | 'pursuits'>('workbench');
  const [draft, setDraft] = useState<ModelDraft>(INITIAL_MODEL);

  const pursuits = useQuery({
    queryKey: ['pursuits'],
    queryFn: ({ signal }) => getData<PursuitListItem[]>('/pricing/pursuits', undefined, signal),
  });

  const calculate = useMutation({
    mutationFn: () => postData<PricingResult>('/pricing/calculate', toRequestBody(draft)),
  });

  const result = calculate.data;

  function updateLabour(index: number, patch: Partial<LabourDraft>) {
    setDraft((current) => ({
      ...current,
      labour: current.labour.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function updateHours(lineIndex: number, yearIndex: number, hours: number) {
    setDraft((current) => ({
      ...current,
      labour: current.labour.map((line, i) => {
        if (i !== lineIndex) return line;
        const next = [...line.hoursByYear];
        while (next.length < current.years) next.push(next[next.length - 1] ?? 0);
        next[yearIndex] = hours;
        return { ...line, hoursByYear: next };
      }),
    }));
  }

  function setYears(years: number) {
    const clamped = Math.max(1, Math.min(10, Math.round(years)));
    setDraft((current) => ({
      ...current,
      years: clamped,
      labour: current.labour.map((line) => {
        const next = line.hoursByYear.slice(0, clamped);
        while (next.length < clamped) next.push(next[next.length - 1] ?? 0);
        return { ...line, hoursByYear: next };
      }),
    }));
  }

  return (
    <>
      <PageHeader
        title="Pricing"
        description="Build a multi-year cost volume, wrap it with indirect pools, add fee and see the price. Profitability is a separate permission — an estimator can price a bid without seeing the margin position on it."
      />

      <Tabs
        label="Pricing views"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'workbench', label: 'Pricing workbench' },
          { id: 'pursuits', label: 'Pursuits' },
        ]}
      />

      {tab === 'pursuits' ? (
        <TabPanel id="pursuits">
          <Card bodyClassName="p-0">
            {pursuits.isPending ? (
              <LoadingTable rows={5} columns={6} />
            ) : pursuits.isError ? (
              <div className="p-4">
                <ErrorState error={pursuits.error} onRetry={() => void pursuits.refetch()} />
              </div>
            ) : (pursuits.data ?? []).length === 0 ? (
              <EmptyState
                title="No pursuits recorded"
                description="Pursuits are the bids this platform prices. Someone with pricing rights needs to create one before a cost volume can be attached to it."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption>
                    Active and closed pursuits. Latest price is the most recent saved pricing model
                    version; margin is shown only if your role may see it. Sign-off applies to that
                    version alone, so re-pricing a bid clears it.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Pursuit</th>
                      <th scope="col">Client</th>
                      <th scope="col">Business unit</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Contract type</th>
                      <th scope="col" className="num">
                        P(win)
                      </th>
                      <th scope="col" className="num">
                        Latest price
                      </th>
                      <th scope="col" className="num">
                        Margin
                      </th>
                      <th scope="col">Sign-off</th>
                      <th scope="col">Award expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pursuits.data ?? []).map((pursuit) => (
                      <tr key={pursuit.id}>
                        <td className="font-medium text-slate-800 dark:text-slate-100">
                          {pursuit.name}
                        </td>
                        <td>{pursuit.client}</td>
                        <td>{pursuit.businessUnit.code}</td>
                        <td>
                          <StatusPill status={pursuit.stage} />
                        </td>
                        <td>{humanise(pursuit.contractType)}</td>
                        <td className="num">
                          {percent(pursuit.probabilityOfWin, { fractionDigits: 0 })}
                        </td>
                        <td className="num">{money0(pursuit.latestPrice)}</td>
                        <td className="num">
                          {!canViewMargin ? (
                            <span className="text-slate-400 dark:text-slate-600">Restricted</span>
                          ) : pursuit.latestMargin === null ? (
                            '—'
                          ) : (
                            percent(pursuit.latestMargin)
                          )}
                        </td>
                        <td>
                          <SignOffCell pursuit={pursuit} />
                        </td>
                        <td className="tabular-nums">{formatDate(pursuit.expectedAwardDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </TabPanel>
      ) : (
        <TabPanel id="workbench">
          <Card className="mb-4" title="Model">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <TextField
                id="pr-name"
                label="Model name"
                value={draft.name}
                onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
                className="xl:col-span-2"
              />
              <SelectField
                id="pr-contract"
                label="Contract type"
                value={draft.contractType}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, contractType: value as ContractType }))
                }
                options={CONTRACT_TYPES.map((value) => ({ value, label: humanise(value) }))}
              />
              <NumberField
                id="pr-years"
                label="Contract years"
                value={draft.years}
                onChange={setYears}
                min={1}
                max={10}
              />
              <TextField
                id="pr-fee"
                label="Fee rate (fraction)"
                value={draft.feeRate}
                onChange={(value) => setDraft((current) => ({ ...current, feeRate: value }))}
                inputClassName="input num"
                hint={`= ${percent(Number(draft.feeRate) || 0, { fractionDigits: 2 })}`}
              />
              <TextField
                id="pr-discount"
                label="Discount rate"
                value={draft.discountRate}
                onChange={(value) => setDraft((current) => ({ ...current, discountRate: value }))}
                inputClassName="input num"
                hint="Applied to the final price"
              />
            </div>

            <h3 className="mb-2 mt-5 text-xs font-semibold">Direct labour</h3>
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">
                  Labour categories with hours per contract year
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Base rate
                    </th>
                    <th scope="col" className="num">
                      Escalation
                    </th>
                    {Array.from({ length: draft.years }).map((_, year) => (
                      <th key={year} scope="col" className="num">
                        Y{year + 1} hours
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.labour.map((line, index) => (
                    <tr key={line.labourCategory}>
                      <td>
                        <label className="sr-only" htmlFor={`labour-name-${index}`}>
                          Labour category {index + 1}
                        </label>
                        <input
                          id={`labour-name-${index}`}
                          className="input"
                          value={line.labourCategory}
                          onChange={(event) =>
                            updateLabour(index, { labourCategory: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`labour-rate-${index}`}>
                          Base rate for {line.labourCategory}
                        </label>
                        <input
                          id={`labour-rate-${index}`}
                          className="input num w-24"
                          value={line.baseRate}
                          onChange={(event) =>
                            updateLabour(index, { baseRate: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`labour-esc-${index}`}>
                          Escalation rate for {line.labourCategory}
                        </label>
                        <input
                          id={`labour-esc-${index}`}
                          className="input num w-20"
                          value={line.escalationRate}
                          onChange={(event) =>
                            updateLabour(index, { escalationRate: event.target.value })
                          }
                        />
                      </td>
                      {Array.from({ length: draft.years }).map((_, year) => (
                        <td key={year}>
                          <label className="sr-only" htmlFor={`labour-hours-${index}-${year}`}>
                            {line.labourCategory} hours in year {year + 1}
                          </label>
                          <input
                            id={`labour-hours-${index}-${year}`}
                            type="number"
                            className="input num w-24"
                            value={line.hoursByYear[year] ?? 0}
                            onChange={(event) =>
                              updateHours(index, year, Number(event.target.value))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="mb-2 mt-5 text-xs font-semibold">Other direct costs</h3>
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">
                  Direct cost lines with year-one amount and escalation
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Year 1 amount
                    </th>
                    <th scope="col" className="num">
                      Escalation
                    </th>
                    <th scope="col">Pass-through</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.directCosts.map((line, index) => (
                    <tr key={line.description}>
                      <td>
                        <label className="sr-only" htmlFor={`dc-desc-${index}`}>
                          Direct cost description {index + 1}
                        </label>
                        <input
                          id={`dc-desc-${index}`}
                          className="input"
                          value={line.description}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              directCosts: current.directCosts.map((item, i) =>
                                i === index ? { ...item, description: event.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`dc-cat-${index}`}>
                          Cost category for {line.description}
                        </label>
                        <select
                          id={`dc-cat-${index}`}
                          className="input"
                          value={line.category}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              directCosts: current.directCosts.map((item, i) =>
                                i === index
                                  ? { ...item, category: event.target.value as CostCategory }
                                  : item,
                              ),
                            }))
                          }
                        >
                          {COST_CATEGORIES.map((value) => (
                            <option key={value} value={value}>
                              {humanise(value)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`dc-amount-${index}`}>
                          Year one amount for {line.description}
                        </label>
                        <input
                          id={`dc-amount-${index}`}
                          className="input num w-32"
                          value={line.amountYear1}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              directCosts: current.directCosts.map((item, i) =>
                                i === index ? { ...item, amountYear1: event.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`dc-esc-${index}`}>
                          Escalation for {line.description}
                        </label>
                        <input
                          id={`dc-esc-${index}`}
                          className="input num w-20"
                          value={line.escalationRate}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              directCosts: current.directCosts.map((item, i) =>
                                i === index
                                  ? { ...item, escalationRate: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </td>
                      <td>
                        <label
                          className="flex items-center gap-2 text-xs"
                          htmlFor={`dc-pt-${index}`}
                        >
                          <input
                            id={`dc-pt-${index}`}
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600"
                            checked={line.isPassThrough}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                directCosts: current.directCosts.map((item, i) =>
                                  i === index
                                    ? { ...item, isPassThrough: event.target.checked }
                                    : item,
                                ),
                              }))
                            }
                          />
                          At cost
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="mb-2 mt-5 text-xs font-semibold">Indirect cost pools</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {draft.burdens.map((burden, index) => (
                <div
                  key={burden.pool}
                  className="rounded border border-slate-200 p-2.5 dark:border-slate-800"
                >
                  <label
                    className="flex items-center gap-2 text-xs font-medium"
                    htmlFor={`burden-on-${burden.pool}`}
                  >
                    <input
                      id={`burden-on-${burden.pool}`}
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600"
                      checked={burden.enabled}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          burdens: current.burdens.map((item, i) =>
                            i === index ? { ...item, enabled: event.target.checked } : item,
                          ),
                        }))
                      }
                    />
                    {BURDEN_POOL_LABELS[burden.pool]}
                  </label>
                  <label className="sr-only" htmlFor={`burden-rate-${burden.pool}`}>
                    {BURDEN_POOL_LABELS[burden.pool]} rate
                  </label>
                  <input
                    id={`burden-rate-${burden.pool}`}
                    className="input num mt-2"
                    value={burden.rate}
                    disabled={!burden.enabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        burdens: current.burdens.map((item, i) =>
                          i === index ? { ...item, rate: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                  <p className="mt-1 text-2xs text-slate-600 dark:text-slate-400">
                    {percent(Number(burden.rate) || 0, { fractionDigits: 2 })} on the standard base
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => calculate.mutate()}
                disabled={calculate.isPending}
              >
                {calculate.isPending ? 'Pricing…' : 'Calculate price'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDraft(INITIAL_MODEL)}
              >
                Reset to seeded bid
              </button>
              <span className="text-2xs text-slate-600 dark:text-slate-400">
                Nothing is saved — this calculates without persisting a model version.
              </span>
            </div>

            {calculate.isError ? (
              <div className="mt-3">
                <ErrorState error={calculate.error} />
              </div>
            ) : null}
          </Card>

          {result ? (
            <>
              {result.warnings.length > 0 ? (
                <div className="mb-4">
                  <InlineNote tone="warning">
                    <ul className="list-disc space-y-1 pl-4">
                      {result.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </InlineNote>
                </div>
              ) : null}

              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <StatTile
                  label="Total price"
                  value={money0(result.totals.price, result.currency)}
                  tone="accent"
                />
                <StatTile
                  label="Total cost"
                  value={money0(result.totals.totalCost, result.currency)}
                />
                <StatTile
                  label="Gross margin"
                  value={
                    canViewMargin && result.margin.grossMargin !== null
                      ? percent(result.margin.grossMargin)
                      : 'Restricted'
                  }
                  caption={
                    canViewMargin ? 'Profit as a share of price' : 'Requires pricing:view_margin'
                  }
                />
                <StatTile
                  label="NPV"
                  value={canViewMargin ? money0(result.npv, result.currency) : 'Restricted'}
                  caption={
                    canViewMargin
                      ? 'Profit stream at cost of capital'
                      : 'Requires pricing:view_margin'
                  }
                />
                <StatTile
                  label="IRR"
                  value={
                    canViewMargin && result.irr !== null
                      ? percent(result.irr)
                      : canViewMargin
                        ? '—'
                        : 'Restricted'
                  }
                  caption={
                    canViewMargin
                      ? 'Null when the cash flow never turns'
                      : 'Requires pricing:view_margin'
                  }
                />
                <StatTile
                  label="Wrap rate (Y1)"
                  value={
                    result.years[0]?.wrapRate
                      ? money(result.years[0].wrapRate, { currency: result.currency })
                      : '—'
                  }
                  caption="Total cost per direct labour hour"
                />
              </div>

              {!canViewMargin ? (
                <div className="mb-4">
                  <InlineNote>
                    Your role can build and check a cost volume but not see the profit position on
                    it. Cost and price are shown in full; margin, fee, NPV and IRR are withheld by
                    the API, not merely hidden here.
                  </InlineNote>
                </div>
              ) : null}

              <Card className="mb-4" title="Cost volume" bodyClassName="p-0">
                <CostVolumeTable result={result} />
              </Card>

              <div className="grid gap-4 xl:grid-cols-2">
                <Card title="Cost by labour category" bodyClassName="p-0">
                  <table className="data-table">
                    <caption className="sr-only">Labour cost split by category</caption>
                    <thead>
                      <tr>
                        <th scope="col">Category</th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                        <th scope="col" className="num">
                          Share of price
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.byLabourCategory.map((line) => (
                        <tr key={line.key}>
                          <td>{line.label}</td>
                          <td className="num">{money0(line.amount, result.currency)}</td>
                          <td className="num">{line.share === null ? '—' : percent(line.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                <Card title="Cost by category" bodyClassName="p-0">
                  <table className="data-table">
                    <caption className="sr-only">Direct cost split by cost category</caption>
                    <thead>
                      <tr>
                        <th scope="col">Category</th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                        <th scope="col" className="num">
                          Share of price
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.byCostCategory.map((line) => (
                        <tr key={line.key}>
                          <td>{humanise(line.label)}</td>
                          <td className="num">{money0(line.amount, result.currency)}</td>
                          <td className="num">{line.share === null ? '—' : percent(line.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            </>
          ) : (
            <Card>
              <EmptyState
                title="No price calculated yet"
                description="Adjust the labour, direct costs and burden pools above, then calculate. The cost volume, the burden bases and the resulting price appear here."
              />
            </Card>
          )}

          {canViewMargin ? (
            <div className="mt-4">
              <PriceToWinPanel draft={draft} />
            </div>
          ) : null}
        </TabPanel>
      )}
    </>
  );
}
