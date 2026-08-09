import type { BudgetStatus } from '@ffp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingCard,
  PageHeader,
  ProgressBar,
  StatusPill,
} from '@/components/ui';
import { getData, isApiError, postData } from '@/lib/api';
import {
  formatDate,
  formatDateTime,
  humanise,
  integer,
  money,
  money0,
  percent,
} from '@/lib/format';
import type { AlignmentReport, BudgetDetail as BudgetDetailData } from '@/types/api';

const TRANSITION_LABELS: Record<BudgetStatus, string> = {
  DRAFT: 'Return to draft',
  IN_REVIEW: 'Move to review',
  SUBMITTED: 'Submit',
  APPROVED: 'Approve',
  REJECTED: 'Reject',
  LOCKED: 'Lock baseline',
};

/**
 * The two governance refusals are the interesting ones, so they get a full
 * explanation rather than a toast: the point of the control is that the person
 * hitting it understands why, and what to do instead.
 */
function TransitionError({ error }: { error: unknown }) {
  if (!isApiError(error)) {
    return (
      <InlineNote tone="warning">
        {error instanceof Error ? error.message : 'The transition could not be completed.'}
      </InlineNote>
    );
  }

  if (error.code === 'SEPARATION_OF_DUTIES') {
    return (
      <div
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
      >
        <p className="text-sm font-semibold">Blocked: separation of duties</p>
        <p className="mt-1">{error.message}</p>
        <p className="mt-2 text-red-800 dark:text-red-300">
          You prepared or submitted this budget, so you cannot also approve it. This control has no
          role-based exemption — not even an administrator can bypass it, because an audit trail
          that can be self-approved cannot be relied on. Ask a different approver with sufficient
          delegated authority to action it.
        </p>
      </div>
    );
  }

  if (error.code === 'DELEGATED_AUTHORITY_EXCEEDED') {
    const details = (error.details ?? {}) as { limit?: string; amount?: string };
    return (
      <div
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
      >
        <p className="text-sm font-semibold">Blocked: delegated authority exceeded</p>
        <p className="mt-1">{error.message}</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:max-w-sm">
          <div>
            <dt className="text-2xs uppercase tracking-wide">Amount to approve</dt>
            <dd className="font-semibold tabular-nums">{money0(details.amount)}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide">Your limit</dt>
            <dd className="font-semibold tabular-nums">
              {details.limit === 'null' || details.limit === undefined
                ? 'Unlimited'
                : money0(details.limit)}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-red-800 dark:text-red-300">
          Escalate to the next approval level. Limits are per-user and can be raised by an
          administrator, but the approval itself has to be made by someone whose authority already
          covers the amount.
        </p>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p className="font-semibold">{humanise(error.code)}</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}

function AlignmentPanel({ budgetId, currency }: { budgetId: string; currency: string }) {
  const query = useQuery({
    queryKey: ['budget-alignment', budgetId],
    queryFn: ({ signal }) =>
      getData<AlignmentReport>(`/budgets/${budgetId}/alignment`, undefined, signal),
  });

  if (query.isPending) return <LoadingCard rows={5} label="Loading strategic alignment" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const report = query.data;

  return (
    <Card
      title="Strategic alignment"
      subtitle="Does where the money goes match what leadership said the priorities were?"
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <p className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Alignment score
          </p>
          <p className="text-2xl font-semibold tabular-nums text-accent-700 dark:text-accent-300">
            {percent(report.alignmentScore)}
          </p>
          <p className="mt-1 text-2xs text-slate-500 dark:text-slate-400">
            Money-weighted: 100% would mean every currency unit is tied directly to an objective.
          </p>
          <div className="mt-3">
            <ProgressBar value={report.alignmentScore} label="Weighted alignment" />
          </div>
          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-500 dark:text-slate-400">Total budget</dt>
              <dd className="tabular-nums font-medium">{money0(report.totalBudget, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500 dark:text-slate-400">Unallocated</dt>
              <dd className="tabular-nums font-medium">
                {money0(report.unallocated, currency)} ({percent(report.unallocatedShare)})
              </dd>
            </div>
          </dl>
        </div>

        <div className="lg:col-span-2">
          <table className="data-table">
            <caption className="sr-only">
              Funding by strategic objective against target share
            </caption>
            <thead>
              <tr>
                <th scope="col">Objective</th>
                <th scope="col">Horizon</th>
                <th scope="col" className="num">
                  Funding
                </th>
                <th scope="col" className="num">
                  Actual share
                </th>
                <th scope="col" className="num">
                  Target share
                </th>
                <th scope="col" className="num">
                  Gap
                </th>
              </tr>
            </thead>
            <tbody>
              {report.allocations.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-slate-500">
                    No budget lines are linked to a strategic objective.
                  </td>
                </tr>
              ) : (
                report.allocations.map((allocation) => (
                  <tr key={allocation.objectiveId}>
                    <td>
                      <span className="font-mono text-2xs text-slate-500 dark:text-slate-400">
                        {allocation.code}
                      </span>{' '}
                      {allocation.title}
                    </td>
                    <td>{humanise(allocation.horizon)}</td>
                    <td className="num">{money0(allocation.amount, currency)}</td>
                    <td className="num">{percent(allocation.actualShare)}</td>
                    <td className="num">
                      {allocation.targetShare === null ? '—' : percent(allocation.targetShare)}
                    </td>
                    <td className="num">
                      {allocation.shareGap === null ? (
                        '—'
                      ) : (
                        <span className={allocation.shareGap < 0 ? 'font-medium' : ''}>
                          {allocation.shareGap > 0 ? '+' : ''}
                          {(allocation.shareGap * 100).toFixed(1)} pp
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold">Spend by horizon</h3>
          <table className="data-table">
            <caption className="sr-only">Budget split across strategic horizons</caption>
            <thead>
              <tr>
                <th scope="col">Horizon</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {report.byHorizon.map((horizon) => (
                <tr key={horizon.horizon}>
                  <td>{humanise(horizon.horizon)}</td>
                  <td className="num">{money0(horizon.amount, currency)}</td>
                  <td className="num">{percent(horizon.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold">Observations</h3>
          {report.observations.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Nothing stands out: funding broadly tracks the declared target shares.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
              {report.observations.map((observation) => (
                <li key={observation} className="flex gap-2">
                  <span aria-hidden="true" className="text-slate-400">
                    •
                  </span>
                  <span>{observation}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function BudgetDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [pendingTarget, setPendingTarget] = useState<BudgetStatus | null>(null);

  const query = useQuery({
    queryKey: ['budget', id],
    queryFn: ({ signal }) => getData<BudgetDetailData>(`/budgets/${id}`, undefined, signal),
    enabled: id !== '',
  });

  const transition = useMutation({
    mutationFn: (to: BudgetStatus) =>
      postData<{ id: string; status: BudgetStatus; version: number }>(`/budgets/${id}/transition`, {
        to,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: () => {
      setComment('');
      setPendingTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['budget', id] });
      void queryClient.invalidateQueries({ queryKey: ['budgets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Budget" />
        <LoadingCard rows={10} />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Budget" />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }

  const budget = query.data;
  const currency = budget.currency;
  const periodKeys = budget.lines[0]?.periods.map((period) => period.periodKey) ?? [];

  return (
    <>
      <PageHeader
        title={budget.name}
        description={`${budget.businessUnit.code} ${budget.businessUnit.name} · ${budget.cycle.name} · version ${budget.version}`}
        actions={
          <Link to="/budgets" className="btn btn-ghost">
            All budgets
          </Link>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Status
          </p>
          <p className="mt-1">
            <StatusPill status={budget.status} />
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Total
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {money0(budget.totalAmount, currency)}
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Prepared by
          </p>
          <p className="mt-1 text-xs font-medium">
            {budget.preparedBy
              ? `${budget.preparedBy.firstName} ${budget.preparedBy.lastName}`
              : '—'}
          </p>
          <p className="text-2xs text-slate-500 dark:text-slate-400">
            Submitted{' '}
            {budget.submittedBy
              ? `by ${budget.submittedBy.firstName} ${budget.submittedBy.lastName}`
              : '—'}
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Approved
          </p>
          <p className="mt-1 text-xs font-medium">
            {budget.approvedBy
              ? `${budget.approvedBy.firstName} ${budget.approvedBy.lastName}`
              : '—'}
          </p>
          <p className="text-2xs text-slate-500 dark:text-slate-400">
            {formatDate(budget.approvedAt)}
          </p>
        </div>
      </div>

      <Card
        className="mb-4"
        title="Workflow"
        subtitle="Only the transitions your role can legally perform from this status are offered."
      >
        {budget.availableTransitions.length === 0 ? (
          <InlineNote>
            {budget.status === 'LOCKED'
              ? 'This budget is locked. It is the baseline variance reporting is measured against, so it cannot be amended — raise a reforecast or a budget transfer instead.'
              : 'No transition is available to you from this status. A more senior approver has to move it on.'}
          </InlineNote>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1">
                <label className="field-label" htmlFor="transition-comment">
                  Comment (recorded on the approval and in the audit trail)
                </label>
                <input
                  id="transition-comment"
                  className="input"
                  value={comment}
                  placeholder="Optional — required by most reviewers for a rejection"
                  onChange={(event) => setComment(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {budget.availableTransitions.map((target) => (
                  <button
                    key={target}
                    type="button"
                    className={`btn ${target === 'APPROVED' || target === 'SUBMITTED' ? 'btn-primary' : 'btn-secondary'}`}
                    disabled={transition.isPending}
                    onClick={() => {
                      setPendingTarget(target);
                      transition.mutate(target);
                    }}
                  >
                    {transition.isPending && pendingTarget === target
                      ? 'Working…'
                      : TRANSITION_LABELS[target]}
                  </button>
                ))}
              </div>
            </div>

            {transition.isError ? (
              <div className="mt-3">
                <TransitionError error={transition.error} />
              </div>
            ) : null}
            {transition.isSuccess ? (
              <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
                Moved to {humanise(transition.data.status)} as version {transition.data.version}.
              </p>
            ) : null}
          </>
        )}
      </Card>

      <Card
        className="mb-4"
        title="Budget lines"
        subtitle={`${integer(budget.lines.length)} line(s), phased across ${integer(periodKeys.length)} periods`}
        bodyClassName="p-0"
      >
        {budget.lines.length === 0 ? (
          <EmptyState
            title="This budget has no lines"
            description="A budget with no lines totals zero. Add lines against the chart of accounts before submitting it for review."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>
                Line detail in {currency}. Each line records the method it was built with and how
                strongly it maps to strategy, because reviewers ask where the number came from.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Method</th>
                  <th scope="col">Alignment</th>
                  {periodKeys.map((key) => (
                    <th key={key} scope="col" className="num">
                      {key.split('-')[1] ?? key}
                    </th>
                  ))}
                  <th scope="col" className="num">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody>
                {budget.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="min-w-[14rem]">
                      <span className="font-mono text-2xs text-slate-500 dark:text-slate-400">
                        {line.account.code}
                      </span>{' '}
                      <span className="font-medium text-slate-800 dark:text-slate-100">
                        {line.account.name}
                      </span>
                      <div className="text-2xs text-slate-500 dark:text-slate-400">
                        {humanise(line.account.type)}
                        {line.strategicObjective ? ` · ${line.strategicObjective.code}` : ''}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{humanise(line.method)}</td>
                    <td className="whitespace-nowrap">{humanise(line.alignment)}</td>
                    {line.periods.map((period) => (
                      <td key={period.id} className="num">
                        {money0(period.amount, currency)}
                      </td>
                    ))}
                    <td className="num font-semibold">{money0(line.totalAmount, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {/*
                  The total comes from the API, which derived it in decimal
                  arithmetic. Nothing on this page adds money in the browser.
                */}
                <tr className="font-semibold">
                  <th scope="row" colSpan={3 + periodKeys.length} className="text-left">
                    Budget total (as calculated by the platform)
                  </th>
                  <td className="num">{money0(budget.totalAmount, currency)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card
          title="Version history"
          subtitle="Every transition freezes the full budget"
          bodyClassName="p-0"
        >
          {budget.versions.length === 0 ? (
            <EmptyState
              title="No versions"
              description="No snapshot has been taken of this budget yet."
            />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="data-table">
                <caption className="sr-only">Budget version snapshots</caption>
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr>
                    <th scope="col" className="num">
                      Version
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col">Comment</th>
                    <th scope="col">Taken</th>
                  </tr>
                </thead>
                <tbody>
                  {budget.versions.map((version) => (
                    <tr key={version.id}>
                      <td className="num">{version.version}</td>
                      <td>
                        <StatusPill status={version.status} />
                      </td>
                      <td className="num">{money0(version.totalAmount, currency)}</td>
                      <td className="text-slate-500 dark:text-slate-400">
                        {version.comment ?? '—'}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">
                        {formatDateTime(version.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Approval history"
          subtitle="Sign-offs and rejections, newest first"
          bodyClassName="p-0"
        >
          {budget.approvals.length === 0 ? (
            <EmptyState
              title="No approval decisions yet"
              description="Once this budget is approved or rejected, each decision appears here with its approver, amount and comment."
            />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="data-table">
                <caption className="sr-only">
                  Approval decisions recorded against this budget
                </caption>
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr>
                    <th scope="col">Decision</th>
                    <th scope="col">Approver</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                    <th scope="col">Comment</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {budget.approvals.map((approval) => (
                    <tr key={approval.id}>
                      <td className="whitespace-nowrap">
                        {humanise(approval.fromStatus)} → <StatusPill status={approval.toStatus} />
                      </td>
                      <td>
                        {approval.approver
                          ? `${approval.approver.firstName} ${approval.approver.lastName}`
                          : '—'}
                      </td>
                      <td className="num">{money(approval.amount, { currency })}</td>
                      <td className="text-slate-500 dark:text-slate-400">
                        {approval.comment ?? '—'}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">
                        {formatDateTime(approval.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <AlignmentPanel budgetId={budget.id} currency={currency} />
    </>
  );
}
