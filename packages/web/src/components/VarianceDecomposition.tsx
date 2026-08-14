/**
 * Price, volume and joint decomposition of a variance.
 *
 * The most senior thing the platform calculates, and until now the only way to
 * reach it was `POST /variance/decompose` over HTTP - the engine could split a
 * variance and no screen led there.
 *
 * What it answers: "we spent 12% more" is not an explanation. "We did 9% more
 * work and paid 3% more for it" is, and the two call for different responses -
 * one is a demand problem, the other a procurement one.
 *
 * It is a **calculator**, not a report, because the platform stores budget
 * *amounts* rather than a volume and a price. Nobody records "1,000 MWh at
 * GBP 120" in a budget line; they record GBP 120,000. So the split has to be
 * supplied by whoever knows the operational quantity, and the arithmetic is
 * what this does reliably.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, ErrorState, InlineNote, NumberField, TextField } from '@/components/ui';
import { postData } from '@/lib/api';
import { money0 } from '@/lib/format';
import type { PriceVolumeResult } from '@/types/api';

interface LineDraft {
  id: string;
  label: string;
  budgetVolume: number;
  budgetPrice: number;
  actualVolume: number;
  actualPrice: number;
}

/**
 * Seeded with telecom lines where the volume and the price are both things
 * somebody actually measures - megawatt hours, site visits, minutes. An example
 * built from abstract units teaches nothing, and this screen has to teach
 * before it can be used.
 */
const INITIAL_LINES: LineDraft[] = [
  {
    id: 'energy',
    label: 'Network energy (MWh)',
    budgetVolume: 42000,
    budgetPrice: 118,
    actualVolume: 45360,
    actualPrice: 131,
  },
  {
    id: 'field',
    label: 'Field maintenance (site visits)',
    budgetVolume: 9600,
    budgetPrice: 340,
    actualVolume: 9120,
    actualPrice: 352,
  },
  {
    id: 'interconnect',
    label: 'Interconnect (million minutes)',
    budgetVolume: 1850,
    budgetPrice: 6200,
    actualVolume: 2035,
    actualPrice: 5890,
  },
];

export default function VarianceDecomposition() {
  const [lines, setLines] = useState<LineDraft[]>(INITIAL_LINES);

  const decompose = useMutation({
    mutationFn: () =>
      postData<{ lines: PriceVolumeResult[] }>('/variance/decompose', {
        lines: lines.map((line) => ({
          label: line.label,
          budgetVolume: line.budgetVolume.toFixed(4),
          budgetPrice: line.budgetPrice.toFixed(4),
          actualVolume: line.actualVolume.toFixed(4),
          actualPrice: line.actualPrice.toFixed(4),
        })),
      }),
  });

  function update(id: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  const results = decompose.data?.lines ?? [];
  const total = (pick: (r: PriceVolumeResult) => string) =>
    results.reduce((acc, r) => acc + Number(pick(r)), 0);

  return (
    <>
      <Card
        className="mb-4"
        title="What drove the variance"
        subtitle="Split a difference into the part that is volume, the part that is price, and the interaction between them."
      >
        <InlineNote>
          A budget line records an amount, not a quantity and a rate, so the split has to come from
          whoever knows the operational number — megawatt hours, site visits, minutes. Enter what
          was planned and what happened, and the arithmetic is done here rather than in a
          spreadsheet nobody can check.
        </InlineNote>

        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <caption>Planned and actual quantity and unit price, per line.</caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col" className="num">
                  Budget quantity
                </th>
                <th scope="col" className="num">
                  Budget unit price
                </th>
                <th scope="col" className="num">
                  Actual quantity
                </th>
                <th scope="col" className="num">
                  Actual unit price
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <TextField
                      id={`dec-label-${line.id}`}
                      label=""
                      value={line.label}
                      onChange={(value) => update(line.id, { label: value })}
                    />
                  </td>
                  <td>
                    <NumberField
                      id={`dec-bv-${line.id}`}
                      label=""
                      value={line.budgetVolume}
                      onChange={(value) => update(line.id, { budgetVolume: value })}
                    />
                  </td>
                  <td>
                    <NumberField
                      id={`dec-bp-${line.id}`}
                      label=""
                      value={line.budgetPrice}
                      onChange={(value) => update(line.id, { budgetPrice: value })}
                    />
                  </td>
                  <td>
                    <NumberField
                      id={`dec-av-${line.id}`}
                      label=""
                      value={line.actualVolume}
                      onChange={(value) => update(line.id, { actualVolume: value })}
                    />
                  </td>
                  <td>
                    <NumberField
                      id={`dec-ap-${line.id}`}
                      label=""
                      value={line.actualPrice}
                      onChange={(value) => update(line.id, { actualPrice: value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={decompose.isPending || lines.length === 0}
            onClick={() => decompose.mutate()}
          >
            {decompose.isPending ? 'Working…' : 'Decompose'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  id: `line-${Date.now()}`,
                  label: 'New line',
                  budgetVolume: 0,
                  budgetPrice: 0,
                  actualVolume: 0,
                  actualPrice: 0,
                },
              ])
            }
          >
            Add a line
          </button>
          {lines.length > 1 ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setLines((current) => current.slice(0, -1))}
            >
              Remove the last
            </button>
          ) : null}
        </div>

        {decompose.isError ? (
          <div className="mt-3">
            <ErrorState error={decompose.error} />
          </div>
        ) : null}
      </Card>

      {results.length > 0 ? (
        <Card title="Decomposition" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>
                Every figure is an <strong>effect on spend</strong>: positive means more money went
                out than planned. The three components sum to the total — volume measured at the
                budgeted price, price measured across the budgeted quantity, and the joint term
                where both moved at once.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col" className="num">
                    Budget
                  </th>
                  <th scope="col" className="num">
                    Actual
                  </th>
                  <th scope="col" className="num">
                    Volume effect
                  </th>
                  <th scope="col" className="num">
                    Price effect
                  </th>
                  <th scope="col" className="num">
                    Joint effect
                  </th>
                  <th scope="col" className="num">
                    Total effect
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.label}>
                    <td className="font-medium text-slate-800 dark:text-slate-100">{row.label}</td>
                    <td className="num">{money0(row.budgetAmount)}</td>
                    <td className="num">{money0(row.actualAmount)}</td>
                    <td className="num">{money0(row.volumeVariance)}</td>
                    <td className="num">{money0(row.priceVariance)}</td>
                    <td className="num">{money0(row.jointVariance)}</td>
                    <td className="num font-medium">{money0(row.totalVariance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-medium">Total</td>
                  <td className="num">{money0(total((r) => r.budgetAmount))}</td>
                  <td className="num">{money0(total((r) => r.actualAmount))}</td>
                  <td className="num">{money0(total((r) => r.volumeVariance))}</td>
                  <td className="num">{money0(total((r) => r.priceVariance))}</td>
                  <td className="num">{money0(total((r) => r.jointVariance))}</td>
                  <td className="num font-medium">{money0(total((r) => r.totalVariance))}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="border-t border-slate-200 p-4 dark:border-slate-800">
            {/*
              The column headings are terms of art. Explaining them here rather
              than in a tooltip is deliberate: the point of this screen is to
              let somebody say what happened out loud in a review, and they can
              only do that if the words are in front of them.
            */}
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-medium text-slate-800 dark:text-slate-100">Volume</dt>
                <dd className="text-slate-600 dark:text-slate-400">
                  We did more or less than planned, priced as planned. A demand or activity
                  question.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-800 dark:text-slate-100">Price</dt>
                <dd className="text-slate-600 dark:text-slate-400">
                  Each unit cost more or less than planned. A procurement, tariff or rate question.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-800 dark:text-slate-100">Joint</dt>
                <dd className="text-slate-600 dark:text-slate-400">
                  Both moved together. Reported separately rather than folded into one of the
                  others, because which one absorbs it is a convention, not a fact.
                </dd>
              </div>
            </dl>

            {/*
              Two sign conventions exist in this product and a finance reader
              will notice within seconds, so it is said out loud rather than
              left to be discovered.

              Budget vs actual reports `budget - consumed`, so a positive figure
              is an underspend and favourable. A decomposition explains a
              *change*, and is conventionally signed the other way: positive
              means the change added cost. Both are standard; using either
              silently on a screen labelled only "variance" is not.
            */}
            <div className="mt-4">
              <InlineNote>
                These are signed the opposite way to the <strong>Budget vs actual</strong> tab, on
                purpose. That tab reports budget less spend, so a positive figure is an underspend.
                This one explains a change, so a positive figure is added cost. Both conventions are
                standard; what is not standard is using either without saying which.
              </InlineNote>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
