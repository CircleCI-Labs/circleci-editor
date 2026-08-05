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
