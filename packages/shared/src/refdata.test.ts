import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  planAccountImport,
  planBusinessUnitImport,
  sortByHierarchy,
  type AccountRow,
  type BusinessUnitRow,
} from './refdata.js';

const noExistingUnits = new Map<string, Omit<BusinessUnitRow, 'code'>>();
const noExistingAccounts = new Map<string, Omit<AccountRow, 'code'>>();

describe('parseCsv', () => {
  it('parses a simple file', () => {
    const rows = parseCsv('code,name\nMOB,Mobile\nFIX,Fixed\n');
    expect(rows).toEqual([
      { code: 'MOB', name: 'Mobile' },
      { code: 'FIX', name: 'Fixed' },
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    const rows = parseCsv('code,name\nMOB,"Mobile, Networks"\n');
    expect(rows[0]?.name).toBe('Mobile, Networks');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('code,name\nMOB,"He said ""go"""\n');
    expect(rows[0]?.name).toBe('He said "go"');
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('code,name\r\nMOB,Mobile\r\nFIX,Fixed\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.code).toBe('FIX');
  });

  it('strips a UTF-8 BOM so the first header still matches', () => {
    // Excel writes one by default; left in place it makes the header '<BOM>code'
    // and every lookup of 'code' silently returns undefined.
    const rows = parseCsv('\uFEFFcode,name\nMOB,Mobile\n');
    expect(rows[0]?.code).toBe('MOB');
  });

  it('pads short rows rather than dropping the record', () => {
    const rows = parseCsv('code,name,currency\nMOB,Mobile\n');
    expect(rows[0]).toEqual({ code: 'MOB', name: 'Mobile', currency: '' });
  });

  it('returns nothing for an empty file or a header alone', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('code,name\n')).toEqual([]);
  });

  it('ignores a trailing blank line', () => {
    expect(parseCsv('code\nMOB\n\n')).toHaveLength(1);
  });

  it('preserves a quoted newline inside a field', () => {
    const rows = parseCsv('code,name\nMOB,"Mobile\nNetworks"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Mobile\nNetworks');
  });
});

describe('planBusinessUnitImport', () => {
  it('plans creates for an empty database', () => {
    const plan = planBusinessUnitImport(
      parseCsv('code,name\nGRP,Group\nMOB,Mobile\n'),
      noExistingUnits,
    );
    expect(plan.issues).toEqual([]);
    expect(plan.creates.map((r) => r.code)).toEqual(['GRP', 'MOB']);
    expect(plan.updates).toHaveLength(0);
  });

  it('uppercases codes so casing is not a second identity', () => {
    const plan = planBusinessUnitImport(parseCsv('code,name\nmob,Mobile\n'), noExistingUnits);
    expect(plan.creates[0]?.code).toBe('MOB');
  });

  it('defaults currency to USD and isActive to true', () => {
    const plan = planBusinessUnitImport(parseCsv('code,name\nMOB,Mobile\n'), noExistingUnits);
    expect(plan.creates[0]?.currency).toBe('USD');
    expect(plan.creates[0]?.isActive).toBe(true);
  });

  it('rejects a duplicate code within one file', () => {
    const plan = planBusinessUnitImport(
      parseCsv('code,name\nMOB,Mobile\nMOB,Mobile Again\n'),
      noExistingUnits,
    );
    expect(plan.issues[0]?.message).toMatch(/Duplicate code 'MOB', first seen on row 2/);
    expect(plan.creates).toHaveLength(1);
  });

  it('requires code and name', () => {
    const plan = planBusinessUnitImport(parseCsv('code,name\n,Nameless\nORP,\n'), noExistingUnits);
    expect(plan.issues.map((i) => i.field)).toEqual(['code', 'name']);
    expect(plan.creates).toHaveLength(0);
  });

  it('accepts a parent defined later in the file', () => {
    // A hierarchy exported in code order routinely lists children first.
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode\nMOB,Mobile,GRP\nGRP,Group,\n'),
      noExistingUnits,
    );
    expect(plan.issues).toEqual([]);
  });

  it('accepts a parent that is already in the database', () => {
    const existing = new Map([
      [
        'GRP',
        { name: 'Group', parentCode: null, costCentre: null, currency: 'USD', isActive: true },
      ],
    ]);
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode\nMOB,Mobile,GRP\n'),
      existing,
    );
    expect(plan.issues).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });

  it('rejects an unresolvable parent', () => {
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode\nMOB,Mobile,NOPE\n'),
      noExistingUnits,
    );
    expect(plan.issues[0]?.message).toMatch(/Parent business unit 'NOPE' is neither in this file/);
  });

  it('rejects a self-parent', () => {
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode\nMOB,Mobile,MOB\n'),
      noExistingUnits,
    );
    expect(plan.issues[0]?.message).toMatch(/cannot be its own parent/);
  });

  it('detects a hierarchy cycle', () => {
    // A -> B -> C -> A. Left unchecked this makes every consolidation walk hang.
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode\nA,A,B\nB,B,C\nC,C,A\n'),
      noExistingUnits,
    );
    expect(plan.issues.some((i) => /Hierarchy cycle/.test(i.message))).toBe(true);
  });

  it('classifies an identical re-import as unchanged', () => {
    const existing = new Map([
      [
        'MOB',
        { name: 'Mobile', parentCode: null, costCentre: 'CC1', currency: 'USD', isActive: true },
      ],
    ]);
    const plan = planBusinessUnitImport(
      parseCsv('code,name,parentCode,costCentre,currency,isActive\nMOB,Mobile,,CC1,USD,true\n'),
      existing,
    );
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.creates).toHaveLength(0);
  });

  it('names exactly the fields that differ', () => {
    const existing = new Map([
      [
        'MOB',
        { name: 'Mobile', parentCode: null, costCentre: 'CC1', currency: 'USD', isActive: true },
      ],
    ]);
    const plan = planBusinessUnitImport(
      parseCsv(
        'code,name,parentCode,costCentre,currency,isActive\nMOB,Mobile Networks,,CC2,USD,true\n',
      ),
      existing,
    );
    expect(plan.updates[0]?.changed.sort()).toEqual(['costCentre', 'name']);
  });

  it('reads a deactivation from the file', () => {
    const existing = new Map([
      [
        'MOB',
        { name: 'Mobile', parentCode: null, costCentre: null, currency: 'USD', isActive: true },
      ],
    ]);
    const plan = planBusinessUnitImport(parseCsv('code,name,isActive\nMOB,Mobile,no\n'), existing);
    expect(plan.updates[0]?.changed).toEqual(['isActive']);
    expect(plan.updates[0]?.row.isActive).toBe(false);
  });

  it('rejects an unrecognised yes/no value rather than guessing', () => {
    const plan = planBusinessUnitImport(
      parseCsv('code,name,isActive\nMOB,Mobile,maybe\n'),
      noExistingUnits,
    );
    expect(plan.issues[0]?.field).toBe('isActive');
  });

  it('never plans a delete for a code missing from the file', () => {
    const existing = new Map([
      ['OLD', { name: 'Old', parentCode: null, costCentre: null, currency: 'USD', isActive: true }],
    ]);
    const plan = planBusinessUnitImport(parseCsv('code,name\nMOB,Mobile\n'), existing);
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(Object.keys(plan)).not.toContain('deletes');
  });
});

describe('planAccountImport', () => {
  const csv = (body: string) =>
    parseCsv(
      'code,name,type,category,parentCode,spendCategory,costBehaviour,variableShare,isActive\n' +
        body,
    );

  it('plans a valid chart of accounts', () => {
    const plan = planAccountImport(
      csv(
        '4000,Service Revenue,REVENUE,,,,,,true\n6100,Energy,OPEX,INDIRECT,,FACILITIES,SEMI_VARIABLE,0.35,true\n',
      ),
      noExistingAccounts,
    );
    expect(plan.issues).toEqual([]);
    expect(plan.creates).toHaveLength(2);
    expect(plan.creates[1]?.variableShare).toBe('0.35');
  });

  it('requires a type', () => {
    const plan = planAccountImport(csv('4000,Revenue,,,,,,,true\n'), noExistingAccounts);
    expect(plan.issues.some((i) => i.field === 'type')).toBe(true);
    expect(plan.creates).toHaveLength(0);
  });

  it('rejects an unknown type', () => {
    const plan = planAccountImport(csv('4000,Revenue,INCOME,,,,,,true\n'), noExistingAccounts);
    expect(plan.issues[0]?.message).toMatch(/is not one of: REVENUE, COGS, OPEX/);
  });

  it('accepts a lowercase type', () => {
    const plan = planAccountImport(csv('4000,Revenue,revenue,,,,,,true\n'), noExistingAccounts);
    expect(plan.issues).toEqual([]);
    expect(plan.creates[0]?.type).toBe('REVENUE');
  });

  it('requires a variable share on a semi-variable account', () => {
    // Without one the account cannot be flexed, which is the only reason to
    // classify it semi-variable in the first place.
    const plan = planAccountImport(
      csv('6100,Energy,OPEX,,,,SEMI_VARIABLE,,true\n'),
      noExistingAccounts,
    );
    expect(plan.issues[0]?.message).toMatch(/needs a variableShare between 0 and 1/);
  });

  it('rejects a variable share expressed as a percentage', () => {
    const plan = planAccountImport(
      csv('6100,Energy,OPEX,,,,SEMI_VARIABLE,35,true\n'),
      noExistingAccounts,
    );
    expect(plan.issues[0]?.message).toMatch(/fractions, not percentages/);
  });

  it('rejects a variable share on a fixed account', () => {
    const plan = planAccountImport(csv('6100,Rent,OPEX,,,,FIXED,0.4,true\n'), noExistingAccounts);
    expect(plan.issues[0]?.message).toMatch(/applies only to SEMI_VARIABLE/);
  });

  it('treats 0 and 1 as valid shares', () => {
    for (const share of ['0', '1']) {
      const plan = planAccountImport(
        csv(`6100,Energy,OPEX,,,,SEMI_VARIABLE,${share},true\n`),
        noExistingAccounts,
      );
      expect(plan.issues).toEqual([]);
    }
  });

  it('does not report a spurious update when only the decimal scale differs', () => {
    // 0.35 stored as numeric(18,8) reads back as "0.35"; a naive numeric
    // comparison against the string would churn every row on every import.
    const existing = new Map([
      [
        '6100',
        {
          name: 'Energy',
          type: 'OPEX',
          category: null,
          parentCode: null,
          spendCategory: null,
          costBehaviour: 'SEMI_VARIABLE',
          variableShare: '0.35',
          isActive: true,
        },
      ],
    ]);
    const plan = planAccountImport(csv('6100,Energy,OPEX,,,,SEMI_VARIABLE,0.35,true\n'), existing);
    expect(plan.unchanged).toHaveLength(1);
  });
});

describe('sortByHierarchy', () => {
  it('puts a parent before its children', () => {
    const rows = [
      { code: 'C', parentCode: 'B' },
      { code: 'B', parentCode: 'A' },
      { code: 'A', parentCode: null },
    ];
    expect(sortByHierarchy(rows, new Set()).map((r) => r.code)).toEqual(['A', 'B', 'C']);
  });

  it('treats an already-loaded parent as satisfied', () => {
    const rows = [{ code: 'MOB', parentCode: 'GRP' }];
    expect(sortByHierarchy(rows, new Set(['GRP'])).map((r) => r.code)).toEqual(['MOB']);
  });

  it('appends unplaceable rows rather than dropping them', () => {
    // A cycle is already reported as an issue; losing the rows silently here
    // would turn a reported error into a mystery.
    const rows = [
      { code: 'A', parentCode: 'B' },
      { code: 'B', parentCode: 'A' },
    ];
    expect(sortByHierarchy(rows, new Set())).toHaveLength(2);
  });

  it('handles an empty input', () => {
    expect(sortByHierarchy([], new Set())).toEqual([]);
  });
});
