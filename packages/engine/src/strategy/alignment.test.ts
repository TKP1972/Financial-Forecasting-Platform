import { describe, expect, it } from 'vitest';
import { assessAlignment, type AlignedBudgetLine, type StrategicObjective } from './alignment.js';

const objectives: StrategicObjective[] = [
  { id: 'o1', code: 'SO-1', title: 'Sustain the core', horizon: 'H1_CORE', targetShare: 0.5 },
  { id: 'o2', code: 'SO-2', title: 'Grow enterprise', horizon: 'H2_ADJACENT', targetShare: 0.3 },
  {
    id: 'o3',
    code: 'SO-3',
    title: 'New digital lines',
    horizon: 'H3_TRANSFORMATIONAL',
    targetShare: 0.2,
  },
];

describe('assessAlignment', () => {
  it('weights the alignment score by money and alignment strength', () => {
    // 500 DIRECT (x1) + 300 SUPPORTING (x0.6) + 200 INDIRECT (x0.3)
    // = 500 + 180 + 60 = 740 over a 1,000 total => 0.74
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '500', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '300', objectiveId: 'o2', alignment: 'SUPPORTING' },
      { id: 'c', label: 'Dig', amount: '200', objectiveId: 'o3', alignment: 'INDIRECT' },
    ];
    const report = assessAlignment(lines, objectives);
    expect(report.totalBudget).toBe('1000.0000');
    expect(report.alignmentScore).toBeCloseTo(0.74, 10);
  });

  it('scores NONE-aligned money at zero', () => {
    const report = assessAlignment(
      [{ id: 'a', label: 'x', amount: '1000', objectiveId: 'o1', alignment: 'NONE' }],
      objectives,
    );
    expect(report.alignmentScore).toBe(0);
  });

  it('treats missing and unknown objectives as unallocated', () => {
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Linked', amount: '600', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'No link', amount: '300', objectiveId: null, alignment: 'DIRECT' },
      {
        id: 'c',
        label: 'Bad link',
        amount: '100',
        objectiveId: 'does-not-exist',
        alignment: 'DIRECT',
      },
    ];
    const report = assessAlignment(lines, objectives);
    expect(report.unallocated).toBe('400.0000');
    expect(report.unallocatedShare).toBeCloseTo(0.4, 10);
  });

  it('computes actual share, share gap and funding gap', () => {
    // o1 gets 300 of 1,000 = 30% against a 50% target => gap -20pp.
    // Funding gap = -(-0.2) x 1,000 = +200 needed.
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '300', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '500', objectiveId: 'o2', alignment: 'DIRECT' },
      { id: 'c', label: 'Dig', amount: '200', objectiveId: 'o3', alignment: 'DIRECT' },
    ];
    const report = assessAlignment(lines, objectives);
    const core = report.allocations.find((a) => a.objectiveId === 'o1');

    expect(core?.actualShare).toBeCloseTo(0.3, 10);
    expect(core?.targetShare).toBe(0.5);
    expect(core?.shareGap).toBeCloseTo(-0.2, 10);
    expect(core?.fundingGap).toBe('200.0000');
  });

  it('reports a negative funding gap where an objective is overfunded', () => {
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '300', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '500', objectiveId: 'o2', alignment: 'DIRECT' },
      { id: 'c', label: 'Dig', amount: '200', objectiveId: 'o3', alignment: 'DIRECT' },
    ];
    const report = assessAlignment(lines, objectives);
    const ent = report.allocations.find((a) => a.objectiveId === 'o2');
    // 50% actual against a 30% target => +20pp, so 200 too much.
    expect(ent?.shareGap).toBeCloseTo(0.2, 10);
    expect(ent?.fundingGap).toBe('-200.0000');
  });

  it('sorts allocations by actual share, largest first', () => {
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '100', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '700', objectiveId: 'o2', alignment: 'DIRECT' },
      { id: 'c', label: 'Dig', amount: '200', objectiveId: 'o3', alignment: 'DIRECT' },
    ];
    const report = assessAlignment(lines, objectives);
    expect(report.allocations[0]?.objectiveId).toBe('o2');
    expect(report.allocations[2]?.objectiveId).toBe('o1');
  });

  it('always reports all three horizons, even when unfunded', () => {
    const report = assessAlignment(
      [{ id: 'a', label: 'Core', amount: '1000', objectiveId: 'o1', alignment: 'DIRECT' }],
      objectives,
    );
    expect(report.byHorizon).toHaveLength(3);
    expect(report.byHorizon.map((h) => h.horizon)).toEqual([
      'H1_CORE',
      'H2_ADJACENT',
      'H3_TRANSFORMATIONAL',
    ]);
    expect(report.byHorizon[2]?.amount).toBe('0.0000');
    expect(report.byHorizon[2]?.share).toBe(0);
  });

  it('flags a large unallocated share', () => {
    const report = assessAlignment(
      [
        { id: 'a', label: 'Linked', amount: '700', objectiveId: 'o1', alignment: 'DIRECT' },
        { id: 'b', label: 'Unlinked', amount: '300', objectiveId: null, alignment: 'DIRECT' },
      ],
      objectives,
    );
    expect(report.observations.join(' ')).toMatch(/not linked to any strategic objective/i);
  });

  it('flags an underfunded transformational horizon', () => {
    const report = assessAlignment(
      [
        { id: 'a', label: 'Core', amount: '990', objectiveId: 'o1', alignment: 'DIRECT' },
        { id: 'b', label: 'Dig', amount: '10', objectiveId: 'o3', alignment: 'DIRECT' },
      ],
      objectives,
    );
    expect(report.observations.join(' ')).toMatch(/transformational/i);
  });

  it('lists misalignments beyond the tolerance, most underfunded first', () => {
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '100', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '800', objectiveId: 'o2', alignment: 'DIRECT' },
      { id: 'c', label: 'Dig', amount: '100', objectiveId: 'o3', alignment: 'DIRECT' },
    ];
    const report = assessAlignment(lines, objectives, { toleranceShare: 0.05 });
    // o1 is -40pp, o2 is +50pp, o3 is -10pp. Sorted ascending by gap.
    expect(report.misalignments[0]?.objectiveId).toBe('o1');
    expect(report.misalignments.at(-1)?.objectiveId).toBe('o2');
  });

  it('respects a wider tolerance', () => {
    const lines: AlignedBudgetLine[] = [
      { id: 'a', label: 'Core', amount: '450', objectiveId: 'o1', alignment: 'DIRECT' },
      { id: 'b', label: 'Ent', amount: '350', objectiveId: 'o2', alignment: 'DIRECT' },
      { id: 'c', label: 'Dig', amount: '200', objectiveId: 'o3', alignment: 'DIRECT' },
    ];
    // Gaps are -5pp, +5pp, 0pp: inside a 10pp tolerance, outside a 1pp one.
    expect(assessAlignment(lines, objectives, { toleranceShare: 0.1 }).misalignments).toHaveLength(
      0,
    );
    expect(assessAlignment(lines, objectives, { toleranceShare: 0.01 }).misalignments).toHaveLength(
      2,
    );
  });

  it('ignores objectives with no declared target', () => {
    const untargeted: StrategicObjective[] = [
      { id: 'o1', code: 'SO-1', title: 'Untargeted', horizon: 'H1_CORE' },
    ];
    const report = assessAlignment(
      [{ id: 'a', label: 'x', amount: '1000', objectiveId: 'o1', alignment: 'DIRECT' }],
      untargeted,
    );
    expect(report.allocations[0]?.targetShare).toBeNull();
    expect(report.allocations[0]?.shareGap).toBeNull();
    expect(report.allocations[0]?.fundingGap).toBeNull();
    expect(report.misalignments).toHaveLength(0);
  });

  it('handles an empty budget without dividing by zero', () => {
    const report = assessAlignment([], objectives);
    expect(report.totalBudget).toBe('0.0000');
    expect(report.alignmentScore).toBe(0);
    expect(report.unallocatedShare).toBe(0);
    expect(report.allocations.every((a) => a.actualShare === 0)).toBe(true);
    expect(report.byHorizon.every((h) => h.share === 0)).toBe(true);
  });

  it('counts the lines attached to each objective', () => {
    const report = assessAlignment(
      [
        { id: 'a', label: 'x', amount: '100', objectiveId: 'o1', alignment: 'DIRECT' },
        { id: 'b', label: 'y', amount: '100', objectiveId: 'o1', alignment: 'SUPPORTING' },
      ],
      objectives,
    );
    expect(report.allocations.find((a) => a.objectiveId === 'o1')?.lineCount).toBe(2);
    expect(report.allocations.find((a) => a.objectiveId === 'o2')?.lineCount).toBe(0);
  });
});
