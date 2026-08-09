/**
 * Reference-data import: CSV parsing and validation.
 *
 * Setting up a new business unit or a new chart of accounts by hand through a UI
 * is the single biggest barrier to a pilot. Finance teams already hold this data
 * in a spreadsheet, so the fastest path to a usable system is to accept the
 * spreadsheet.
 *
 * Everything here is pure: parse the text, validate the rows, and produce a
 * *plan* describing what would change. Applying the plan is the API's job. That
 * split is what makes a genuine dry run possible - the dry run is not a separate
 * code path that might drift from the real one, it is the same plan with the
 * apply step skipped.
 *
 * Rules the validator enforces, all of which have bitten real imports:
 *   - the natural key (`code`) is the identity, not a row number
 *   - a duplicate code within one file is an error, not last-write-wins
 *   - a parent may appear anywhere in the file, or already exist in the database
 *   - a cycle in the hierarchy is an error (a unit cannot be its own ancestor)
 *   - nothing is ever deleted; disappearance from the file means nothing
 */
import { ACCOUNT_TYPES, COST_BEHAVIOURS, COST_CATEGORIES, SPEND_CATEGORIES } from './domain.js';

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------

/**
 * Parse RFC 4180 CSV into rows keyed by header.
 *
 * Hand-written rather than pulled from a package because the requirement is
 * small and exact: quoted fields containing commas, escaped quotes (`""`), CRLF
 * or LF line endings, and a UTF-8 BOM - which Excel writes by default and which
 * would otherwise become part of the first column's name, so `code` silently
 * stops matching.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  // \uFEFF as an escape, not a literal: a raw BOM in source is invisible in
  // every editor and lint rightly flags it.
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Ignore a trailing blank line rather than emitting an empty record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      // Consume CRLF as one terminator.
      if (input[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (field !== '' || row.length > 0) endRow();

  if (rows.length === 0) return [];

  const headers = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

export interface ImportIssue {
  /** 1-based row number as it appears in the file, counting the header as 1. */
  row: number;
  field?: string;
  message: string;
}

export interface BusinessUnitRow {
  code: string;
  name: string;
  parentCode: string | null;
  costCentre: string | null;
  currency: string;
  isActive: boolean;
}

export interface AccountRow {
  code: string;
  name: string;
  type: string;
  category: string | null;
  parentCode: string | null;
  spendCategory: string | null;
  costBehaviour: string | null;
  variableShare: string | null;
  isActive: boolean;
}

export interface ImportPlan<T> {
  /** Rows that would be inserted. */
  creates: T[];
  /** Rows that would update an existing record, with the fields that differ. */
  updates: Array<{ row: T; changed: string[] }>;
  /** Rows identical to what is already stored. */
  unchanged: T[];
  issues: ImportIssue[];
}

const TRUTHY = new Set(['true', '1', 'yes', 'y', 'active']);
const FALSEY = new Set(['false', '0', 'no', 'n', 'inactive']);

/**
 * Parse a boolean cell.
 *
 * Blank means true: a chart of accounts exported from a finance system rarely
 * carries an `isActive` column at all, and the sane default for a row someone
 * has chosen to import is that they want it usable. An unrecognised value is an
 * error rather than a guess.
 */
function parseFlag(
  value: string | undefined,
  row: number,
  field: string,
  issues: ImportIssue[],
): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '') return true;
  if (TRUTHY.has(raw)) return true;
  if (FALSEY.has(raw)) return false;
  issues.push({ row, field, message: `'${value}' is not a yes/no value.` });
  return true;
}

function required(
  record: Record<string, string>,
  field: string,
  row: number,
  issues: ImportIssue[],
): string {
  const value = (record[field] ?? '').trim();
  if (value === '') issues.push({ row, field, message: `${field} is required.` });
  return value;
}

function optionalEnum(
  record: Record<string, string>,
  field: string,
  allowed: readonly string[],
  row: number,
  issues: ImportIssue[],
): string | null {
  const value = (record[field] ?? '').trim().toUpperCase();
  if (value === '') return null;
  if (!allowed.includes(value)) {
    issues.push({ row, field, message: `'${value}' is not one of: ${allowed.join(', ')}.` });
    return null;
  }
  return value;
}

/** Existing records, keyed by code, so the plan can distinguish create from update. */
export type ExistingBusinessUnits = ReadonlyMap<string, Omit<BusinessUnitRow, 'code'>>;
export type ExistingAccounts = ReadonlyMap<string, Omit<AccountRow, 'code'>>;

export function planBusinessUnitImport(
  records: ReadonlyArray<Record<string, string>>,
  existing: ExistingBusinessUnits,
): ImportPlan<BusinessUnitRow> {
  const issues: ImportIssue[] = [];
  const parsed: BusinessUnitRow[] = [];
  const seen = new Map<string, number>();

  records.forEach((record, index) => {
    const row = index + 2; // header is row 1
    const code = required(record, 'code', row, issues).toUpperCase();
    const name = required(record, 'name', row, issues);

    if (code !== '' && seen.has(code)) {
      issues.push({
        row,
        field: 'code',
        message: `Duplicate code '${code}', first seen on row ${seen.get(code)}.`,
      });
      return;
    }
    if (code !== '') seen.set(code, row);
    if (code === '' || name === '') return;

    const parentCode = (record.parentCode ?? '').trim().toUpperCase() || null;
    if (parentCode === code) {
      issues.push({
        row,
        field: 'parentCode',
        message: 'A business unit cannot be its own parent.',
      });
      return;
    }

    parsed.push({
      code,
      name,
      parentCode,
      costCentre: (record.costCentre ?? '').trim() || null,
      currency: ((record.currency ?? '').trim() || 'USD').toUpperCase(),
      isActive: parseFlag(record.isActive, row, 'isActive', issues),
    });
  });

  checkParents(parsed, existing, issues, seen, 'business unit');
  return classify(parsed, existing, issues, compareBusinessUnit);
}

export function planAccountImport(
  records: ReadonlyArray<Record<string, string>>,
  existing: ExistingAccounts,
): ImportPlan<AccountRow> {
  const issues: ImportIssue[] = [];
  const parsed: AccountRow[] = [];
  const seen = new Map<string, number>();

  records.forEach((record, index) => {
    const row = index + 2;
    const code = required(record, 'code', row, issues).toUpperCase();
    const name = required(record, 'name', row, issues);
    const type = optionalEnum(record, 'type', ACCOUNT_TYPES, row, issues);

    if (type === null && (record.type ?? '').trim() === '') {
      issues.push({ row, field: 'type', message: 'type is required.' });
    }

    if (code !== '' && seen.has(code)) {
      issues.push({
        row,
        field: 'code',
        message: `Duplicate code '${code}', first seen on row ${seen.get(code)}.`,
      });
      return;
    }
    if (code !== '') seen.set(code, row);
    if (code === '' || name === '' || type === null) return;

    const parentCode = (record.parentCode ?? '').trim().toUpperCase() || null;
    if (parentCode === code) {
      issues.push({ row, field: 'parentCode', message: 'An account cannot be its own parent.' });
      return;
    }

    const costBehaviour = optionalEnum(record, 'costBehaviour', COST_BEHAVIOURS, row, issues);
    const variableShare = (record.variableShare ?? '').trim() || null;

    // The variable share is meaningful only for a semi-variable cost, and is
    // mandatory there - a SEMI_VARIABLE account with no split cannot be flexed,
    // which is the entire reason for classifying it.
    if (costBehaviour === 'SEMI_VARIABLE' && variableShare === null) {
      issues.push({
        row,
        field: 'variableShare',
        message: 'A SEMI_VARIABLE account needs a variableShare between 0 and 1.',
      });
    }
    if (variableShare !== null) {
      const share = Number(variableShare);
      if (!Number.isFinite(share) || share < 0 || share > 1) {
        issues.push({
          row,
          field: 'variableShare',
          message: `'${variableShare}' is not a fraction between 0 and 1. Rates are fractions, not percentages.`,
        });
      } else if (costBehaviour !== 'SEMI_VARIABLE' && costBehaviour !== null) {
        issues.push({
          row,
          field: 'variableShare',
          message: `variableShare applies only to SEMI_VARIABLE accounts, not ${costBehaviour}.`,
        });
      }
    }

    parsed.push({
      code,
      name,
      type,
      category: optionalEnum(record, 'category', COST_CATEGORIES, row, issues),
      parentCode,
      spendCategory: optionalEnum(record, 'spendCategory', SPEND_CATEGORIES, row, issues),
      costBehaviour,
      variableShare,
      isActive: parseFlag(record.isActive, row, 'isActive', issues),
    });
  });

  checkParents(parsed, existing, issues, seen, 'account');
  return classify(parsed, existing, issues, compareAccount);
}

/**
 * Every parent must resolve, and the hierarchy must be acyclic.
 *
 * A parent may live in this file or already be in the database, so forward
 * references are fine - which matters, because a chart of accounts exported in
 * code order routinely lists children before parents.
 */
function checkParents<T extends { code: string; parentCode: string | null }>(
  rows: readonly T[],
  existing: ReadonlyMap<string, unknown>,
  issues: ImportIssue[],
  rowNumbers: ReadonlyMap<string, number>,
  noun: string,
): void {
  const inFile = new Map(rows.map((r) => [r.code, r]));

  for (const row of rows) {
    if (!row.parentCode) continue;
    if (!inFile.has(row.parentCode) && !existing.has(row.parentCode)) {
      issues.push({
        row: rowNumbers.get(row.code) ?? 0,
        field: 'parentCode',
        message: `Parent ${noun} '${row.parentCode}' is neither in this file nor already loaded.`,
      });
      continue;
    }

    // Walk up through the file's own rows. A cycle entirely inside the database
    // cannot be created here, because an existing parent's own parent is not
    // being changed by this row.
    const visited = new Set<string>([row.code]);
    let cursor = inFile.get(row.parentCode);
    while (cursor) {
      if (visited.has(cursor.code)) {
        issues.push({
          row: rowNumbers.get(row.code) ?? 0,
          field: 'parentCode',
          message: `Hierarchy cycle: '${row.code}' is its own ancestor via '${cursor.code}'.`,
        });
        break;
      }
      visited.add(cursor.code);
      cursor = cursor.parentCode ? inFile.get(cursor.parentCode) : undefined;
    }
  }
}

function classify<T extends { code: string }>(
  rows: readonly T[],
  existing: ReadonlyMap<string, unknown>,
  issues: ImportIssue[],
  compare: (row: T, current: never) => string[],
): ImportPlan<T> {
  const creates: T[] = [];
  const updates: Array<{ row: T; changed: string[] }> = [];
  const unchanged: T[] = [];

  for (const row of rows) {
    const current = existing.get(row.code);
    if (current === undefined) {
      creates.push(row);
      continue;
    }
    const changed = compare(row, current as never);
    if (changed.length === 0) unchanged.push(row);
    else updates.push({ row, changed });
  }

  return { creates, updates, unchanged, issues };
}

function diff(fields: Record<string, [unknown, unknown]>): string[] {
  return Object.entries(fields)
    .filter(([, [next, current]]) => next !== current)
    .map(([field]) => field);
}

function compareBusinessUnit(
  row: BusinessUnitRow,
  current: Omit<BusinessUnitRow, 'code'>,
): string[] {
  return diff({
    name: [row.name, current.name],
    parentCode: [row.parentCode, current.parentCode],
    costCentre: [row.costCentre, current.costCentre],
    currency: [row.currency, current.currency],
    isActive: [row.isActive, current.isActive],
  });
}

function compareAccount(row: AccountRow, current: Omit<AccountRow, 'code'>): string[] {
  return diff({
    name: [row.name, current.name],
    type: [row.type, current.type],
    category: [row.category, current.category],
    parentCode: [row.parentCode, current.parentCode],
    spendCategory: [row.spendCategory, current.spendCategory],
    costBehaviour: [row.costBehaviour, current.costBehaviour],
    variableShare: [row.variableShare, current.variableShare],
    isActive: [row.isActive, current.isActive],
  });
}

/**
 * Order rows so that a parent is always applied before its children.
 *
 * Necessary because parents are stored as foreign keys, and a create referencing
 * a parent that does not exist yet would fail. Rows whose parent is already in
 * the database sort first; anything left over after the passes (which can only
 * be a cycle, already reported as an issue) is appended so it is not silently
 * dropped.
 */
export function sortByHierarchy<T extends { code: string; parentCode: string | null }>(
  rows: readonly T[],
  existingCodes: ReadonlySet<string>,
): T[] {
  const remaining = new Map(rows.map((r) => [r.code, r]));
  const placed = new Set(existingCodes);
  const ordered: T[] = [];

  let progress = true;
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const [code, row] of [...remaining]) {
      if (row.parentCode === null || placed.has(row.parentCode)) {
        ordered.push(row);
        placed.add(code);
        remaining.delete(code);
        progress = true;
      }
    }
  }

  return [...ordered, ...remaining.values()];
}
