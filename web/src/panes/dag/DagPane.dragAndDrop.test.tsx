import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowGraph } from '~/lib/graph/buildGraph';
import type { LayoutResult } from '~/lib/graph/layout';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import { useAppStore } from '~/state/appStore';
import { useNodePositionStore } from '~/state/nodePositionStore';

/**
 * A slimmer stand-in for `@xyflow/react` than `DagPane.test.tsx`'s -- this
 * file only exercises drag-and-drop, not connections/selection/deletion --
 * but renders real node components through `nodeTypes` the same way, since
 * the whole point is exercising `JobNode`'s own drag handlers for real.
 */
vi.mock('@xyflow/react', () => ({
  // Only the enum value DagPane actually uses; importing the real module
  // would pull React Flow's DOM-dependent components into jsdom.
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: (props: {
    nodes: { id: string; type?: string; data: unknown; selected?: boolean }[];
    nodeTypes?: Record<
      string,
      ComponentType<{ id: string; data: unknown; selected?: boolean }>
    >;
    children?: ReactNode;
  }) => (
    <div data-testid="react-flow">
      {props.nodes.map((node) => {
        const Component = node.type ? props.nodeTypes?.[node.type] : undefined;
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
      {props.children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({ fitView: vi.fn<() => void>() }),
}));

vi.mock('~/lib/graph/layout', () => ({
  layoutGraph: vi.fn<
    (
      graph: WorkflowGraph,
      options?: { direction?: 'RIGHT' | 'DOWN' },
    ) => Promise<LayoutResult>
  >(async (graph: WorkflowGraph) => ({
    nodes: graph.nodes.map((node, index) => ({
      ...node,
      x: index * 160,
      y: 0,
      width: 140,
      height: 56,
    })),
    edges: graph.edges,
  })),
}));

import { DagPane } from './DagPane';

const RESET_STATE = {
  meta: null,
  configPath: '',
  doc: null,
  text: '',
  savedText: '',
  parseError: null,
  isDirty: false,
  status: 'ready' as const,
  error: null,
  autosave: false,
  selectedWorkflow: null,
  workflowSelected: false,
  dagDirection: 'RIGHT' as const,
  selectedNodeId: null,
  validation: { state: 'idle' as const, errors: [] },
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  editError: null,
};

const YAML = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - hold:
          type: approval
`;

function seed(): void {
  const { doc } = parseConfig(YAML);
  useAppStore.setState({ ...RESET_STATE, doc, text: YAML, savedText: YAML });
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

/**
 * A minimal fake `DataTransfer` good enough for these components: they read
 * `types`, call `getData`, and (issue #87) read/write `dropEffect` during
 * `dragover`. A plain mutable object, not a real `DataTransfer` -- so a
 * production handler's `event.dataTransfer.dropEffect = 'none'` mutates
 * this exact object, and the test below can read it straight back off the
 * same reference it passed to `fireEvent`.
 */
function fakeDataTransfer(mime: string, payload: unknown): DataTransfer {
  return {
    types: [mime],
    getData: (type: string) => (type === mime ? JSON.stringify(payload) : ''),
    setData: () => {},
    dropEffect: 'move',
  } as unknown as DataTransfer;
}

describe('DagPane drag-and-drop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seed();
  });

  afterEach(async () => {
    await act(async () => {
      useAppStore.setState(RESET_STATE);
      useNodePositionStore.setState({ positions: {} });
    });
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('dropping an orb job on the canvas adds the orbs: entry and a workflow job entry', async () => {
    render(<DagPane />);
    await settle();

    const canvas = screen.getByTestId('dag-canvas');
    const dataTransfer = fakeDataTransfer('application/x-vce-orb-job', {
      kind: 'job',
      orbRef: 'circleci/node@5.2.0',
      element: { name: 'test', kind: 'job', parameters: [] },
    });

    fireEvent.dragOver(canvas, { dataTransfer });
    fireEvent.drop(canvas, { dataTransfer });
    await settle();

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.0');
    const jobs = getIn(doc, ['workflows', 'main', 'jobs']) as unknown[];
    expect(jobs).toContain('node/test');
  });

  it("dropping an orb command on a defined job node appends it to that job's steps", async () => {
    render(<DagPane />);
    await settle();

    const jobNodeEl = screen
      .getByTestId('node-build')
      .querySelector('.vce-dag-node')!;
    const dataTransfer = fakeDataTransfer('application/x-vce-orb-command', {
      kind: 'command',
      orbRef: 'circleci/node@5.2.0',
      element: { name: 'install-packages', kind: 'command', parameters: [] },
    });

    fireEvent.dragOver(jobNodeEl, { dataTransfer });
    fireEvent.drop(jobNodeEl, { dataTransfer });
    await settle();

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'build', 'steps', 1])).toBe(
      'node/install-packages',
    );
  });

  it('dropping an orb executor on a defined job node sets its executor', async () => {
    render(<DagPane />);
    await settle();

    const jobNodeEl = screen
      .getByTestId('node-build')
      .querySelector('.vce-dag-node')!;
    const dataTransfer = fakeDataTransfer('application/x-vce-orb-executor', {
      kind: 'executor',
      orbRef: 'circleci/node@5.2.0',
      element: { name: 'default', kind: 'executor', parameters: [] },
    });

    fireEvent.dragOver(jobNodeEl, { dataTransfer });
    fireEvent.drop(jobNodeEl, { dataTransfer });
    await settle();

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'build', 'executor'])).toBe('node/default');
  });

  it('refuses to drop an orb command on an approval node, leaving the document untouched', async () => {
    render(<DagPane />);
    await settle();

    const textBefore = useAppStore.getState().text;
    const holdNodeEl = screen
      .getByTestId('node-hold')
      .querySelector('.vce-dag-node')!;
    const dataTransfer = fakeDataTransfer('application/x-vce-orb-command', {
      kind: 'command',
      orbRef: 'circleci/node@5.2.0',
      element: { name: 'install-packages', kind: 'command', parameters: [] },
    });

    fireEvent.dragOver(holdNodeEl, { dataTransfer });
    fireEvent.drop(holdNodeEl, { dataTransfer });
    await settle();

    expect(useAppStore.getState().text).toBe(textBefore);
    expect(screen.getByRole('alert')).toHaveTextContent(/approval/i);
  });

  // Issue #71: the object palette's own drag payloads.
  describe('palette executors and steps', () => {
    it('dropping a built-in executor on the canvas opens the configure dialog, and submitting creates the job + workflow entry in one mutation', async () => {
      render(<DagPane />);
      await settle();

      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer(
        'application/x-vce-palette-executor',
        {
          source: 'builtin',
          builtinId: 'docker',
        },
      );

      fireEvent.dragOver(canvas, { dataTransfer });
      fireEvent.drop(canvas, { dataTransfer });
      await settle();

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/docker/i);
      const jobNameInput = screen.getByLabelText(/job name/i);
      expect(jobNameInput).toHaveValue('new-job');

      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();

      const doc = useAppStore.getState().doc!;
      expect(getIn(doc, ['jobs', 'new-job', 'docker', 0, 'image'])).toBe(
        'cimg/base:current',
      );
      const jobs = getIn(doc, ['workflows', 'main', 'jobs']) as unknown[];
      expect(jobs).toContain('new-job');
    });

    it('creates the workflow too when dropping an executor on a config with no workflows: block', async () => {
      const { doc } = parseConfig('jobs:\n  build:\n    docker: []\n');
      useAppStore.setState({
        ...RESET_STATE,
        doc,
        text: 'jobs:\n  build:\n    docker: []\n',
        savedText: '',
      });
      render(<DagPane />);
      await settle();

      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer(
        'application/x-vce-palette-executor',
        {
          source: 'builtin',
          builtinId: 'machine',
        },
      );
      fireEvent.dragOver(canvas, { dataTransfer });
      fireEvent.drop(canvas, { dataTransfer });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: /create job/i }));
      await settle();

      const nextDoc = useAppStore.getState().doc!;
      // `ubuntu-2404`, not `ubuntu-2204` (issue #203): every `machine` example in
      // the vendored configuration reference uses `ubuntu-2404:current`, commented
      // "recommended linux image", and this card was a release behind.
      // `paletteExecutors.test.ts` is what pins the value against that snapshot;
      // this only checks that the card's default is what gets written.
      expect(getIn(nextDoc, ['jobs', 'new-job', 'machine', 'image'])).toBe(
        'ubuntu-2404:current',
      );
      const jobs = getIn(nextDoc, [
        'workflows',
        'build-and-test',
        'jobs',
      ]) as unknown[];
      expect(jobs).toContain('new-job');
    });

    it("dropping a palette step on a defined job node appends its default value to that job's steps", async () => {
      render(<DagPane />);
      await settle();

      const jobNodeEl = screen
        .getByTestId('node-build')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'store_artifacts',
      });

      fireEvent.dragOver(jobNodeEl, { dataTransfer });
      fireEvent.drop(jobNodeEl, { dataTransfer });
      await settle();

      const doc = useAppStore.getState().doc!;
      expect(
        getIn(doc, ['jobs', 'build', 'steps', 1, 'store_artifacts', 'path']),
      ).toBe('artifacts');
    });

    it('refuses to drop a palette step on an approval node, leaving the document untouched', async () => {
      render(<DagPane />);
      await settle();

      const textBefore = useAppStore.getState().text;
      const holdNodeEl = screen
        .getByTestId('node-hold')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'checkout',
      });

      fireEvent.dragOver(holdNodeEl, { dataTransfer });
      fireEvent.drop(holdNodeEl, { dataTransfer });
      await settle();

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/approval/i);
    });

    it('refuses to drop a palette executor onto an existing job node -- executors only ever create a new job', async () => {
      render(<DagPane />);
      await settle();

      const textBefore = useAppStore.getState().text;
      const jobNodeEl = screen
        .getByTestId('node-build')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer(
        'application/x-vce-palette-executor',
        {
          source: 'builtin',
          builtinId: 'macos',
        },
      );

      fireEvent.dragOver(jobNodeEl, { dataTransfer });
      fireEvent.drop(jobNodeEl, { dataTransfer });
      await settle();

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/canvas background/i);
    });

    it('refuses to drop a palette step on the canvas background -- it has nowhere to go without a job', async () => {
      render(<DagPane />);
      await settle();

      const textBefore = useAppStore.getState().text;
      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'checkout',
      });

      fireEvent.dragOver(canvas, { dataTransfer });
      fireEvent.drop(canvas, { dataTransfer });
      await settle();

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/job node/i);
    });
  });

  // Issue #87 part 1: the two refusal tests above still exercise the
  // *backstop* -- `fireEvent.drop` fires unconditionally in this harness,
  // bypassing the real browser's "only fire `drop` if some `dragover`
  // handler called `preventDefault()`" rule entirely. These tests exercise
  // the actual fix: `dragover` itself must not accept a drop that would
  // only be refused afterward. `fireEvent.dragOver` returns the raw
  // `dispatchEvent` result -- `false` means some handler called
  // `preventDefault()` (accepting the drop, and showing the browser's
  // "copy" cursor -- the green "+" the user likes on a genuinely valid
  // target); `true` means none did, which is what makes a real browser
  // refuse the drop outright and show its own "not-allowed" cursor instead.
  describe('invalid-drop prevention (issue #87)', () => {
    it('does not accept a palette step dragged over the canvas background', async () => {
      render(<DagPane />);
      await settle();

      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'checkout',
      });

      const notCanceled = fireEvent.dragOver(canvas, { dataTransfer });

      expect(notCanceled).toBe(true);
      expect(dataTransfer.dropEffect).toBe('none');
    });

    it('accepts a palette executor dragged over the canvas background (always a valid target)', async () => {
      render(<DagPane />);
      await settle();

      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer(
        'application/x-vce-palette-executor',
        {
          source: 'builtin',
          builtinId: 'docker',
        },
      );

      const canceled = fireEvent.dragOver(canvas, { dataTransfer });

      expect(canceled).toBe(false);
      expect(dataTransfer.dropEffect).toBe('copy');
    });

    it('does not accept a palette executor dragged over an existing job node (symmetric case: executors only ever create new jobs)', async () => {
      render(<DagPane />);
      await settle();

      const jobNodeEl = screen
        .getByTestId('node-build')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer(
        'application/x-vce-palette-executor',
        {
          source: 'builtin',
          builtinId: 'macos',
        },
      );

      const notCanceled = fireEvent.dragOver(jobNodeEl, { dataTransfer });

      expect(notCanceled).toBe(true);
      expect(dataTransfer.dropEffect).toBe('none');
    });

    it('accepts a palette step dragged over a defined job node (a genuinely valid target)', async () => {
      render(<DagPane />);
      await settle();

      const jobNodeEl = screen
        .getByTestId('node-build')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'checkout',
      });

      const canceled = fireEvent.dragOver(jobNodeEl, { dataTransfer });

      expect(canceled).toBe(false);
      expect(dataTransfer.dropEffect).toBe('copy');
    });

    it('does not accept a palette step dragged over an approval node (not a locally-defined job)', async () => {
      render(<DagPane />);
      await settle();

      const holdNodeEl = screen
        .getByTestId('node-hold')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer('application/x-vce-palette-step', {
        stepKey: 'checkout',
      });

      const notCanceled = fireEvent.dragOver(holdNodeEl, { dataTransfer });

      expect(notCanceled).toBe(true);
      expect(dataTransfer.dropEffect).toBe('none');
    });
  });

  // Issue #105: dragging a context onto a job node.
  describe('contexts', () => {
    const CONTEXT_MIME = 'application/x-vce-palette-context';

    it("dropping a context on a defined job node appends it to that workflow entry's context:", async () => {
      render(<DagPane />);
      await settle();

      const jobNodeEl = screen
        .getByTestId('node-build')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer(CONTEXT_MIME, {
        contextName: 'deploy-prod',
      });

      fireEvent.dragOver(jobNodeEl, { dataTransfer });
      expect(dataTransfer.dropEffect).toBe('copy');

      fireEvent.drop(jobNodeEl, { dataTransfer });
      await settle();

      const doc = useAppStore.getState().doc!;
      // The bare `- build` entry is promoted to map form, and the context
      // lands on the *entry*, not on the job definition.
      expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toEqual({
        build: { context: ['deploy-prod'] },
      });
      expect(getIn(doc, ['jobs', 'build', 'context'])).toBeUndefined();
    });

    it('dropping a second context appends rather than replacing', async () => {
      render(<DagPane />);
      await settle();

      const jobNodeEl = () =>
        screen.getByTestId('node-build').querySelector('.vce-dag-node')!;

      for (const contextName of ['first', 'second']) {
        const dataTransfer = fakeDataTransfer(CONTEXT_MIME, { contextName });
        fireEvent.dragOver(jobNodeEl(), { dataTransfer });
        fireEvent.drop(jobNodeEl(), { dataTransfer });
        await settle();
      }

      const doc = useAppStore.getState().doc!;
      expect(
        getIn(doc, ['workflows', 'main', 'jobs', 0, 'build', 'context']),
      ).toEqual(['first', 'second']);
    });

    // An approval entry runs nothing, so a context has nothing to supply --
    // and per issue #87 the refusal must be visible *before* release, not
    // only as an error banner after it.
    it('refuses a context on an approval node, showing it as invalid during dragover', async () => {
      render(<DagPane />);
      await settle();

      const textBefore = useAppStore.getState().text;
      const holdNodeEl = screen
        .getByTestId('node-hold')
        .querySelector('.vce-dag-node')!;
      const dataTransfer = fakeDataTransfer(CONTEXT_MIME, {
        contextName: 'deploy-prod',
      });

      fireEvent.dragOver(holdNodeEl, { dataTransfer });
      expect(dataTransfer.dropEffect).toBe('none');

      fireEvent.drop(holdNodeEl, { dataTransfer });
      await settle();

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(useAppStore.getState().editError).toMatch(/manual approval step/i);
    });

    it('refuses a context dropped on the canvas background', async () => {
      render(<DagPane />);
      await settle();

      const textBefore = useAppStore.getState().text;
      const canvas = screen.getByTestId('dag-canvas');
      const dataTransfer = fakeDataTransfer(CONTEXT_MIME, {
        contextName: 'deploy-prod',
      });

      fireEvent.dragOver(canvas, { dataTransfer });
      expect(dataTransfer.dropEffect).toBe('none');

      fireEvent.drop(canvas, { dataTransfer });
      await settle();

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(useAppStore.getState().editError).toMatch(/onto a job node/i);
    });
  });
});
