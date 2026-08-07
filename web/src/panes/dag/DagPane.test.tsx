import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowGraph } from '~/lib/graph/buildGraph';
import type { LayoutResult, PositionedNode } from '~/lib/graph/layout';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import {
  buildDefaultPersistedLayout,
  useLayoutStore,
} from '~/state/layoutStore';
import { useAppStore } from '~/state/appStore';
import { useNodePositionStore } from '~/state/nodePositionStore';

// jsdom (this project's test environment) has no `PointerEvent` constructor
// at all -- `fireEvent.pointerDown`/`pointerMove`/`pointerUp` below fall
// back to a bare `Event` with no `clientX`, which is fine for tests that
// don't care about pointer coordinates but breaks the inspector-resize drag
// tests, which do (see `InspectorDivider` in `DagPane.tsx`). A minimal
// polyfill -- subclassing `MouseEvent`, which jsdom *does* support
// `clientX` on -- is enough, since `InspectorDivider`'s own handlers only
// ever read `event.clientX`.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {}
  // @ts-expect-error -- a `MouseEvent` subclass standing in for the `PointerEvent` jsdom lacks, not a spec-accurate one.
  window.PointerEvent = PointerEventPolyfill;
}

interface MockFlowNode {
  id: string;
  type?: string;
  data: unknown;
  selected?: boolean;
  // Issue #54: the selection-driven ancestor-chain dim lands here (see
  // `DagPane`'s `flowNodes`), so tests that exercise it need to read it back.
  className?: string;
  // Issue #70: a manually-dragged position overrides ELK's own x/y -- see
  // `flowNodes`' `getStoredPosition` lookup -- so tests that exercise
  // dragging need to read the position actually handed to React Flow.
  position: { x: number; y: number };
}

/** The subset of an edge these tests read back -- see `flowEdges` in `DagPane.tsx`. */
interface MockFlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  style?: { strokeWidth?: number };
  className?: string;
  markerEnd?: { type: string };
  // Issue #289: a fully controlled selection flag, mirroring `MockFlowNode`'s
  // own `selected` -- see `flowEdges`' own comment on why this can't be left
  // to React Flow's internal-only edge selection.
  selected?: boolean;
  // Issue #70: a status-conditioned `requires` no longer sets React Flow's
  // own always-on `label` -- the statuses travel here instead, read by
  // `RequiresEdge.tsx` to render its hover/focus tooltip.
  //
  // Issue #289: `canRemove`/`onRemove` are the unlink affordance's own data
  // -- see `RequiresEdge.tsx`.
  data?: { statuses?: string[]; canRemove?: boolean; onRemove?: () => void };
  label?: unknown;
}

/** The subset of `<ReactFlow>` props these tests drive directly (see `getCapturedProps`). */
export interface CapturedFlowProps {
  nodes: MockFlowNode[];
  edges: MockFlowEdge[];
  onConnect: (connection: { source: string; target: string }) => void;
  isValidConnection: (edge: { source: string; target: string }) => boolean;
  onNodesDelete: (nodes: { id: string }[]) => void;
  onEdgesDelete: (
    edges: { id: string; source: string; target: string }[],
  ) => void;
  onNodeClick: (event: unknown, node: { id: string }) => void;
  onPaneClick: () => void;
  // Issue #289: click-to-select an edge, and the hover half of the
  // discoverable unlink affordance -- see `handleEdgeClick`/`hoveredEdgeId`
  // in `DagPane.tsx`.
  onEdgeClick: (event: unknown, edge: { id: string }) => void;
  onEdgeMouseEnter: (event: unknown, edge: { id: string }) => void;
  onEdgeMouseLeave: (event: unknown, edge: { id: string }) => void;
  // Issue #54: drives "hovering a node highlights its connected edges" --
  // see `hoveredNodeId` in `DagPane.tsx`.
  onNodeMouseEnter: (event: unknown, node: { id: string }) => void;
  onNodeMouseLeave: (event: unknown, node: { id: string }) => void;
  // Issue #85: React Flow's own per-frame drag callback -- see
  // `handleNodeDrag`. Tests call this directly the same way the #70 tests
  // already call `onNodeDragStop` directly, to exercise the live-position
  // fix without needing React Flow's actual pointer machinery.
  onNodeDrag: (
    event: unknown,
    node: { id: string; position: { x: number; y: number } },
  ) => void;
  // Issue #70: persists a manual drag -- see `handleNodeDragStop`.
  onNodeDragStop: (
    event: unknown,
    node: { id: string; position: { x: number; y: number } },
  ) => void;
}

// A plain mutable box (not a React ref) that the mocked `ReactFlow` below
// stashes its full props into on every render. Declared inside the
// `vi.mock` factory itself (rather than closed over from this file's outer
// scope) since factories run before this file's own top-level bindings
// exist -- see vitest's hoisting docs -- and re-exported as `__captured` so
// tests can reach in and call `onConnect`/`isValidConnection`/etc.
// directly, exercising `DagPane`'s real callback implementations without
// needing React Flow's actual drag-and-drop machinery.
vi.mock('@xyflow/react', () => {
  const captured: { current: CapturedFlowProps | null } = { current: null };
  const fitView = vi.fn<() => void>();
  return {
    __captured: captured,
    __fitView: fitView,
    // Only the enum value DagPane actually uses; importing the real module
    // would pull React Flow's DOM-dependent components into jsdom.
    MarkerType: { ArrowClosed: 'arrowclosed' },
    ReactFlow: (props: CapturedFlowProps & { children?: ReactNode }) => {
      captured.current = props;
      const { nodes, children } = props;
      const nodeTypes = (
        props as unknown as {
          nodeTypes?: Record<
            string,
            ComponentType<{ id: string; data: unknown; selected?: boolean }>
          >;
        }
      ).nodeTypes;
      return (
        <div data-testid="react-flow">
          {nodes.map((node) => {
            const Component = node.type ? nodeTypes?.[node.type] : undefined;
            return (
              <div key={node.id} data-testid={`node-${node.id}`}>
                {Component ? (
                  <Component
                    id={node.id}
                    data={node.data}
                    selected={node.selected}
                  />
                ) : null}
              </div>
            );
          })}
          {children}
        </div>
      );
    },
    ReactFlowProvider: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    // `zoomIn`/`zoomOut` are consumed by `CanvasControls` (issue #82);
    // without them here it destructures `undefined` and its zoom buttons
    // throw on click.
    useReactFlow: () => ({
      fitView,
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
    }),
  };
});

/** Reaches into the `@xyflow/react` mock above for the most recent `<ReactFlow>` props. */
async function getCapturedProps(): Promise<CapturedFlowProps> {
  const mocked = (await import('@xyflow/react')) as unknown as {
    __captured: { current: CapturedFlowProps | null };
  };
  const props = mocked.__captured.current;
  if (!props) throw new Error('ReactFlow has not rendered yet');
  return props;
}

/**
 * Reaches into the `@xyflow/react` mock above for the shared `fitView` spy
 * that `useReactFlow` returns -- see the regression test for the
 * "graph loads with most nodes off-screen" bug below.
 */
async function getFitViewMock(): Promise<ReturnType<typeof vi.fn>> {
  const mocked = (await import('@xyflow/react')) as unknown as {
    __fitView: ReturnType<typeof vi.fn>;
  };
  return mocked.__fitView;
}

// The layout module wraps elkjs, which is real async work; mocking it keeps
// this test focused on DagPane's own logic (workflow selection, direction
// toggle, problem banners, empty states) rather than ELK's actual geometry,
// which `layout.test.ts` already covers.
//
// Issue #24: still has to honour `expandedGroupId` -- a bare `graph.nodes.map`
// would never surface a group's members into the flat array `DagPane`'s
// `flowNodes` reads, and every test exercising expansion would then be
// testing nothing. This mirrors the real `layout.ts`'s own flattening (one
// entry per member, `parentId` untouched from `buildGraph`'s own output,
// internal edges appended) without ELK's actual geometry -- exactly the same
// scope cut this mock already made for the ordinary, non-expanded case.
vi.mock('~/lib/graph/layout', () => ({
  layoutGraph: vi.fn<
    (
      graph: WorkflowGraph,
      options?: { direction?: 'RIGHT' | 'DOWN'; expandedGroupId?: string },
    ) => Promise<LayoutResult>
  >(
    async (
      graph: WorkflowGraph,
      options: { direction?: 'RIGHT' | 'DOWN'; expandedGroupId?: string } = {},
    ): Promise<LayoutResult> => {
      const nodes: PositionedNode[] = [];
      let internalEdges: WorkflowGraph['edges'] = [];
      graph.nodes.forEach((node, index) => {
        nodes.push({
          ...node,
          x: options.direction === 'DOWN' ? 0 : index * 160,
          y: options.direction === 'DOWN' ? index * 80 : 0,
          width: 140,
          height: 56,
        });
        if (node.id === options.expandedGroupId && node.groupSubgraph) {
          node.groupSubgraph.nodes.forEach((member, memberIndex) => {
            nodes.push({
              ...member,
              x: 10,
              y: memberIndex * 60,
              width: 120,
              height: 40,
            });
          });
          internalEdges = node.groupSubgraph.edges;
        }
      });
      return {
        nodes,
        edges:
          internalEdges.length > 0
            ? [...graph.edges, ...internalEdges]
            : graph.edges,
      };
    },
  ),
}));

import { DagPane, computeMinimapSize } from './DagPane';

function setDocFromYaml(text: string): void {
  const { doc } = parseConfig(text);
  useAppStore.setState({ doc, parseError: null, selectedWorkflow: null });
}

const RESET_STATE = {
  meta: null,
  configPath: '',
  // The directory listing this pane reads to tell whether the open file is
  // even a CircleCI config (issue #135) -- reset so no test leaks a
  // classification into the next one.
  files: [],
  doc: null,
  text: '',
  savedText: '',
  parseError: null,
  isDirty: false,
  status: 'ready' as const,
  error: null,
  autosave: false,
  selectedWorkflow: null,
  dagDirection: 'RIGHT' as const,
  selectedNodeId: null,
  workflowSelected: false,
  validation: { state: 'idle' as const, errors: [] },
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  editError: null,
};

/**
 * Advances past the pane's ~150ms layout debounce and flushes the mocked
 * (but still genuinely async) `layoutGraph` call, wrapped in `act()` so the
 * resulting `setState` -- which fires from a real timer callback, not from
 * anything React Testing Library observes directly -- doesn't trigger an
 * "update not wrapped in act" warning.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe('DagPane', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // The mocked `useReactFlow().fitView` spy lives at the `@xyflow/react`
    // mock module's scope (see `getFitViewMock`), not per-test -- clear its
    // call history so one test's fits don't leak into the next's
    // assertions.
    (await getFitViewMock()).mockClear();
  });

  afterEach(async () => {
    // Wrapped in `act()`: React Testing Library's own autocleanup afterEach
    // (registered before this describe block's hooks) unmounts the
    // component *after* this hook runs, so the still-mounted component from
    // the test that just ran would otherwise pick up this state change
    // outside of any act() scope.
    await act(async () => {
      useAppStore.setState(RESET_STATE);
      // Issue #70: this store persists to `localStorage`, and its module
      // state otherwise leaks across every `it` in this file (only a
      // fresh module registry per *file*, not per test) -- without this a
      // drag persisted in one test would still be there, keyed by the same
      // `configPath: ''` `RESET_STATE` gives every test, when the next
      // test's `flowNodes` looks it up.
      useNodePositionStore.setState({ positions: {} });
      // Issue #88: the palette's open/closed state now lives in this store
      // (see `DagPane`'s own `paletteCollapsed`), which is the same kind of
      // module-scoped-not-per-test state as the two stores above -- reset
      // for the same reason, even though nothing in this file's tests
      // toggles it today.
      const defaults = buildDefaultPersistedLayout();
      useLayoutStore.setState({
        activePreset: defaults.activePreset,
        presetStates: defaults.presets,
      });
    });
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('shows a friendly message when no config has loaded yet', async () => {
    useAppStore.setState(RESET_STATE);
    render(<DagPane />);
    await settle();
    expect(
      screen.getByText(/no configuration loaded yet/i),
    ).toBeInTheDocument();
  });

  // A config file that already has unparsable YAML on disk the first time
  // it's loaded also leaves `doc` null -- but that must not be reported as
  // "No configuration loaded yet.", which reads as if the file were empty
  // or untouched, nor paired with the (unrelated, doc-required) "showing
  // last valid version" footer, since there is no last valid version yet.
  it('explains a parse error distinctly from having no config loaded at all', async () => {
    useAppStore.setState(RESET_STATE);
    useAppStore.setState({
      doc: null,
      parseError: 'Unexpected token at line 2, column 1',
    });
    render(<DagPane />);
    await settle();

    expect(screen.getByText(/yaml has a parse error/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/no configuration loaded yet/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/showing last valid version/i),
    ).not.toBeInTheDocument();
  });

  it('shows a friendly message when the config has no workflows: block', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml('jobs:\n  build:\n    docker: []\n');
    render(<DagPane />);
    await settle();
    expect(screen.getByText(/no workflows/i)).toBeInTheDocument();
  });

  // Issue #135: a file the host classified as not a CircleCI config can
  // still be opened deliberately from the switcher's reveal. It must not
  // present as an empty graph, and must not be told to add a `workflows:`
  // block -- it should state the host's own reason instead.
  it('explains why an opened non-config has no graph, using the host’s reason', async () => {
    useAppStore.setState(RESET_STATE);
    useAppStore.setState({
      configPath: '/repo/.circleci/goss.yaml',
      files: [
        {
          path: '/repo/.circleci/goss.yaml',
          relPath: 'goss.yaml',
          size: 30,
          isPrimary: false,
          isConfig: false,
          configReason: 'No CircleCI structure: no top-level version: 2.',
        },
      ],
    });
    setDocFromYaml('command:\n  echo hi:\n    exit-status: 0\n');
    render(<DagPane />);
    await settle();

    expect(
      screen.getByText(/goss\.yaml is not a CircleCI config/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/No CircleCI structure/)).toBeInTheDocument();
    expect(screen.queryByText(/no workflows/i)).not.toBeInTheDocument();
  });

  it('renders nodes for a simple workflow and labels them by alias', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
    render(<DagPane />);
    await settle();

    expect(screen.getByTestId('node-build')).toBeInTheDocument();
    expect(screen.getByTestId('node-test')).toBeInTheDocument();
  });

  it('renders a node under its alias, not its underlying job name', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
          name: test-linux
          requires:
            - build
`);
    render(<DagPane />);
    await settle();

    expect(screen.getByTestId('node-test-linux')).toBeInTheDocument();
    expect(screen.queryByTestId('node-test')).not.toBeInTheDocument();
  });

  // Regression test for a bug where the graph rendered with most or all
  // nodes off-screen: `<ReactFlow fitView>` only fits once, at mount, but
  // this pane's nodes arrive asynchronously from the debounced ELK layout,
  // so there was nothing yet to fit at that point. See
  // `FitViewOnStructureChange` in DagPane.tsx.
  it('fits the viewport once the graph has nodes, and re-fits when the structure changes', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
    render(<DagPane />);

    const fitView = await getFitViewMock();
    // Nothing to fit yet: the debounced layout hasn't resolved, so the
    // graph has no nodes.
    expect(fitView).not.toHaveBeenCalled();

    await settle();

    // The nodes just arrived -- this is the call the bug was missing.
    expect(fitView).toHaveBeenCalled();

    fitView.mockClear();
    fireEvent.click(
      screen.getByRole('button', { name: /switch to vertical layout/i }),
    );
    await settle();

    // A direction change re-lays-out the graph and must re-fit, since the
    // previous fit was computed for the old (left-to-right) layout.
    expect(fitView).toHaveBeenCalled();
  });

  // Issue #49: the workflow switcher used to be a `<select>` gated behind
  // `workflows.length > 1`, so a single-workflow config showed nothing at
  // all -- reading as though multi-workflow support didn't exist. It's now
  // an always-visible `WorkflowTabs` strip (see `DagPane.tsx`), present
  // even for exactly one workflow, with each tab labelled by its job count.
  it('always shows workflow navigation, even for a config with only one workflow', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
jobs:
  build:
    docker: []
workflows:
  build_only:
    jobs:
      - build
`);
    render(<DagPane />);
    await settle();
    expect(screen.getByTestId('node-build')).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: /workflows/i });
    const tab = within(tablist).getByRole('tab', { name: /build_only/i });
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-selected', 'true');
    // The job count badge -- this workflow runs exactly one job.
    expect(within(tab).getByText('1')).toBeInTheDocument();
  });

  it('adds a second tab (with its own job count) once a second workflow exists', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
jobs:
  build:
    docker: []
workflows:
  build_only:
    jobs:
      - build
`);
    const { rerender } = render(<DagPane />);
    await settle();
    const tablistBefore = screen.getByRole('tablist', { name: /workflows/i });
    expect(within(tablistBefore).getAllByRole('tab')).toHaveLength(1);

    await act(async () => {
      setDocFromYaml(`
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
      rerender(<DagPane />);
    });

    const tablistAfter = screen.getByRole('tablist', { name: /workflows/i });
    expect(within(tablistAfter).getAllByRole('tab')).toHaveLength(2);
    expect(
      within(tablistAfter).getByRole('tab', { name: /deploy_only/i }),
    ).toBeInTheDocument();
  });

  it('persists workflow selection in the store when the user clicks a different workflow tab', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
    render(<DagPane />);
    await settle();

    fireEvent.click(screen.getByRole('tab', { name: /deploy_only/i }));

    expect(useAppStore.getState().selectedWorkflow).toBe('deploy_only');
  });

  it('marks a workflow tab with structural problems distinctly from a clean one', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
jobs:
  build:
    docker: []
workflows:
  broken:
    jobs:
      - build:
          requires:
            - nonexistent
  clean:
    jobs:
      - build
`);
    render(<DagPane />);
    await settle();

    const brokenTab = screen.getByRole('tab', { name: /broken/i });
    const cleanTab = screen.getByRole('tab', { name: /clean/i });
    expect(brokenTab).toHaveAttribute(
      'title',
      expect.stringMatching(/has problems/i),
    );
    expect(cleanTab).not.toHaveAttribute(
      'title',
      expect.stringMatching(/has problems/i),
    );
  });

  it('toggles direction and persists it in the store', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml('workflows:\n  main:\n    jobs:\n      - build\n');
    render(<DagPane />);
    await settle();

    const tbButton = screen.getByRole('button', {
      name: /switch to vertical layout/i,
    });
    fireEvent.click(tbButton);

    expect(useAppStore.getState().dagDirection).toBe('DOWN');
  });

  // Issue #183: *"we have the palette button still on the workflow graph
  // section."* It is gone, and this asserts that rather than the affordance of
  // a button that no longer exists (the test this replaces required "Palette"
  // to read as a solid action rather than as a segment of the LR/TB toggle
  // that used to sit beside it -- a requirement about a control that #88 had
  // already reduced to a remote duplicate of the palette pane's own
  // Collapse/Expand strip, and that #183 removed outright).
  //
  // Scoped to the pane's own header, deliberately: this pane still renders the
  // whole `<Palette>` inline in unit tests (no `PalettePane` is mounted to
  // portal into -- see `palettePortalTarget.ts`), so the *palette itself* is in
  // this tree and a document-wide query for /palette/i would match its content.
  // What must not come back is a control in this header.
  it('no longer carries a "Palette" button in the graph header (issue #183)', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml('workflows:\n  main:\n    jobs:\n      - build\n');
    render(<DagPane />);
    await settle();

    const header = screen
      .getByRole('heading', { name: 'Workflow Graph' })
      .closest('header')!;
    expect(header).not.toBeNull();
    expect(
      within(header).queryByRole('button', { name: /^palette$/i }),
    ).toBeNull();

    // The header's real actions are untouched.
    for (const name of [
      /undo last change/i,
      /redo last undone change/i,
      /^re-layout$/i,
    ]) {
      expect(within(header).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows an unknown-requires error in the problems banner', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
    render(<DagPane />);
    await settle();

    expect(screen.getByText(/unknown job "nonexistent"/i)).toBeInTheDocument();
  });

  it('dismisses the problems banner and keeps it dismissed until the problems change', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml(`
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
    render(<DagPane />);
    await settle();
    expect(screen.getByText(/unknown job "nonexistent"/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /dismiss graph problems/i }),
    );

    expect(
      screen.queryByText(/unknown job "nonexistent"/i),
    ).not.toBeInTheDocument();
  });

  /**
   * Issue #148: "highlight nicely in the graph where the error is." Every
   * assertion here reads the class and node data actually handed to React
   * Flow (see `getCapturedProps`), so a regression shows up as a failed test
   * rather than as a graph that quietly stops marking anything.
   */
  describe('validation errors on the canvas (issue #148)', () => {
    const CONFIG = `version: 2.1
jobs:
  build:
    docker: []
    steps: [checkout]
  test:
    docker: []
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
      - test
`;

    /** The validation errors `DagPane` attributed to this React Flow node, or `[]` when it attributed none. */
    function markedMessages(node: MockFlowNode): string[] {
      return (node.data as { diagnostics?: string[] }).diagnostics ?? [];
    }

    function markedCount(node: MockFlowNode): number {
      return markedMessages(node).length;
    }

    /** Seeds the doc plus a real compile-error response for it. */
    function seed(messages: string[]): void {
      useAppStore.setState(RESET_STATE);
      const { doc } = parseConfig(CONFIG);
      useAppStore.setState({
        doc,
        text: CONFIG,
        parseError: null,
        selectedWorkflow: null,
        validation: {
          state: 'invalid',
          errors: messages.map((message) => ({ message })),
        },
      });
    }

    it('marks only the node a compile error names', async () => {
      seed([
        "Error calling workflow: 'main'",
        "Error calling job: 'build'",
        'Cannot find a definition for command named chekcout',
      ]);
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      const marked = props.nodes.filter((node) => markedCount(node) > 0);
      expect(marked.map((node) => node.id)).toEqual(['build']);
      const first = marked[0];
      expect(first).toBeDefined();
      expect(markedMessages(first as MockFlowNode)).toEqual([
        'Cannot find a definition for command named chekcout',
      ]);
    });

    it('marks no node at all when the config compiles', async () => {
      useAppStore.setState(RESET_STATE);
      const { doc } = parseConfig(CONFIG);
      useAppStore.setState({
        doc,
        text: CONFIG,
        validation: { state: 'valid', errors: [] },
      });
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      for (const node of props.nodes) {
        expect(
          (node.data as { diagnostics?: string[] }).diagnostics,
        ).toBeUndefined();
      }
    });

    it('marks the job a schema error points into, even though the error names no workflow', async () => {
      // A `[#/jobs/build]` schema violation carries no workflow at all --
      // CircleCI has no reason to mention one -- but every workflow that runs
      // `build` is broken by it. Attributing marks by workflow name alone let
      // this render as a perfectly healthy graph.
      seed([
        'ERROR IN CONFIG FILE:',
        '[#/jobs/build] 0 subschemas matched instead of one',
        '|   |   1. [#/jobs/build] extraneous key [stpes] is not permitted',
        '|   |   |   Permitted keys:',
        '|   |   |     - steps',
      ]);
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      expect(
        props.nodes.filter((node) => markedCount(node) > 0).map((n) => n.id),
      ).toEqual(['build']);
      // ...and the tab says so too.
      expect(screen.getByRole('tab', { name: /main/ })).toHaveAttribute(
        'title',
        expect.stringMatching(/has problems/i),
      );
    });

    it('marks a node named by an error in a different workflow not at all', async () => {
      seed([
        "Error calling workflow: 'release'",
        'Cannot find a definition for job named build',
      ]);
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      const marked = props.nodes.filter((node) => markedCount(node) > 0);
      expect(marked).toEqual([]);
    });

    it('lists the compile error in the banner, labelled with its source', async () => {
      seed([
        "Error calling workflow: 'main'",
        "Error calling job: 'build'",
        'Cannot find a definition for command named chekcout',
      ]);
      render(<DagPane />);
      await settle();

      expect(screen.getByText('CircleCI compiler:')).toBeInTheDocument();
      expect(
        screen.getByText('Cannot find a definition for command named chekcout'),
      ).toBeInTheDocument();
    });

    it('makes each banner error a button that selects the job it names', async () => {
      seed([
        "Error calling workflow: 'main'",
        "Error calling job: 'test'",
        'Cannot find a definition for command named chekcout',
      ]);
      render(<DagPane />);
      await settle();

      // Keyboard-reachable by construction: it is a real <button>, not a
      // hover affordance on the node.
      fireEvent.click(
        screen.getByRole('button', {
          name: /Cannot find a definition for command named chekcout/,
        }),
      );
      expect(useAppStore.getState().selectedNodeId).toBe('test');
    });

    it('labels an offline finding as a local check, never as the compiler', async () => {
      useAppStore.setState(RESET_STATE);
      const broken = `version: 2.1
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          requires:
            - gone
`;
      const { doc } = parseConfig(broken);
      useAppStore.setState({
        doc,
        text: broken,
        validation: {
          state: 'unavailable',
          errors: [],
          reason:
            'no CircleCI API token available; validation requires a token',
        },
      });
      render(<DagPane />);
      await settle();

      expect(screen.getByText('Local check:')).toBeInTheDocument();
      expect(screen.queryByText('CircleCI compiler:')).not.toBeInTheDocument();
    });

    it('flags a workflow tab whose only problem is a compile error', async () => {
      // Structurally this workflow is fine -- an undefined executor is
      // invisible to `buildWorkflowGraph`. The tab still has to say something
      // is wrong, because the pipeline will not run.
      useAppStore.setState(RESET_STATE);
      const config = `version: 2.1
jobs:
  build:
    executor: nope
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
`;
      const { doc } = parseConfig(config);
      useAppStore.setState({
        doc,
        text: config,
        validation: {
          state: 'invalid',
          errors: [
            { message: "Error calling workflow: 'main'" },
            { message: "Error calling job: 'build'" },
            { message: 'Cannot find a definition for executor named nope' },
          ],
        },
      });
      render(<DagPane />);
      await settle();

      expect(screen.getByRole('tab', { name: /main/ })).toHaveAttribute(
        'title',
        expect.stringMatching(/has problems/i),
      );
    });
  });

  it('shows a "showing last valid version" note when there is a parse error but a prior doc exists', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml('workflows:\n  main:\n    jobs:\n      - build\n');
    useAppStore.setState({ parseError: 'Bad indentation at line 3' });

    render(<DagPane />);
    await settle();

    expect(screen.getByText(/showing last valid version/i)).toBeInTheDocument();
  });

  it('shows a friendly message when the selected workflow has no jobs', async () => {
    useAppStore.setState(RESET_STATE);
    setDocFromYaml('workflows:\n  main:\n    jobs: []\n');
    render(<DagPane />);
    await settle();

    expect(screen.getByText(/has no jobs/i)).toBeInTheDocument();
  });

  // Issue #54: matches CircleCI production's own DAG rendering/interaction
  // (edge routing/markers, and the hover/select highlight behaviour), while
  // deliberately not copying every value verbatim -- see `layout.ts` and
  // `DagPane.tsx`'s own comments for what's ground-truthed vs. what's
  // adapted for this app being an editor rather than an observer.
  describe('graph rendering and highlighting (issue #54)', () => {
    function setDiamondWorkflow(): void {
      // a -> b -> d, a -> c -> d: gives `d` a two-branch ancestor chain
      // (a, b, c) and leaves an unrelated node (`e`) fully outside it.
      setDocFromYaml(`
jobs:
  a:
    docker: []
  b:
    docker: []
  c:
    docker: []
  d:
    docker: []
  e:
    docker: []
workflows:
  main:
    jobs:
      - a
      - b:
          requires:
            - a
      - c:
          requires:
            - a
      - d:
          requires:
            - b
            - c
      - e
`);
    }

    it('routes edges with smoothstep, a 1px stroke, and a colour-matched ArrowClosed marker', async () => {
      useAppStore.setState(RESET_STATE);
      setDiamondWorkflow();
      render(<DagPane />);
      await settle();

      const { edges } = await getCapturedProps();
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        // Production routes with `smoothstep`, not React Flow's bezier
        // fallback -- see `layout.ts`'s NODE_WIDTH comment and `flowEdges`
        // in `DagPane.tsx`.
        expect(edge.type).toBe('smoothstep');
        expect(edge.style?.strokeWidth).toBe(1);
        // The marker's own colour is CSS `context-stroke`, not asserted
        // here (jsdom doesn't render it) -- only that a colour-matchable
        // ArrowClosed marker is actually present.
        expect(edge.markerEnd?.type).toBe('arrowclosed');
      }
    });

    it('a status-conditioned requires carries its statuses as edge data, not an always-on label (issue #70)', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      render(<DagPane />);
      await settle();

      const { edges } = await getCapturedProps();
      const conditioned = edges.find(
        (e) => e.id === 'lint-backend->test-backend',
      );
      expect(conditioned?.data?.statuses).toEqual(['success', 'failed']);
      // The whole point (issue #70): no permanent on-canvas text -- the
      // statuses are read by `RequiresEdge.tsx`'s hover/focus tooltip, not
      // rendered as React Flow's own always-on `label`.
      expect(conditioned?.label).toBeUndefined();
    });

    it('an unconditioned requires carries no statuses in its edge data', async () => {
      useAppStore.setState(RESET_STATE);
      setDiamondWorkflow();
      render(<DagPane />);
      await settle();

      const { edges } = await getCapturedProps();
      expect(edges.every((e) => e.data?.statuses === undefined)).toBe(true);
    });

    it("highlights a hovered node's connected edges and no others", async () => {
      useAppStore.setState(RESET_STATE);
      setDiamondWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeMouseEnter(null, { id: 'a' }));
      await settle();

      const afterHover = await getCapturedProps();
      const highlighted = new Set(
        afterHover.edges
          .filter((e) => e.className?.includes('vce-dag-edge--highlighted'))
          .map((e) => e.id),
      );
      // `a` feeds both `b` and `c`.
      expect(highlighted).toEqual(new Set(['a->b', 'a->c']));

      act(() => props.onNodeMouseLeave(null, { id: 'a' }));
      await settle();
      const afterLeave = await getCapturedProps();
      expect(
        afterLeave.edges.every(
          (e) => !e.className?.includes('vce-dag-edge--highlighted'),
        ),
      ).toBe(true);
    });

    it('selecting a node highlights its ancestor chain and dims everything outside it', async () => {
      useAppStore.setState(RESET_STATE);
      setDiamondWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'd' }));
      await settle();

      const afterSelect = await getCapturedProps();
      const dimmedNodes = new Set(
        afterSelect.nodes
          .filter((n) => n.className?.includes('vce-dag-node--dimmed'))
          .map((n) => n.id),
      );
      // d's ancestor chain is {a, b, c, d}; only the unrelated `e` dims.
      expect(dimmedNodes).toEqual(new Set(['e']));

      const dimmedEdges = new Set(
        afterSelect.edges
          .filter((e) => e.className?.includes('vce-dag-edge--dimmed'))
          .map((e) => e.id),
      );
      expect(dimmedEdges.size).toBe(0);

      const highlightedEdges = new Set(
        afterSelect.edges
          .filter((e) => e.className?.includes('vce-dag-edge--highlighted'))
          .map((e) => e.id),
      );
      expect(highlightedEdges).toEqual(
        new Set(['a->b', 'a->c', 'b->d', 'c->d']),
      );

      // Under the large-graph threshold, the dim animates.
      const dimmedNode = afterSelect.nodes.find((n) => n.id === 'e');
      expect(dimmedNode?.className).toContain('vce-dag-fade');
    });

    it('Escape clears the selection, undimming the chain highlight', async () => {
      useAppStore.setState(RESET_STATE);
      setDiamondWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'd' }));
      await settle();
      expect(useAppStore.getState().selectedNodeId).toBe('d');

      fireEvent.keyDown(screen.getByTestId('dag-canvas'), { key: 'Escape' });
      await settle();

      expect(useAppStore.getState().selectedNodeId).toBeNull();
      const afterEscape = await getCapturedProps();
      expect(
        afterEscape.nodes.every(
          (n) => !n.className?.includes('vce-dag-node--dimmed'),
        ),
      ).toBe(true);
    });

    it('skips the opacity transition class above the large-graph threshold', async () => {
      useAppStore.setState(RESET_STATE);
      // 101 independent jobs plus one dependency edge (job-1 requires
      // job-0) -- enough to cross `LARGE_GRAPH_THRESHOLD` (100) while still
      // giving the selected node a one-node ancestor chain to dim around.
      const jobCount = 101;
      const jobDefs = Array.from(
        { length: jobCount },
        (_, i) => `  job-${i}:\n    docker: []`,
      ).join('\n');
      const workflowJobs = Array.from({ length: jobCount }, (_, i) =>
        i === 1
          ? '      - job-1:\n          requires:\n            - job-0'
          : `      - job-${i}`,
      ).join('\n');
      setDocFromYaml(
        `jobs:\n${jobDefs}\nworkflows:\n  main:\n    jobs:\n${workflowJobs}\n`,
      );
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      expect(props.nodes.length).toBe(jobCount);
      // Edge type falls back to `default` above the threshold, matching
      // production's own perf fallback (see `LARGE_GRAPH_THRESHOLD`).
      expect(props.edges[0]?.type).toBe('default');

      act(() => props.onNodeClick(null, { id: 'job-1' }));
      await settle();

      const afterSelect = await getCapturedProps();
      const dimmedOther = afterSelect.nodes.find((n) => n.id === 'job-2');
      expect(dimmedOther?.className).toContain('vce-dag-node--dimmed');
      expect(dimmedOther?.className).not.toContain('vce-dag-fade');
    });
  });

  describe('free positioning (issue #70)', () => {
    function setSimpleTwoJobWorkflowForPositioning(): void {
      setDocFromYaml(`
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
    }

    it("a manually-dragged position overrides ELK's own layout and survives a structure change", async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflowForPositioning();
      render(<DagPane />);
      await settle();

      const beforeDrag = await getCapturedProps();
      const elkPosition = beforeDrag.nodes.find(
        (n) => n.id === 'build',
      )?.position;
      expect(elkPosition).toEqual({ x: 0, y: 0 }); // index 0 under this file's mocked layoutGraph

      act(() =>
        beforeDrag.onNodeDragStop(null, {
          id: 'build',
          position: { x: 321, y: 654 },
        }),
      );
      await settle();

      const afterDrag = await getCapturedProps();
      expect(afterDrag.nodes.find((n) => n.id === 'build')?.position).toEqual({
        x: 321,
        y: 654,
      });

      // Toggling layout direction is a structural-change trigger `DagPane`
      // exposes as a button, and re-runs the mocked `layoutGraph`, giving
      // `rendered.nodes` (and every node object in it) a fresh identity --
      // exactly what used to snap a drag straight back to ELK's own
      // position; see `flowNodes`' own comment on why looking the position
      // up by id instead fixes that.
      fireEvent.click(
        screen.getByRole('button', { name: /switch to vertical layout/i }),
      );
      await settle();

      const afterStructureChange = await getCapturedProps();
      expect(
        afterStructureChange.nodes.find((n) => n.id === 'build')?.position,
      ).toEqual({ x: 321, y: 654 });
    });

    it('a dragged node moves live, mid-drag, not just after mouseup (issue #85 regression)', async () => {
      // The #85 regression: `flowNodes` recomputed this node's position
      // from ELK/manual on *every* render, which stomped React Flow's own
      // in-flight drag position before it ever painted -- measured on the
      // running app as a `transform` that stayed at `translate(12px,
      // 240px)` for the entire drag (`dragging: true`) and only jumped once,
      // on `mouseup`. The existing "survives a structure change" test above
      // only ever calls `onNodeDragStop`, which a node that never moves
      // until release still passes -- this asserts the position mid-drag,
      // via React Flow's own per-frame `onNodeDrag` callback, which is what
      // that test never covered and what actually caught this bug.
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflowForPositioning();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      expect(props.nodes.find((n) => n.id === 'build')?.position).toEqual({
        x: 0,
        y: 0,
      });

      act(() =>
        props.onNodeDrag(null, { id: 'build', position: { x: 40, y: 12 } }),
      );
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({
        x: 40,
        y: 12,
      });

      act(() =>
        props.onNodeDrag(null, { id: 'build', position: { x: 88, y: 30 } }),
      );
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({
        x: 88,
        y: 30,
      });

      act(() =>
        props.onNodeDragStop(null, {
          id: 'build',
          position: { x: 321, y: 654 },
        }),
      );
      await settle();
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({
        x: 321,
        y: 654,
      });
    });

    it('"Re-layout" discards a manually-dragged position and hands the node back to ELK', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflowForPositioning();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() =>
        props.onNodeDragStop(null, {
          id: 'build',
          position: { x: 321, y: 654 },
        }),
      );
      await settle();
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({ x: 321, y: 654 });

      fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }));
      await settle();

      const afterRelayout = await getCapturedProps();
      // Back to the mocked layoutGraph's own index-based position, not the
      // dragged one.
      expect(
        afterRelayout.nodes.find((n) => n.id === 'build')?.position,
      ).toEqual({ x: 0, y: 0 });
    });

    it('a manually-dragged position is scoped to its own workflow', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
  other:
    jobs:
      - build
`);
      render(<DagPane />);
      await settle();

      const propsBeforeDrag = await getCapturedProps();
      act(() =>
        propsBeforeDrag.onNodeDragStop(null, {
          id: 'build',
          position: { x: 50, y: 60 },
        }),
      );
      await settle();
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({ x: 50, y: 60 });

      fireEvent.click(screen.getByRole('tab', { name: /other/i }));
      await settle();

      // `other`'s own `build` node has never been dragged -- it must not
      // pick up `main`'s stored position just because the node id matches.
      expect(
        (await getCapturedProps()).nodes.find((n) => n.id === 'build')
          ?.position,
      ).toEqual({ x: 0, y: 0 });
    });
  });

  describe('keyboard-accessible connecting (issue #70)', () => {
    // `JobNode`'s own Enter/Space handling is exercised by `JobNode.test.tsx`
    // (real `Handle` elements, mocked here to `() => null` like the rest of
    // this file's `@xyflow/react` mock); this exercises the state machine
    // `DagPane` runs on top, by calling the exact same `data.onActivateHandle`
    // callback `JobNode` calls, taken directly off a captured node's data --
    // the same technique `getCapturedProps` already uses to reach
    // `onConnect`/`isValidConnection` without React Flow's real DOM.
    function activateHandle(props: CapturedFlowProps, nodeId: string): void {
      const node = props.nodes.find((n) => n.id === nodeId);
      const data = node?.data as
        | { onActivateHandle?: (id: string) => void }
        | undefined;
      data?.onActivateHandle?.(nodeId);
    }

    function isKeyboardConnectSource(
      props: CapturedFlowProps,
      nodeId: string,
    ): boolean {
      const node = props.nodes.find((n) => n.id === nodeId);
      const data = node?.data as
        | { isKeyboardConnectSource?: boolean }
        | undefined;
      return data?.isKeyboardConnectSource ?? false;
    }

    /** Activates `nodeId`'s handle against the *latest* captured props --
     * every call site needs a fresh `getCapturedProps()` since the previous
     * activation's `act()` re-renders `DagPane` with new node data. */
    async function activateLatest(nodeId: string): Promise<void> {
      const props = await getCapturedProps();
      act(() => activateHandle(props, nodeId));
    }

    function setTwoIndependentJobs(): void {
      setDocFromYaml(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test
`);
    }

    it('activating a handle becomes the pending connect-from anchor, surfaced in a status hint', async () => {
      useAppStore.setState(RESET_STATE);
      setTwoIndependentJobs();
      render(<DagPane />);
      await settle();

      await activateLatest('build');
      await settle();

      expect(screen.getByRole('status')).toHaveTextContent(/connecting from/i);
      expect(screen.getByRole('status')).toHaveTextContent('build');
      expect(isKeyboardConnectSource(await getCapturedProps(), 'build')).toBe(
        true,
      );
      expect(isKeyboardConnectSource(await getCapturedProps(), 'test')).toBe(
        false,
      );
    });

    it("activating a second node's handle completes the connection via addRequire", async () => {
      useAppStore.setState(RESET_STATE);
      setTwoIndependentJobs();
      render(<DagPane />);
      await settle();

      await activateLatest('build');
      await settle();
      await activateLatest('test');
      await settle();

      const doc = useAppStore.getState().doc!;
      const requires = getIn(doc, [
        'workflows',
        'main',
        'jobs',
        1,
        'test',
        'requires',
      ]);
      expect(requires).toEqual(['build']);
      // The anchor clears once the connection completes.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it("activating the anchor's own handle again cancels, without connecting it to itself", async () => {
      useAppStore.setState(RESET_STATE);
      setTwoIndependentJobs();
      render(<DagPane />);
      await settle();

      await activateLatest('build');
      await settle();
      await activateLatest('build');
      await settle();

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      const doc = useAppStore.getState().doc!;
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'requires']),
      ).toBeUndefined();
    });

    it('Escape cancels a pending keyboard connection', async () => {
      useAppStore.setState(RESET_STATE);
      setTwoIndependentJobs();
      render(<DagPane />);
      await settle();

      await activateLatest('build');
      await settle();
      expect(screen.getByRole('status')).toBeInTheDocument();

      fireEvent.keyDown(screen.getByTestId('dag-canvas'), { key: 'Escape' });
      await settle();

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // A subsequent activation on a different node starts a *fresh*
      // connection rather than completing whatever was cancelled.
      await activateLatest('test');
      await settle();
      expect(isKeyboardConnectSource(await getCapturedProps(), 'test')).toBe(
        true,
      );
    });

    it('completing a connection that would close a cycle surfaces the same refusal a mouse drag gets, and cancels the anchor', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      render(<DagPane />);
      await settle();

      // build already precedes test; completing test -> build would close a
      // cycle (build already requires test transitively... here directly
      // the reverse: making `build` require `test` closes the loop).
      await activateLatest('test');
      await settle();
      await activateLatest('build');
      await settle();

      expect(screen.getByRole('alert')).toHaveTextContent(/cycle/i);
      const doc = useAppStore.getState().doc!;
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'requires']),
      ).toBeUndefined();
    });
  });

  describe('editing', () => {
    // Two edges sharing a source (`a->b`, `a->c`) -- enough to prove an
    // edge-scoped affordance/selection lands on the one edge interacted with
    // and not its sibling. `setDiamondWorkflow` (used by the "graph
    // rendering and highlighting" tests above) is scoped to that other
    // `describe` block, not this one.
    function setTwoEdgeWorkflow(): void {
      setDocFromYaml(`
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
      - b:
          requires:
            - a
      - c:
          requires:
            - a
`);
    }

    function setSimpleTwoJobWorkflow(): void {
      setDocFromYaml(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test
`);
    }

    // Issue #71: "Add job" is gone -- clicking a palette Executors card (the
    // keyboard/no-drag equivalent of dragging it onto the canvas) opens
    // `ConfigureJobDialog`, pre-filled with a unique job name via the same
    // `generateUniqueJobName` the old button used, and "Create job" performs
    // both halves (job + workflow entry) as one mutation.
    it('clicking the Docker executor card creates a uniquely-named job in the active workflow and selects it', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /^docker\b/i }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();

      expect(screen.getByTestId('node-new-job')).toBeInTheDocument();
      expect(useAppStore.getState().selectedNodeId).toBe('new-job');
      expect(useAppStore.getState().text).toContain('new-job');
    });

    it('generates the next free "new-job-N" name when "new-job" is already taken', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
jobs:
  build:
    docker: []
  new-job:
    docker: []
workflows:
  main:
    jobs:
      - build
      - new-job
`);
      render(<DagPane />);
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /^docker\b/i }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();

      expect(screen.getByTestId('node-new-job-2')).toBeInTheDocument();
    });

    it('connecting two nodes calls addRequire, adding a requires edge to the config', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => {
        props.onConnect({ source: 'build', target: 'test' });
      });

      expect(useAppStore.getState().text).toMatch(/requires:\s*\n\s*-\s*build/);
    });

    it('rejects a self-connection via isValidConnection before any edit is attempted', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      expect(
        props.isValidConnection({ source: 'build', target: 'build' }),
      ).toBe(false);
      // Nothing was attempted, so the config is untouched and there's no editError.
      expect(useAppStore.getState().editError).toBeNull();
    });

    it('rejects a connection that would close a dependency cycle', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      // test already requires build; making build require test would close the loop.
      expect(props.isValidConnection({ source: 'test', target: 'build' })).toBe(
        false,
      );
    });

    it('deleting an edge calls removeRequire, removing the requires entry', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => {
        props.onEdgesDelete([
          { id: 'build->test', source: 'build', target: 'test' },
        ]);
      });

      expect(useAppStore.getState().text).not.toMatch(/requires/);
    });

    // Issue #289: deleting the last (only) entry must remove the now-empty
    // `requires:` key entirely, not leave `requires: []` -- and undo must
    // restore the document byte-for-byte, not just something semantically
    // equivalent. This is the exact round-trip the issue calls out as "the
    // property most likely to quietly break".
    it('deleting the last requires entry removes the key, and undo restores the document byte-for-byte', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      // Same seeding `a whole multi-site delete undoes as one step` (below)
      // uses: `setDocFromYaml` only sets `doc`, not `text`/the undo stack, so
      // this makes `text` (what `undo()` actually restores) agree with the
      // parsed `doc` before any edit -- otherwise undo would restore the
      // stale `RESET_STATE.text` (`''`), not this fixture.
      const before = useAppStore.getState().doc?.toString() ?? '';
      useAppStore.setState({
        text: before,
        savedText: before,
        undoStack: [],
        redoStack: [],
        canUndo: false,
      });
      render(<DagPane />);
      await settle();
      expect(useAppStore.getState().text).toBe(before);

      const props = await getCapturedProps();
      act(() => {
        props.onEdgesDelete([
          { id: 'build->test', source: 'build', target: 'test' },
        ]);
      });
      await settle();

      const afterDelete = useAppStore.getState().text;
      expect(afterDelete).not.toContain('requires');
      // Not `requires: []` left behind -- the whole map entry collapses back
      // to the bare string form it would have had without the dependency.
      expect(afterDelete).toContain('      - test\n');

      act(() => useAppStore.getState().undo());
      await settle();
      expect(useAppStore.getState().text).toBe(before);
    });

    // Issue #289: canvas-level unlink is the inverse of the canvas-level link
    // gesture (#29/#32) -- linking then unlinking must return the document to
    // exactly its original bytes, not just an equivalent parse.
    it('linking then unlinking on the canvas round-trips the document byte-for-byte', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      const before = useAppStore.getState().doc?.toString() ?? '';
      useAppStore.setState({
        text: before,
        savedText: before,
        undoStack: [],
        redoStack: [],
        canUndo: false,
      });
      render(<DagPane />);
      await settle();
      expect(useAppStore.getState().text).toBe(before);

      const props = await getCapturedProps();
      act(() => props.onConnect({ source: 'build', target: 'test' }));
      await settle();
      expect(useAppStore.getState().text).not.toBe(before);

      act(() => {
        props.onEdgesDelete([
          { id: 'build->test', source: 'build', target: 'test' },
        ]);
      });
      await settle();

      expect(useAppStore.getState().text).toBe(before);
    });

    // Issue #289: the discoverable hover/selected affordance (`RequiresEdge.tsx`'s
    // "×") calls the exact same removal, via the edge's own `data.onRemove`
    // rather than `onEdgesDelete` -- this is the path a mouse-only user who
    // never learns "select, then press Delete" actually takes.
    it('the edge data.onRemove callback (the hover-affordance path) removes the same dependency', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
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
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      const edge = props.edges.find((e) => e.id === 'build->test');
      expect(edge?.data?.onRemove).toBeInstanceOf(Function);

      act(() => edge?.data?.onRemove?.());
      await settle();

      expect(useAppStore.getState().text).not.toMatch(/requires/);
    });

    it('hovering an edge shows the delete affordance (canRemove), only on that edge', async () => {
      useAppStore.setState(RESET_STATE);
      setTwoEdgeWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onEdgeMouseEnter(null, { id: 'a->b' }));
      await settle();

      const afterHover = await getCapturedProps();
      const withAffordance = new Set(
        afterHover.edges.filter((e) => e.data?.canRemove).map((e) => e.id),
      );
      expect(withAffordance).toEqual(new Set(['a->b']));

      act(() => props.onEdgeMouseLeave(null, { id: 'a->b' }));
      await settle();
      const afterLeave = await getCapturedProps();
      expect(afterLeave.edges.every((e) => !e.data?.canRemove)).toBe(true);
    });

    it("clicking an edge selects it (canRemove, and React Flow's own selected flag), and deselects any selected node", async () => {
      useAppStore.setState(RESET_STATE);
      setTwoEdgeWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'a' }));
      await settle();
      expect(useAppStore.getState().selectedNodeId).toBe('a');

      act(() => props.onEdgeClick(null, { id: 'a->b' }));
      await settle();

      const afterEdgeSelect = await getCapturedProps();
      const selectedEdge = afterEdgeSelect.edges.find((e) => e.id === 'a->b');
      expect(selectedEdge?.selected).toBe(true);
      expect(selectedEdge?.data?.canRemove).toBe(true);
      // Clicking the edge cleared the node selection -- only one kind of
      // thing is "selected" on this canvas at a time.
      expect(useAppStore.getState().selectedNodeId).toBeNull();
    });

    it('Escape clears an edge selection, the same way it clears a node selection', async () => {
      useAppStore.setState(RESET_STATE);
      setTwoEdgeWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onEdgeClick(null, { id: 'a->b' }));
      await settle();
      expect(
        (await getCapturedProps()).edges.find((e) => e.id === 'a->b')?.selected,
      ).toBe(true);

      fireEvent.keyDown(screen.getByTestId('dag-canvas'), { key: 'Escape' });
      await settle();

      const afterEscape = await getCapturedProps();
      expect(afterEscape.edges.every((e) => !e.selected)).toBe(true);
    });

    it('deleting a selected node opens a popover offering both "remove from workflow" and "delete job"', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => {
        props.onNodeClick(null, { id: 'build' });
      });
      act(() => {
        props.onNodesDelete([{ id: 'build' }]);
      });

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /remove from workflow/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /delete job/i }),
      ).toBeInTheDocument();
    });

    it('"Remove from workflow" only detaches the entry, leaving the job definition intact', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));
      act(() => props.onNodesDelete([{ id: 'build' }]));
      fireEvent.click(
        screen.getByRole('button', { name: /remove from workflow/i }),
      );

      const { text } = useAppStore.getState();
      expect(text).toContain('build:'); // the job definition survives
      expect(text).not.toMatch(/jobs:\s*\n\s*-\s*build\s*\n/); // but the workflow entry is gone
    });

    it('"Delete job" removes the job definition entirely', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));
      act(() => props.onNodesDelete([{ id: 'build' }]));
      fireEvent.click(screen.getByRole('button', { name: /delete job/i }));

      expect(useAppStore.getState().text).not.toContain('build');
    });

    // -----------------------------------------------------------------------
    // Issue #12: before deleting a job, say exactly what will change -- and
    // say plainly what won't. The dependents of a deleted job are never
    // silently re-pointed at its dependencies.
    // -----------------------------------------------------------------------

    function setChainWorkflow(): void {
      setDocFromYaml(`
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
            - test
`);
    }

    it('the delete popover names every site the delete will touch, not just "are you sure"', async () => {
      useAppStore.setState(RESET_STATE);
      setChainWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'test' }));
      act(() => props.onNodesDelete([{ id: 'test' }]));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Deleting test changes 3 places.');
      expect(dialog).toHaveTextContent('the job definition: jobs.test');
      expect(dialog).toHaveTextContent('1 job entry removed');
      expect(dialog).toHaveTextContent("removed from deploy's requires:");
    });

    it('the delete popover says the dependents will not be re-wired', async () => {
      useAppStore.setState(RESET_STATE);
      setChainWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'test' }));
      act(() => props.onNodesDelete([{ id: 'test' }]));

      expect(screen.getByRole('dialog')).toHaveTextContent(
        'deploy is not re-pointed at whatever test required',
      );
    });

    it('deleting a mid-chain job leaves the DAG visibly broken rather than re-wiring it', async () => {
      useAppStore.setState(RESET_STATE);
      setChainWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'test' }));
      act(() => props.onNodesDelete([{ id: 'test' }]));
      fireEvent.click(screen.getByRole('button', { name: /delete job/i }));
      await settle();

      const text = useAppStore.getState().text;
      // `deploy` is NOT connected to `build`: the reference was removed, not
      // redirected. Inventing that edge is the thing this refuses to do.
      expect(text).not.toMatch(/deploy:\s*\n\s*requires:/);
      expect(text).toContain('- deploy');
      expect(text).toContain('- build');
    });

    it('refuses, with the reason up front, when the delete would strand a YAML alias', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
jobs:
  deploy_prod: &deploy
    docker: []
  deploy_canary: *deploy
workflows:
  main:
    jobs:
      - deploy_prod
`);
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'deploy_prod' }));
      act(() => props.onNodesDelete([{ id: 'deploy_prod' }]));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent("This can't be done yet");
      expect(dialog).toHaveTextContent('deploy_canary');
      // The button is disabled rather than letting the user confirm an action
      // the mutation layer will then refuse.
      expect(
        screen.getByRole('button', { name: /delete job/i }),
      ).toBeDisabled();
    });

    it('a whole multi-site delete undoes as one step', async () => {
      useAppStore.setState(RESET_STATE);
      setChainWorkflow();
      const before = useAppStore.getState().doc?.toString() ?? '';
      useAppStore.setState({
        text: before,
        savedText: before,
        undoStack: [],
        redoStack: [],
        canUndo: false,
      });
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'test' }));
      act(() => props.onNodesDelete([{ id: 'test' }]));
      fireEvent.click(screen.getByRole('button', { name: /delete job/i }));
      await settle();

      // Three sites changed (definition, entry, deploy's requires) in one
      // history entry.
      expect(useAppStore.getState().undoStack).toHaveLength(1);
      act(() => {
        useAppStore.getState().undo();
      });
      expect(useAppStore.getState().text).toBe(before);
      expect(useAppStore.getState().canUndo).toBe(false);
    });

    it('renders a dangling requires: as a visible broken edge into a missing placeholder', async () => {
      useAppStore.setState(RESET_STATE);
      setDocFromYaml(`
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy:
          requires:
            - build
`);
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      const placeholder = props.nodes.find((n) => n.id === 'build');
      expect(placeholder).toBeDefined();
      // Inert: nothing to select, nothing to connect to, no delete affordance.
      const data = placeholder?.data as {
        node: { isMissing?: boolean };
        onRequestDelete?: unknown;
        onActivateHandle?: unknown;
      };
      expect(data.node.isMissing).toBe(true);
      expect(data.onRequestDelete).toBeUndefined();
      expect(data.onActivateHandle).toBeUndefined();

      const edge = props.edges.find((e) => e.id === 'build->deploy');
      expect(edge?.className).toContain('vce-dag-edge--dangling');
    });

    it('the Undo button is disabled until an edit happens, then restores the prior text', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      expect(
        screen.getByRole('button', { name: /undo last change/i }),
      ).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: /^docker\b/i }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();
      expect(useAppStore.getState().text).toContain('new-job');

      const undoButton = screen.getByRole('button', {
        name: /undo last change/i,
      });
      expect(undoButton).not.toBeDisabled();
      fireEvent.click(undoButton);

      expect(useAppStore.getState().text).not.toContain('new-job');
    });

    it('Ctrl+Z inside the pane triggers undo, but not while a text input is focused', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      const { container } = render(<DagPane />);
      await settle();

      fireEvent.click(screen.getByRole('button', { name: /^docker\b/i }));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();
      expect(useAppStore.getState().text).toContain('new-job');

      // The inspector's own Job name input is focused: Ctrl+Z here must be
      // left to the browser's native input-undo, not trigger a document undo.
      const nameInput = screen.getByLabelText(/^job name$/i);
      nameInput.focus();
      fireEvent.keyDown(nameInput, { key: 'z', ctrlKey: true });
      expect(useAppStore.getState().text).toContain('new-job');

      // Away from any text input, the same shortcut does undo the document.
      const pane = container.querySelector('[data-testid="react-flow"]');
      if (pane) fireEvent.keyDown(pane, { key: 'z', ctrlKey: true });
      expect(useAppStore.getState().text).not.toContain('new-job');
    });

    it('does not open the delete popover while a text input elsewhere on the page is focused', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(
        <>
          <input aria-label="unrelated text field" />
          <DagPane />
        </>,
      );
      await settle();

      const input = screen.getByLabelText('unrelated text field');
      input.focus();
      expect(document.activeElement).toBe(input);

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));
      act(() => props.onNodesDelete([{ id: 'build' }]));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('inspector resizing (issue #30)', () => {
    const STORAGE_KEY = 'vce.inspectorWidth';

    function setSimpleTwoJobWorkflow(): void {
      setDocFromYaml(`
jobs:
  build:
    docker: []
  test:
    docker: []
workflows:
  main:
    jobs:
      - build
      - test
`);
    }

    beforeEach(() => {
      window.localStorage.clear();
    });

    it('defaults to 280px and exposes itself as a keyboard-focusable vertical separator', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));

      const separator = screen.getByRole('separator', {
        name: /resize inspector/i,
      });
      expect(separator).toHaveAttribute('aria-orientation', 'vertical');
      expect(separator).toHaveAttribute('aria-valuenow', '280');
      expect(separator).toHaveAttribute('tabIndex', '0');
    });

    it('dragging the separator resizes the inspector and persists the width', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));

      const separator = screen.getByRole('separator', {
        name: /resize inspector/i,
      });
      fireEvent.pointerDown(separator, { clientX: 500 });
      // Dragging the handle 100px to the *left* widens the inspector (it sits
      // to the separator's right), so the column should grow, not shrink.
      fireEvent.pointerMove(window, { clientX: 400 });
      fireEvent.pointerUp(window);

      expect(
        screen.getByRole('separator', { name: /resize inspector/i }),
      ).toHaveAttribute('aria-valuenow', '380');
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('380');
    });

    it('clamps a drag past the minimum/maximum width', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));

      const separator = screen.getByRole('separator', {
        name: /resize inspector/i,
      });
      fireEvent.pointerDown(separator, { clientX: 0 });
      // Dragging far to the *right* narrows the inspector well past any
      // sensible minimum.
      fireEvent.pointerMove(window, { clientX: 5000 });
      fireEvent.pointerUp(window);

      expect(
        screen.getByRole('separator', { name: /resize inspector/i }),
      ).toHaveAttribute('aria-valuenow', '220');
    });

    it('supports keyboard resizing via arrow keys, and Home/End for the extremes', async () => {
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));

      const separator = screen.getByRole('separator', {
        name: /resize inspector/i,
      });
      fireEvent.keyDown(separator, { key: 'ArrowLeft' });
      expect(separator).toHaveAttribute('aria-valuenow', '296');

      fireEvent.keyDown(separator, { key: 'ArrowRight' });
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
      expect(separator).toHaveAttribute('aria-valuenow', '264');

      fireEvent.keyDown(separator, { key: 'End' });
      expect(separator).toHaveAttribute('aria-valuenow', '560');

      fireEvent.keyDown(separator, { key: 'Home' });
      expect(separator).toHaveAttribute('aria-valuenow', '220');
    });

    it('restores a previously-persisted width on mount', async () => {
      window.localStorage.setItem(STORAGE_KEY, '400');
      useAppStore.setState(RESET_STATE);
      setSimpleTwoJobWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'build' }));

      expect(
        screen.getByRole('separator', { name: /resize inspector/i }),
      ).toHaveAttribute('aria-valuenow', '400');
    });
  });

  /*
   * Issue #24: a job group resolves correctly and carries its member list
   * today, but draws no interior -- these pin the "shown on selection"
   * choice this issue's PR argues for: the interior stays undrawn until the
   * group itself (or, once expanded, one of its members) is selected, and
   * collapses the moment selection moves elsewhere. Real ELK geometry is
   * `layout.test.ts`'s job; this exercises `DagPane`'s own wiring --
   * `expandedGroupId` derivation, `flowNodes`/`flowEdges` construction, and
   * `findGraphNode`-based selection -- via the flattening the mocked
   * `layoutGraph` above reproduces.
   */
  describe('job groups (issue #24)', () => {
    function setGroupWorkflow(): void {
      setDocFromYaml(`
job-groups:
  deploy-group:
    jobs:
      - deploy
      - release:
          requires:
            - deploy
  mystery-group:
    jobs: not-a-list
jobs:
  build:
    docker: []
  deploy:
    docker: []
  release:
    docker: []
workflows:
  main:
    jobs:
      - build
      - deploy-group:
          requires:
            - build
      - mystery-group:
          requires:
            - build
`);
    }

    it('draws no members until the group itself is selected', async () => {
      useAppStore.setState(RESET_STATE);
      setGroupWorkflow();
      render(<DagPane />);
      await settle();

      const props = await getCapturedProps();
      expect(props.nodes.map((n) => n.id)).toEqual([
        'build',
        'deploy-group',
        'mystery-group',
      ]);
      expect(screen.queryByTestId('node-deploy-group::deploy')).toBeNull();
    });

    it('renders the resolvable group as its members the moment it is selected, and collapses again on deselect', async () => {
      useAppStore.setState(RESET_STATE);
      setGroupWorkflow();
      render(<DagPane />);
      await settle();

      let props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'deploy-group' }));
      await settle();

      props = await getCapturedProps();
      const ids = props.nodes.map((n) => n.id);
      expect(ids).toContain('deploy-group::deploy');
      expect(ids).toContain('deploy-group::release');

      // The container renders through the new `jobGroup` node type, not the
      // ordinary `job` JobNode -- see `NODE_TYPES` in `DagPane.tsx`.
      const container = props.nodes.find((n) => n.id === 'deploy-group');
      expect(container?.type).toBe('jobGroup');
      const member = props.nodes.find((n) => n.id === 'deploy-group::release');
      expect(member?.type).toBe('job');

      // The internal `requires: [deploy]` is a real edge too, reusing the
      // same flowEdges machinery as any workflow-level dependency.
      expect(
        props.edges.some(
          (e) =>
            e.source === 'deploy-group::deploy' &&
            e.target === 'deploy-group::release',
        ),
      ).toBe(true);

      // Deselecting (clicking the pane background) collapses it back to one
      // node -- selection is the only thing driving expansion, so nothing
      // separate needs to be "closed".
      act(() => props.onPaneClick());
      await settle();
      props = await getCapturedProps();
      expect(props.nodes.map((n) => n.id)).toEqual([
        'build',
        'deploy-group',
        'mystery-group',
      ]);
    });

    it('keeps the group expanded when a member is selected directly, instead of snapping shut', async () => {
      useAppStore.setState(RESET_STATE);
      setGroupWorkflow();
      render(<DagPane />);
      await settle();

      let props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'deploy-group' }));
      await settle();

      props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'deploy-group::release' }));
      await settle();

      props = await getCapturedProps();
      expect(props.nodes.map((n) => n.id)).toContain('deploy-group::deploy');
      const member = props.nodes.find((n) => n.id === 'deploy-group::release');
      expect(member?.selected).toBe(true);
    });

    it('never expands a group whose membership could not be resolved', async () => {
      useAppStore.setState(RESET_STATE);
      setGroupWorkflow();
      render(<DagPane />);
      await settle();

      let props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'mystery-group' }));
      await settle();

      props = await getCapturedProps();
      // Still exactly the three top-level nodes -- selecting an unresolvable
      // group is a no-op for expansion, not a group that "expands into
      // nothing" (which would look identical to a real, empty, resolved
      // group -- the truthfulness distinction this issue's PR argues for).
      expect(props.nodes.map((n) => n.id)).toEqual([
        'build',
        'deploy-group',
        'mystery-group',
      ]);
      const mystery = props.nodes.find((n) => n.id === 'mystery-group');
      expect(mystery?.type).toBe('job');
    });

    it('selecting an ordinary job elsewhere collapses a previously-expanded group', async () => {
      useAppStore.setState(RESET_STATE);
      setGroupWorkflow();
      render(<DagPane />);
      await settle();

      let props = await getCapturedProps();
      act(() => props.onNodeClick(null, { id: 'deploy-group' }));
      await settle();
      props = await getCapturedProps();
      expect(props.nodes.map((n) => n.id)).toContain('deploy-group::deploy');

      act(() => props.onNodeClick(null, { id: 'build' }));
      await settle();
      props = await getCapturedProps();
      expect(props.nodes.map((n) => n.id)).toEqual([
        'build',
        'deploy-group',
        'mystery-group',
      ]);
    });
  });
});

describe('computeMinimapSize (issue #70)', () => {
  function makePositionedNode(
    x: number,
    y: number,
    width = 220,
    height = 56,
  ): PositionedNode {
    return {
      id: `${x}-${y}`,
      jobName: `${x}-${y}`,
      alias: `${x}-${y}`,
      kind: 'job',
      requires: [],
      isDefined: true,
      matrix: false,
      entryOptions: {
        context: [],
        preSteps: [],
        postSteps: [],
        parameters: {},
      },
      x,
      y,
      width,
      height,
    };
  }

  it('falls back to the minimum box for an empty graph', () => {
    expect(computeMinimapSize([])).toEqual({ width: 140, height: 90 });
  });

  it('gives a wide graph a wide box', () => {
    // Five nodes laid out in a single row (LR): much wider than tall.
    const nodes = [0, 1, 2, 3, 4].map((i) => makePositionedNode(i * 300, 0));
    const { width, height } = computeMinimapSize(nodes);
    expect(width).toBeGreaterThan(height);
  });

  it('gives a tall graph a tall box', () => {
    // Five nodes stacked in a single column (TB): much taller than wide.
    const nodes = [0, 1, 2, 3, 4].map((i) => makePositionedNode(0, i * 150));
    const { width, height } = computeMinimapSize(nodes);
    expect(height).toBeGreaterThan(width);
  });

  it('gives a roughly-square graph a roughly-square box', () => {
    // Zero-size nodes (rather than the usual 220x56) so the bounding box's
    // width and height come out exactly equal (500 each) and this isn't
    // accidentally sensitive to the real node dimensions used elsewhere.
    const nodes = [
      makePositionedNode(0, 0, 0, 0),
      makePositionedNode(500, 0, 0, 0),
      makePositionedNode(0, 500, 0, 0),
      makePositionedNode(500, 500, 0, 0),
    ];
    const { width, height } = computeMinimapSize(nodes);
    expect(Math.abs(width - height)).toBeLessThan(5);
  });

  it('never returns a dimension outside the documented floor/ceiling', () => {
    // A single node has zero graph width/height on its own axis of
    // variation -- exercises the `Math.max(1, ...)` floor that keeps the
    // aspect ratio from becoming NaN/Infinity.
    const { width, height } = computeMinimapSize([makePositionedNode(0, 0)]);
    expect(width).toBeGreaterThanOrEqual(140);
    expect(width).toBeLessThanOrEqual(280);
    expect(height).toBeGreaterThanOrEqual(90);
    expect(height).toBeLessThanOrEqual(200);
  });

  it('an extremely wide graph still respects the height floor', () => {
    const nodes = Array.from({ length: 50 }, (_, i) =>
      makePositionedNode(i * 300, 0),
    );
    const { height } = computeMinimapSize(nodes);
    expect(height).toBeGreaterThanOrEqual(90);
  });
});
