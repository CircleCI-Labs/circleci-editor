/**
 * Wraps elkjs's `layered` algorithm to position a `WorkflowGraph`'s nodes.
 * Deliberately framework-free (no React) so it stays trivial to swap or
 * mock in tests; `DagPane` is the only real caller.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';

import type { GraphEdge, GraphNode, WorkflowGraph } from './buildGraph';

/** Mirrors elk's own direction vocabulary; `DagPane`'s LR/TB toggle maps directly onto this. */
export type LayoutDirection = 'RIGHT' | 'DOWN';

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: GraphEdge[];
}

export interface LayoutOptions {
  direction?: LayoutDirection;
}

/**
 * Issue #90: the original 220x56 was justified by ours holding *two* cramped
 * rows (`text-xs` mono alias+matrix, then kind/job-name/warning) against
 * production's one comfortable row -- "revisit if node content changes,"
 * was the plan from the start. It just did: `JobNode` now renders a
 * single row too, with the primary label at production's sans/`text-sm`
 * rather than `text-xs` mono. With that gap closed, production's own
 * 256x44 (`WorkflowDagDialog.tsx`) is the right number *verbatim*, not an
 * adapted proportion -- our remaining per-node "budget" is spent on the
 * same shape production's is (one label plus a couple of small trailing
 * badges), just optional/muted ones (matrix, kind, undefined) instead of
 * production's status pill and duration, and it fits the same envelope.
 * Uniformity across every node (both dimensions, both directions) is what
 * keeps ELK's Brandes-Koepf placement landing nodes in clean lanes rather
 * than staggering their centers.
 */
const NODE_HEIGHT = 44;
const NODE_WIDTH = 256;

const elk = new ELK();

/**
 * Lays out `graph` with elkjs's `layered` algorithm, mirroring CircleCI
 * production's own DAG settings (Brandes-Koepf node placement, layer-sweep
 * crossing minimization, orthogonal edge routing) so the result feels
 * consistent with the pipeline UI users already know.
 */
export async function layoutGraph(
  graph: WorkflowGraph,
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  const direction = options.direction ?? 'RIGHT';
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: graph.edges };
  }

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Production's own spacing (issue #54); tighter within a layer (20 vs
      // our old 32) but much more generous between layers (120 vs our old
      // 72), which is what actually reads as "clean lanes" -- cramped
      // between-layer spacing was the second-biggest reason the graph felt
      // denser/messier than production even before the fixed-width change
      // above.
      'elk.spacing.nodeNode': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
      // Independent jobs (no shared ancestor) previously landed in whichever
      // layer/lane ELK's crossing-minimization happened to prefer, which
      // could scatter them across the graph. Both options below are
      // production's own (also missing from our config until issue #54):
      // `considerModelOrder` biases placement toward the order jobs are
      // *written* in the workflow's `jobs:` list, and
      // `separateConnectedComponents: false` stops ELK from laying out each
      // disconnected subgraph as its own independent island -- together they
      // keep independent jobs as one first-layer stack in config order,
      // matching how a user reads the YAML top-to-bottom.
      'elk.separateConnectedComponents': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: graph.edges.map(
      (edge): ElkExtendedEdge => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      }),
    ),
  };

  const result = await elk.layout(elkGraph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const positioned: PositionedNode[] = [];
  for (const child of result.children ?? []) {
    const node = byId.get(child.id);
    if (!node) continue; // defensive: elk should only ever echo back the ids we sent it
    positioned.push({
      ...node,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? NODE_WIDTH,
      height: child.height ?? NODE_HEIGHT,
    });
  }

  return { nodes: positioned, edges: graph.edges };
}
