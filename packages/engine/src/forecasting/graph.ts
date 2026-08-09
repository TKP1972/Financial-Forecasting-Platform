/**
 * Connected planning: a driver dependency graph.
 *
 * The gap this closes is that independent drivers cannot answer the question
 * planning actually gets asked. "What happens if churn runs two points higher?"
 * touches subscribers, then revenue, then the headcount needed to serve them,
 * then next year's capex. Modelled as separate drivers, each of those has to be
 * revised by hand and they drift apart the moment anyone forgets one.
 *
 * Here a node declares the nodes it reads. The graph is evaluated in topological
 * order so every input is resolved before the node that consumes it, and cycles
 * are rejected at validation time rather than producing an infinite loop or a
 * silently stale value.
 *
 * Design notes:
 *  - Nodes are evaluated per period, and a node may read *earlier* periods of
 *    any node (including itself) through `lag`. That is what makes stock
 *    balances - subscribers, headcount, an asset base - expressible without
 *    creating a same-period cycle.
 *  - Only same-period references participate in cycle detection. A self
 *    reference at lag >= 1 is legitimate and common.
 */
import {
  CalculationError,
  add,
  toDecimal,
  toMoneyString,
  type Decimal,
  type MoneyInput,
} from '@ffp/shared';

/** A reference from one node to another. */
export interface NodeInput {
  /** Local name the formula sees. */
  as: string;
  /** Code of the node being read. */
  from: string;
  /**
   * Periods to look back. 0 is the same period and creates a dependency edge;
   * 1 or more reads a settled earlier value and does not.
   */
  lag?: number;
  /** Value used when the lag reaches before the start of the horizon. */
  initial?: MoneyInput;
}

export type NodeKind =
  /** A supplied series. The leaves of the graph. */
  | 'INPUT'
  /** Computed from other nodes by a formula. */
  | 'FORMULA'
  /** A stock that carries forward: opening + additions - reductions. */
  | 'BALANCE';

export interface PlanNode {
  code: string;
  name: string;
  kind: NodeKind;
  /** Unit label, purely for presentation. */
  unit?: string;
  /** INPUT only: the supplied series, one value per period. */
  values?: MoneyInput[];
  /** What this node reads. */
  inputs?: NodeInput[];
  /**
   * FORMULA and BALANCE only. Receives the resolved inputs by their local names
   * plus `periodIndex`, and returns this period's value.
   *
   * Kept as a function rather than an expression string: an interpreter would
   * need its own parser, its own error messages and its own sandbox, and the
   * evaluation order - which is the actually hard part - is the same either way.
   */
  compute?: (inputs: Record<string, Decimal>, context: NodeContext) => MoneyInput;
  /** Marks the node as money, so results are rounded to the money scale. */
  isMonetary?: boolean;
}

export interface NodeContext {
  periodIndex: number;
  periodCount: number;
  /** This node's own value in the previous period, when there is one. */
  previous: Decimal | null;
}

export interface PlanGraph {
  name: string;
  periodCount: number;
  nodes: PlanNode[];
}

export interface NodeResult {
  code: string;
  name: string;
  kind: NodeKind;
  unit: string;
  values: string[];
  total: string;
  isMonetary: boolean;
}

export interface GraphResult {
  name: string;
  periodCount: number;
  /** Evaluation order actually used - the topological sort. */
  evaluationOrder: string[];
  nodes: NodeResult[];
  byCode: Record<string, string[]>;
  warnings: string[];
}

// --------------------------------------------------------------------------
// Validation and ordering
// --------------------------------------------------------------------------

/**
 * Topologically order the nodes, or explain precisely why they cannot be.
 *
 * Kahn's algorithm. When it stalls, the nodes still carrying unmet dependencies
 * are exactly the ones in cycles, and the error names them - "there is a cycle
 * somewhere" is not a usable message when a model has two hundred nodes.
 */
export function topologicalOrder(nodes: readonly PlanNode[]): string[] {
  const byCode = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (byCode.has(node.code)) {
      throw CalculationError(`Duplicate node code '${node.code}' in the plan graph.`, {
        code: node.code,
      });
    }
    byCode.set(node.code, node);
  }

  // Only same-period (lag 0) references constrain evaluation order.
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const node of nodes) {
    dependencies.set(node.code, new Set());
    if (!dependents.has(node.code)) dependents.set(node.code, new Set());
  }

  for (const node of nodes) {
    for (const input of node.inputs ?? []) {
      if (!byCode.has(input.from)) {
        throw CalculationError(
          `Node '${node.code}' reads '${input.from}', which is not defined in this graph.`,
          { node: node.code, missing: input.from },
        );
      }
      const lag = input.lag ?? 0;
      if (lag < 0 || !Number.isInteger(lag)) {
        throw CalculationError(
          `Node '${node.code}' reads '${input.from}' with a lag of ${lag}; lag must be a non-negative whole number.`,
          { node: node.code },
        );
      }
      if (lag > 0) continue;

      if (input.from === node.code) {
        throw CalculationError(
          `Node '${node.code}' reads itself in the same period. Use a lag of 1 or more to read its previous value.`,
          { node: node.code },
        );
      }
      dependencies.get(node.code)?.add(input.from);
      dependents.get(input.from)?.add(node.code);
    }
  }

  const ready = nodes.filter((n) => (dependencies.get(n.code)?.size ?? 0) === 0).map((n) => n.code);
  // Stable order: equal-depth nodes come out in declaration order, so a given
  // graph always evaluates identically.
  ready.sort((a, b) => nodes.findIndex((n) => n.code === a) - nodes.findIndex((n) => n.code === b));

  const order: string[] = [];
  const queue = [...ready];

  while (queue.length > 0) {
    const code = queue.shift() as string;
    order.push(code);
    for (const dependent of dependents.get(code) ?? []) {
      const deps = dependencies.get(dependent);
      deps?.delete(code);
      if (deps && deps.size === 0) queue.push(dependent);
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.code)).map((n) => n.code);
    throw CalculationError(
      `The plan graph contains a circular dependency involving: ${stuck.join(', ')}. Break the cycle, or read the previous period instead by giving the input a lag of 1.`,
      { cycle: stuck },
    );
  }

  return order;
}

// --------------------------------------------------------------------------
// Evaluation
// --------------------------------------------------------------------------

/**
 * Evaluate the whole graph.
 *
 * Period-major, node-minor: every node is resolved for period 0 before any node
 * moves to period 1. That ordering is what makes lagged references safe -
 * an earlier period is always fully settled before anything reads it.
 */
export function evaluateGraph(graph: PlanGraph): GraphResult {
  const { nodes, periodCount } = graph;

  if (!Number.isInteger(periodCount) || periodCount < 1) {
    throw CalculationError(`Period count must be a positive whole number, got ${periodCount}.`);
  }
  if (nodes.length === 0) {
    throw CalculationError('A plan graph needs at least one node.');
  }

  const order = topologicalOrder(nodes);
  const byCode = new Map(nodes.map((n) => [n.code, n]));
  const warnings: string[] = [];

  // values[code][periodIndex]
  const values = new Map<string, Decimal[]>(nodes.map((n) => [n.code, []]));

  for (let period = 0; period < periodCount; period += 1) {
    for (const code of order) {
      const node = byCode.get(code) as PlanNode;
      const series = values.get(code) as Decimal[];

      if (node.kind === 'INPUT') {
        const supplied = node.values ?? [];
        if (supplied.length === 0) {
          throw CalculationError(`Input node '${code}' has no values.`, { node: code });
        }
        // Beyond the supplied series, hold the last value flat rather than
        // dropping to zero, which would silently truncate the plan.
        const raw = supplied[period] ?? supplied[supplied.length - 1];
        if (period === supplied.length && supplied.length < periodCount) {
          warnings.push(
            `Input '${code}' supplies ${supplied.length} of ${periodCount} periods; the last value is held flat for the remainder.`,
          );
        }
        series.push(toDecimal(raw as MoneyInput));
        continue;
      }

      if (!node.compute) {
        throw CalculationError(
          `Node '${code}' is a ${node.kind} node but has no compute function.`,
          { node: code },
        );
      }

      const resolved: Record<string, Decimal> = {};
      for (const input of node.inputs ?? []) {
        const lag = input.lag ?? 0;
        const sourceIndex = period - lag;
        if (sourceIndex < 0) {
          resolved[input.as] = toDecimal(input.initial ?? 0);
          continue;
        }
        const sourceSeries = values.get(input.from) as Decimal[];
        const value = sourceSeries[sourceIndex];
        if (value === undefined) {
          // Unreachable given topological order plus period-major evaluation;
          // kept so a future change to either surfaces loudly.
          throw CalculationError(
            `Node '${code}' read '${input.from}' at period ${sourceIndex} before it was computed.`,
            { node: code, from: input.from, period: sourceIndex },
          );
        }
        resolved[input.as] = value;
      }

      const context: NodeContext = {
        periodIndex: period,
        periodCount,
        previous: period > 0 ? ((series[period - 1] as Decimal) ?? null) : null,
      };

      let computed: Decimal;
      try {
        computed = toDecimal(node.compute(resolved, context));
      } catch (error) {
        throw CalculationError(
          `Node '${code}' failed to compute at period ${period + 1}: ${error instanceof Error ? error.message : String(error)}`,
          { node: code, period: period + 1 },
        );
      }

      if (!computed.isFinite()) {
        throw CalculationError(
          `Node '${code}' produced a non-finite value at period ${period + 1}. Check for a division by zero.`,
          { node: code, period: period + 1 },
        );
      }

      series.push(computed);
    }
  }

  const results: NodeResult[] = nodes.map((node) => {
    const series = values.get(node.code) as Decimal[];
    const scale = node.isMonetary ? 4 : 6;
    return {
      code: node.code,
      name: node.name,
      kind: node.kind,
      unit: node.unit ?? (node.isMonetary ? 'currency' : 'units'),
      values: series.map((v) => toMoneyString(v, scale)),
      total: toMoneyString(add(...series), scale),
      isMonetary: node.isMonetary ?? false,
    };
  });

  return {
    name: graph.name,
    periodCount,
    evaluationOrder: order,
    nodes: results,
    byCode: Object.fromEntries(results.map((r) => [r.code, r.values])),
    warnings: [...new Set(warnings)],
  };
}

// --------------------------------------------------------------------------
// Impact analysis
// --------------------------------------------------------------------------

export interface GraphImpact {
  changedNode: string;
  /** Nodes that change as a consequence, in evaluation order. */
  affectedNodes: string[];
  baseline: GraphResult;
  adjusted: GraphResult;
  deltas: Array<{
    code: string;
    name: string;
    isMonetary: boolean;
    baselineTotal: string;
    adjustedTotal: string;
    delta: string;
    deltaPercent: number | null;
  }>;
}

/**
 * Re-evaluate with one input perturbed and report everything it moved.
 *
 * This is the payoff of the graph: "raise churn two points" produces the full
 * downstream consequence in one call, rather than a person remembering which
 * four other numbers to revise.
 */
export function analyseImpact(
  graph: PlanGraph,
  change: { nodeCode: string; factor?: MoneyInput; values?: MoneyInput[] },
): GraphImpact {
  const target = graph.nodes.find((n) => n.code === change.nodeCode);
  if (!target) {
    throw CalculationError(`Node '${change.nodeCode}' is not in this graph.`, {
      node: change.nodeCode,
    });
  }
  if (target.kind !== 'INPUT') {
    throw CalculationError(
      `Only INPUT nodes can be perturbed directly; '${change.nodeCode}' is a ${target.kind} node. Change the inputs it derives from instead.`,
      { node: change.nodeCode, kind: target.kind },
    );
  }

  const baseline = evaluateGraph(graph);

  const adjustedNodes = graph.nodes.map((node) => {
    if (node.code !== change.nodeCode) return node;
    if (change.values) return { ...node, values: change.values };
    const factor = toDecimal(change.factor ?? 1);
    return { ...node, values: (node.values ?? []).map((v) => toDecimal(v).times(factor)) };
  });

  const adjusted = evaluateGraph({ ...graph, nodes: adjustedNodes });

  const deltas = baseline.nodes.map((base) => {
    const after = adjusted.nodes.find((n) => n.code === base.code) as NodeResult;
    const baseTotal = toDecimal(base.total);
    const delta = toDecimal(after.total).minus(baseTotal);
    return {
      code: base.code,
      name: base.name,
      isMonetary: base.isMonetary,
      baselineTotal: base.total,
      adjustedTotal: after.total,
      delta: toMoneyString(delta, base.isMonetary ? 4 : 6),
      deltaPercent: baseTotal.isZero() ? null : delta.dividedBy(baseTotal.abs()).toNumber(),
    };
  });

  return {
    changedNode: change.nodeCode,
    affectedNodes: baseline.evaluationOrder.filter((code) => {
      const delta = deltas.find((d) => d.code === code);
      return delta !== undefined && !toDecimal(delta.delta).isZero();
    }),
    baseline,
    adjusted,
    deltas,
  };
}

/** Every node reachable downstream of `code`, in evaluation order. */
export function downstreamOf(nodes: readonly PlanNode[], code: string): string[] {
  const order = topologicalOrder(nodes);
  const affected = new Set<string>([code]);

  for (const candidate of order) {
    const node = nodes.find((n) => n.code === candidate);
    const reads = (node?.inputs ?? []).some((input) => affected.has(input.from));
    if (reads) affected.add(candidate);
  }

  affected.delete(code);
  return order.filter((c) => affected.has(c));
}
