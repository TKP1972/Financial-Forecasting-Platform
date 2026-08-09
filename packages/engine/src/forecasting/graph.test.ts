import { describe, expect, it } from 'vitest';
import {
  analyseImpact,
  downstreamOf,
  evaluateGraph,
  topologicalOrder,
  type PlanGraph,
  type PlanNode,
} from './graph.js';

/**
 * A small connected plan of the shape the framework describes:
 *   churn -> subscribers -> revenue
 *                   |
 *                   +-----> support contacts -> headcount -> people cost
 */
function telecomGraph(): PlanGraph {
  const nodes: PlanNode[] = [
    {
      code: 'gross_adds',
      name: 'Gross additions',
      kind: 'INPUT',
      values: [1000, 1000, 1000, 1000],
    },
    {
      code: 'churn_rate',
      name: 'Monthly churn',
      kind: 'INPUT',
      values: ['0.02', '0.02', '0.02', '0.02'],
    },
    {
      code: 'subscribers',
      name: 'Closing subscribers',
      kind: 'BALANCE',
      inputs: [
        { as: 'adds', from: 'gross_adds' },
        { as: 'churn', from: 'churn_rate' },
        { as: 'opening', from: 'subscribers', lag: 1, initial: 10000 },
      ],
      compute: ({ adds, churn, opening }) => opening.minus(opening.times(churn)).plus(adds),
    },
    {
      code: 'arpu',
      name: 'ARPU',
      kind: 'INPUT',
      values: ['25.00', '25.00', '25.00', '25.00'],
      isMonetary: true,
    },
    {
      code: 'revenue',
      name: 'Service revenue',
      kind: 'FORMULA',
      isMonetary: true,
      inputs: [
        { as: 'subs', from: 'subscribers' },
        { as: 'arpu', from: 'arpu' },
      ],
      compute: ({ subs, arpu }) => subs.times(arpu),
    },
  ];
  return { name: 'Telecom plan', periodCount: 4, nodes };
}

describe('topologicalOrder', () => {
  it('places every dependency before the node that reads it', () => {
    const order = topologicalOrder(telecomGraph().nodes);
    expect(order.indexOf('subscribers')).toBeLessThan(order.indexOf('revenue'));
    expect(order.indexOf('arpu')).toBeLessThan(order.indexOf('revenue'));
    expect(order.indexOf('gross_adds')).toBeLessThan(order.indexOf('subscribers'));
  });

  it('includes every node exactly once', () => {
    const order = topologicalOrder(telecomGraph().nodes);
    expect(order).toHaveLength(5);
    expect(new Set(order).size).toBe(5);
  });

  it('does not treat a lagged self-reference as a cycle', () => {
    // `subscribers` reads its own previous period, which is legitimate.
    expect(() => topologicalOrder(telecomGraph().nodes)).not.toThrow();
  });

  it('rejects a same-period self-reference with actionable advice', () => {
    const nodes: PlanNode[] = [
      {
        code: 'a',
        name: 'A',
        kind: 'FORMULA',
        inputs: [{ as: 'self', from: 'a' }],
        compute: ({ self }) => self,
      },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/reads itself in the same period/);
  });

  it('detects a two-node cycle and names both nodes', () => {
    const nodes: PlanNode[] = [
      {
        code: 'a',
        name: 'A',
        kind: 'FORMULA',
        inputs: [{ as: 'b', from: 'b' }],
        compute: ({ b }) => b,
      },
      {
        code: 'b',
        name: 'B',
        kind: 'FORMULA',
        inputs: [{ as: 'a', from: 'a' }],
        compute: ({ a }) => a,
      },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/circular dependency/);
    expect(() => topologicalOrder(nodes)).toThrow(/a, b/);
  });

  it('detects a longer cycle', () => {
    const nodes: PlanNode[] = [
      {
        code: 'a',
        name: 'A',
        kind: 'FORMULA',
        inputs: [{ as: 'x', from: 'c' }],
        compute: ({ x }) => x,
      },
      {
        code: 'b',
        name: 'B',
        kind: 'FORMULA',
        inputs: [{ as: 'x', from: 'a' }],
        compute: ({ x }) => x,
      },
      {
        code: 'c',
        name: 'C',
        kind: 'FORMULA',
        inputs: [{ as: 'x', from: 'b' }],
        compute: ({ x }) => x,
      },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/circular dependency/);
  });

  it('rejects a reference to an undefined node', () => {
    const nodes: PlanNode[] = [
      {
        code: 'a',
        name: 'A',
        kind: 'FORMULA',
        inputs: [{ as: 'x', from: 'ghost' }],
        compute: ({ x }) => x,
      },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/reads 'ghost', which is not defined/);
  });

  it('rejects duplicate node codes', () => {
    const nodes: PlanNode[] = [
      { code: 'a', name: 'A', kind: 'INPUT', values: [1] },
      { code: 'a', name: 'A again', kind: 'INPUT', values: [1] },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/Duplicate node code/);
  });

  it('rejects a negative or fractional lag', () => {
    const nodes: PlanNode[] = [
      { code: 'a', name: 'A', kind: 'INPUT', values: [1] },
      {
        code: 'b',
        name: 'B',
        kind: 'FORMULA',
        inputs: [{ as: 'x', from: 'a', lag: -1 }],
        compute: ({ x }) => x,
      },
    ];
    expect(() => topologicalOrder(nodes)).toThrow(/lag must be a non-negative whole number/);
  });
});

describe('evaluateGraph', () => {
  it('propagates a balance forward through the horizon', () => {
    // opening 10,000; churn 2%; adds 1,000
    // P1: 10000 - 200 + 1000 = 10800
    // P2: 10800 - 216 + 1000 = 11584
    // P3: 11584 - 231.68 + 1000 = 12352.32
    // P4: 12352.32 - 247.0464 + 1000 = 13105.2736
    const result = evaluateGraph(telecomGraph());
    const subs = result.byCode.subscribers as string[];

    expect(Number(subs[0])).toBeCloseTo(10800, 6);
    expect(Number(subs[1])).toBeCloseTo(11584, 6);
    expect(Number(subs[2])).toBeCloseTo(12352.32, 6);
    expect(Number(subs[3])).toBeCloseTo(13105.2736, 6);
  });

  it('computes a downstream node from an upstream one in the same period', () => {
    // revenue = subscribers x 25
    const result = evaluateGraph(telecomGraph());
    const revenue = result.byCode.revenue as string[];
    expect(Number(revenue[0])).toBeCloseTo(10800 * 25, 4);
    expect(Number(revenue[3])).toBeCloseTo(13105.2736 * 25, 4);
  });

  it('reports the evaluation order it used', () => {
    const result = evaluateGraph(telecomGraph());
    expect(result.evaluationOrder).toHaveLength(5);
    expect(result.evaluationOrder.indexOf('revenue')).toBe(4);
  });

  it('uses the declared initial value before the horizon starts', () => {
    const graph: PlanGraph = {
      name: 'lag',
      periodCount: 2,
      nodes: [
        { code: 'x', name: 'X', kind: 'INPUT', values: [5, 5] },
        {
          code: 'y',
          name: 'Y',
          kind: 'FORMULA',
          inputs: [{ as: 'prev', from: 'x', lag: 1, initial: 99 }],
          compute: ({ prev }) => prev,
        },
      ],
    };
    const result = evaluateGraph(graph);
    // Period 1 reaches before the horizon, so the initial applies; period 2 sees x[0].
    expect(Number((result.byCode.y as string[])[0])).toBeCloseTo(99, 6);
    expect(Number((result.byCode.y as string[])[1])).toBeCloseTo(5, 6);
  });

  it('defaults a missing initial to zero', () => {
    const graph: PlanGraph = {
      name: 'lag',
      periodCount: 1,
      nodes: [
        { code: 'x', name: 'X', kind: 'INPUT', values: [5] },
        {
          code: 'y',
          name: 'Y',
          kind: 'FORMULA',
          inputs: [{ as: 'prev', from: 'x', lag: 1 }],
          compute: ({ prev }) => prev,
        },
      ],
    };
    expect(Number((evaluateGraph(graph).byCode.y as string[])[0])).toBe(0);
  });

  it('holds a short input series flat and says so', () => {
    const graph: PlanGraph = {
      name: 'short',
      periodCount: 4,
      nodes: [{ code: 'x', name: 'X', kind: 'INPUT', values: [7, 8] }],
    };
    const result = evaluateGraph(graph);
    expect((result.byCode.x as string[]).map(Number)).toEqual([7, 8, 8, 8]);
    expect(result.warnings.join(' ')).toMatch(/held flat/);
  });

  it('exposes the node its own previous value through context', () => {
    const graph: PlanGraph = {
      name: 'ctx',
      periodCount: 3,
      nodes: [
        { code: 'seed', name: 'Seed', kind: 'INPUT', values: [2, 2, 2] },
        {
          code: 'cumulative',
          name: 'Cumulative',
          kind: 'BALANCE',
          inputs: [{ as: 'add', from: 'seed' }],
          compute: ({ add }, ctx) => (ctx.previous ?? add.times(0)).plus(add),
        },
      ],
    };
    expect((evaluateGraph(graph).byCode.cumulative as string[]).map(Number)).toEqual([2, 4, 6]);
  });

  it('rejects a non-finite result rather than propagating it', () => {
    const graph: PlanGraph = {
      name: 'bad',
      periodCount: 1,
      nodes: [
        { code: 'z', name: 'Zero', kind: 'INPUT', values: [0] },
        {
          code: 'div',
          name: 'Div',
          kind: 'FORMULA',
          inputs: [{ as: 'z', from: 'z' }],
          compute: ({ z }) => z.dividedBy(z),
        },
      ],
    };
    expect(() => evaluateGraph(graph)).toThrow(/non-finite|failed to compute/);
  });

  it('names the node and period when a formula throws', () => {
    const graph: PlanGraph = {
      name: 'boom',
      periodCount: 2,
      nodes: [
        { code: 'x', name: 'X', kind: 'INPUT', values: [1, 1] },
        {
          code: 'bang',
          name: 'Bang',
          kind: 'FORMULA',
          inputs: [{ as: 'x', from: 'x' }],
          compute: (_i, ctx) => {
            if (ctx.periodIndex === 1) throw new Error('deliberate');
            return 0;
          },
        },
      ],
    };
    expect(() => evaluateGraph(graph)).toThrow(/'bang' failed to compute at period 2/);
  });

  it('rejects an empty graph and a non-positive period count', () => {
    expect(() => evaluateGraph({ name: 'e', periodCount: 3, nodes: [] })).toThrow(
      /at least one node/,
    );
    expect(() =>
      evaluateGraph({
        name: 'e',
        periodCount: 0,
        nodes: [{ code: 'a', name: 'A', kind: 'INPUT', values: [1] }],
      }),
    ).toThrow(/positive whole number/);
  });

  it('rejects an input node with no values and a formula node with no compute', () => {
    expect(() =>
      evaluateGraph({
        name: 'x',
        periodCount: 1,
        nodes: [{ code: 'a', name: 'A', kind: 'INPUT', values: [] }],
      }),
    ).toThrow(/has no values/);

    expect(() =>
      evaluateGraph({
        name: 'x',
        periodCount: 1,
        nodes: [{ code: 'a', name: 'A', kind: 'FORMULA' }],
      }),
    ).toThrow(/has no compute function/);
  });
});

describe('analyseImpact', () => {
  it('propagates an input change through every downstream node', () => {
    // Doubling churn from 2% to 4% must reduce subscribers and therefore revenue.
    const impact = analyseImpact(telecomGraph(), { nodeCode: 'churn_rate', factor: '2' });

    expect(impact.affectedNodes).toContain('subscribers');
    expect(impact.affectedNodes).toContain('revenue');
    // The changed node itself and unrelated nodes are reported separately.
    expect(impact.affectedNodes).not.toContain('arpu');

    const revenue = impact.deltas.find((d) => d.code === 'revenue');
    expect(Number(revenue?.delta)).toBeLessThan(0);
  });

  it('reports the changed node itself as moved', () => {
    const impact = analyseImpact(telecomGraph(), { nodeCode: 'arpu', factor: '1.1' });
    expect(impact.affectedNodes).toContain('arpu');
    expect(impact.affectedNodes).toContain('revenue');
    // ARPU does not feed subscribers, so the subscriber base must be untouched.
    expect(impact.affectedNodes).not.toContain('subscribers');
  });

  it('scales a pure multiplier exactly', () => {
    // Revenue = subscribers x ARPU, so +10% ARPU is exactly +10% revenue.
    const impact = analyseImpact(telecomGraph(), { nodeCode: 'arpu', factor: '1.1' });
    const revenue = impact.deltas.find((d) => d.code === 'revenue');
    expect(revenue?.deltaPercent).toBeCloseTo(0.1, 9);
  });

  it('accepts a replacement series', () => {
    const impact = analyseImpact(telecomGraph(), {
      nodeCode: 'arpu',
      values: ['50.00', '50.00', '50.00', '50.00'],
    });
    const revenue = impact.deltas.find((d) => d.code === 'revenue');
    expect(revenue?.deltaPercent).toBeCloseTo(1, 9);
  });

  it('reports no movement when the factor is 1', () => {
    const impact = analyseImpact(telecomGraph(), { nodeCode: 'arpu', factor: '1' });
    expect(impact.affectedNodes).toHaveLength(0);
  });

  it('refuses to perturb a computed node', () => {
    expect(() => analyseImpact(telecomGraph(), { nodeCode: 'revenue', factor: '1.1' })).toThrow(
      /Only INPUT nodes can be perturbed/,
    );
  });

  it('refuses an unknown node', () => {
    expect(() => analyseImpact(telecomGraph(), { nodeCode: 'ghost', factor: '2' })).toThrow(
      /is not in this graph/,
    );
  });
});

describe('downstreamOf', () => {
  it('lists everything reachable downstream, in evaluation order', () => {
    const downstream = downstreamOf(telecomGraph().nodes, 'churn_rate');
    expect(downstream).toContain('subscribers');
    expect(downstream).toContain('revenue');
    expect(downstream).not.toContain('churn_rate');
    expect(downstream.indexOf('subscribers')).toBeLessThan(downstream.indexOf('revenue'));
  });

  it('returns nothing for a leaf that nothing reads', () => {
    expect(downstreamOf(telecomGraph().nodes, 'revenue')).toHaveLength(0);
  });
});
