import { describe, expect, it } from 'vitest';

import { getJobNames, parseConfig } from '~/lib/yaml/documentUtils';

import reusableExecutorsConfig from '~/fixtures/reusable-executors.yml?raw';
import orchestrationConstructs from '~/fixtures/orchestration-constructs.yml?raw';
import matrixJobsConfig from '~/fixtures/matrix-jobs.yml?raw';

import { buildWorkflowGraph, listWorkflows } from './buildGraph';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('listWorkflows', () => {
  it('lists workflow names in document order', () => {
    const doc = parse(`
workflows:
  build_test:
    jobs:
      - build
  deploy:
    jobs:
      - build
`);
    expect(listWorkflows(doc)).toEqual(['build_test', 'deploy']);
  });
});

describe('buildWorkflowGraph', () => {
  it('handles a bare string entry with no requires', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes).toEqual([
      {
        id: 'build',
        jobName: 'build',
        alias: 'build',
        kind: 'job',
        orbRef: undefined,
        requires: [],
        isDefined: true,
        matrix: false,
        entryOptions: {
          context: [],
          preSteps: [],
          postSteps: [],
          parameters: {},
        },
      },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([]);
  });

  it('handles single-key map entries and produces one edge per requires entry', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
  test:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build
      - deploy:
          requires:
            - build
            - test
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes.map((n) => n.id)).toEqual(['build', 'test', 'deploy']);
    expect(graph.edges).toEqual([
      { id: 'build->test', source: 'build', target: 'test' },
      { id: 'build->deploy', source: 'build', target: 'deploy' },
      { id: 'test->deploy', source: 'test', target: 'deploy' },
    ]);
    expect(graph.problems).toEqual([]);
  });

  it('uses the entry alias (name:) as the node id, not the job name -- requires must resolve against it', () => {
    const doc = parse(`
jobs:
  test:
    docker: []
  build:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          name: test-linux
          requires:
            - build
      - test:
          name: test-macos
          requires:
            - build
      - deploy:
          requires:
            - test-linux
            - test-macos
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toEqual(['build', 'test-linux', 'test-macos', 'deploy']);

    const testLinux = graph.nodes.find((n) => n.id === 'test-linux');
    expect(testLinux).toMatchObject({ jobName: 'test', alias: 'test-linux' });

    // "deploy" requires both aliases -- both must resolve to real nodes, not
    // to an unknown-job problem, and not collide with each other despite
    // sharing an underlying job name.
    expect(graph.problems).toEqual([]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { id: 'test-linux->deploy', source: 'test-linux', target: 'deploy' },
        { id: 'test-macos->deploy', source: 'test-macos', target: 'deploy' },
      ]),
    );
  });

  it('marks type: approval entries as kind approval and never flags them as undefined', () => {
    const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - hold:
          type: approval
      - deploy:
          requires:
            - hold
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const hold = graph.nodes.find((n) => n.id === 'hold');
    expect(hold).toMatchObject({
      kind: 'approval',
      isDefined: true,
      jobName: 'hold',
    });
    expect(graph.problems).toEqual([]);
  });

  it('detects orb jobs by the slash in the job name and extracts orbRef', () => {
    const doc = parse(`
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes).toEqual([
      {
        id: 'node/test',
        jobName: 'node/test',
        alias: 'node/test',
        kind: 'orb',
        orbRef: 'node',
        requires: [],
        isDefined: true,
        matrix: false,
        entryOptions: {
          context: [],
          preSteps: [],
          postSteps: [],
          parameters: {},
        },
      },
    ]);
    expect(graph.problems).toEqual([]);
  });

  it('flags a job entry referencing a job not defined under jobs: and not orb-qualified', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
      - ghost:
          requires:
            - build
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const ghost = graph.nodes.find((n) => n.id === 'ghost');
    expect(ghost?.isDefined).toBe(false);
    expect(graph.problems).toEqual([
      expect.objectContaining({ severity: 'warning', nodeId: 'ghost' }),
    ]);
  });

  it('flags requires naming an unknown node as an error, and renders it as a visible dangling edge (#12)', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          requires:
            - nonexistent
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.problems).toEqual([
      expect.objectContaining({
        severity: 'error',
        nodeId: 'build',
        message: expect.stringContaining('nonexistent'),
      }),
    ]);
    // Issue #12: the edge is kept, pointing at a synthesised placeholder, so
    // the break is something the user can see rather than an edge that
    // silently isn't drawn.
    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: 'nonexistent',
        target: 'build',
        dangling: true,
      }),
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(['build', 'nonexistent']);
    expect(graph.nodes.find((n) => n.id === 'nonexistent')).toMatchObject({
      kind: 'missing',
      isMissing: true,
      isDefined: false,
    });
  });

  it('detects a two-node dependency cycle without hanging and reports the participating nodes', () => {
    const doc = parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
workflows:
  main:
    jobs:
      - a:
          requires:
            - b
      - b:
          requires:
            - a
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const cycleProblems = graph.problems.filter((p) =>
      p.message.includes('cycle'),
    );
    expect(cycleProblems).toHaveLength(1);
    expect(cycleProblems[0]?.severity).toBe('error');
    expect(cycleProblems[0]?.message).toMatch(/a/);
    expect(cycleProblems[0]?.message).toMatch(/b/);
  });

  it('detects a longer cycle and does not report the same cycle twice', () => {
    const doc = parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
  c:
    docker: []
workflows:
  main:
    jobs:
      - a:
          requires:
            - c
      - b:
          requires:
            - a
      - c:
          requires:
            - b
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const cycleProblems = graph.problems.filter((p) =>
      p.message.includes('cycle'),
    );
    expect(cycleProblems).toHaveLength(1);
  });

  it('marks matrix entries with matrix: true and expands one node per combination', () => {
    const doc = parse(`
jobs:
  test:
    docker: []
workflows:
  main:
    jobs:
      - test:
          matrix:
            parameters:
              version: ["1", "2"]
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes).toHaveLength(2);
    for (const node of graph.nodes) {
      expect(node).toMatchObject({ matrix: true, matrixGroupSize: 2 });
    }
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['test-1', 'test-2']);
  });

  it('defaults matrix to false when absent', () => {
    const doc = parse(`
jobs:
  test:
    docker: []
workflows:
  main:
    jobs:
      - test
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes[0]).toMatchObject({ matrix: false });
  });

  describe('entryOptions (#37)', () => {
    it('defaults to empty for a bare-string entry', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions).toEqual({
        context: [],
        preSteps: [],
        postSteps: [],
        parameters: {},
      });
    });

    it('normalizes a bare-string context to a one-item list', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          context: org-global
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.context).toEqual(['org-global']);
    });

    it('reads a list-form context as-is', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          context:
            - org-global
            - deploy-secrets
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.context).toEqual([
        'org-global',
        'deploy-secrets',
      ]);
    });

    it('reads filters, normalizing a bare-string only/ignore to a list (matches the real flakey-todo-list config)', () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          filters:
            branches:
              only: main
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.filters).toEqual({
        branches: { only: ['main'] },
      });
    });

    it('reads full branches+tags filters with only and ignore', () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          filters:
            branches:
              only: [main, develop]
              ignore: [/wip-.*/]
            tags:
              only: [/^v.*/]
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.filters).toEqual({
        branches: { only: ['main', 'develop'], ignore: ['/wip-.*/'] },
        tags: { only: ['/^v.*/'] },
      });
    });

    it('omits filters entirely when the entry declares none', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          context: org-global
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.filters).toBeUndefined();
    });

    it("reads pre-steps and post-steps to the same plain-JS shape a job's own steps would produce", () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          pre-steps:
            - run: echo pre
          post-steps:
            - run: echo post
            - store_artifacts:
                path: out
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.preSteps).toEqual([
        { run: 'echo pre' },
      ]);
      expect(graph.nodes[0]?.entryOptions.postSteps).toEqual([
        { run: 'echo post' },
        { store_artifacts: { path: 'out' } },
      ]);
    });

    it('collects every other sibling key as an invocation parameter for an orb job entry', () => {
      const doc = parse(`
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test:
          run-command: npm run test:ci
          requires: []
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.parameters).toEqual({
        'run-command': 'npm run test:ci',
      });
    });

    it('collects invocation parameters for a parameterized local job, excluding name/requires/context/filters', () => {
      const doc = parse(`
jobs:
  deploy:
    parameters:
      environment:
        type: string
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          name: deploy-staging
          environment: staging
          context: org-global
          requires: []
`);
      const graph = buildWorkflowGraph(doc, 'main');
      const node = graph.nodes.find((n) => n.id === 'deploy-staging');
      expect(node?.entryOptions.parameters).toEqual({ environment: 'staging' });
      expect(node?.entryOptions.context).toEqual(['org-global']);
    });

    it('does not treat matrix: as an invocation parameter', () => {
      const doc = parse(`
jobs:
  test:
    docker: []
workflows:
  main:
    jobs:
      - test:
          matrix:
            parameters:
              version: ["1", "2"]
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes[0]?.entryOptions.parameters).toEqual({});
    });

    it('reads entryOptions for an approval entry the same way as a job entry', () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy
      - hold:
          type: approval
          name: hold-before-deploy
          context: org-global
          requires:
            - deploy
`);
      const graph = buildWorkflowGraph(doc, 'main');
      const hold = graph.nodes.find((n) => n.id === 'hold-before-deploy');
      expect(hold?.entryOptions.context).toEqual(['org-global']);
    });
  });

  it('returns an empty graph for a workflow with no jobs', () => {
    const doc = parse(`
workflows:
  main:
    jobs: []
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph).toEqual({ nodes: [], edges: [], problems: [] });
  });

  it('returns an empty graph for an unknown workflow name', () => {
    const doc = parse(`
workflows:
  main:
    jobs:
      - build
`);
    const graph = buildWorkflowGraph(doc, 'does-not-exist');
    expect(graph).toEqual({ nodes: [], edges: [], problems: [] });
  });

  describe('requires with status conditions (#26)', () => {
    it('draws an edge from a status-map requires entry, keyed by its map key', () => {
      const doc = parse(`
jobs:
  lint-backend:
    docker: []
  test-backend:
    docker: []
workflows:
  main:
    jobs:
      - lint-backend
      - test-backend:
          requires:
            - lint-backend:
                - success
                - failed
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes.map((n) => n.id)).toEqual([
        'lint-backend',
        'test-backend',
      ]);
      // The edge exists and points at the map's key -- the statuses never
      // change topology, only the edges' `statuses` metadata.
      expect(graph.edges).toEqual([
        {
          id: 'lint-backend->test-backend',
          source: 'lint-backend',
          target: 'test-backend',
          statuses: ['success', 'failed'],
        },
      ]);
      // No phantom "success"/"failed" nodes, and no unknown-job errors.
      expect(graph.nodes.map((n) => n.id)).not.toContain('success');
      expect(graph.nodes.map((n) => n.id)).not.toContain('failed');
      expect(graph.problems).toEqual([]);
    });

    it('leaves a plain string requires entry with statuses undefined on both the node and the edge', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.edges).toEqual([
        { id: 'build->test', source: 'build', target: 'test' },
      ]);
      expect(graph.edges[0]?.statuses).toBeUndefined();
    });

    it('mixes plain and status-map requires entries on the same node', () => {
      const doc = parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
  c:
    docker: []
workflows:
  main:
    jobs:
      - a
      - b
      - c:
          requires:
            - a
            - b:
                - success
                - canceled
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          { id: 'a->c', source: 'a', target: 'c' },
          {
            id: 'b->c',
            source: 'b',
            target: 'c',
            statuses: ['success', 'canceled'],
          },
        ]),
      );
      expect(graph.problems).toEqual([]);
    });

    it('warns (never errors) on an unrecognized status, and still draws the edge', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build:
                - some-made-up-status
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.edges).toEqual([
        {
          id: 'build->test',
          source: 'build',
          target: 'test',
          statuses: ['some-made-up-status'],
        },
      ]);
      expect(graph.problems).toEqual([
        expect.objectContaining({ severity: 'warning', nodeId: 'test' }),
      ]);
      expect(graph.problems.every((p) => p.severity === 'warning')).toBe(true);
    });

    it('warns (never errors) when a status-map value is not a plain list of strings, and still draws the edge', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build: not-a-list
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.edges).toEqual([
        { id: 'build->test', source: 'build', target: 'test' },
      ]);
      expect(graph.problems).toEqual([
        expect.objectContaining({ severity: 'warning', nodeId: 'test' }),
      ]);
    });

    it('still flags an unknown job even inside the status-map form', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          requires:
            - nonexistent:
                - success
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('nonexistent'),
        }),
      ]);
      // #12: kept as a dangling edge into a `missing` placeholder, with the
      // status condition it was written with preserved on the edge.
      expect(graph.edges).toEqual([
        expect.objectContaining({
          source: 'nonexistent',
          target: 'build',
          dangling: true,
          statuses: ['success'],
        }),
      ]);
    });

    it('produces zero unknown-job problems and correct edges for the real-world reusable-executors fixture', () => {
      const doc = parse(reusableExecutorsConfig);
      const graph = buildWorkflowGraph(doc, 'main');

      expect(graph.problems.filter((p) => p.severity === 'error')).toEqual([]);
      // Specifically: no "requires unknown job" / undefined-job noise from
      // the status-map requires entries (issue #26's actual symptom).
      expect(
        graph.problems.filter((p) => p.message.includes('unknown job')),
      ).toEqual([]);

      const nodeIds = graph.nodes.map((n) => n.id);
      expect(nodeIds).not.toContain('success');
      expect(nodeIds).not.toContain('failed');

      const edge = graph.edges.find(
        (e) => e.source === 'lint-backend' && e.target === 'test-backend',
      );
      expect(edge).toMatchObject({ statuses: ['success', 'failed'] });

      // slack/on-hold is an orb job entry, unaffected by the orb's own
      // (deliberately) broken ref -- that's the user's bug, not ours.
      const slackNode = graph.nodes.find((n) => n.id === 'slack/on-hold');
      expect(slackNode).toMatchObject({
        kind: 'orb',
        orbRef: 'slack',
        isDefined: true,
      });
    });
  });

  it('supports multiple independent workflows in the same document', () => {
    const doc = parse(`
jobs:
  build:
    docker: []
  deploy:
    docker: []
workflows:
  build_only:
    jobs:
      - build
  deploy_only:
    jobs:
      - deploy
`);
    expect(listWorkflows(doc)).toEqual(['build_only', 'deploy_only']);
    expect(
      buildWorkflowGraph(doc, 'build_only').nodes.map((n) => n.id),
    ).toEqual(['build']);
    expect(
      buildWorkflowGraph(doc, 'deploy_only').nodes.map((n) => n.id),
    ).toEqual(['deploy']);
  });
});

// ---------------------------------------------------------------------------
// Issue #12: a dangling `requires:` must be *visible*. Being able to see the
// breakage is the feature -- these pin that the graph reports it, renders it,
// and never quietly repairs or hides it.
// ---------------------------------------------------------------------------

describe('dangling requires references (#12)', () => {
  it('one placeholder serves every entry requiring the same missing id', () => {
    const doc = parse(`
jobs:
  lint:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - lint:
          requires:
            - build
      - deploy:
          requires:
            - build
            - lint
`);
    const graph = buildWorkflowGraph(doc, 'main');

    expect(graph.nodes.filter((n) => n.isMissing).map((n) => n.id)).toEqual([
      'build',
    ]);
    expect(
      graph.edges
        .filter((e) => e.dangling)
        .map((e) => `${e.source}->${e.target}`),
    ).toEqual(['build->lint', 'build->deploy']);
    // The healthy edge in the same list is untouched and not marked dangling.
    expect(graph.edges.find((e) => e.id === 'lint->deploy')).toMatchObject({
      dangling: undefined,
    });
    expect(graph.problems.filter((p) => p.severity === 'error')).toHaveLength(
      2,
    );
  });

  it('the placeholder is never mistaken for a real, definable job', () => {
    const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          requires:
            - gone
`);
    const graph = buildWorkflowGraph(doc, 'main');
    const placeholder = graph.nodes.find((n) => n.id === 'gone');
    expect(placeholder).toMatchObject({
      kind: 'missing',
      isMissing: true,
      isDefined: false,
      matrix: false,
      requires: [],
    });
    // A `missing` node has no entry in the config, so it must never be
    // counted as a `job` node the inspector/palette could act on.
    expect(placeholder?.kind).not.toBe('job');
  });

  it('an alias that requires a *removed* alias dangles under the alias name, not the job name (#12)', () => {
    // The exact residue a mid-chain delete leaves: `deploy` still requires
    // `test-linux`, an alias whose entry is gone. The hole is named after the
    // alias -- what `requires:` actually wrote -- not the underlying job.
    const doc = parse(`
jobs:
  test:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          requires:
            - test-linux
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes.filter((n) => n.isMissing).map((n) => n.id)).toEqual([
      'test-linux',
    ]);
    expect(graph.problems).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('test-linux'),
      }),
    ]);
  });

  it('placeholders come after every real node so model-order layout is unaffected', () => {
    const doc = parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
workflows:
  main:
    jobs:
      - a:
          requires:
            - missing-one
      - b
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(graph.nodes.map((n) => n.id)).toEqual(['a', 'b', 'missing-one']);
  });

  it('a cycle that runs through nothing missing is still detected normally', () => {
    const doc = parse(`
jobs:
  a:
    docker: []
  b:
    docker: []
workflows:
  main:
    jobs:
      - a:
          requires:
            - b
            - ghost
      - b:
          requires:
            - a
`);
    const graph = buildWorkflowGraph(doc, 'main');
    expect(
      graph.problems.some((p) => p.message.startsWith('Dependency cycle')),
    ).toBe(true);
    expect(graph.nodes.filter((n) => n.isMissing).map((n) => n.id)).toEqual([
      'ghost',
    ]);
  });
});

/*
 * Issue #220: serial groups, job groups, no-op jobs and "deploy" jobs -- three
 * constructs the owner flagged as never deliberately tested, plus the keys that
 * travel with them. The question each block answers is the one the issue asks:
 * does the DAG render this *truthfully*, since silent misrepresentation is
 * worse than no support at all.
 *
 * The fixture is `orchestration-constructs.yml`, whose every construct is
 * copied from CircleCI's own vendored reference rather than invented.
 */
describe('buildWorkflowGraph: orchestration constructs (#220)', () => {
  const constructsDoc = () => parse(orchestrationConstructs);

  describe('serial groups', () => {
    /*
     * The highest-risk claim in the issue, stated plainly: `serial-group` does
     * NOT serialise members inside the workflow, so there is no hidden
     * ordering the graph is failing to draw.
     *
     * It is a string that makes jobs sharing it run one at a time *across an
     * organisation*, ordered at run time by queue arrival and pipeline number
     * (reference: "serial-group"). Nothing in the source document determines
     * that order -- the value routinely contains pipeline values whose compiled
     * form is unknowable here -- so any edge drawn between two serial-group
     * members would be an invention. Drawing them as independent siblings is
     * the truthful rendering, and this test exists to pin *that* as the
     * decision rather than leaving it looking like an oversight.
     */
    it('adds no edges: a serial group is a run-time queue, not a dependency', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const serialNodes = graph.nodes.filter((n) => n.serialGroup);
      expect(serialNodes.map((n) => n.id)).toEqual(['deploy', 'smoke']);

      // Every edge in this workflow is explained by an explicit `requires:`.
      // No edge exists between the two serial-group members, in either
      // direction, and neither gained an edge the config did not ask for.
      const edgeIds = graph.edges.map((e) => `${e.source}->${e.target}`);
      expect(edgeIds).not.toContain('deploy->smoke');
      expect(edgeIds).not.toContain('smoke->deploy');
      expect(edgeIds).toEqual([
        'build->test',
        'build->ok-to-deploy',
        'test->ok-to-deploy',
        'ok-to-deploy->deploy',
        'deploy->deploy-and-release',
        'deploy-and-release->smoke',
        'smoke->gate',
      ]);
    });

    /*
     * The other half of truthfulness: the constraint has to be *visible*.
     * Before this, `serial-group` was swept into `entryOptions.parameters` --
     * modelled as a parameter passed to the job, which it is not, and rendered
     * nowhere, because the inspector only shows parameters a job declares.
     */
    it('surfaces the serial-group string instead of filing it as a parameter', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const deploy = graph.nodes.find((n) => n.id === 'deploy');
      expect(deploy?.serialGroup).toBe(
        '<< pipeline.project.slug >>/deploy-group',
      );
      expect(deploy?.entryOptions.serialGroup).toBe(
        '<< pipeline.project.slug >>/deploy-group',
      );
      // The regression this guards: not merely "is it present" but "is it
      // absent from the place it used to wrongly appear".
      expect(deploy?.entryOptions.parameters).toEqual({});
      expect(Object.keys(deploy?.entryOptions.parameters ?? {})).not.toContain(
        'serial-group',
      );
    });

    it('reads a serial-group applied to a whole job-group invocation', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      // The reference documents this as the way to serialise a group as an
      // atomic unit, so it must work on a group node and not only on a job.
      const smoke = graph.nodes.find((n) => n.id === 'smoke');
      expect(smoke?.kind).toBe('group');
      expect(smoke?.serialGroup).toBe('org-wide/smoke');
    });

    it('treats a non-scalar serial-group as absent rather than coercing it', () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          serial-group:
            - not
            - a-string
`);
      const graph = buildWorkflowGraph(doc, 'main');
      // The compiler is the authority on that being invalid; inventing a
      // string here would hide the problem instead of reporting it.
      expect(graph.nodes[0]?.serialGroup).toBeUndefined();
    });
  });

  describe('job groups', () => {
    /*
     * The defect this fixture found. A workflow entry naming a `job-groups`
     * entry was reported as `"X" references job "X", which is not defined
     * under jobs: and is not an orb job` -- a false error, on valid config,
     * shown as a warning badge on the node and a line in the problems banner.
     */
    it('resolves a group invocation instead of calling it an undefined job', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      expect(graph.problems).toEqual([]);

      const group = graph.nodes.find((n) => n.id === 'deploy-and-release');
      expect(group?.kind).toBe('group');
      expect(group?.isDefined).toBe(true);
      expect(group?.isMissing).toBeUndefined();
    });

    it('reports the group members so the node can say what it runs', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      expect(
        graph.nodes.find((n) => n.id === 'deploy-and-release')?.groupMembers,
      ).toEqual(['deploy', 'release-service']);
      // A single-member group is the shape that most resembles a plain job,
      // and so the one most likely to be silently mislabelled.
      expect(graph.nodes.find((n) => n.id === 'smoke')?.groupMembers).toEqual([
        'smoke-test',
      ]);
    });

    /*
     * Deliberate: the group is one node, not one node per member. The workflow
     * invokes it as a unit and its `requires:` applies to the unit, so drawing
     * the members as workflow-level siblings would misreport the config -- it
     * would imply `notify` could start when only part of the group had run.
     */
    it('draws one node per invocation, with the unit carrying the requires', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      expect(graph.nodes.map((n) => n.id)).toEqual([
        'build',
        'test',
        'ok-to-deploy',
        'deploy',
        'deploy-and-release',
        'smoke',
        'gate',
      ]);
      // `release-service` is a group *member*; it is defined under `jobs:` but
      // never invoked at workflow level, so it must not appear as a node.
      expect(graph.nodes.map((n) => n.id)).not.toContain('release-service');
      expect(
        graph.nodes.find((n) => n.id === 'deploy-and-release')?.requires,
      ).toEqual(['deploy']);
    });

    it('still reports a genuinely undefined name as undefined', () => {
      // The fix must not have turned the real warning off along with the
      // false one.
      const doc = parse(`
job-groups:
  real-group:
    jobs:
      - build
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - real-group
      - typo-group
`);
      const graph = buildWorkflowGraph(doc, 'main');

      expect(graph.nodes.find((n) => n.id === 'real-group')?.kind).toBe(
        'group',
      );
      const undefinedProblems = graph.problems.filter((p) => p.undefinedJob);
      expect(undefinedProblems.map((p) => p.undefinedJob)).toEqual([
        'typo-group',
      ]);
    });

    it('prefers a job group over an orb reading of the same name', () => {
      // A group name cannot contain a `/` today, so this pins the resolution
      // order rather than a live ambiguity -- see `resolveKind`.
      const doc = parse(`
job-groups:
  build:
    jobs:
      - compile
jobs:
  compile:
    docker: []
workflows:
  main:
    jobs:
      - build
`);
      expect(buildWorkflowGraph(doc, 'main').nodes[0]?.kind).toBe('group');
    });
  });

  describe('no-op jobs', () => {
    /*
     * `type: no-op` is a real, current CircleCI job type -- "performs no
     * actions and consumes no credits", and "only the type is required, no
     * further job configuration". So a no-op job has no executor and no
     * `steps:`, which is the part that could plausibly have broken something.
     */
    it('renders a type: no-op job as an ordinary node with correct edges', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const gate = graph.nodes.find((n) => n.id === 'ok-to-deploy');
      expect(gate?.kind).toBe('job');
      expect(gate?.isDefined).toBe(true);
      // It is not an approval: nothing waits for a human here.
      expect(gate?.kind).not.toBe('approval');
      // The fan-in is the whole point of the construct.
      expect(gate?.requires).toEqual(['build', 'test']);
    });

    it('renders a hand-rolled echo gate identically to a type: no-op one', () => {
      // Both shapes exist in the wild -- this repository's own config used the
      // echo form before `type: no-op` existed -- and a fan-in gate must read
      // the same either way.
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const noOp = graph.nodes.find((n) => n.id === 'ok-to-deploy');
      const handRolled = graph.nodes.find((n) => n.id === 'gate');
      expect(handRolled?.kind).toBe(noOp?.kind);
      expect(handRolled?.isDefined).toBe(noOp?.isDefined);
    });

    it('keeps type: approval distinct from type: no-op', () => {
      const doc = parse(`
jobs:
  gate:
    type: no-op
  hold:
    type: approval
workflows:
  main:
    jobs:
      - gate
      - hold:
          type: approval
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes.find((n) => n.id === 'gate')?.kind).toBe('job');
      expect(graph.nodes.find((n) => n.id === 'hold')?.kind).toBe('approval');
    });
  });

  describe('deploy jobs', () => {
    /*
     * The issue asks whether "deploy job" means anything specific, and to say
     * so plainly if it is only a convention. It is: a job named `deploy` gets
     * no special treatment from CircleCI, and none from this graph either.
     *
     * The `deploy` *step* did once exist and is marked DEPRECATED in the
     * reference ("The run step replaces the deprecated deploy step"); it is
     * absent from the vendored JSON Schema entirely. The construct that is
     * genuinely a deploy job in current config is `type: release`, tested
     * below.
     */
    it('gives a job named deploy no special treatment: the name is a convention', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const deploy = graph.nodes.find((n) => n.id === 'deploy');
      expect(deploy?.kind).toBe('job');
      // Identical in kind to a job called anything else.
      expect(deploy?.kind).toBe(
        graph.nodes.find((n) => n.id === 'build')?.kind,
      );
    });

    it('renders a type: release job as a job, invoked from a group', () => {
      // `type: release` is the real deploy-job construct (it links a pipeline
      // to a deployment in the deploys UI, and is the only type requiring
      // `plan_name`). It needs no special kind: it is a job that runs.
      const doc = constructsDoc();
      expect(getJobNames(doc)).toContain('release-service');

      const graph = buildWorkflowGraph(doc, 'main');
      // Reached only via the group, so it is correctly not a workflow node.
      expect(graph.nodes.map((n) => n.id)).not.toContain('release-service');
      expect(
        graph.nodes.find((n) => n.id === 'deploy-and-release')?.groupMembers,
      ).toContain('release-service');
    });
  });

  describe('override-with', () => {
    it('surfaces override-with instead of filing it as a parameter', () => {
      const graph = buildWorkflowGraph(constructsDoc(), 'main');

      const gate = graph.nodes.find((n) => n.id === 'gate');
      expect(gate?.entryOptions.overrideWith).toBe('my-orb/my-gate');
      expect(gate?.entryOptions.parameters).toEqual({});
      // The job keeps its local identity: `override-with` swaps the
      // implementation at run time, and whether the orb job exists is a fact
      // about the orb, not about this document.
      expect(gate?.kind).toBe('job');
      expect(gate?.isDefined).toBe(true);
    });
  });

  describe('real invocation parameters still work', () => {
    it('does not swallow genuine parameters alongside the new reserved keys', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          serial-group: org/build
          override-with: my-orb/build
          some-parameter: a-value
          another: 3
`);
      const node = buildWorkflowGraph(doc, 'main').nodes[0];
      expect(node?.serialGroup).toBe('org/build');
      expect(node?.entryOptions.overrideWith).toBe('my-orb/build');
      expect(node?.entryOptions.parameters).toEqual({
        'some-parameter': 'a-value',
        another: 3,
      });
    });
  });

  describe('matrix expansion (issue #284)', () => {
    it('substitutes << matrix.PARAM >> in an explicit name: template, per combination', () => {
      const doc = parse(`
jobs:
  deploy-service:
    docker: []
workflows:
  main:
    jobs:
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.nodes.map((n) => n.id).sort()).toEqual([
        'Deploy frontend to EU',
        'Deploy frontend to NA',
      ]);
      for (const node of graph.nodes) {
        expect(node.jobName).toBe('deploy-service');
        expect(node.matrixGroupSize).toBe(2);
      }
      const na = graph.nodes.find((n) => n.id === 'Deploy frontend to NA');
      expect(na?.matrixParams).toEqual({ region: 'NA' });
    });

    it("the reported case: a non-matrix entry's requires: naming the matrix's expanded instances is not dangling", () => {
      const doc = parse(`
jobs:
  deploy-service:
    docker: []
  staging-complete:
    docker: []
workflows:
  main:
    jobs:
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - staging-complete:
          name: Staging complete (frontend)
          requires:
            - Deploy frontend to NA
            - Deploy frontend to EU
`);
      const graph = buildWorkflowGraph(doc, 'main');
      // The whole point of #284: this must be a config circleci config
      // validate accepts, rendered with zero false errors -- not merely
      // "the two specific dangling messages are gone".
      expect(graph.problems).toEqual([]);
      expect(graph.edges).toHaveLength(2);
      expect(graph.edges.every((e) => e.dangling === undefined)).toBe(true);
      const complete = graph.nodes.find(
        (n) => n.id === 'Staging complete (frontend)',
      );
      expect(complete?.requires.sort()).toEqual([
        'Deploy frontend to EU',
        'Deploy frontend to NA',
      ]);
    });

    it('the reverse: a matrix entry can require a non-matrix entry', () => {
      const doc = parse(`
jobs:
  build-frontend:
    docker: []
  deploy-service:
    docker: []
workflows:
  main:
    jobs:
      - build-frontend
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          requires:
            - build-frontend
          matrix:
            parameters:
              region: [NA, EU]
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      const na = graph.nodes.find((n) => n.id === 'Deploy frontend to NA');
      const eu = graph.nodes.find((n) => n.id === 'Deploy frontend to EU');
      expect(na?.requires).toEqual(['build-frontend']);
      expect(eu?.requires).toEqual(['build-frontend']);
    });

    it("a matrix job's own requires: names another matrix's expanded instances, substituted per-instance", () => {
      const doc = parse(`
jobs:
  notify-downstream:
    docker: []
  e2e-tests:
    docker: []
workflows:
  main:
    jobs:
      - notify-downstream:
          name: Notify downstream cron-jobs (<< matrix.region >>)
          matrix:
            parameters:
              region: [NA, EU]
      - e2e-tests:
          name: E2E tests cron-jobs (<< matrix.region >>)
          matrix:
            parameters:
              region: [NA, EU]
          requires:
            - Notify downstream cron-jobs (<< matrix.region >>)
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      const e2eNa = graph.nodes.find(
        (n) => n.id === 'E2E tests cron-jobs (NA)',
      );
      const e2eEu = graph.nodes.find(
        (n) => n.id === 'E2E tests cron-jobs (EU)',
      );
      // Each instance's own template resolves against its *own* region, not
      // the other instance's -- the NA e2e job must not end up requiring the
      // EU notify job or vice versa.
      expect(e2eNa?.requires).toEqual(['Notify downstream cron-jobs (NA)']);
      expect(e2eEu?.requires).toEqual(['Notify downstream cron-jobs (EU)']);
    });

    it('follows a YAML alias on a matrix parameter value list instead of seeing an unresolved node (issue #41 precedent)', () => {
      const doc = parse(`
jobs:
  deploy-a:
    docker: []
  deploy-b:
    docker: []
workflows:
  main:
    jobs:
      - deploy-a:
          name: Deploy A to << matrix.region >>
          matrix:
            parameters:
              region: &region_list [NA, EU]
      - deploy-b:
          name: Deploy B to << matrix.region >>
          matrix:
            parameters:
              region: *region_list
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      expect(graph.nodes.map((n) => n.id).sort()).toEqual([
        'Deploy A to EU',
        'Deploy A to NA',
        'Deploy B to EU',
        'Deploy B to NA',
      ]);
    });

    it('expands the cross product of multiple parameters and honours exclude:, matching configuration-reference.adoc default naming exactly', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          matrix:
            parameters:
              version: ["0.1", "0.2", "0.3"]
              platform: ["macos", "windows", "linux"]
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      // Verbatim from configuration-reference.adoc's own worked example for
      // this exact `matrix:` stanza -- see `~/lib/yaml/matrixExpansion`'s
      // doc comment for where this was established.
      expect(graph.nodes.map((n) => n.id).sort()).toEqual(
        [
          'build-macos-0.1',
          'build-macos-0.2',
          'build-macos-0.3',
          'build-windows-0.1',
          'build-windows-0.2',
          'build-windows-0.3',
          'build-linux-0.1',
          'build-linux-0.2',
          'build-linux-0.3',
        ].sort(),
      );
    });

    it('exclude: removes exactly the listed combination and no others', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          matrix:
            parameters:
              a: [1, 2, 3]
              b: [4, 5, 6]
            exclude:
              - a: 3
                b: 5
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      // configuration-reference.adoc's own "Excluding sets of parameters"
      // example: 9 combinations minus the one excluded is 8.
      expect(graph.nodes).toHaveLength(8);
      expect(graph.nodes.some((n) => n.id === 'build-5-3')).toBe(false);
    });

    it("requires: naming the matrix's own alias (default: the bare job name) fans out to every instance", () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
  another-job:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          matrix:
            parameters:
              version: ["0.1", "0.2"]
      - another-job:
          requires:
            - deploy
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      const another = graph.nodes.find((n) => n.id === 'another-job');
      expect(another?.requires).toEqual(['deploy']);
      const incomingToAnother = graph.edges.filter(
        (e) => e.target === 'another-job',
      );
      expect(incomingToAnother.map((e) => e.source).sort()).toEqual([
        'deploy-0.1',
        'deploy-0.2',
      ]);
      expect(incomingToAnother.every((e) => e.dangling === undefined)).toBe(
        true,
      );
    });

    it('requires: naming an explicit matrix.alias fans out to every instance', () => {
      const doc = parse(`
jobs:
  deploy:
    docker: []
  another-job:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          matrix:
            alias: deploy-all-regions
            parameters:
              version: ["0.1", "0.2"]
      - another-job:
          requires:
            - deploy-all-regions
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      const incoming = graph.edges.filter((e) => e.target === 'another-job');
      expect(incoming.map((e) => e.source).sort()).toEqual([
        'deploy-0.1',
        'deploy-0.2',
      ]);
    });

    it('does not loosen the dangling check: a genuinely unknown requires: target is still an error', () => {
      const doc = parse(`
jobs:
  deploy-service:
    docker: []
  staging-complete:
    docker: []
workflows:
  main:
    jobs:
      - deploy-service:
          name: Deploy frontend to << matrix.region >>
          matrix:
            parameters:
              region: [NA, EU]
      - staging-complete:
          requires:
            - Deploy frontend to APAC
`);
      const graph = buildWorkflowGraph(doc, 'main');
      const errors = graph.problems.filter((p) => p.severity === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(
        'requires unknown job "Deploy frontend to APAC"',
      );
      expect(errors[0]?.danglingRequire).toEqual({
        fromAlias: 'staging-complete',
        missingId: 'Deploy frontend to APAC',
      });
    });

    it('a scalar matrix parameter value with no seq is treated as a one-item combination rather than crashing', () => {
      const doc = parse(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          matrix:
            parameters:
              version: "1"
`);
      const graph = buildWorkflowGraph(doc, 'main');
      expect(graph.problems).toEqual([]);
      expect(graph.nodes.map((n) => n.id)).toEqual(['build-1']);
    });

    describe('the reported config (issue #284 fixture)', () => {
      const doc = parse(matrixJobsConfig);

      it('produces zero problems in every workflow -- circleci config validate passes on this config', () => {
        for (const workflowName of listWorkflows(doc)) {
          const graph = buildWorkflowGraph(doc, workflowName);
          expect({ workflowName, problems: graph.problems }).toEqual({
            workflowName,
            problems: [],
          });
        }
      });

      it("expands deploy-frontend's matrix and resolves Staging complete (frontend) against the real names", () => {
        const graph = buildWorkflowGraph(doc, 'deploy-frontend');
        expect(graph.nodes.map((n) => n.id).sort()).toEqual([
          'Deploy frontend to EU',
          'Deploy frontend to NA',
          'Staging complete (frontend)',
          'build-frontend',
        ]);
        const complete = graph.nodes.find(
          (n) => n.id === 'Staging complete (frontend)',
        );
        expect(complete?.requires.sort()).toEqual([
          'Deploy frontend to EU',
          'Deploy frontend to NA',
        ]);
        const deployNa = graph.nodes.find(
          (n) => n.id === 'Deploy frontend to NA',
        );
        expect(deployNa?.requires).toEqual(['build-frontend']);
      });

      it('follows the region anchor/alias into deploy-backend', () => {
        const graph = buildWorkflowGraph(doc, 'deploy-backend');
        expect(graph.nodes.map((n) => n.id).sort()).toEqual([
          'Deploy backend to EU',
          'Deploy backend to NA',
          'backend-smoke-test',
        ]);
        expect(graph.problems).toEqual([]);
      });

      it('resolves cron-jobs: E2E tests requiring Notify downstream, per-region', () => {
        const graph = buildWorkflowGraph(doc, 'cron-jobs');
        expect(graph.problems).toEqual([]);
        const e2eNa = graph.nodes.find(
          (n) => n.id === 'E2E tests cron-jobs (NA)',
        );
        expect(e2eNa?.requires).toEqual(['Notify downstream cron-jobs (NA)']);
      });

      it("expands nightly's cross-product matrix to 8 nodes (9 combinations minus the excluded one)", () => {
        const graph = buildWorkflowGraph(doc, 'nightly');
        expect(graph.nodes).toHaveLength(8);
        expect(graph.nodes.some((n) => n.id === 'smoke-test-linux-0.3')).toBe(
          false,
        );
      });

      it('leaves the non-matrix release workflow completely unaffected', () => {
        const graph = buildWorkflowGraph(doc, 'release');
        expect(graph.problems).toEqual([]);
        expect(graph.nodes.map((n) => n.id).sort()).toEqual([
          'hold-for-release',
          'lint',
          'package-release',
          'publish-release',
        ]);
        expect(graph.nodes.every((n) => n.matrix === false)).toBe(true);
      });
    });
  });
});
