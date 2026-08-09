import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_MUTABLE,
  NOTIFICATION_TYPES,
  renderNotification,
  resolveApprovalRecipients,
  shouldDeliver,
  type RecipientCandidate,
} from './notifications.js';

const candidate = (over: Partial<RecipientCandidate> = {}): RecipientCandidate => ({
  id: 'u1',
  email: 'a@b.local',
  name: 'Approver One',
  role: 'FINANCE_MANAGER',
  isActive: true,
  ...over,
});

describe('resolveApprovalRecipients', () => {
  it('includes an eligible approver', () => {
    const result = resolveApprovalRecipients([candidate()], { amount: '100000' });
    expect(result.recipients).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });

  it('excludes roles that cannot approve', () => {
    const result = resolveApprovalRecipients(
      [candidate({ role: 'ANALYST' }), candidate({ id: 'u2', role: 'VIEWER' })],
      { amount: '1000' },
    );
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/cannot approve budgets/);
  });

  it('excludes inactive accounts', () => {
    const result = resolveApprovalRecipients([candidate({ isActive: false })], { amount: '1000' });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/inactive/);
  });

  it('excludes the preparer, because separation of duties bars them', () => {
    const result = resolveApprovalRecipients([candidate({ id: 'prep' })], {
      amount: '1000',
      preparedById: 'prep',
    });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/separation of duties/);
  });

  it('excludes the submitter for the same reason', () => {
    const result = resolveApprovalRecipients([candidate({ id: 'sub' })], {
      amount: '1000',
      submittedById: 'sub',
    });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/separation of duties/);
  });

  it('excludes approvers whose delegated authority is too low', () => {
    // Finance Manager default limit is 2,000,000.
    const result = resolveApprovalRecipients([candidate()], { amount: '6000000' });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/exceeds their delegated authority/);
  });

  it('includes the CFO for an amount above every other limit', () => {
    const result = resolveApprovalRecipients(
      [candidate({ role: 'FINANCE_MANAGER' }), candidate({ id: 'cfo', role: 'CFO', name: 'CFO' })],
      { amount: '6000000' },
    );
    expect(result.recipients.map((r) => r.id)).toEqual(['cfo']);
  });

  it('honours a per-user approval limit over the role default', () => {
    const raised = candidate({ approvalLimit: '10000000' });
    expect(resolveApprovalRecipients([raised], { amount: '6000000' }).recipients).toHaveLength(1);

    const lowered = candidate({ approvalLimit: '500' });
    expect(resolveApprovalRecipients([lowered], { amount: '1000' }).recipients).toHaveLength(0);
  });

  it('compares the absolute amount, so a credit does not slip through', () => {
    const result = resolveApprovalRecipients([candidate()], { amount: '-6000000' });
    expect(result.recipients).toHaveLength(0);
  });

  it('excludes approvers scoped to a different business unit', () => {
    const result = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-other' })], {
      amount: '1000',
      businessUnitId: 'bu-1',
    });
    expect(result.excluded[0]?.reason).toMatch(/different business unit/);
  });

  it('includes an approver scoped to a unit above the budget in the hierarchy', () => {
    // A Finance Manager at Group is exactly who should approve a division's
    // budget. Comparing the unit id alone would exclude them.
    const result = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-group' })], {
      amount: '1000',
      businessUnitId: 'bu-division',
      businessUnitPath: ['bu-division', 'bu-group'],
    });
    expect(result.recipients).toHaveLength(1);
  });

  it('still excludes a sibling unit at the same level', () => {
    const result = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-sibling' })], {
      amount: '1000',
      businessUnitId: 'bu-division',
      businessUnitPath: ['bu-division', 'bu-group'],
    });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/different business unit/);
  });

  it('falls back to the unit alone when no path is supplied', () => {
    const onUnit = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-1' })], {
      amount: '1000',
      businessUnitId: 'bu-1',
    });
    expect(onUnit.recipients).toHaveLength(1);

    const elsewhere = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-2' })], {
      amount: '1000',
      businessUnitId: 'bu-1',
    });
    expect(elsewhere.recipients).toHaveLength(0);
  });

  it('considers everyone when the budget has no unit at all', () => {
    const result = resolveApprovalRecipients([candidate({ businessUnitId: 'bu-anything' })], {
      amount: '1000',
    });
    expect(result.recipients).toHaveLength(1);
  });

  it('always considers an approver with no business unit, as central finance', () => {
    const result = resolveApprovalRecipients([candidate({ businessUnitId: null })], {
      amount: '1000',
      businessUnitId: 'bu-1',
    });
    expect(result.recipients).toHaveLength(1);
  });

  it('respects a muted approval preference', () => {
    const result = resolveApprovalRecipients([candidate({ mutedTypes: ['BUDGET_SUBMITTED'] })], {
      amount: '1000',
    });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded[0]?.reason).toMatch(/muted/);
  });

  it('never notifies someone the system would then refuse', () => {
    // The whole point: everyone returned must pass permission, SoD and authority.
    const pool = [
      candidate({ id: 'analyst', role: 'ANALYST' }),
      candidate({ id: 'preparer', role: 'FINANCE_MANAGER' }),
      candidate({ id: 'lowlimit', role: 'BUDGET_OWNER' }),
      candidate({ id: 'ok', role: 'FINANCE_MANAGER' }),
      candidate({ id: 'inactive', role: 'CFO', isActive: false }),
    ];
    const result = resolveApprovalRecipients(pool, {
      amount: '1000000',
      preparedById: 'preparer',
    });

    expect(result.recipients.map((r) => r.id)).toEqual(['ok']);
    expect(result.excluded).toHaveLength(4);
  });

  it('handles an empty candidate pool', () => {
    const result = resolveApprovalRecipients([], { amount: '1000' });
    expect(result.recipients).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
  });
});

describe('shouldDeliver', () => {
  it('suppresses a muted, mutable type', () => {
    expect(
      shouldDeliver('BUDGET_APPROVED', { isActive: true, mutedTypes: ['BUDGET_APPROVED'] }),
    ).toBe(false);
  });

  it('delivers a non-mutable type even when muted', () => {
    // Being told your budget was rejected is not a preference.
    expect(
      shouldDeliver('BUDGET_REJECTED', { isActive: true, mutedTypes: ['BUDGET_REJECTED'] }),
    ).toBe(true);
    expect(
      shouldDeliver('PASSWORD_RESET', { isActive: true, mutedTypes: ['PASSWORD_RESET'] }),
    ).toBe(true);
  });

  it('never delivers to an inactive account', () => {
    expect(shouldDeliver('BUDGET_REJECTED', { isActive: false })).toBe(false);
  });

  it('delivers when nothing is muted', () => {
    expect(shouldDeliver('BUDGET_APPROVED', { isActive: true })).toBe(true);
  });

  it('marks rejections, missed deadlines and password resets as non-mutable', () => {
    expect(NOTIFICATION_MUTABLE.BUDGET_REJECTED).toBe(false);
    expect(NOTIFICATION_MUTABLE.SUBMISSION_DEADLINE_PASSED).toBe(false);
    expect(NOTIFICATION_MUTABLE.PASSWORD_RESET).toBe(false);
  });
});

describe('renderNotification', () => {
  const facts = {
    budgetName: 'Mobile Networks FY2026',
    businessUnit: 'MOB',
    cycleName: 'FY2026 Annual Budget',
    amount: '402000000.0000',
    currency: 'USD',
    actorName: 'Aisha Okafor',
  };

  it('renders every declared type without throwing', () => {
    for (const type of NOTIFICATION_TYPES) {
      const rendered = renderNotification(type, { ...facts, daysRemaining: 3 });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(0);
    }
  });

  it('puts the amount in the subject of an approval request', () => {
    const rendered = renderNotification('BUDGET_SUBMITTED', facts);
    expect(rendered.subject).toContain('402000000.0000 USD');
    expect(rendered.subject).toContain('Approval needed');
  });

  it('explains why the reader was selected', () => {
    const rendered = renderNotification('BUDGET_SUBMITTED', facts);
    expect(rendered.body).toMatch(/within your delegated authority/);
    expect(rendered.body).toMatch(/did not prepare or submit it/);
  });

  it('includes the rejection reason when one was given', () => {
    const rendered = renderNotification('BUDGET_REJECTED', {
      ...facts,
      comment: 'Energy escalation looks understated.',
    });
    expect(rendered.body).toContain('Energy escalation looks understated.');
  });

  it('says so plainly when no rejection reason was recorded', () => {
    const rendered = renderNotification('BUDGET_REJECTED', { ...facts, comment: null });
    expect(rendered.body).toMatch(/No reason was recorded/);
  });

  it('describes deadlines in human terms', () => {
    expect(
      renderNotification('SUBMISSION_DEADLINE_APPROACHING', { ...facts, daysRemaining: 0 }).subject,
    ).toContain('today');
    expect(
      renderNotification('SUBMISSION_DEADLINE_APPROACHING', { ...facts, daysRemaining: 1 }).subject,
    ).toContain('tomorrow');
    expect(
      renderNotification('SUBMISSION_DEADLINE_APPROACHING', { ...facts, daysRemaining: 5 }).subject,
    ).toContain('in 5 days');
  });

  it('describes an overdue deadline as overdue, not as negative days', () => {
    const rendered = renderNotification('APPROVAL_REMINDER', { ...facts, daysRemaining: -3 });
    expect(rendered.body).toContain('3 day(s) overdue');
    expect(rendered.body).not.toContain('-3');
  });

  it('appends the app link only when one is supplied', () => {
    expect(
      renderNotification('BUDGET_APPROVED', { ...facts, appUrl: 'https://ffp.local' }).body,
    ).toContain('https://ffp.local');
    expect(renderNotification('BUDGET_APPROVED', facts).body).not.toContain('Open the platform');
  });

  it('tells a locked-budget reader what to do instead', () => {
    const rendered = renderNotification('BUDGET_LOCKED', facts);
    expect(rendered.body).toMatch(/reforecast or a budget transfer/);
  });
});
