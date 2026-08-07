import { describe, expect, it } from 'vitest';

import type { GraphNode, WorkflowGraph } from './buildGraph';
import { layoutGraph } from './layout';

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    jobName: overrides.id,
    alias: overrides.id,
    kind: 'job',
    requires: [],
    isDefined: true,
    matrix: false,
    entryOptions: { context: [], preSteps: [], postSteps: [], parameters: {} },
    ...overrides,
  };
}

function makeGraph(
  nodes: GraphNode[],
  edges: WorkflowGraph['edges'] = [],
): WorkflowGraph {
  return { nodes, edges, problems: [] };
}

describe('layoutGraph', () => {
  it('returns a position for every node', async () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'build' }),
        makeNode({ id: 'test' }),
        makeNode({ id: 'deploy' }),
      ],
      [
        { id: 'build->test', source: 'build', target: 'test' },
        { id: 'test->deploy', source: 'test', target: 'deploy' },
      ],
    );

    const result = await layoutGraph(graph);

    expect(result.nodes).toHaveLength(3);
    for (const node of result.nodes) {
      expect(typeof node.x).toBe('number');
      expect(typeof node.y).toBe('number');
      expect(Number.isNaN(node.x)).toBe(false);
      expect(Number.isNaN(node.y)).toBe(false);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
    expect(result.edges).toBe(graph.edges);
  });

  it("preserves each node's original graph fields alongside its position", async () => {
    const graph = makeGraph([
      makeNode({
        id: 'node/test',
        kind: 'orb',
        orbRef: 'node',
        jobName: 'node/test',
      }),
    ]);

    const result = await layoutGraph(graph);

    expect(result.nodes[0]).toMatchObject({
      id: 'node/test',
      kind: 'orb',
      orbRef: 'node',
    });
  });

  it('lays out left-to-right (RIGHT) so the second node advances mostly along x', async () => {
    const graph = makeGraph(
      [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
      [{ id: 'a->b', source: 'a', target: 'b' }],
    );

    const result = await layoutGraph(graph, { direction: 'RIGHT' });
    const a = result.nodes.find((n) => n.id === 'a');
    const b = result.nodes.find((n) => n.id === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;

    expect(b.x).toBeGreaterThan(a.x);
  });

  it('lays out top-to-bottom (DOWN) so the second node advances mostly along y', async () => {
    const graph = makeGraph(
      [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
      [{ id: 'a->b', source: 'a', target: 'b' }],
    );

    const result = await layoutGraph(graph, { direction: 'DOWN' });
    const a = result.nodes.find((n) => n.id === 'a');
    const b = result.nodes.find((n) => n.id === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;

    expect(b.y).toBeGreaterThan(a.y);
  });

  // Issue #54: nodes used to widen per label length (`estimateNodeWidth`,
  // 140-320px), which read as ragged rows compared to CircleCI production's
  // own fixed-width nodes -- production's uniform dimensions are what keep
  // ranks aligned into clean lanes. A long label still isn't clipped, but
  // now via `JobNode`'s `truncate` + `title` tooltip rather than a wider box.
  it('gives every node the same fixed width regardless of label length', async () => {
    const graph = makeGraph([
      makeNode({ id: 'short' }),
      makeNode({ id: 'a-very-long-job-name-that-needs-more-room' }),
    ]);

    const result = await layoutGraph(graph);
    const short = result.nodes.find((n) => n.id === 'short');
    const long = result.nodes.find(
      (n) => n.id === 'a-very-long-job-name-that-needs-more-room',
    );
    expect(short).toBeDefined();
    expect(long).toBeDefined();
    if (!short || !long) return;

    expect(long.width).toBe(short.width);
  });

  it('resolves to an empty result for an empty graph without calling elk', async () => {
    const result = await layoutGraph(makeGraph([]));
    expect(result).toEqual({ nodes: [], edges: [] });
  });
});

// ---------------------------------------------------------------------------
// Issue #24: a selected group's interior is laid out as ELK's own compound
// node, not a second, disconnected layout pass -- these pin that the
// surrounding graph still lays out and that the interior's positions come
// back usable (finite, relative to the group), without asserting exact
// pixel values that would just be pinning ELK's own algorithm.
// ---------------------------------------------------------------------------

describe('layoutGraph with expandedGroupId (#24)', () => {
  function makeGroupNode(
    overrides: Partial<GraphNode> & { id: string },
  ): GraphNode {
    return makeNode({
      kind: 'group',
      groupMembers: ['a', 'b'],
      groupSubgraph: {
        nodes: [
          makeNode({ id: `${overrides.id}::a` }),
          makeNode({ id: `${overrides.id}::b` }),
        ],
        edges: [
          {
            id: `${overrides.id}::a->${overrides.id}::b`,
            source: `${overrides.id}::a`,
            target: `${overrides.id}::b`,
            internal: true,
          },
        ],
        problems: [],
      },
      ...overrides,
    });
  }

  it('lays out an expanded group as a compound node, with members positioned relative to it', async () => {
    const group = makeGroupNode({ id: 'deploy-group' });
    const graph = makeGraph(
      [makeNode({ id: 'build' }), group],
      [{ id: 'build->deploy-group', source: 'build', target: 'deploy-group' }],
    );

    const result = await layoutGraph(graph, {
      expandedGroupId: 'deploy-group',
    });

    const groupPos = result.nodes.find((n) => n.id === 'deploy-group');
    const memberA = result.nodes.find((n) => n.id === 'deploy-group::a');
    const memberB = result.nodes.find((n) => n.id === 'deploy-group::b');
    expect(groupPos).toBeDefined();
    expect(memberA).toBeDefined();
    expect(memberB).toBeDefined();

    // Sized to fit its own children, not the ordinary fixed leaf size --
    // the whole point of the compound treatment.
    expect(groupPos && groupPos.width).toBeGreaterThan(NODE_WIDTH_FOR_TEST);
    // Every position is finite and, per ELK's own convention for a
    // hierarchical node, small (member coordinates are relative to the
    // group's own origin, not the root's) -- both members land well inside
    // the group's own bounding box, not out at the root graph's scale.
    for (const node of [groupPos, memberA, memberB]) {
      expect(Number.isFinite(node?.x)).toBe(true);
      expect(Number.isFinite(node?.y)).toBe(true);
    }
    expect(memberA && groupPos && memberA.x < groupPos.width).toBe(true);

    // The internal edge is appended to the graph's own edges -- one flat
    // list, no separate rendering path for "an edge inside a group".
    expect(
      result.edges.some(
        (e) =>
          e.source === 'deploy-group::a' &&
          e.target === 'deploy-group::b' &&
          e.internal === true,
      ),
    ).toBe(true);
    // The external edge (build -> the group as a unit) is untouched.
    expect(
      result.edges.some(
        (e) => e.source === 'build' && e.target === 'deploy-group',
      ),
    ).toBe(true);
  });

  it('falls back to the ordinary leaf when expandedGroupId names an unresolvable group', async () => {
    const unresolvable = makeNode({
      id: 'mystery',
      kind: 'group',
      groupMembers: undefined,
      groupSubgraph: undefined,
    });
    const graph = makeGraph([unresolvable]);

    const result = await layoutGraph(graph, { expandedGroupId: 'mystery' });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.width).toBe(NODE_WIDTH_FOR_TEST);
    // No interior to draw, so the edges array is untouched -- same
    // reference as the input, exactly like the collapsed path.
    expect(result.edges).toBe(graph.edges);
  });

  it('leaves the collapsed (no expandedGroupId) path producing the identical edges reference', async () => {
    const group = makeGroupNode({ id: 'deploy-group' });
    const graph = makeGraph([group]);

    const result = await layoutGraph(graph);

    expect(result.nodes[0]?.width).toBe(NODE_WIDTH_FOR_TEST);
    expect(result.edges).toBe(graph.edges);
  });
});

/** Mirrors `layout.ts`'s own private `NODE_WIDTH` -- kept as a literal here
 * rather than exported from that module purely for a test to import, since
 * nothing else needs it public. */
const NODE_WIDTH_FOR_TEST = 256;

// ---------------------------------------------------------------------------
// Issue #12: a dangling `requires:` is now a real edge into a synthesised
// `missing` placeholder node (see `buildGraph`). ELK must handle that like
// any other node -- an edge whose endpoint it has never been told about is
// what would actually make `elk.layout()` throw, which is precisely why the
// placeholder exists rather than a half-drawn edge.
// ---------------------------------------------------------------------------

describe('layoutGraph with a dangling requires reference (#12)', () => {
  it('lays out a missing-node placeholder and its dangling edge without throwing', async () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'deploy' }),
        makeNode({
          id: 'gone',
          kind: 'missing',
          isMissing: true,
          isDefined: false,
        }),
      ],
      [
        {
          id: 'gone->deploy',
          source: 'gone',
          target: 'deploy',
          dangling: true,
        },
      ],
    );

    const result = await layoutGraph(graph);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['deploy', 'gone']);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    // The placeholder is laid out upstream of the entry that requires it,
    // exactly like a real dependency would be.
    const gone = result.nodes.find((n) => n.id === 'gone');
    const deploy = result.nodes.find((n) => n.id === 'deploy');
    expect(gone && deploy && gone.x < deploy.x).toBe(true);
    expect(result.edges).toEqual(graph.edges);
  });

  it('does not throw when several entries dangle onto the same placeholder', async () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'lint' }),
        makeNode({ id: 'deploy' }),
        makeNode({
          id: 'build',
          kind: 'missing',
          isMissing: true,
          isDefined: false,
        }),
      ],
      [
        { id: 'build->lint', source: 'build', target: 'lint', dangling: true },
        {
          id: 'build->deploy',
          source: 'build',
          target: 'deploy',
          dangling: true,
        },
      ],
    );

    await expect(layoutGraph(graph)).resolves.toMatchObject({
      nodes: expect.any(Array),
    });
  });
});
