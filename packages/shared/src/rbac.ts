/**
 * Role-based access control and separation of duties.
 *
 * Two independent gates protect every governed action:
 *   1. Does this role hold the permission at all? ({@link can})
 *   2. Is this specific person allowed to act on this specific record?
 *      ({@link assertSeparationOfDuties}, {@link isWithinDelegatedAuthority})
 *
 * A Finance Manager holds `budget:approve`, but may not approve a budget they
 * prepared themselves, and not above their delegated limit.
 */
import { ROLE_RANK, type BudgetStatus, type Role } from './domain.js';

/**
 * Every governed action in the platform.
 *
 * **There is deliberately no `budget:delete`.** A budget is amended, superseded
 * or returned for revision - never removed. The reasons are structural rather
 * than a matter of taste:
 *
 *   - Audit entries reference budget ids. Deleting the budget leaves a
 *     hash-chained trail that still verifies while pointing at nothing, which
 *     is worse than a gap because it looks intact.
 *   - Variance reporting is measured against a locked baseline. Removing a
 *     budget silently rewrites the comparison behind reports already issued.
 *   - An ADMIN-only delete is exactly the override shape SOD-01 warns about:
 *     added for one urgent case, then permanent.
 *
 * The permission existed here for months while no route implemented it, which
 * is the only reason it could be removed rather than argued about. If a genuine
 * need for removal appears, it is a *reversal* - a new record that supersedes
 * the old one and leaves both visible - not a delete.
 *
 * There is likewise no `actuals:read`. Actuals are never served on their own;
 * they reach a user through a variance report, a forecast or the leadership
 * pack, each guarded by its own permission. A second permission that no route
 * consults would suggest a control that is not there.
 */
export const PERMISSIONS = [
  // Budgets
  'budget:read',
  'budget:write',
  'budget:submit',
  'budget:approve',
  'budget:lock',
  // Cycles & guidance
  'cycle:read',
  'cycle:manage',
  'guidance:publish',
  // Forecasting
  'forecast:read',
  'forecast:run',
  'forecast:publish',
  // Pricing
  'pricing:read',
  'pricing:write',
  'pricing:approve',
  'pricing:view_margin',
  // Risk
  'risk:read',
  'risk:write',
  'risk:simulate',
  'risk:accept',
  // Actuals & reporting
  'actuals:import',
  'report:read',
  'report:export',
  'report:publish_leadership',
  // Governance
  'audit:read',
  'audit:verify',
  'user:read',
  'user:manage',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'budget:read',
  'cycle:read',
  'forecast:read',
  'pricing:read',
  'risk:read',
  'report:read',
];

const ANALYST: Permission[] = [
  ...VIEWER,
  'budget:write',
  'forecast:run',
  'pricing:write',
  'risk:write',
  'risk:simulate',
  'report:export',
];

const BUDGET_OWNER: Permission[] = [
  ...ANALYST,
  'budget:submit',
  'forecast:publish',
  'pricing:view_margin',
];

const FINANCE_MANAGER: Permission[] = [
  ...BUDGET_OWNER,
  'budget:approve',
  'cycle:manage',
  'guidance:publish',
  'pricing:approve',
  'risk:accept',
  'actuals:import',
  'report:publish_leadership',
  'audit:read',
  'user:read',
];

const CFO: Permission[] = [...FINANCE_MANAGER, 'budget:lock', 'audit:verify'];

/**
 * The administrator runs the platform. It does not transact in it.
 *
 * This is the one role that is **not** a superset of the one below it, and the
 * departure is deliberate. An identity that can both manage users and approve
 * unlimited spend is the segregation-of-duties failure an auditor looks for
 * first, and the user manual has claimed since it was written that this is
 * "deliberately not a finance role" - a claim the matrix did not honour until
 * now, because ADMIN inherited every CFO permission.
 *
 * So: it may **observe** (the reads), **audit** (read and verify the chain),
 * and **administer** (users, settings, reference data). It may not approve a
 * budget, lock a baseline, sign off a price, accept a risk, import actuals,
 * publish guidance or a leadership pack, or see the margin on a bid. Its
 * default approval limit is zero, and budget transitions now require the
 * permission as well as the seniority, so rank 60 no longer walks past a
 * control that rank was never meant to open.
 *
 * **What this does and does not buy.** An administrator holding `user:manage`
 * can change a role or reset a password, so financial authority remains
 * *reachable*. What changes is that reaching it is no longer silent: it takes a
 * deliberate, audited alteration of an account that names a second identity,
 * instead of an approval nobody had reason to look at. Detectable, not
 * prevented - the same standard the audit threat model holds itself to.
 */
const ADMIN: Permission[] = [
  // Observe the system it runs.
  'budget:read',
  'cycle:read',
  'forecast:read',
  'pricing:read',
  'risk:read',
  'report:read',
  // Audit it. Verification is the administrator's job precisely because they
  // are not party to what the chain records.
  'audit:read',
  'audit:verify',
  // Administer it.
  'user:read',
  'user:manage',
  'settings:manage',
];

/** Frozen so a bug elsewhere cannot mutate the matrix at runtime. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  VIEWER: new Set(VIEWER),
  ANALYST: new Set(ANALYST),
  BUDGET_OWNER: new Set(BUDGET_OWNER),
  FINANCE_MANAGER: new Set(FINANCE_MANAGER),
  CFO: new Set(CFO),
  ADMIN: new Set(ADMIN),
});

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function canAll(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

export function canAny(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

export function permissionsFor(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? new Set<Permission>())].sort();
}

/** Seniority comparison, for "requires at least Finance Manager" style checks. */
export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

// --------------------------------------------------------------------------
// Separation of duties
// --------------------------------------------------------------------------

export class SeparationOfDutiesError extends Error {
  readonly code = 'SEPARATION_OF_DUTIES';
  constructor(message: string) {
    super(message);
    this.name = 'SeparationOfDutiesError';
  }
}

export class DelegatedAuthorityError extends Error {
  readonly code = 'DELEGATED_AUTHORITY_EXCEEDED';
  constructor(
    message: string,
    readonly limit: string,
    readonly amount: string,
  ) {
    super(message);
    this.name = 'DelegatedAuthorityError';
  }
}

export interface SoDContext {
  actorId: string;
  preparedById?: string | null;
  submittedById?: string | null;
}

/**
 * Nobody approves their own work. An ADMIN is not exempt - the whole point of the
 * control is that it has no bypass, otherwise the audit trail cannot be trusted.
 */
export function violatesSeparationOfDuties(ctx: SoDContext): boolean {
  return ctx.actorId === ctx.preparedById || ctx.actorId === ctx.submittedById;
}

export function assertSeparationOfDuties(ctx: SoDContext): void {
  if (violatesSeparationOfDuties(ctx)) {
    throw new SeparationOfDutiesError(
      'You cannot approve a submission you prepared or submitted. A different approver is required.',
    );
  }
}

// --------------------------------------------------------------------------
// Delegation of authority
// --------------------------------------------------------------------------

/**
 * Default approval limits by role, in base currency units.
 * `null` means unlimited. Overridable per user in settings.
 */
export const DEFAULT_APPROVAL_LIMITS: Record<Role, string | null> = {
  VIEWER: '0',
  ANALYST: '0',
  BUDGET_OWNER: '250000',
  FINANCE_MANAGER: '2000000',
  CFO: null,
  // Zero rather than null: null means "no ceiling", and an administrator is not
  // an approver at all. See the note on the ADMIN permission set.
  ADMIN: '0',
};

/**
 * The limit that actually applies to a user: their override if they have one,
 * otherwise their role's default.
 *
 * This exists because the expression `user.approvalLimit ?? DEFAULT[role]` was
 * written out at four call sites, and the places that *reported* the limit did
 * not use it - they returned the stored column. A stored `null` means "no
 * override, fall back to the default"; a reported `null` means "unlimited".
 * The two readings collide precisely on ADMIN, whose stored value is null and
 * whose default is '0', so `POST /auth/login` described the administrator as
 * having no ceiling while every approval path held them to zero. Enforcement
 * was correct throughout; only the description was wrong, which is the harder
 * kind of wrong to notice.
 *
 * Report and enforce through the same expression, so they cannot drift again.
 */
export function effectiveApprovalLimit(user: {
  role: Role | string;
  approvalLimit?: string | null;
}): string | null {
  return user.approvalLimit ?? DEFAULT_APPROVAL_LIMITS[user.role as Role] ?? null;
}

/**
 * Compare an amount against the actor's limit.
 * Amounts are decimal strings; comparison is string-safe via Number only after
 * an explicit finite check, because limits are policy values, not ledger money.
 */
export function isWithinDelegatedAuthority(
  amount: string | number,
  limit: string | number | null,
): boolean {
  if (limit === null) return true;
  const a = Math.abs(typeof amount === 'string' ? Number(amount) : amount);
  const l = typeof limit === 'string' ? Number(limit) : limit;
  if (!Number.isFinite(a) || !Number.isFinite(l)) return false;
  return a <= l;
}

export function assertWithinDelegatedAuthority(
  amount: string | number,
  limit: string | number | null,
): void {
  if (!isWithinDelegatedAuthority(amount, limit)) {
    throw new DelegatedAuthorityError(
      `Approval amount exceeds your delegated authority limit. Escalate to the next approval level.`,
      String(limit),
      String(amount),
    );
  }
}

/**
 * The permission each budget transition requires, alongside
 * {@link TRANSITION_MIN_ROLE}.
 *
 * Seniority alone was the whole authorisation for years, which had two
 * consequences. `budget:submit`, `budget:approve` and `budget:lock` guarded no
 * route by name, so a scan for unreachable permissions reported them as dead
 * when they were not. And ADMIN outranks CFO, so removing a financial
 * permission from the administrator would have changed nothing at all - rank 60
 * satisfies every minimum in the table.
 *
 * Both gates now apply: the actor must be senior enough **and** hold the
 * permission. Every existing role satisfies both, so no behaviour changes for
 * them; what changes is that the permission is now load-bearing.
 */
export const TRANSITION_PERMISSION: Record<BudgetStatus, Permission> = {
  DRAFT: 'budget:write',
  IN_REVIEW: 'budget:write',
  SUBMITTED: 'budget:submit',
  APPROVED: 'budget:approve',
  REJECTED: 'budget:approve',
  LOCKED: 'budget:lock',
};

/** Lowest role whose default limit covers `amount` - used to route escalations. */
export function requiredApproverRole(amount: string | number): Role {
  const ordered: Role[] = ['BUDGET_OWNER', 'FINANCE_MANAGER', 'CFO'];
  for (const role of ordered) {
    if (isWithinDelegatedAuthority(amount, DEFAULT_APPROVAL_LIMITS[role])) return role;
  }
  return 'CFO';
}
