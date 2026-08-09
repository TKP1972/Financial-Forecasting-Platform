/**
 * Unit tests for role-based access control and the two governance gates
 * (separation of duties, delegated authority).
 *
 * Expected permission sets are read off the role definitions and counted by hand
 * in the comments below.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APPROVAL_LIMITS,
  DelegatedAuthorityError,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SeparationOfDutiesError,
  assertSeparationOfDuties,
  assertWithinDelegatedAuthority,
  atLeast,
  can,
  canAll,
  canAny,
  isWithinDelegatedAuthority,
  permissionsFor,
  requiredApproverRole,
  violatesSeparationOfDuties,
  type Permission,
} from './rbac.js';
import { ROLES, type Role } from './domain.js';

/** Roles in ascending privilege order - the inheritance chain under test. */
const LADDER: Role[] = ['VIEWER', 'ANALYST', 'BUDGET_OWNER', 'FINANCE_MANAGER', 'CFO', 'ADMIN'];

describe('permission inheritance', () => {
  it('has an entry for every declared role', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], role).toBeInstanceOf(Set);
    }
  });

  it('each role is a STRICT superset of the role below it', () => {
    // Hand-counted sizes from the role definitions:
    //   VIEWER          7   (budget/cycle/forecast/pricing/risk/actuals/report read)
    //   ANALYST        13   (+6: budget:write, forecast:run, pricing:write,
    //                        risk:write, risk:simulate, report:export)
    //   BUDGET_OWNER   16   (+3: budget:submit, forecast:publish, pricing:view_margin)
    //   FINANCE_MANAGER 25  (+9: budget:approve, cycle:manage, guidance:publish,
    //                        pricing:approve, risk:accept, actuals:import,
    //                        report:publish_leadership, audit:read, user:read)
    //   CFO            27   (+2: budget:lock, audit:verify)
    //   ADMIN          30   (+3: budget:delete, user:manage, settings:manage)
    const expectedSizes: Record<Role, number> = {
      VIEWER: 7,
      ANALYST: 13,
      BUDGET_OWNER: 16,
      FINANCE_MANAGER: 25,
      CFO: 27,
      ADMIN: 30,
    };

    for (const role of LADDER) {
      expect(ROLE_PERMISSIONS[role].size, role).toBe(expectedSizes[role]);
    }

    for (let i = 1; i < LADDER.length; i += 1) {
      const lower = LADDER[i - 1] as Role;
      const higher = LADDER[i] as Role;
      // Superset: every lower permission is held by the higher role.
      for (const permission of ROLE_PERMISSIONS[lower]) {
        expect(can(higher, permission), `${higher} should inherit ${permission}`).toBe(true);
      }
      // Strict: the higher role holds at least one permission the lower does not.
      expect(
        ROLE_PERMISSIONS[higher].size,
        `${higher} must strictly exceed ${lower}`,
      ).toBeGreaterThan(ROLE_PERMISSIONS[lower].size);
    }
  });

  it('ADMIN holds every declared permission', () => {
    // 6 budget + 3 cycle/guidance + 3 forecast + 4 pricing + 4 risk
    //   + 5 actuals/report + 5 governance = 30
    expect(PERMISSIONS).toHaveLength(30);
    for (const permission of PERMISSIONS) {
      expect(can('ADMIN', permission), permission).toBe(true);
    }
  });

  it('permissionsFor returns a sorted array and is unaffected by mutation', () => {
    const first = permissionsFor('VIEWER');
    expect(first).toEqual([...first].sort());
    first.push('budget:delete');
    expect(permissionsFor('VIEWER')).not.toContain('budget:delete');
  });

  it('permissionsFor returns an empty list for an unknown role', () => {
    expect(permissionsFor('NOT_A_ROLE' as Role)).toEqual([]);
  });
});

describe('specific permission boundaries', () => {
  it('ANALYST cannot approve a budget; FINANCE_MANAGER can', () => {
    expect(can('ANALYST', 'budget:approve')).toBe(false);
    expect(can('BUDGET_OWNER', 'budget:approve')).toBe(false);
    expect(can('FINANCE_MANAGER', 'budget:approve')).toBe(true);
    expect(can('CFO', 'budget:approve')).toBe(true);
    expect(can('ADMIN', 'budget:approve')).toBe(true);
  });

  it("only CFO and ADMIN hold 'budget:lock'", () => {
    const holders = LADDER.filter((r) => can(r, 'budget:lock'));
    expect(holders).toEqual(['CFO', 'ADMIN']);
  });

  it("only ADMIN holds 'user:manage'", () => {
    expect(LADDER.filter((r) => can(r, 'user:manage'))).toEqual(['ADMIN']);
  });

  it("only ADMIN holds 'budget:delete'", () => {
    expect(LADDER.filter((r) => can(r, 'budget:delete'))).toEqual(['ADMIN']);
  });

  it("only ADMIN holds 'settings:manage'", () => {
    expect(LADDER.filter((r) => can(r, 'settings:manage'))).toEqual(['ADMIN']);
  });

  it("only CFO and ADMIN hold 'audit:verify'", () => {
    expect(LADDER.filter((r) => can(r, 'audit:verify'))).toEqual(['CFO', 'ADMIN']);
  });

  it('VIEWER is read-only', () => {
    for (const permission of ROLE_PERMISSIONS.VIEWER) {
      expect(permission.endsWith(':read'), permission).toBe(true);
    }
    expect(can('VIEWER', 'budget:write')).toBe(false);
  });

  it('an unknown role holds nothing', () => {
    expect(can('GHOST' as Role, 'budget:read')).toBe(false);
  });

  it('canAll requires every permission; canAny requires one', () => {
    expect(canAll('ANALYST', ['budget:read', 'budget:write'])).toBe(true);
    expect(canAll('ANALYST', ['budget:read', 'budget:approve'])).toBe(false);
    expect(canAny('ANALYST', ['budget:approve', 'budget:write'])).toBe(true);
    expect(canAny('VIEWER', ['budget:approve', 'budget:write'])).toBe(false);
    // Vacuous truth / vacuous falsity on empty lists.
    expect(canAll('VIEWER', [])).toBe(true);
    expect(canAny('VIEWER', [])).toBe(false);
  });

  it('atLeast compares seniority by rank', () => {
    expect(atLeast('CFO', 'FINANCE_MANAGER')).toBe(true);
    expect(atLeast('FINANCE_MANAGER', 'FINANCE_MANAGER')).toBe(true);
    expect(atLeast('ANALYST', 'FINANCE_MANAGER')).toBe(false);
    expect(atLeast('ADMIN', 'VIEWER')).toBe(true);
  });
});

describe('ROLE_PERMISSIONS immutability', () => {
  it('the matrix object is frozen and cannot be reassigned', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);

    const before = [...ROLE_PERMISSIONS.VIEWER].sort();
    try {
      // ESM modules run in strict mode, so this throws; under sloppy mode it is a
      // silent no-op. Either way the matrix must be unchanged afterwards.
      (ROLE_PERMISSIONS as unknown as Record<string, unknown>).VIEWER = new Set<Permission>([
        'budget:delete',
      ]);
    } catch {
      /* expected under strict mode */
    }
    expect([...ROLE_PERMISSIONS.VIEWER].sort()).toEqual(before);
    expect(can('VIEWER', 'budget:delete')).toBe(false);
  });

  it('a new role cannot be grafted onto the matrix', () => {
    const before = Object.keys(ROLE_PERMISSIONS).length;
    try {
      (ROLE_PERMISSIONS as unknown as Record<string, unknown>).SUPERUSER = new Set<Permission>(
        PERMISSIONS,
      );
    } catch {
      /* expected under strict mode */
    }
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(before);
    expect(can('SUPERUSER' as Role, 'budget:delete')).toBe(false);
  });

  // KNOWN GAP - see report. Object.freeze is shallow: the Set objects inside the
  // frozen record are still mutable, so a stray `ROLE_PERMISSIONS.VIEWER.add(...)`
  // at runtime silently escalates every viewer in the process. The file comment
  // ("Frozen so a bug elsewhere cannot mutate the matrix at runtime") claims
  // otherwise. This test asserts the CORRECT behaviour and is expected to fail.
  it.fails('the inner permission sets should also be immutable (KNOWN GAP)', () => {
    const viewer = ROLE_PERMISSIONS.VIEWER as Set<Permission>;
    try {
      viewer.add('budget:delete');
      expect(can('VIEWER', 'budget:delete')).toBe(false);
    } finally {
      // Always restore, so the leak cannot contaminate other tests in this file.
      viewer.delete('budget:delete');
    }
  });

  it('the matrix is intact after the mutability probe above', () => {
    expect(can('VIEWER', 'budget:delete')).toBe(false);
    expect(ROLE_PERMISSIONS.VIEWER.size).toBe(7);
  });
});

describe('separation of duties', () => {
  it('flags an actor approving what they prepared', () => {
    expect(violatesSeparationOfDuties({ actorId: 'u1', preparedById: 'u1' })).toBe(true);
  });

  it('flags an actor approving what they submitted', () => {
    expect(violatesSeparationOfDuties({ actorId: 'u1', submittedById: 'u1' })).toBe(true);
  });

  it('permits an independent approver', () => {
    expect(
      violatesSeparationOfDuties({ actorId: 'u2', preparedById: 'u1', submittedById: 'u1' }),
    ).toBe(false);
  });

  it('does not fire on absent preparer/submitter ids', () => {
    expect(
      violatesSeparationOfDuties({ actorId: 'u1', preparedById: null, submittedById: undefined }),
    ).toBe(false);
    expect(violatesSeparationOfDuties({ actorId: 'u1' })).toBe(false);
  });

  it('assertSeparationOfDuties throws a SeparationOfDutiesError with a stable code', () => {
    let thrown: unknown;
    try {
      assertSeparationOfDuties({ actorId: 'u1', preparedById: 'u1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SeparationOfDutiesError);
    expect((thrown as SeparationOfDutiesError).code).toBe('SEPARATION_OF_DUTIES');
    expect((thrown as Error).name).toBe('SeparationOfDutiesError');
    expect((thrown as Error).message).toMatch(/cannot approve a submission you prepared/i);
  });

  it('THROWS EVEN FOR ADMIN - the control has no bypass', () => {
    // assertSeparationOfDuties takes no role at all: there is no parameter through
    // which an exemption could be granted. Assert that for every role, including
    // ADMIN and CFO, self-approval is refused.
    for (const role of ROLES) {
      expect(
        () => assertSeparationOfDuties({ actorId: `${role}-user`, preparedById: `${role}-user` }),
        `${role} must not be exempt`,
      ).toThrow(SeparationOfDutiesError);
    }
    // Explicit ADMIN case, spelled out because it is the one people try to bypass.
    expect(() => assertSeparationOfDuties({ actorId: 'admin', preparedById: 'admin' })).toThrow(
      SeparationOfDutiesError,
    );
    expect(() => assertSeparationOfDuties({ actorId: 'admin', submittedById: 'admin' })).toThrow(
      SeparationOfDutiesError,
    );
  });

  it('does not throw for a valid separated approval', () => {
    expect(() =>
      assertSeparationOfDuties({ actorId: 'approver', preparedById: 'preparer' }),
    ).not.toThrow();
  });
});

describe('delegated authority', () => {
  it('a null limit is unlimited', () => {
    expect(isWithinDelegatedAuthority('999999999999', null)).toBe(true);
    expect(isWithinDelegatedAuthority(Number.MAX_SAFE_INTEGER, null)).toBe(true);
    expect(DEFAULT_APPROVAL_LIMITS.CFO).toBeNull();
    expect(DEFAULT_APPROVAL_LIMITS.ADMIN).toBeNull();
  });

  it('compares the ABSOLUTE value of the amount', () => {
    // A credit of 300,000 is just as consequential as a debit of 300,000.
    // |-300000| = 300000 > 250000 -> outside a BUDGET_OWNER's authority.
    expect(isWithinDelegatedAuthority('-300000', '250000')).toBe(false);
    expect(isWithinDelegatedAuthority(-300000, 250000)).toBe(false);
    expect(isWithinDelegatedAuthority('-250000', '250000')).toBe(true);
    expect(isWithinDelegatedAuthority('300000', '250000')).toBe(false);
  });

  it('the limit itself is inclusive', () => {
    expect(isWithinDelegatedAuthority('250000', '250000')).toBe(true);
    expect(isWithinDelegatedAuthority('250000.01', '250000')).toBe(false);
  });

  it('a zero limit permits nothing but zero', () => {
    expect(isWithinDelegatedAuthority('0', '0')).toBe(true);
    expect(isWithinDelegatedAuthority('0.01', '0')).toBe(false);
    expect(DEFAULT_APPROVAL_LIMITS.VIEWER).toBe('0');
    expect(DEFAULT_APPROVAL_LIMITS.ANALYST).toBe('0');
  });

  it('non-finite input returns false rather than passing the gate', () => {
    expect(isWithinDelegatedAuthority('not-a-number', '250000')).toBe(false);
    expect(isWithinDelegatedAuthority(Number.NaN, '250000')).toBe(false);
    expect(isWithinDelegatedAuthority(Number.POSITIVE_INFINITY, '250000')).toBe(false);
    expect(isWithinDelegatedAuthority('100', 'not-a-number')).toBe(false);
    expect(isWithinDelegatedAuthority('100', Number.NaN)).toBe(false);
  });

  it('assertWithinDelegatedAuthority throws with the limit and amount attached', () => {
    let thrown: unknown;
    try {
      assertWithinDelegatedAuthority('300000', '250000');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DelegatedAuthorityError);
    const err = thrown as DelegatedAuthorityError;
    expect(err.code).toBe('DELEGATED_AUTHORITY_EXCEEDED');
    expect(err.limit).toBe('250000');
    expect(err.amount).toBe('300000');
    expect(err.message).toMatch(/exceeds your delegated authority/i);
  });

  it('assertWithinDelegatedAuthority is silent when within limit', () => {
    expect(() => assertWithinDelegatedAuthority('100000', '250000')).not.toThrow();
    expect(() => assertWithinDelegatedAuthority('9e99', null)).not.toThrow();
  });
});

describe('requiredApproverRole', () => {
  it('routes 100,000 to BUDGET_OWNER', () => {
    // BUDGET_OWNER limit is 250,000 and 100,000 <= 250,000.
    expect(requiredApproverRole(100000)).toBe('BUDGET_OWNER');
    expect(requiredApproverRole('100000')).toBe('BUDGET_OWNER');
  });

  it('routes 1,000,000 to FINANCE_MANAGER', () => {
    // Above the 250,000 BUDGET_OWNER limit, within the 2,000,000 FM limit.
    expect(requiredApproverRole(1000000)).toBe('FINANCE_MANAGER');
    expect(requiredApproverRole('1000000')).toBe('FINANCE_MANAGER');
  });

  it('routes 50,000,000 to CFO', () => {
    // Above every finite limit; CFO's limit is null (unlimited).
    expect(requiredApproverRole(50000000)).toBe('CFO');
    expect(requiredApproverRole('50000000')).toBe('CFO');
  });

  it('routes exactly at the band boundaries', () => {
    expect(requiredApproverRole('250000')).toBe('BUDGET_OWNER');
    expect(requiredApproverRole('250000.01')).toBe('FINANCE_MANAGER');
    expect(requiredApproverRole('2000000')).toBe('FINANCE_MANAGER');
    expect(requiredApproverRole('2000000.01')).toBe('CFO');
  });

  it('routes on magnitude, so a large credit escalates too', () => {
    expect(requiredApproverRole('-1000000')).toBe('FINANCE_MANAGER');
  });

  it('escalates to CFO when the amount cannot be interpreted', () => {
    // Every finite check returns false, so the loop falls through to CFO.
    expect(requiredApproverRole('rubbish')).toBe('CFO');
  });
});
