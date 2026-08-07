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
  /**
   * The single group node whose interior should be laid out alongside
   * everything else, drawn as ELK's own hierarchical/compound node rather
   * than a second, disconnected layout pass (issue #24). At most one at a
   * time, by construction -- `DagPane` derives this from *selection*, and
   * only one node can be selected -- which is what keeps this cheap even on
   * a config that leans heavily on groups: laying out N groups' worth of
   * members costs nothing extra for every group nobody has clicked on. Has
   * no effect (falls back to the ordinary fixed-size leaf) when `graph` has
   * no node with this id, or that node has no resolvable `groupSubgraph` --
   * see `GraphNode.groupSubgraph`'s own doc comment on when that happens.
   */
  expandedGroupId?: string;
}

/**
 * Room reserved above a group's members for the header this app draws in
 * their place -- the "Group" badge, its name, and a collapse affordance --
 * via ELK's own `elk.padding` on that one compound node. Not `NODE_HEIGHT`
 * itself: the header is a simpler single row than a full job card, and
 * padding this tight is what keeps an expanded group's own footprint close
 * to "one job card's height plus its members," rather than needlessly wide.
 */
const GROUP_HEADER_HEIGHT = 40;
const GROUP_PADDING = 16;

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

  // Issue #24: at most one node ever expands (see `LayoutOptions.expandedGroupId`'s
  // own doc comment), and only when it actually has an interior to draw --
  // an unresolvable group, or any other kind, falls straight through to the
  // ordinary fixed-size leaf below, unchanged from before this option
  // existed.
  const expandedNode = graph.nodes.find(
    (node) => node.id === options.expandedGroupId && node.groupSubgraph,
  );

  // Shared by the root graph and (below) the one compound node -- a group's
  // interior is laid out with the identical algorithm/crossing-minimization
  // choices as the rest of the canvas, just at a tighter between-layer
  // spacing (60 vs 120) that suits a small, single-group interior rather
  // than a whole workflow's worth of layers.
  const sharedLayoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.separateConnectedComponents': 'false',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  };

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...sharedLayoutOptions,
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
      // could scatter them across the graph. `considerModelOrder` (above)
      // and `separateConnectedComponents: false` (also above) are both
      // production's own (also missing from our config until issue #54) --
      // together they keep independent jobs as one first-layer stack in
      // config order, matching how a user reads the YAML top-to-bottom.
    },
    children: graph.nodes.map((node) => {
      if (node !== expandedNode || !node.groupSubgraph) {
        return { id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT };
      }
      // The expanded group becomes a compound ELK node: no fixed
      // width/height of its own (ELK sizes it to fit its own children plus
      // `elk.padding`, exactly the way a leaf's fixed size fits a job
      // card) -- this is what makes the surrounding layout reflow around
      // however big *this one* group's interior turns out to be, rather
      // than every node reserving room for a group nobody has expanded.
      return {
        id: node.id,
        layoutOptions: {
          ...sharedLayoutOptions,
          'elk.spacing.nodeNode': '20',
          'elk.layered.spacing.nodeNodeBetweenLayers': '60',
          'elk.padding': `[top=${GROUP_HEADER_HEIGHT},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
        },
        children: node.groupSubgraph.nodes.map((member) => ({
          id: member.id,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
        edges: node.groupSubgraph.edges.map(
          (edge): ElkExtendedEdge => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
          }),
        ),
      };
    }),
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
  // Set only if `expandedNode` actually got laid out as a compound node
  // below -- i.e. exactly its own `groupSubgraph.edges`, ready to be
  // appended to the graph's own edges so `DagPane` can hand both to React
  // Flow with no separate rendering path for an internal edge (issue #24).
  let expandedEdges: GraphEdge[] | undefined;
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

    if (node !== expandedNode || !node.groupSubgraph) continue;
    // ELK positions a compound node's own children *relative to that
    // node's own origin* (verified against elkjs directly, not assumed --
    // see this PR's description for the spike) -- which is exactly the
    // coordinate space React Flow's `parentId` node relationship expects,
    // so no re-basing is needed between the two.
    const memberById = new Map(
      node.groupSubgraph.nodes.map((member) => [member.id, member]),
    );
    for (const memberChild of child.children ?? []) {
      const member = memberById.get(memberChild.id);
      if (!member) continue;
      positioned.push({
        ...member,
        x: memberChild.x ?? 0,
        y: memberChild.y ?? 0,
        width: memberChild.width ?? NODE_WIDTH,
        height: memberChild.height ?? NODE_HEIGHT,
      });
    }
    expandedEdges = node.groupSubgraph.edges;
  }

  return {
    nodes: positioned,
    // Identical reference to `graph.edges` when nothing is expanded (the
    // overwhelming common case): no new array, no new work, matching this
    // function's behaviour before `expandedGroupId` existed.
    edges: expandedEdges ? [...graph.edges, ...expandedEdges] : graph.edges,
  };
}
