import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNote,
  LoadingTable,
  PageHeader,
  SelectField,
  StatusPill,
} from '@/components/ui';
import { apiRequest, downloadFile, getData } from '@/lib/api';
import { humanise } from '@/lib/format';
import { useHasPermission } from '@/lib/permissions';
import type { Account, BusinessUnit } from '@/types/api';

type Entity = 'business-units' | 'accounts';

interface ImportIssue {
  row: number;
  field?: string;
  message: string;
}

interface ImportSummary {
  entity: string;
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  issues: ImportIssue[];
  preview: Array<{ code: string; action: 'create' | 'update'; changed?: string[] }>;
}

const ENTITY_LABEL: Record<Entity, string> = {
  'business-units': 'Business units',
  accounts: 'Chart of accounts',
};

const COLUMNS: Record<Entity, string> = {
  'business-units': 'code, name, parentCode, costCentre, currency, isActive',
  accounts:
    'code, name, type, category, parentCode, spendCategory, costBehaviour, variableShare, isActive',
};

/**
 * The reference data itself, readable by anyone who can read a budget.
 *
 * This page used to render nothing but a permission notice to every role
 * except Admin. Reading the chart of accounts is not privileged - it populates
 * the pickers on Budgets, Forecasting and Variance, so every role already sees
 * it piecemeal. Only *importing* changes what budgets can be posted against,
 * and only that is restricted. Showing a bare refusal made a working screen
 * look unfinished.
 */
function ReferenceTable({ entity }: { entity: Entity }) {
  const units = useQuery({
    queryKey: ['business-units'],
    queryFn: ({ signal }) => getData<BusinessUnit[]>('/org/business-units', undefined, signal),
    enabled: entity === 'business-units',
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => getData<Account[]>('/org/accounts', undefined, signal),
    enabled: entity === 'accounts',
  });

  const query = entity === 'business-units' ? units : accounts;

  if (query.isPending) return <LoadingTable rows={6} columns={4} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (entity === 'business-units') {
    return (
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption>
            The unit hierarchy every budget is posted against. Only active units are listed; a
            deactivated unit keeps its history and stops accepting new lines.
          </caption>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Currency</th>
              <th scope="col" className="num">
                Budgets
              </th>
            </tr>
          </thead>
          <tbody>
            {(units.data ?? []).map((unit) => (
              <tr key={unit.id}>
                <td className="font-mono text-2xs">{unit.code}</td>
                <td className="font-medium text-slate-800 dark:text-slate-100">{unit.name}</td>
                <td>{unit.currency}</td>
                <td className="num">{unit.budgetCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <caption>
          The chart of accounts. An account&rsquo;s type decides how variance is read on it -
          underspend on a cost is favourable, under-delivery of revenue is not.
        </caption>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Category</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {(accounts.data ?? []).map((account) => (
            <tr key={account.id}>
              <td className="font-mono text-2xs">{account.code}</td>
              <td className="font-medium text-slate-800 dark:text-slate-100">{account.name}</td>
              <td>{humanise(account.type)}</td>
              <td>{account.category ? humanise(account.category) : '—'}</td>
              <td>
                <StatusPill status={account.isActive ? 'ACTIVE' : 'INACTIVE'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ReferenceData() {
  const has = useHasPermission();
  const [entity, setEntity] = useState<Entity>('business-units');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = useMutation({
    mutationFn: (apply: boolean) =>
      apiRequest<ImportSummary>(`/import/${entity}`, {
        method: 'POST',
        body: { csv },
        query: { apply },
      }),
    onSuccess: setResult,
  });

  const canImport = has('settings:manage');

  if (!canImport) {
    return (
      <>
        <PageHeader
          title="Reference data"
          description="The business units and accounts every budget is posted against."
        />
        <Card className="mb-4">
          <div className="max-w-xs">
            <SelectField
              id="ref-entity"
              label="Showing"
              value={entity}
              onChange={(value) => setEntity(value as Entity)}
              options={[
                { value: 'business-units', label: ENTITY_LABEL['business-units'] },
                { value: 'accounts', label: ENTITY_LABEL.accounts },
              ]}
            />
          </div>
        </Card>
        <Card bodyClassName="p-0">
          <ReferenceTable entity={entity} />
        </Card>
        <div className="mt-4">
          <InlineNote>
            You can read reference data but not load it. Importing changes what every budget in the
            platform can be posted against, so it requires the <code>settings:manage</code>
            permission — ask an administrator.
          </InlineNote>
        </div>
      </>
    );
  }

  async function handleFile(file: File): Promise<void> {
    setCsv(await file.text());
    setResult(null);
  }

  const hasIssues = (result?.issues.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Reference data"
        description="Load business units and the chart of accounts from a spreadsheet. Nothing is ever deleted by an import - a code missing from the file means the file did not mention it, not that it should disappear. Retire a record by setting isActive to no."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Choose and paste" bodyClassName="space-y-3 p-4">
          <SelectField
            label="What are you importing?"
            value={entity}
            onChange={(value) => {
              setEntity(value as Entity);
              setCsv('');
              setResult(null);
            }}
            options={[
              { value: 'business-units', label: ENTITY_LABEL['business-units'] },
              { value: 'accounts', label: ENTITY_LABEL.accounts },
            ]}
            hint={`Columns: ${COLUMNS[entity]}`}
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileInput.current?.click()}
            >
              Choose CSV file
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => downloadFile(`/import/templates/${entity}`, `${entity}-template.csv`)}
            >
              Download template
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="csv-body">
              CSV
            </label>
            <textarea
              id="csv-body"
              className="input h-56 font-mono text-2xs"
              spellCheck={false}
              value={csv}
              placeholder={`${COLUMNS[entity]}\n…`}
              onChange={(event) => {
                setCsv(event.target.value);
                setResult(null);
              }}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={csv.trim() === '' || run.isPending}
              onClick={() => run.mutate(false)}
            >
              {run.isPending ? 'Checking…' : 'Check (writes nothing)'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              // Deliberately requires a clean check first. An import applied
              // without anyone reading the preview is how a chart of accounts
              // acquires two hundred rows nobody meant to add.
              disabled={run.isPending || result === null || hasIssues || result.applied}
              onClick={() => run.mutate(true)}
            >
              {run.isPending ? 'Importing…' : 'Apply import'}
            </button>
          </div>
          {result === null && csv.trim() !== '' ? (
            <p className="text-2xs text-slate-600 dark:text-slate-400">
              Check the file first. Apply is enabled once the check comes back clean.
            </p>
          ) : null}
        </Card>

        <Card title="2. Review" bodyClassName="p-4">
          {run.isError ? <ErrorState error={run.error} /> : null}

          {result === null && !run.isError ? (
            <EmptyState
              title="Nothing checked yet"
              description="Paste or choose a file and select Check. You will see exactly what would be created and what would change before anything is written."
            />
          ) : null}

          {result ? (
            <div className="space-y-3">
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  result.applied
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
                    : hasIssues
                      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
                      : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-200'
                }`}
              >
                {result.applied
                  ? 'Imported. The changes below are now live.'
                  : hasIssues
                    ? 'Not imported. Fix the problems below and check again.'
                    : 'Dry run only. Nothing has been written.'}
              </div>

              <dl className="grid grid-cols-3 gap-3 text-xs">
                {[
                  ['Create', result.created],
                  ['Update', result.updated],
                  ['Unchanged', result.unchanged],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-2xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                      {label}
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>

              {hasIssues ? (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-red-800 dark:text-red-300">
                    {result.issues.length} problem{result.issues.length === 1 ? '' : 's'}
                  </h3>
                  <ul className="max-h-56 space-y-1 overflow-y-auto text-2xs">
                    {result.issues.map((issue, index) => (
                      <li key={index} className="text-slate-700 dark:text-slate-300">
                        <span className="font-semibold tabular-nums">Row {issue.row}</span>
                        {issue.field ? (
                          <span className="text-slate-600"> · {issue.field}</span>
                        ) : null}
                        {' — '}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.preview.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-xs font-semibold">What changes</h3>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="table">
                      <caption className="sr-only">
                        Rows this import would create or update, with the fields affected.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Code</th>
                          <th scope="col">Action</th>
                          <th scope="col">Fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.preview.map((entry) => (
                          <tr key={`${entry.action}-${entry.code}`}>
                            <td className="font-mono text-2xs">{entry.code}</td>
                            <td>{entry.action === 'create' ? 'New' : 'Update'}</td>
                            <td className="text-2xs text-slate-600 dark:text-slate-400">
                              {entry.changed?.join(', ') ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      <div className="mt-4">
        <InlineNote>
          Re-importing the same file is safe: rows that already match are reported as unchanged and
          nothing is rewritten. That makes the file, not the platform, the place the chart of
          accounts is maintained.
        </InlineNote>
      </div>
    </>
  );
}
