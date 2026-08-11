/**
 * The dashboard and the leadership pack must not disagree about money.
 *
 * They did, by $531m, on the same cycle at the same moment. The pack scoped
 * both sides of its comparison to units with an approved budget; the dashboard
 * divided **every** unit's actuals by the **approved-only** budget total. Both
 * numbers were computed correctly from their own inputs and neither test suite
 * noticed, because each screen was only ever checked against itself.
 *
 * That is the shape this file exists to catch: two places computing one
 * concept. The other instances found in this codebase — an endpoint advertising
 * a period axis a validator enforced differently, a redaction applied at three
 * of four call sites — were the same failure at different layers.
 *
 * These are unit tests over the arithmetic rather than route tests, because the
 * property is about how the two figures relate, and a fake database large
 * enough to make that meaningful would be a fixture nobody trusts.
 */
import { describe, expect, it } from 'vitest';

/** Both screens' shared shape: a unit, its budget, its status, its spend. */
interface Unit {
  id: string;
  budget: number;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'LOCKED';
  actual: number;
  commitment: number;
}

const APPROVED = (u: Unit) => u.status === 'APPROVED' || u.status === 'LOCKED';
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** What the dashboard reports, as the route now computes it. */
function dashboard(units: Unit[]) {
  const approvedTotal = sum(units.filter(APPROVED).map((u) => u.budget));
  const approvedActual = sum(units.filter(APPROVED).map((u) => u.actual));
  const approvedCommitment = sum(units.filter(APPROVED).map((u) => u.commitment));
  const actualTotal = sum(units.map((u) => u.actual));

  return {
    approvedBudget: approvedTotal,
    // Every unit: a fact about the business, not narrowed to suit a ratio.
    actual: actualTotal,
    remaining: approvedTotal - approvedActual - approvedCommitment,
    utilisation: approvedTotal === 0 ? null : (approvedActual + approvedCommitment) / approvedTotal,
    unapprovedActual: actualTotal - approvedActual,
  };
}

/** What the leadership pack reports: approved budgets and their own actuals. */
function leadershipPack(units: Unit[]) {
  const approved = units.filter(APPROVED);
  return {
    approvedBudget: sum(approved.map((u) => u.budget)),
    actual: sum(approved.map((u) => u.actual)),
  };
}

/**
 * Two units approved, two not — the ordinary mid-cycle state, and the one that
 * produced the defect. The real figures from the seeded FY2026 cycle.
 */
const MID_CYCLE: Unit[] = [
  {
    id: 'MOB',
    budget: 402_075_472,
    status: 'APPROVED',
    actual: 236_000_000,
    commitment: 8_000_000,
  },
  {
    id: 'FIX',
    budget: 205_707_852,
    status: 'APPROVED',
    actual: 120_000_000,
    commitment: 4_000_000,
  },
  { id: 'ENT', budget: 125_000_000, status: 'SUBMITTED', actual: 72_000_000, commitment: 0 },
  { id: 'SHR', budget: 94_000_000, status: 'DRAFT', actual: 54_000_000, commitment: 0 },
];

describe('the dashboard and the leadership pack agree', () => {
  it('reports the same approved budget', () => {
    expect(dashboard(MID_CYCLE).approvedBudget).toBe(leadershipPack(MID_CYCLE).approvedBudget);
  });

  it("measures utilisation against the same units the pack's variance covers", () => {
    const d = dashboard(MID_CYCLE);
    const p = leadershipPack(MID_CYCLE);

    // 356,000,000 spent + 12,000,000 committed against 607,783,324 approved.
    // Hand-computed: 607,783,324 x 0.6 = 364,669,994.4, leaving a remainder of
    // 3,330,005.6, which is 0.0054789 of the approved total. So 0.6054789.
    expect(d.utilisation).toBeCloseTo(0.605479, 6);

    // The ratio's numerator must be the pack's actual plus commitment, not the
    // whole-cycle figure. That equality is the defect, stated.
    const impliedNumerator = d.utilisation! * d.approvedBudget;
    expect(impliedNumerator).toBeCloseTo(p.actual + 12_000_000, 2);
  });

  it('never reports utilisation above 100% merely because budgets are unapproved', () => {
    // The original defect in its purest form: one small approved budget, four
    // units spending. It reported 333%.
    const skewed: Unit[] = [
      { id: 'A', budget: 100, status: 'APPROVED', actual: 50, commitment: 0 },
      { id: 'B', budget: 900, status: 'DRAFT', actual: 800, commitment: 0 },
    ];

    // 50 of 100 on the only approved unit. The 800 spent elsewhere is real, and
    // reported separately, but it is not consumption of an approved budget.
    expect(dashboard(skewed).utilisation).toBe(0.5);
    expect(dashboard(skewed).unapprovedActual).toBe(800);
  });

  it('still reports total spend in full, including unapproved units', () => {
    // Correcting the ratio must not hide money. 236+120+72+54 = 482,000,000.
    expect(dashboard(MID_CYCLE).actual).toBe(482_000_000);
    expect(dashboard(MID_CYCLE).unapprovedActual).toBe(126_000_000);
  });

  it('leaves remaining positive when an approved budget is underspent', () => {
    // 607,783,324 - 356,000,000 - 12,000,000 = 239,783,324.
    expect(dashboard(MID_CYCLE).remaining).toBe(239_783_324);
  });

  it('reports no utilisation at all when nothing is approved yet', () => {
    const early: Unit[] = [
      { id: 'A', budget: 100, status: 'DRAFT', actual: 10, commitment: 0 },
      { id: 'B', budget: 200, status: 'SUBMITTED', actual: 20, commitment: 0 },
    ];

    // Not zero, and not infinity: there is no approved budget to consume, so
    // the question has no answer and the tile says so.
    expect(dashboard(early).utilisation).toBeNull();
    expect(dashboard(early).remaining).toBe(0);
    // The spend is still visible rather than vanishing with the ratio.
    expect(dashboard(early).actual).toBe(30);
    expect(dashboard(early).unapprovedActual).toBe(30);
  });

  it('counts a locked budget as approved on both screens', () => {
    const locked: Unit[] = [{ id: 'A', budget: 100, status: 'LOCKED', actual: 40, commitment: 0 }];
    expect(dashboard(locked).approvedBudget).toBe(leadershipPack(locked).approvedBudget);
    expect(dashboard(locked).utilisation).toBe(0.4);
  });
});
