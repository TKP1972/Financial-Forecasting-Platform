/**
 * The leadership pack, and the record of the ones that were issued.
 *
 * The pack itself was reachable only over the API before this page existed — a
 * headline capability with nothing in the interface leading to it. Publication
 * is the part that matters governance-wise: the pack is otherwise rebuilt live
 * from budgets, actuals and forecasts, so regenerating it after those move
 * gives different numbers and a figure quoted in a board meeting traces back to
 * nothing. Issuing one freezes it.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  PageHeader,
  RagPill,
  SelectField,
  StatTile,
  TabPanel,
  Tabs,
  TextField,
} from '@/components/ui';
import { getData, postData } from '@/lib/api';
import { formatDate, money0, percent } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type {
  CycleSummary,
  LeadershipPack,
  PublishedReportListItem,
  PublishedReportRef,
} from '@/types/api';

function PackSummary({ pack }: { pack: LeadershipPack }) {
  const currency = pack.cycle.baseCurrency;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Approved budget" value={money0(pack.summary.approvedBudget, currency)} />
        <StatTile label="Actual" value={money0(pack.summary.actual, currency)} />
        <StatTile
          label="Commitment"
          value={money0(pack.summary.commitment, currency)}
          caption="Counts as consumed"
        />
        <StatTile
          label="Variance"
          value={money0(pack.summary.variance, currency)}
          caption={
            pack.summary.variancePercent === null
              ? 'No budget to compare against'
              : percent(pack.summary.variancePercent)
          }
        />
      </div>

      <Card className="mb-4" title="By business unit" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption>
              Through period {pack.throughPeriod} of {pack.periodsInYear}.
            </caption>
            <thead>
              <tr>
                <th scope="col">Unit</th>
                <th scope="col" className="num">
                  Budget
                </th>
                <th scope="col" className="num">
                  Actual
                </th>
                <th scope="col" className="num">
                  Variance
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {pack.byBusinessUnit.map((row) => (
                <tr key={row.code}>
                  <td className="font-medium text-slate-800 dark:text-slate-100">
                    {row.name}{' '}
                    <span className="text-slate-500 dark:text-slate-400">({row.code})</span>
                  </td>
                  <td className="num">{money0(row.budget, currency)}</td>
                  <td className="num">{money0(row.actual, currency)}</td>
                  <td className="num">{money0(row.variance, currency)}</td>
                  <td>
                    <RagPill rag={row.rag} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {pack.exceptions.length > 0 ? (
        <Card className="mb-4" title="Exceptions" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>Lines the pack calls out for review.</caption>
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
                    Variance
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {pack.exceptions.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="num">{money0(row.budget, currency)}</td>
                    <td className="num">{money0(row.actual, currency)}</td>
                    <td className="num">{money0(row.variance, currency)}</td>
                    <td>
                      <RagPill rag={row.rag} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {pack.commentary.length > 0 ? (
        <Card title="Commentary" subtitle="Generated from the numbers above, not written by hand.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {pack.commentary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

export default function Reports() {
  const has = useHasPermission();
  const canPublish = has('report:publish_leadership');
  const [tab, setTab] = useState<'pack' | 'issued'>('pack');
  const [cycleId, setCycleId] = useState('');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: ({ signal }) => getData<CycleSummary[]>('/cycles', undefined, signal),
  });

  useEffect(() => {
    if (cycleId === '' && cycles.data && cycles.data.length > 0) {
      setCycleId(cycles.data[0]?.id ?? '');
    }
  }, [cycles.data, cycleId]);

  const pack = useQuery({
    queryKey: ['leadership-pack', cycleId],
    queryFn: ({ signal }) =>
      getData<LeadershipPack>('/reports/leadership-pack', { cycleId }, signal),
    enabled: cycleId !== '',
    placeholderData: keepPreviousData,
  });

  const issued = useQuery({
    queryKey: ['published-reports', cycleId],
    queryFn: ({ signal }) =>
      getData<PublishedReportListItem[]>(
        '/reports/published',
        cycleId ? { cycleId } : undefined,
        signal,
      ),
  });

  const publish = useMutation({
    mutationFn: () =>
      postData<PublishedReportRef>('/reports/leadership-pack/publish', {
        cycleId,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['published-reports'] });
      setTab('issued');
    },
  });

  return (
    <>
      <PageHeader
        title="Reports"
        description="The leadership pack as it stands, and the record of the ones that were issued. Publishing freezes a pack so a figure quoted in a review can be traced back to exactly what was tabled."
      />

      <Card className="mb-4">
        <div className="max-w-md">
          <SelectField
            id="rep-cycle"
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

      <Tabs
        label="Report views"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'pack', label: 'Leadership pack' },
          { id: 'issued', label: 'Issued packs' },
        ]}
      />

      {tab === 'pack' ? (
        <TabPanel id="pack">
          {cycleId === '' ? (
            <Card>
              <InlineNote>Select a cycle to build the pack.</InlineNote>
            </Card>
          ) : pack.isPending ? (
            <LoadingTable rows={6} columns={5} />
          ) : pack.isError ? (
            <ErrorState error={pack.error} onRetry={() => void pack.refetch()} />
          ) : pack.data ? (
            <>
              <PackSummary pack={pack.data} />

              <Card
                className="mt-4"
                title="Issue this pack"
                subtitle="Freezes the numbers above as a permanent record, attributed to you."
              >
                {canPublish ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[18rem] flex-1">
                      <TextField
                        id="publish-note"
                        label="Note (optional — what this pack was for)"
                        value={note}
                        onChange={setNote}
                        placeholder="e.g. August board review"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={publish.isPending}
                      onClick={() => publish.mutate()}
                    >
                      {publish.isPending ? 'Publishing…' : 'Publish pack'}
                    </button>
                  </div>
                ) : (
                  <InlineNote>
                    Issuing a pack requires the <code>report:publish_leadership</code> permission,
                    held from Finance Manager upwards. You can read and export this pack; making it
                    a matter of record is someone else&rsquo;s sign-off.
                  </InlineNote>
                )}

                {publish.isError ? (
                  <div className="mt-3 text-sm text-rose-700 dark:text-rose-400">
                    {publish.error instanceof Error
                      ? publish.error.message
                      : 'Could not publish the pack.'}
                  </div>
                ) : null}
              </Card>
            </>
          ) : null}
        </TabPanel>
      ) : (
        <TabPanel id="issued">
          <Card bodyClassName="p-0">
            {issued.isPending ? (
              <LoadingTable rows={4} columns={4} />
            ) : issued.isError ? (
              <div className="p-4">
                <ErrorState error={issued.error} onRetry={() => void issued.refetch()} />
              </div>
            ) : (issued.data ?? []).length === 0 ? (
              <EmptyState
                title="No packs issued yet"
                description="A published pack is a frozen copy of the leadership review at a point in time. Until one is issued, the pack above is rebuilt from live data every time it is opened."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption>
                    Issued packs, most recent first. Each is stored exactly as it was published and
                    is never recomputed.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Title</th>
                      <th scope="col">Cycle</th>
                      <th scope="col">Issued</th>
                      <th scope="col">By</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(issued.data ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="font-medium text-slate-800 dark:text-slate-100">
                          {row.title}
                        </td>
                        <td>
                          {row.cycle.name} (FY{row.cycle.fiscalYear})
                        </td>
                        <td className="tabular-nums">{formatDate(row.publishedAt)}</td>
                        <td>{row.publishedBy?.name ?? '—'}</td>
                        <td className="text-slate-600 dark:text-slate-400">{row.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </TabPanel>
      )}
    </>
  );
}
