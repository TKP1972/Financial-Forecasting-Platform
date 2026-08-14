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
  effectiveApprovalLimit,
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

  /*
    The finance ladder is a strict chain. ADMIN is deliberately not on it.

    Until this change every role was a superset of the one below, ADMIN
    included, which handed the administrator every financial approval in the
    product. That is the segregation-of-duties failure an auditor looks for
    first, and the user manual had claimed the opposite since it was written.
    ADMIN is now a separate branch: observe, audit, administer, transact
    nothing.
  */
  const FINANCE_LADDER: Role[] = ['VIEWER', 'ANALYST', 'BUDGET_OWNER', 'FINANCE_MANAGER', 'CFO'];

  it('each finance role is a STRICT superset of the role below it', () => {
    // Hand-counted sizes from the role definitions:
    //   VIEWER          6   (budget/cycle/forecast/pricing/risk/report read)
    //   ANALYST        12   (+6: budget:write, forecast:run, pricing:write,
    //                        risk:write, risk:simulate, report:export)
    //   BUDGET_OWNER   15   (+3: budget:submit, forecast:publish, pricing:view_margin)
    //   FINANCE_MANAGER 24  (+9: budget:approve, cycle:manage, guidance:publish,
    //                        pricing:approve, risk:accept, actuals:import,
    //                        report:publish_leadership, audit:read, user:read)
    //   CFO            26   (+2: budget:lock, audit:verify)
    const expectedSizes: Record<string, number> = {
      VIEWER: 6,
      ANALYST: 12,
      BUDGET_OWNER: 15,
      FINANCE_MANAGER: 24,
      CFO: 26,
    };

    for (const role of FINANCE_LADDER) {
      expect(ROLE_PERMISSIONS[role].size, role).toBe(expectedSizes[role]);
    }

    for (let i = 1; i < FINANCE_LADDER.length; i += 1) {
      const lower = FINANCE_LADDER[i - 1] as Role;
      const higher = FINANCE_LADDER[i] as Role;
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

  it('ADMIN observes, audits and administers - and transacts nothing', () => {
    // 11 hand-listed: 6 reads + audit:read + audit:verify + user:read
    //   + user:manage + settings:manage.
    expect(ROLE_PERMISSIONS.ADMIN.size).toBe(11);

    for (const permission of [
      'budget:read',
      'cycle:read',
      'forecast:read',
      'pricing:read',
      'risk:read',
      'report:read',
      'audit:read',
      'audit:verify',
      'user:read',
      'user:manage',
      'settings:manage',
    ] as const) {
      expect(can('ADMIN', permission), permission).toBe(true);
    }

    // Every financial action, refused by name. Listed rather than derived,
    // because deriving it from the matrix would pass whatever the matrix said.
    for (const permission of [
      'budget:write',
      'budget:submit',
      'budget:approve',
      'budget:lock',
      'cycle:manage',
      'guidance:publish',
      'forecast:run',
      'forecast:publish',
      'pricing:write',
      'pricing:approve',
      'pricing:view_margin',
      'risk:write',
      'risk:simulate',
      'risk:accept',
      'actuals:import',
      'report:export',
      'report:publish_leadership',
    ] as const) {
      expect(can('ADMIN', permission), permission).toBe(false);
    }
  });

  it('every declared permission is held by some role', () => {
    // The old form of this asserted ADMIN held all 28, which is exactly the
    // property that has been removed. The thing actually worth guarding is that
    // no permission is orphaned - declared, and granted to nobody.
    expect(PERMISSIONS).toHaveLength(28);
    for (const permission of PERMISSIONS) {
      const holders = ROLES.filter((role) => can(role, permission));
      expect(holders.length, `${permission} is granted to no role`).toBeGreaterThan(0);
    }
  });

  it('permissionsFor returns a sorted array and is unaffected by mutation', () => {
    const first = permissionsFor('VIEWER');
    expect(first).toEqual([...first].sort());
    first.push('settings:manage');
    expect(permissionsFor('VIEWER')).not.toContain('settings:manage');
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
    // The administrator outranks the CFO and still cannot approve. That is the
    // point of the role, not an oversight.
    expect(can('ADMIN', 'budget:approve')).toBe(false);
  });

  it("only the CFO holds 'budget:lock'", () => {
    const holders = LADDER.filter((r) => can(r, 'budget:lock'));
    expect(holders).toEqual(['CFO']);
  });

  it("only ADMIN holds 'user:manage'", () => {
    expect(LADDER.filter((r) => can(r, 'user:manage'))).toEqual(['ADMIN']);
  });

  it("only ADMIN holds 'settings:manage'", () => {
    expect(LADDER.filter((r) => can(r, 'settings:manage'))).toEqual(['ADMIN']);
  });

  it('has no delete permission at all - budgets are amended, never removed', () => {
    // Not a coverage test. Deleting a budget would leave audit entries pointing
    // at a row that no longer exists, in a chain that still verifies, and would
    // move the baseline under reports already issued. The absence is the
    // control; see the comment on PERMISSIONS.
    expect(PERMISSIONS.filter((p) => p.endsWith(':delete'))).toEqual([]);
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
        'settings:manage',
      ]);
    } catch {
      /* expected under strict mode */
    }
    expect([...ROLE_PERMISSIONS.VIEWER].sort()).toEqual(before);
    expect(can('VIEWER', 'settings:manage')).toBe(false);
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
    expect(can('SUPERUSER' as Role, 'settings:manage')).toBe(false);
  });

  // KNOWN GAP - see report. Object.freeze is shallow: the Set objects inside the
  // frozen record are still mutable, so a stray `ROLE_PERMISSIONS.VIEWER.add(...)`
  // at runtime silently escalates every viewer in the process. The file comment
  // ("Frozen so a bug elsewhere cannot mutate the matrix at runtime") claims
  // otherwise. This test asserts the CORRECT behaviour and is expected to fail.
  it.fails('the inner permission sets should also be immutable (KNOWN GAP)', () => {
    const viewer = ROLE_PERMISSIONS.VIEWER as Set<Permission>;
    try {
      viewer.add('settings:manage');
      expect(can('VIEWER', 'settings:manage')).toBe(false);
    } finally {
      // Always restore, so the leak cannot contaminate other tests in this file.
      viewer.delete('settings:manage');
    }
  });

  it('the matrix is intact after the mutability probe above', () => {
    expect(can('VIEWER', 'settings:manage')).toBe(false);
    expect(ROLE_PERMISSIONS.VIEWER.size).toBe(6);
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

describe('effectiveApprovalLimit', () => {
  // The bug this function exists to close: a stored null means "no override",
  // but a *reported* null means "unlimited". They collide on ADMIN, whose
  // stored value is null and whose default is '0'. Reporting the stored value
  // described the administrator as having no ceiling while every approval path
  // held them to zero.
  it('reports the administrator as zero, not unlimited', () => {
    expect(effectiveApprovalLimit({ role: 'ADMIN', approvalLimit: null })).toBe('0');
    expect(effectiveApprovalLimit({ role: 'ADMIN' })).toBe('0');
  });

  it('still reports the CFO as unlimited, which is what null legitimately means', () => {
    expect(effectiveApprovalLimit({ role: 'CFO', approvalLimit: null })).toBeNull();
  });

  it('an explicit override wins over the role default', () => {
    // FINANCE_MANAGER defaults to 2,000,000; this user is capped lower.
    expect(effectiveApprovalLimit({ role: 'FINANCE_MANAGER', approvalLimit: '500000' })).toBe(
      '500000',
    );
    // And a zero override is honoured rather than treated as absent, which
    // `||` would have got wrong.
    expect(effectiveApprovalLimit({ role: 'CFO', approvalLimit: '0' })).toBe('0');
  });

  it('falls back to the role default for every role', () => {
    // Hand-checked against DEFAULT_APPROVAL_LIMITS, not derived from it.
    expect(effectiveApprovalLimit({ role: 'VIEWER' })).toBe('0');
    expect(effectiveApprovalLimit({ role: 'ANALYST' })).toBe('0');
    expect(effectiveApprovalLimit({ role: 'BUDGET_OWNER' })).toBe('250000');
    expect(effectiveApprovalLimit({ role: 'FINANCE_MANAGER' })).toBe('2000000');
  });

  it('an administrator can approve nothing at all', () => {
    // 0 <= 0 is within authority, so the limit alone does not bar a zero-value
    // approval - the absence of any approval permission does. Asserted so the
    // limit is not mistaken for the whole control.
    const limit = effectiveApprovalLimit({ role: 'ADMIN' });
    expect(isWithinDelegatedAuthority('0.0001', limit)).toBe(false);
    expect(isWithinDelegatedAuthority('1', limit)).toBe(false);
  });
});

describe('delegated authority', () => {
  it('a null limit is unlimited', () => {
    expect(isWithinDelegatedAuthority('999999999999', null)).toBe(true);
    expect(isWithinDelegatedAuthority(Number.MAX_SAFE_INTEGER, null)).toBe(true);
    expect(DEFAULT_APPROVAL_LIMITS.CFO).toBeNull();
    // The administrator is not an approver, so its limit is zero rather than
    // unlimited. null would say "no ceiling", which is the opposite.
    expect(DEFAULT_APPROVAL_LIMITS.ADMIN).toBe('0');
    expect(isWithinDelegatedAuthority('1', DEFAULT_APPROVAL_LIMITS.ADMIN)).toBe(false);
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
