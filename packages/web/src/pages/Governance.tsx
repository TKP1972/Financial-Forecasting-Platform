import { PERMISSIONS, ROLE_LABELS } from '@ffp/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  PageHeader,
  StatTile,
  TabPanel,
  Tabs,
} from '@/components/ui';
import { apiRequest, getData, postData } from '@/lib/api';
import { formatDateTime, humanise, integer, money0 } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type {
  AuditEntry,
  ChainVerification,
  ControlRegister,
  Paged,
  RoleMatrixEntry,
} from '@/types/api';

function AuditTab() {
  const has = useHasPermission();
  const [page, setPage] = useState(1);

  const audit = useQuery({
    queryKey: ['audit', page],
    queryFn: ({ signal }) =>
      apiRequest<Paged<AuditEntry>>('/governance/audit', { query: { page, pageSize: 50 }, signal }),
    placeholderData: keepPreviousData,
  });

  const verify = useMutation({
    mutationFn: () => postData<ChainVerification>('/governance/audit/verify'),
  });

  if (!has('audit:read')) {
    return (
      <Card>
        <EmptyState
          title="The audit trail is restricted"
          description="Reading the audit trail requires the audit:read permission, held from Finance Manager upwards. Ask a finance manager or the CFO if you need an extract."
        />
      </Card>
    );
  }

  const rows = audit.data?.data ?? [];
  const meta = audit.data?.meta;

  return (
    <>
      <Card
        className="mb-4"
        title="Chain integrity"
        subtitle="Every governed action appends a row hash-chained to its predecessor. Any edit, deletion or reordering breaks the chain and is detectable."
        actions={
          has('audit:verify') ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
            >
              {verify.isPending ? 'Verifying…' : 'Verify chain'}
            </button>
          ) : null
        }
      >
        {!has('audit:verify') ? (
          <InlineNote>
            Verification re-derives every hash in the trail and is itself audited, so it is
            restricted to the CFO and administrator level. You can read the trail below.
          </InlineNote>
        ) : verify.isError ? (
          <ErrorState error={verify.error} />
        ) : verify.data ? (
          verify.data.valid ? (
            <div
              role="status"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <p className="text-sm font-semibold">Chain intact</p>
              <p className="mt-1">
                {integer(verify.data.entriesChecked)} entries re-hashed and verified, from sequence{' '}
                {verify.data.firstSequence ?? '—'} to {verify.data.lastSequence ?? '—'}. No entry
                has been modified, inserted or removed.
              </p>
              <p className="mt-1 text-emerald-800 dark:text-emerald-300">
                Verified {formatDateTime(verify.data.verifiedAt)}.
              </p>
            </div>
          ) : (
            <div
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
            >
              <p className="text-sm font-semibold">Chain BROKEN</p>
              <p className="mt-1">{verify.data.reason}</p>
              <p className="mt-1">
                First failure at sequence {verify.data.brokenAtSequence ?? '—'} after{' '}
                {integer(verify.data.entriesChecked)} valid entries. Treat every record after that
                point as unverified and escalate immediately.
              </p>
            </div>
          )
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Verification has not been run in this session. It re-derives every hash from the genesis
            entry forward — the one control that proves the trail has not been tampered with.
          </p>
        )}
      </Card>

      <Card title="Audit trail" subtitle="Newest first" bodyClassName="p-0">
        {audit.isPending ? (
          <LoadingTable rows={10} columns={6} />
        ) : audit.isError ? (
          <div className="p-4">
            <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No audit entries"
            description="Nothing has been recorded in the trail yet."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption>
                Every governed action, with the hash that links it to the entry before it. Hashes
                are truncated for reading; verification uses the full value.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Seq
                  </th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Actor</th>
                  <th scope="col">When</th>
                  <th scope="col">Hash</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td className="num font-mono text-2xs">{entry.sequence}</td>
                    <td className="whitespace-nowrap">{humanise(entry.action)}</td>
                    <td className="whitespace-nowrap">{entry.entityType}</td>
                    <td className="min-w-[20rem]">{entry.summary}</td>
                    <td className="whitespace-nowrap">
                      {entry.actor
                        ? `${entry.actor.firstName} ${entry.actor.lastName}`
                        : (entry.actorEmail ?? 'System')}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td
                      className="font-mono text-2xs text-slate-500 dark:text-slate-400"
                      title={entry.hash}
                    >
                      {entry.hash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 text-xs dark:border-slate-800">
            <p className="text-slate-500 dark:text-slate-400">
              {integer(meta.total)} entries in the trail
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
              <span className="tabular-nums text-slate-500 dark:text-slate-400">
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

function ControlsTab() {
  const has = useHasPermission();
  const controls = useQuery({
    queryKey: ['controls'],
    queryFn: ({ signal }) => getData<ControlRegister>('/governance/controls', undefined, signal),
    enabled: has('audit:read'),
  });

  if (!has('audit:read')) {
    return (
      <Card>
        <EmptyState
          title="The control register is restricted"
          description="Viewing the controls in force requires the audit:read permission. Ask a finance manager or the CFO for the snapshot an auditor would be given."
        />
      </Card>
    );
  }

  if (controls.isPending) {
    return (
      <Card bodyClassName="p-0">
        <LoadingTable rows={5} columns={3} />
      </Card>
    );
  }
  if (controls.isError)
    return <ErrorState error={controls.error} onRetry={() => void controls.refetch()} />;

  const { controls: rows, metrics } = controls.data;

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Users"
          value={integer(metrics.users)}
          caption={`${integer(metrics.activeUsers)} active`}
        />
        <StatTile label="Approved budgets" value={integer(metrics.approvedBudgets)} />
        <StatTile label="Audit entries" value={integer(metrics.auditEntries)} />
        <StatTile
          label="Last verification"
          value={
            metrics.lastChainVerification ? formatDateTime(metrics.lastChainVerification) : 'Never'
          }
          caption={metrics.lastChainVerificationResult ?? 'Run a verification to record one'}
        />
      </div>

      <Card title="Control register" subtitle="What an auditor asks for first" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption>
              The controls in force, and whether each is enforced by the platform itself.
            </caption>
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Control</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((control) => (
                <tr key={control.id}>
                  <td className="font-mono text-2xs">{control.id}</td>
                  <td className="whitespace-nowrap font-medium text-slate-800 dark:text-slate-100">
                    {control.name}
                  </td>
                  <td>{control.description}</td>
                  <td>
                    <span className="pill bg-accent-100 text-accent-800 dark:bg-accent-900/50 dark:text-accent-200">
                      {humanise(control.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function RolesTab() {
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => getData<RoleMatrixEntry[]>('/governance/roles', undefined, signal),
  });

  if (roles.isPending) {
    return (
      <Card bodyClassName="p-0">
        <LoadingTable rows={8} columns={7} />
      </Card>
    );
  }
  if (roles.isError) return <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />;

  const matrix = roles.data;

  return (
    <Card
      title="Role and permission matrix"
      subtitle="What each role may do, and the default value it may approve up to"
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption>
            A tick means the role holds the permission. Separation of duties and delegated authority
            apply on top of this: holding budget:approve does not let you approve your own work.
          </caption>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {matrix.map((entry) => (
                <th key={entry.role} scope="col" className="text-center">
                  {ROLE_LABELS[entry.role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((permission) => (
              <tr key={permission}>
                <th scope="row" className="text-left font-mono text-2xs font-normal">
                  {permission}
                </th>
                {matrix.map((entry) => {
                  const held = entry.permissions.includes(permission);
                  return (
                    <td key={entry.role} className="text-center">
                      <span
                        className={
                          held
                            ? 'font-semibold text-accent-700 dark:text-accent-300'
                            : 'text-slate-300 dark:text-slate-700'
                        }
                      >
                        <span aria-hidden="true">{held ? '✓' : '·'}</span>
                        <span className="sr-only">
                          {held ? 'Held' : 'Not held'} by {ROLE_LABELS[entry.role]}
                        </span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <th scope="row" className="text-left">
                Default approval limit
              </th>
              {matrix.map((entry) => (
                <td key={entry.role} className="num text-center">
                  {entry.defaultApprovalLimit === null
                    ? 'Unlimited'
                    : money0(entry.defaultApprovalLimit)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

export default function Governance() {
  const [tab, setTab] = useState<'audit' | 'controls' | 'roles'>('audit');

  return (
    <>
      <PageHeader
        title="Governance"
        description="The audit trail, the controls in force and the permission matrix behind them. The trail is hash-chained, so tampering is detectable rather than merely discouraged."
      />

      <Tabs
        label="Governance views"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'audit', label: 'Audit trail' },
          { id: 'controls', label: 'Controls' },
          { id: 'roles', label: 'Roles & permissions' },
        ]}
      />

      {tab === 'audit' ? (
        <TabPanel id="audit">
          <AuditTab />
        </TabPanel>
      ) : tab === 'controls' ? (
        <TabPanel id="controls">
          <ControlsTab />
        </TabPanel>
      ) : (
        <TabPanel id="roles">
          <RolesTab />
        </TabPanel>
      )}
    </>
  );
}
