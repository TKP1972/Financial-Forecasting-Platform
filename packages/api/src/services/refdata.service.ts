/**
 * Reference-data import: applying a plan.
 *
 * The parse and validate half is pure and lives in `shared/src/refdata.ts`. This
 * half loads what already exists, hands it to the planner, and - only when asked
 * to commit - writes the plan.
 *
 * Three properties worth stating, because each one is a decision:
 *
 *   - **Dry run is the same code path.** `apply: false` builds the identical plan
 *     and stops before the write. A dry run that ran different logic would be a
 *     dry run you could not trust.
 *   - **Nothing is deleted, ever.** A code missing from the file means the file
 *     did not mention it, not that the account should vanish - and an account
 *     with budget lines against it must not vanish under any circumstances.
 *     Retirement is `isActive=false`, explicitly, in the file.
 *   - **All or nothing.** The whole import commits in one transaction. A chart of
 *     accounts half-loaded because row 400 was malformed is worse than one not
 *     loaded at all, because nobody can tell which half is live.
 */
import {
  AppError,
  parseCsv,
  planAccountImport,
  planBusinessUnitImport,
  sortByHierarchy,
  type AccountRow,
  type BusinessUnitRow,
  type ImportPlan,
} from '@ffp/shared';
import type { AccountType, CostBehaviour, CostCategory, SpendCategory } from '@prisma/client';
import { prisma } from '../db.js';
import { appendAuditEntry } from './audit.service.js';
import type { AuthenticatedUser } from './auth.service.js';

export type EntityKind = 'businessUnits' | 'accounts';

export interface ImportOptions {
  /** False (the default) validates and reports without writing anything. */
  apply?: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export interface ImportSummary {
  entity: EntityKind;
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  issues: ImportPlan<never>['issues'];
  /** What would change, so a dry run is reviewable rather than just a count. */
  preview: Array<{ code: string; action: 'create' | 'update'; changed?: string[] }>;
}

/** Accept either raw CSV text or an already-parsed array of records. */
export type ImportInput = string | ReadonlyArray<Record<string, string>>;

function toRecords(input: ImportInput): Array<Record<string, string>> {
  if (typeof input === 'string') return parseCsv(input);
  return input.map((record) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = value === null || value === undefined ? '' : String(value);
    }
    return out;
  });
}

function preview(plan: ImportPlan<{ code: string }>): ImportSummary['preview'] {
  return [
    ...plan.creates.map((row) => ({ code: row.code, action: 'create' as const })),
    ...plan.updates.map((entry) => ({
      code: entry.row.code,
      action: 'update' as const,
      changed: entry.changed,
    })),
  ];
}

export async function importBusinessUnits(
  input: ImportInput,
  actor: AuthenticatedUser,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const records = toRecords(input);
  const current = await prisma.businessUnit.findMany({
    select: {
      code: true,
      name: true,
      costCentre: true,
      currency: true,
      isActive: true,
      parent: { select: { code: true } },
    },
  });

  const existing = new Map(
    current.map((unit) => [
      unit.code,
      {
        name: unit.name,
        parentCode: unit.parent?.code ?? null,
        costCentre: unit.costCentre,
        currency: unit.currency,
        isActive: unit.isActive,
      },
    ]),
  );

  const plan = planBusinessUnitImport(records, existing);
  const summary = summarise('businessUnits', plan, options.apply ?? false);

  if (!options.apply || plan.issues.length > 0) return summary;

  const toWrite = sortByHierarchy(
    [...plan.creates, ...plan.updates.map((u) => u.row)],
    new Set(existing.keys()),
  );

  await prisma.$transaction(async (tx) => {
    for (const row of toWrite) {
      // Parents are resolved by code inside the loop rather than up front,
      // because a parent created earlier in this same loop has no id until now.
      const parentId = row.parentCode
        ? ((
            await tx.businessUnit.findUnique({
              where: { code: row.parentCode },
              select: { id: true },
            })
          )?.id ?? null)
        : null;

      if (row.parentCode && parentId === null) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Parent business unit '${row.parentCode}' could not be resolved while writing '${row.code}'.`,
        );
      }

      await tx.businessUnit.upsert({
        where: { code: row.code },
        create: {
          code: row.code,
          name: row.name,
          parentId,
          costCentre: row.costCentre,
          currency: row.currency,
          isActive: row.isActive,
        },
        update: {
          name: row.name,
          parentId,
          costCentre: row.costCentre,
          currency: row.currency,
          isActive: row.isActive,
        },
      });
    }

    await recordImportAudit(tx, actor, summary, options);
  });

  return summary;
}

export async function importAccounts(
  input: ImportInput,
  actor: AuthenticatedUser,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const records = toRecords(input);
  const current = await prisma.account.findMany({
    select: {
      code: true,
      name: true,
      type: true,
      category: true,
      spendCategory: true,
      costBehaviour: true,
      variableShare: true,
      isActive: true,
      parent: { select: { code: true } },
    },
  });

  const existing = new Map(
    current.map((account) => [
      account.code,
      {
        name: account.name,
        type: account.type as string,
        category: (account.category as string | null) ?? null,
        parentCode: account.parent?.code ?? null,
        spendCategory: (account.spendCategory as string | null) ?? null,
        costBehaviour: (account.costBehaviour as string | null) ?? null,
        // Compared as a string so 0.35 and 0.3500 are the same value, not a
        // spurious update on every re-import.
        variableShare: account.variableShare?.toString() ?? null,
        isActive: account.isActive,
      },
    ]),
  );

  const plan = planAccountImport(records, existing);
  const summary = summarise('accounts', plan, options.apply ?? false);

  if (!options.apply || plan.issues.length > 0) return summary;

  const toWrite = sortByHierarchy(
    [...plan.creates, ...plan.updates.map((u) => u.row)],
    new Set(existing.keys()),
  );

  await prisma.$transaction(async (tx) => {
    for (const row of toWrite) {
      const parentId = row.parentCode
        ? ((await tx.account.findUnique({ where: { code: row.parentCode }, select: { id: true } }))
            ?.id ?? null)
        : null;

      if (row.parentCode && parentId === null) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Parent account '${row.parentCode}' could not be resolved while writing '${row.code}'.`,
        );
      }

      const fields = {
        name: row.name,
        type: row.type as AccountType,
        category: (row.category as CostCategory | null) ?? null,
        parentId,
        spendCategory: (row.spendCategory as SpendCategory | null) ?? null,
        costBehaviour: (row.costBehaviour as CostBehaviour | null) ?? null,
        variableShare: row.variableShare,
        isActive: row.isActive,
      };

      await tx.account.upsert({
        where: { code: row.code },
        create: { code: row.code, ...fields },
        update: fields,
      });
    }

    await recordImportAudit(tx, actor, summary, options);
  });

  return summary;
}

function summarise<T extends { code: string }>(
  entity: EntityKind,
  plan: ImportPlan<T>,
  applied: boolean,
): ImportSummary {
  return {
    entity,
    // An import with issues never writes, so it is never "applied" whatever the
    // caller asked for.
    applied: applied && plan.issues.length === 0,
    created: plan.creates.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged.length,
    issues: plan.issues,
    preview: preview(plan),
  };
}

async function recordImportAudit(
  tx: Parameters<typeof appendAuditEntry>[1],
  actor: AuthenticatedUser,
  summary: ImportSummary,
  options: ImportOptions,
): Promise<void> {
  await appendAuditEntry(
    {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'IMPORT',
      entityType: summary.entity === 'accounts' ? 'Account' : 'BusinessUnit',
      summary: `Imported reference data: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged`,
      // The codes, not the whole file: enough to answer "when did this account
      // appear?" without putting a spreadsheet in the audit trail.
      changes: {
        created: summary.preview.filter((p) => p.action === 'create').map((p) => p.code),
        updated: summary.preview.filter((p) => p.action === 'update').map((p) => p.code),
      },
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
    },
    tx,
  );
}

export type { AccountRow, BusinessUnitRow };
