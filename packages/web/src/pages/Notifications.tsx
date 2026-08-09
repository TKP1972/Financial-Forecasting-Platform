import { NOTIFICATION_TYPE_LABELS, type NotificationType } from '@ffp/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  PageHeader,
  TabPanel,
  Tabs,
} from '@/components/ui';
import { apiRequest } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';

interface NotificationRow {
  id: string;
  type: NotificationType;
  channel: string;
  status: string;
  subject: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Inbox {
  data: NotificationRow[];
  unread: number;
  pagination: { page: number; pageSize: number; total: number };
}

interface PreferenceRow {
  type: NotificationType;
  label: string;
  mutable: boolean;
  muted: boolean;
}

/** Deep-link a notification to whatever it is about. */
function entityLink(row: NotificationRow): string | null {
  if (row.entityType === 'Budget' && row.entityId) return `/budgets/${row.entityId}`;
  return null;
}

function InboxTab() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const inbox = useQuery({
    queryKey: ['notifications', page, unreadOnly],
    queryFn: ({ signal }) =>
      apiRequest<Inbox>('/notifications', { query: { page, pageSize: 25, unreadOnly }, signal }),
    placeholderData: keepPreviousData,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => apiRequest(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => apiRequest('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  if (inbox.isError) return <ErrorState error={inbox.error} onRetry={() => inbox.refetch()} />;

  const rows = inbox.data?.data ?? [];
  const total = inbox.data?.pagination.total ?? 0;
  const pageSize = inbox.data?.pagination.pageSize ?? 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card
      title="Inbox"
      subtitle={`${inbox.data?.unread ?? 0} unread of ${total}`}
      bodyClassName=""
      actions={
        <>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => {
                setUnreadOnly(event.target.checked);
                setPage(1);
              }}
            />
            Unread only
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending || (inbox.data?.unread ?? 0) === 0}
          >
            {markAll.isPending ? 'Marking…' : 'Mark all read'}
          </button>
        </>
      }
    >
      {inbox.isPending ? (
        <LoadingTable rows={6} columns={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          description="Notifications arrive when a budget you are involved in changes state, and when a submission or approval deadline is close."
        />
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {rows.map((row) => {
            const isUnread = row.readAt === null;
            const isOpen = expanded === row.id;
            const link = entityLink(row);
            return (
              <li key={row.id} className={isUnread ? 'bg-accent-50/40 dark:bg-accent-950/20' : ''}>
                <div className="flex items-start gap-3 px-4 py-3">
                  {/* The unread marker is also announced, not colour alone. */}
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      isUnread ? 'bg-accent-600 dark:bg-accent-400' : 'bg-transparent'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="w-full text-left"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : row.id)}
                    >
                      <p
                        className={`truncate text-xs ${
                          isUnread
                            ? 'font-semibold text-slate-900 dark:text-slate-50'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {isUnread ? <span className="sr-only">Unread. </span> : null}
                        {row.subject}
                      </p>
                      <p className="mt-0.5 text-2xs text-slate-500 dark:text-slate-400">
                        {NOTIFICATION_TYPE_LABELS[row.type] ?? row.type} ·{' '}
                        {formatDateTime(row.createdAt)}
                        {row.status === 'PENDING' ? ' · queued for delivery' : ''}
                        {row.status === 'FAILED' ? ' · delivery failed' : ''}
                      </p>
                    </button>

                    {isOpen ? (
                      <div className="mt-2 space-y-2">
                        {/* Plain text, preserved as written - see the note in
                            shared/src/notifications.ts on why these are not HTML. */}
                        <p className="whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-300">
                          {row.body}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {link ? (
                            <Link to={link} className="btn btn-secondary">
                              Open {row.entityType?.toLowerCase()}
                            </Link>
                          ) : null}
                          {isUnread ? (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => markRead.mutate(row.id)}
                              disabled={markRead.isPending}
                            >
                              Mark read
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function PreferencesTab() {
  const queryClient = useQueryClient();

  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: ({ signal }) =>
      apiRequest<{ data: PreferenceRow[] }>('/notifications/preferences', { signal }),
  });

  const setPref = useMutation({
    mutationFn: (input: { type: NotificationType; muted: boolean }) =>
      apiRequest('/notifications/preferences', { method: 'PUT', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-preferences'] }),
  });

  if (prefs.isError) return <ErrorState error={prefs.error} onRetry={() => prefs.refetch()} />;
  if (prefs.isPending) return <LoadingTable rows={8} columns={2} />;

  return (
    <Card
      title="What you are notified about"
      subtitle="Some notifications cannot be turned off. Being told that a budget you prepared was returned, or that a deadline has passed, is information you need whatever your preferences say."
      bodyClassName=""
    >
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {(prefs.data?.data ?? []).map((row) => (
          <li key={row.type} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-800 dark:text-slate-100">{row.label}</p>
              {!row.mutable ? (
                <p className="text-2xs text-slate-500 dark:text-slate-400">Always sent</p>
              ) : null}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={!row.muted}
                disabled={!row.mutable || setPref.isPending}
                onChange={(event) =>
                  setPref.mutate({ type: row.type, muted: !event.target.checked })
                }
              />
              <span className="text-slate-600 dark:text-slate-300">
                {row.muted ? 'Muted' : 'On'}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OperationsTab() {
  const queryClient = useQueryClient();

  const dispatch = useMutation({
    mutationFn: () =>
      apiRequest<{
        sent: number;
        failed: number;
        suppressed: number;
        skipped: number;
        transport: string;
      }>('/notifications/dispatch', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const scan = useMutation({
    mutationFn: () =>
      apiRequest<{
        cyclesScanned: number;
        submissionWarnings: number;
        submissionOverdue: number;
        approvalReminders: number;
        queued: number;
      }>('/notifications/scan-deadlines', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="space-y-4">
      <InlineNote>
        Both of these run automatically in the background. Running them here is for when you have
        just fixed a delivery problem and do not want to wait for the next cycle.
      </InlineNote>

      <Card
        title="Deliver queued notifications"
        subtitle="Notifications are written to an outbox inside the transaction that caused them, then delivered separately. A mail failure can never roll back an approval."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch.mutate()}
            disabled={dispatch.isPending}
          >
            {dispatch.isPending ? 'Dispatching…' : 'Dispatch now'}
          </button>
        }
      >
        {dispatch.isError ? <ErrorState error={dispatch.error} /> : null}
        {dispatch.data ? (
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            {[
              ['Sent', dispatch.data.sent],
              ['Failed', dispatch.data.failed],
              ['Suppressed', dispatch.data.suppressed],
              ['Not yet due', dispatch.data.skipped],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {label}
                </dt>
                <dd className="text-sm font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Transport
              </dt>
              <dd className="text-sm font-semibold">{dispatch.data.transport}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">Not run in this session.</p>
        )}
      </Card>

      <Card
        title="Scan deadlines"
        subtitle="Finds units that have not submitted as their deadline approaches, and budgets still waiting for approval. One reminder per person per day, whatever the scan frequency."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
          >
            {scan.isPending ? 'Scanning…' : 'Scan now'}
          </button>
        }
      >
        {scan.isError ? <ErrorState error={scan.error} /> : null}
        {scan.data ? (
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            {[
              ['Cycles', scan.data.cyclesScanned],
              ['Approaching', scan.data.submissionWarnings],
              ['Overdue', scan.data.submissionOverdue],
              ['Approvals', scan.data.approvalReminders],
              ['Queued', scan.data.queued],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-2xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {label}
                </dt>
                <dd className="text-sm font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">Not run in this session.</p>
        )}
      </Card>
    </div>
  );
}

type TabId = 'inbox' | 'preferences' | 'operations';

export default function Notifications() {
  const has = useHasPermission();
  const [tab, setTab] = useState<TabId>('inbox');

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'preferences', label: 'Preferences' },
    ...(has('settings:manage') ? [{ id: 'operations' as const, label: 'Operations' }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Approval requests are only ever sent to people who could actually approve the amount, and never to whoever prepared or submitted it. A request the system would then refuse is worse than no request at all."
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Notification sections" />
      <TabPanel id={tab}>
        {tab === 'inbox' ? <InboxTab /> : null}
        {tab === 'preferences' ? <PreferencesTab /> : null}
        {tab === 'operations' ? <OperationsTab /> : null}
      </TabPanel>
    </>
  );
}
