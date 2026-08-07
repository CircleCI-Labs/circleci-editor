import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWorkflowGraph, type GraphNode } from '~/lib/graph/buildGraph';
import { resourceClassesFetchStub } from '~/lib/resourceClasses/testFixtures';
import { __resetResourceClassesCacheForTests } from '~/lib/resourceClasses/useResourceClasses';
import { FIXTURE_RAW_SCHEMA } from '~/lib/schema/testFixtures';
import { __resetCircleciSchemaCacheForTests } from '~/lib/schema/useCircleciSchema';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import { useAppStore } from '~/state/appStore';
import { useConfirmStore } from '~/state/confirmStore';
import {
  readPersistedSectionChoices,
  useInspectorSectionStore,
} from '~/state/inspectorSectionStore';
import { useOrbStore } from '~/state/orbStore';
import type { Document } from 'yaml';

import { Inspector } from './Inspector';

/**
 * Every test in this file renders `Inspector`, which fetches
 * `/api/schema` once per app session (issue #48 -- see
 * `useCircleciSchema`'s own doc comment on why that fetch is cached at the
 * module level rather than per-render). Most tests here don't care what
 * that schema contains, so a file-wide default stub keeps them from making
 * a real network call; the cache reset keeps each test's `fetch` stub (this
 * default, or `stubSchemaFetch` below for the tests that need real
 * step-field data) actually effective instead of every test after the
 * first silently reusing whatever the very first test's fetch returned.
 */
/**
 * A `fetch` stub that builds a fresh `Response` for every call.
 *
 * `mockResolvedValue(new Response(...))` hands the *same* response object to
 * every caller, and a `Response` body can only be read once -- so the second
 * request in a render silently got an unusable body. That was invisible while
 * `Inspector` made one request per test; it stopped being invisible when the
 * `context:` field started reading the shared project-context store (issue
 * #152), which is a second request in the same render. Per-call responses are
 * what a real host does anyway.
 */
/** Gives one element the box a browser would have measured for it. */
function giveBox(element: HTMLElement, top: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 200,
      width: 200,
    }) as DOMRect;
}

/** The `[data-testid="step-drop-region"]` of the section titled `title`. */
function stepDropRegion(title = 'Steps'): HTMLElement {
  // `name` matches the whole accessible name, so this is "Steps" and never
  // "Pre-steps"/"Post-steps" (issue #37 renders three of these sections).
  const section = screen
    .getByRole('heading', { name: title })
    .closest('section')!;
  return within(section).getByTestId('step-drop-region');
}

/**
 * jsdom has no layout, so every `getBoundingClientRect()` is zeroes -- which
 * makes issue #249's insertion-gap rule (`stepDropFrame.ts`) untestable without
 * giving the list a box. Stubs the drop region at viewport y=0 with each of its
 * top-level rows `rowHeight` tall, stacked from its top edge, so a `clientY` in
 * a test means what it would mean in a browser.
 *
 * With the default 20px rows, three steps have midpoints at 10/30/50: `clientY`
 * 5 is above every row (gap 0), 15 is past the first (gap 1), 45 is past the
 * second (gap 2), and anything from 50 down -- including the Add form well below
 * the list -- is the last gap.
 *
 * Call it *after* `render`, and again after any change to the number of rows.
 */
function stubStepListGeometry(region: HTMLElement, rowHeight = 20): void {
  giveBox(region, 0, 2000);
  region
    .querySelectorAll<HTMLElement>('[data-step-row]')
    .forEach((row, index) => giveBox(row, index * rowHeight, rowHeight));
}

/**
 * Fires a drag event on the step list's drop region that actually carries a
 * pointer coordinate.
 *
 * `fireEvent.dragOver(el, { clientY })` silently does not: testing-library maps
 * the drag events onto jsdom's `DragEvent`, whose constructor drops the
 * `MouseEventInit` half, so `event.clientY` arrives as `undefined`. That is
 * quietly dangerous for the gap rule under test, because `gapForPointer`
 * deliberately answers `0` for an unmeasurable coordinate -- so a test asserting
 * the top-of-list outcome would pass without ever exercising the comparison.
 * Verified directly: a bare `<div onDrop={(e) => { seen = e.clientY; }} />` sees
 * `undefined` after `fireEvent.drop(el, { clientY: 118 })`.
 *
 * So the event is constructed and patched explicitly instead.
 */
function fireDragAt(
  kind: 'dragOver' | 'drop',
  element: HTMLElement,
  init: { dataTransfer: DataTransfer; clientY: number },
): Event {
  const event = createEvent[kind](element, { dataTransfer: init.dataTransfer });
  Object.defineProperty(event, 'clientY', { value: init.clientY });
  fireEvent(element, event);
  return event;
}

/**
 * `dragleave` carrying a `relatedTarget` -- "the new target element", which is
 * how the region tells "the drag left" from "the pointer crossed between two
 * things inside it". Patched explicitly for the same reason `fireDragAt` patches
 * `clientY`: jsdom's `DragEvent` drops the `MouseEventInit` half wholesale, and
 * `relatedTarget` lives in it.
 */
function fireDragLeave(
  element: HTMLElement,
  relatedTarget: EventTarget | null,
): void {
  const event = createEvent.dragLeave(element);
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  fireEvent(element, event);
}

function jsonFetchStub(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function stubEmptySchemaFetch() {
  vi.stubGlobal('fetch', jsonFetchStub({}));
}

/** Stubs `/api/schema` with the shared schema fixture (`FIXTURE_RAW_SCHEMA`) -- used by tests that exercise the schema-driven per-step-type field editors (issue #48). Must be followed by flushing the resulting effect, e.g. `await act(async () => { await vi.advanceTimersByTimeAsync(0); })`. */
function stubSchemaFetch() {
  __resetCircleciSchemaCacheForTests();
  vi.stubGlobal('fetch', jsonFetchStub(FIXTURE_RAW_SCHEMA));
}

/**
 * Stubs `/api/resource-classes` with the shared fixture, and everything else
 * with `fallback` -- the resource-class field (issue #181) is the second request
 * this pane makes in a render, so the URL-agnostic stubs above would answer it
 * with schema JSON. Must be followed by flushing the effect, e.g.
 * `await act(async () => { await vi.advanceTimersByTimeAsync(0); })`.
 */
function stubResourceClassesFetch(fallback: unknown = {}) {
  __resetResourceClassesCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(resourceClassesFetchStub(fallback)),
  );
}

/** Flushes `useResourceClasses`' fetch effect, so the resource-class options exist. */
async function flushResourceClasses() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  __resetCircleciSchemaCacheForTests();
  __resetResourceClassesCacheForTests();
  stubEmptySchemaFetch();
});

/** Parses `yamlText`, seeds the real store with it, and resolves one graph node from `workflowName`. */
function setup(
  yamlText: string,
  nodeId: string,
  workflowName = 'main',
): { doc: Document; node: GraphNode } {
  const { doc, error } = parseConfig(yamlText);
  if (error || !doc) throw new Error(`fixture failed to parse: ${error}`);
  useAppStore.setState({
    doc,
    text: yamlText,
    savedText: yamlText,
    parseError: null,
    editError: null,
  });
  const graph = buildWorkflowGraph(doc, workflowName);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`no node "${nodeId}" in fixture`);
  return { doc, node };
}

/** Re-derives `{ doc, node }` from the store's current text after a mutation, for a test that wants to `rerender` and see the *result* of an edit rather than just checking the raw text. */
function fromStore(
  nodeId: string,
  workflowName = 'main',
): { doc: Document; node: GraphNode } {
  const { doc } = useAppStore.getState();
  if (!doc) throw new Error('store has no doc');
  const graph = buildWorkflowGraph(doc, workflowName);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`no node "${nodeId}" in store`);
  return { doc, node };
}

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
  selectedNodeId: null,
  workflowSelected: false,
  dagDirection: 'RIGHT' as const,
  validation: { state: 'idle' as const, errors: [] },
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  editError: null,
};

const SIMPLE_JOB_YAML = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    resource_class: medium
    steps:
      - checkout
      - run:
          name: Build
          command: make build
  test:
    docker:
      - image: cimg/base:current
workflows:
  main:
    jobs:
      - build
      - test:
          requires:
            - build
`;

describe('Inspector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a placeholder when nothing is selected', () => {
    render(
      <Inspector
        doc={null}
        workflowName={undefined}
        node={null}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    expect(screen.getByText(/select a job in the graph/i)).toBeInTheDocument();
  });

  it('renders the selected job’s name, executor, steps, and requires', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'test');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByLabelText(/^job name$/i)).toHaveValue('test');
    expect(screen.getByLabelText(/docker image/i)).toHaveValue(
      'cimg/base:current',
    );
    expect(
      screen.getByRole('button', { name: /remove requirement on build/i }),
    ).toBeInTheDocument();
  });

  it('renders an existing job’s steps and resource class', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByLabelText(/resource class/i)).toHaveValue('medium');
    expect(screen.getByTitle('checkout')).toBeInTheDocument();
    expect(screen.getByTitle('Build')).toBeInTheDocument();
  });

  it('editing the image field commits setExecutorImage on blur, not on every keystroke', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const imageInput = screen.getByLabelText(/docker image/i);
    fireEvent.change(imageInput, { target: { value: 'cimg/node:20.1' } });
    // Not committed yet -- only on blur.
    expect(useAppStore.getState().text).toContain('cimg/base:current');

    fireEvent.blur(imageInput);
    expect(useAppStore.getState().text).toContain('cimg/node:20.1');
  });

  it('blocks a rename that collides with an existing job name, and leaves the doc unchanged', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const nameInput = screen.getByLabelText(/^job name$/i);
    fireEvent.change(nameInput, { target: { value: 'test' } });
    fireEvent.blur(nameInput);

    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    // A rejected rename must leave the document byte-for-byte unchanged.
    expect(useAppStore.getState().text).toBe(SIMPLE_JOB_YAML);
  });

  it('blocks a rename to an empty name', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const nameInput = screen.getByLabelText(/^job name$/i);
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);

    expect(screen.getByText(/cannot be empty/i)).toBeInTheDocument();
  });

  it('successfully renaming a job calls renameJob and updates the config text', () => {
    const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const nameInput = screen.getByLabelText(/^job name$/i);
    fireEvent.change(nameInput, { target: { value: 'compile' } });
    fireEvent.blur(nameInput);

    // Issue #12: `build` is referenced by the workflow, so the rename prompts
    // with the concrete list of sites first. Confirming performs it.
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(useAppStore.getState().text).toContain('compile:');
    expect(useAppStore.getState().text).not.toMatch(/^\s*build:/m);
  });

  it('shows a read-only summary (not a form) for an orb-provided job', async () => {
    // The orb-job parameter editor (issue #37) fetches the orb's source on
    // mount -- stub `fetch` so that happens deterministically instead of
    // hitting a real network call from jsdom, and await its settling so the
    // effect's eventual `setState` doesn't warn about running outside `act`.
    vi.stubGlobal(
      'fetch',
      jsonFetchStub({ available: false, reason: 'no token in tests' }),
    );
    const { doc, node } = setup(
      `
orbs:
  node: circleci/node@5
workflows:
  main:
    jobs:
      - node/test
`,
      'node/test',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    // Issue #252 rewrote this note. It still has to say the definition lives in
    // the orb -- that is the explanation for the missing Steps section -- but it
    // must no longer *lead* with it: the owner read the old opening clause,
    // concluded there was nothing here to edit, and nearly stopped. So the
    // assertion is on the order, not just the presence, of the two halves.
    const note = screen.getByText(/steps and executor live inside the "node"/i);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/^Set this job's parameters below/);
    expect(note.textContent).toMatch(/why no steps are listed/i);
    expect(note.textContent!.indexOf("Set this job's parameters")).toBeLessThan(
      note.textContent!.indexOf('cannot change'),
    );

    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/docker image/i)).not.toBeInTheDocument();

    // Flush the orb-fetch promise under fake timers (see `beforeEach`)
    // rather than `findByText`, whose internal polling assumes real timers --
    // wrapped in `act` since it resolves a `setState` from that effect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/no token in tests/i)).toBeInTheDocument();
  });

  it('shows a read-only summary (not a form) for an approval node', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
      - hold:
          type: approval
          requires:
            - build
`,
      'hold',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByText(/manual approval step/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it('surfaces editError prominently and dismisses it via clearEditError', () => {
    useAppStore.setState({
      editError: 'Making "test" require "build" would create a cycle',
    });
    render(
      <Inspector
        doc={null}
        workflowName={undefined}
        node={null}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      /would create a cycle/i,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(useAppStore.getState().editError).toBeNull();
  });

  describe('orb command drop target', () => {
    const COMMAND_PAYLOAD = {
      kind: 'command' as const,
      orbRef: 'circleci/node@5.2.0',
      element: {
        name: 'install-packages',
        kind: 'command' as const,
        parameters: [],
      },
    };

    function fakeDataTransfer(): DataTransfer {
      return {
        types: ['application/x-vce-orb-command'],
        getData: (type: string) =>
          type === 'application/x-vce-orb-command'
            ? JSON.stringify(COMMAND_PAYLOAD)
            : '',
        setData: () => {},
      } as unknown as DataTransfer;
    }

    it('dropping above the first step inserts the command at index 0', () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      const onDropOrbCommand =
        vi.fn<(jobName: string, index: number, payload: unknown) => void>();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropOrbCommand={onDropOrbCommand}
        />,
      );

      const region = stepDropRegion();
      stubStepListGeometry(region);
      const dataTransfer = fakeDataTransfer();
      fireDragAt('dragOver', region, { dataTransfer, clientY: 4 });
      fireDragAt('drop', region, { dataTransfer, clientY: 4 });

      expect(onDropOrbCommand).toHaveBeenCalledWith(
        'build',
        0,
        COMMAND_PAYLOAD,
      );
    });

    it('dropping over the "add a run step" box appends the command as the last step', () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      const onDropOrbCommand =
        vi.fn<(jobName: string, index: number, payload: unknown) => void>();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropOrbCommand={onDropOrbCommand}
        />,
      );

      // Issue #249: the Add form has no drop handler of its own any more -- it
      // sits inside the section's one drop region, and a pointer below every row
      // is the last gap by the same rule that names every other gap. "Add a run
      // step" also appears under Pre-steps/Post-steps (issue #37), so this is
      // scoped to the job body's own "Steps" section.
      const region = stepDropRegion();
      stubStepListGeometry(region);
      const appendZone = within(region)
        .getByText(/add a run step/i)
        .closest('div')!;
      const dataTransfer = fakeDataTransfer();
      fireDragAt('dragOver', appendZone, { dataTransfer, clientY: 400 });
      fireDragAt('drop', appendZone, { dataTransfer, clientY: 400 });

      expect(onDropOrbCommand).toHaveBeenCalledWith(
        'build',
        2,
        COMMAND_PAYLOAD,
      );
    });
  });

  /**
   * Issue #21: pre-steps/post-steps are rendered by the same `StepsSection`
   * as a job's own body, so reorder-by-drag and the "Add a run step" form
   * already worked there -- what was missing was landing a *new* command or
   * palette step, because `Inspector` never threaded a drop handler down to
   * those two sections at all (see the module doc this closes). These mirror
   * the "orb command drop target" describe above and
   * "dropping onto an empty steps list" below, just addressed at
   * `workflowName`+`nodeId`+`key` instead of `jobName`.
   */
  describe('pre-steps/post-steps drop targets (issue #21)', () => {
    const COMMAND_PAYLOAD = {
      kind: 'command' as const,
      orbRef: 'circleci/node@5.2.0',
      element: {
        name: 'install-packages',
        kind: 'command' as const,
        parameters: [],
      },
    };

    function orbCommandTransfer(): DataTransfer {
      return {
        types: ['application/x-vce-orb-command'],
        getData: (type: string) =>
          type === 'application/x-vce-orb-command'
            ? JSON.stringify(COMMAND_PAYLOAD)
            : '',
        setData: () => {},
      } as unknown as DataTransfer;
    }

    function paletteStepTransfer(stepKey: string): DataTransfer {
      return {
        types: ['application/x-vce-palette-step'],
        getData: (type: string) =>
          type === 'application/x-vce-palette-step'
            ? JSON.stringify({ stepKey })
            : '',
        setData: () => {},
      } as unknown as DataTransfer;
    }

    it('dropping an orb command onto an empty Pre-steps list calls onDropOrbCommandOnEntrySteps with the workflow entry, not a jobName', () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      const onDropOrbCommandOnEntrySteps =
        vi.fn<
          (
            workflowName: string,
            nodeId: string,
            key: string,
            index: number,
            payload: unknown,
          ) => void
        >();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropOrbCommandOnEntrySteps={onDropOrbCommandOnEntrySteps}
        />,
      );

      const region = stepDropRegion('Pre-steps');
      const emptyState = within(region).getByText(/no pre-steps yet/i);
      const dataTransfer = orbCommandTransfer();
      fireDragAt('dragOver', emptyState, { dataTransfer, clientY: 0 });
      fireDragAt('drop', emptyState, { dataTransfer, clientY: 0 });

      expect(onDropOrbCommandOnEntrySteps).toHaveBeenCalledWith(
        'main',
        'build',
        'pre-steps',
        0,
        COMMAND_PAYLOAD,
      );
    });

    it('dropping a palette step onto an empty Post-steps list calls onDropPaletteStepOnEntrySteps with "post-steps"', () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      const onDropPaletteStepOnEntrySteps =
        vi.fn<
          (
            workflowName: string,
            nodeId: string,
            key: string,
            index: number,
            stepKey: string,
          ) => void
        >();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropPaletteStepOnEntrySteps={onDropPaletteStepOnEntrySteps}
        />,
      );

      const region = stepDropRegion('Post-steps');
      const emptyState = within(region).getByText(/no post-steps yet/i);
      const dataTransfer = paletteStepTransfer('checkout');
      fireDragAt('dragOver', emptyState, { dataTransfer, clientY: 0 });
      fireDragAt('drop', emptyState, { dataTransfer, clientY: 0 });

      expect(onDropPaletteStepOnEntrySteps).toHaveBeenCalledWith(
        'main',
        'build',
        'post-steps',
        0,
        'checkout',
      );
    });

    it('without the entry-steps handlers, Pre-steps/Post-steps refuse the drop exactly like before -- no crash, no silent no-drop-cursor regression', () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      const region = stepDropRegion('Pre-steps');
      const emptyState = within(region).getByText(/no pre-steps yet/i);
      const dataTransfer = orbCommandTransfer();
      const dragOverEvent = fireDragAt('dragOver', emptyState, {
        dataTransfer,
        clientY: 0,
      });
      expect(dragOverEvent.defaultPrevented).toBe(false);
      expect(dataTransfer.dropEffect).toBe('none');
    });

    it("dropping onto Steps still only calls the job-body handler, never the entry-steps one (the two drop targets don't cross-fire)", () => {
      const { doc, node } = setup(SIMPLE_JOB_YAML, 'build');
      const onDropOrbCommand =
        vi.fn<(jobName: string, index: number, payload: unknown) => void>();
      const onDropOrbCommandOnEntrySteps =
        vi.fn<
          (
            workflowName: string,
            nodeId: string,
            key: string,
            index: number,
            payload: unknown,
          ) => void
        >();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropOrbCommand={onDropOrbCommand}
          onDropOrbCommandOnEntrySteps={onDropOrbCommandOnEntrySteps}
        />,
      );

      const region = stepDropRegion('Steps');
      stubStepListGeometry(region);
      const dataTransfer = orbCommandTransfer();
      fireDragAt('dragOver', region, { dataTransfer, clientY: 4 });
      fireDragAt('drop', region, { dataTransfer, clientY: 4 });

      expect(onDropOrbCommand).toHaveBeenCalledWith(
        'build',
        0,
        COMMAND_PAYLOAD,
      );
      expect(onDropOrbCommandOnEntrySteps).not.toHaveBeenCalled();
    });
  });

  describe('step kinds (issue #28)', () => {
    const REAL_WORLD_YAML = `
jobs:
  lint-backend:
    docker:
      - image: cimg/python:3.11.13
    steps:
      - checkout
      - python/install-packages:
          pkg-manager: pip
          pip-dependency-file: requirements-dev.txt
          app-dir: backend
          pypi-cache: true
          cache-version: v2
      - run:
          name: Run flake8 linting
          command: flake8 src tests
      - store_artifacts:
          path: trivy-report.json
          destination: trivy-scan-results
      - persist_to_workspace:
          root: .
          paths:
            - backend-image.tar
      - attach_workspace:
          at: .
      - when:
          condition: << pipeline.parameters.run-security-scans >>
          steps:
            - run:
                name: Nested run
                command: echo nested
            - trivy/scan:
                scan-type: 'fs'
workflows:
  main:
    jobs:
      - lint-backend
`;

    it('distinguishes checkout, run, orb command, other built-ins, and a when group', () => {
      const { doc, node } = setup(REAL_WORLD_YAML, 'lint-backend');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      expect(screen.getByTitle('checkout')).toBeInTheDocument();
      // The orb step renders as alias + command, not the raw "python/install-packages" blob.
      expect(screen.getByTitle('install-packages')).toBeInTheDocument();
      expect(screen.getByText('python')).toBeInTheDocument();
      expect(screen.getByTitle('Run flake8 linting')).toBeInTheDocument();
      expect(screen.getByText('store_artifacts')).toBeInTheDocument();
      expect(screen.getByTitle('trivy-report.json')).toBeInTheDocument();
      expect(screen.getByText('persist_to_workspace')).toBeInTheDocument();
      expect(screen.getByText('attach_workspace')).toBeInTheDocument();
      // The `when:` step shows its condition, not an opaque blob.
      expect(screen.getByTitle(/run-security-scans/)).toBeInTheDocument();
    });

    it('expanding a when group reveals its nested steps instead of hiding them in a blob', () => {
      const { doc, node } = setup(REAL_WORLD_YAML, 'lint-backend');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      // Nested steps aren't rendered until the group is expanded.
      expect(screen.queryByTitle('Nested run')).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: /expand.*run-security-scans/i }),
      );

      expect(screen.getByTitle('Nested run')).toBeInTheDocument();
      expect(screen.getByTitle('scan')).toBeInTheDocument();
      expect(screen.getByText('trivy')).toBeInTheDocument();
    });

    it('a step with a very long orb command name does not push its controls out of the row (regression for issue #28)', () => {
      const { doc, node } = setup(
        `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - some-very-long-orb-namespace-alias/an-extremely-long-command-name-that-used-to-push-controls-off-screen:
          some-param: some-value
workflows:
  main:
    jobs:
      - build
`,
        'build',
      );
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      const label = screen.getByTitle(
        'an-extremely-long-command-name-that-used-to-push-controls-off-screen',
      );
      expect(label.className).toContain('truncate');
      expect(label.className).toContain('min-w-0');

      const badge = screen.getByText('some-very-long-orb-namespace-alias');
      expect(badge.className).toContain('truncate');

      // The reorder/remove controls for that same row must still be present and
      // reachable, not shoved off past the panel's edge.
      const row = label.closest('li')!;
      const up = within(row).getByRole('button', { name: /move step 2 up/i });
      const down = within(row).getByRole('button', {
        name: /move step 2 down/i,
      });
      const remove = within(row).getByRole('button', {
        name: /remove step 2/i,
      });
      for (const button of [up, down, remove]) {
        expect(button.className).toContain('shrink-0');
      }
    });
  });

  describe('orb step parameters (issue #28)', () => {
    const YAML_WITH_PARAMS = `
jobs:
  lint-backend:
    docker:
      - image: cimg/python:3.11.13
    steps:
      - python/install-packages:
          pkg-manager: pip
          pip-dependency-file: requirements-dev.txt
          pypi-cache: true
workflows:
  main:
    jobs:
      - lint-backend
`;

    it("lists an orb command's parameters collapsed by default, then shows them on expand", () => {
      const { doc, node } = setup(YAML_WITH_PARAMS, 'lint-backend');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      expect(screen.queryByLabelText('pkg-manager')).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: /expand install-packages/i }),
      );

      expect(screen.getByLabelText('pkg-manager')).toHaveValue('pip');
      expect(screen.getByLabelText('pip-dependency-file')).toHaveValue(
        'requirements-dev.txt',
      );
      const pypiCache = screen.getByRole('checkbox');
      expect(pypiCache).toBeChecked();
    });

    it('editing a string parameter commits through setJobField on blur', () => {
      const { doc, node } = setup(YAML_WITH_PARAMS, 'lint-backend');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: /expand install-packages/i }),
      );

      const pkgManager = screen.getByLabelText('pkg-manager');
      fireEvent.change(pkgManager, { target: { value: 'poetry' } });
      expect(useAppStore.getState().text).toContain('pkg-manager: pip');

      fireEvent.blur(pkgManager);
      expect(useAppStore.getState().text).toContain('pkg-manager: poetry');
    });

    it('toggling a boolean parameter commits immediately', () => {
      const { doc, node } = setup(YAML_WITH_PARAMS, 'lint-backend');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: /expand install-packages/i }),
      );

      fireEvent.click(screen.getByRole('checkbox'));
      expect(useAppStore.getState().text).toContain('pypi-cache: false');
    });
  });

  describe('drag to reorder steps (issue #31)', () => {
    const THREE_RUN_STEPS_YAML = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - run:
          name: A
          command: echo a
      - run:
          name: B
          command: echo b
      - run:
          name: C
          command: echo c
workflows:
  main:
    jobs:
      - build
`;

    /** A palette step card mid-drag -- the payload `paletteSteps.ts` writes. */
    function paletteStepTransfer(stepKey: string): DataTransfer {
      return {
        types: ['application/x-vce-palette-step'],
        effectAllowed: 'copy',
        dropEffect: 'copy',
        getData: (type: string) =>
          type === 'application/x-vce-palette-step'
            ? JSON.stringify({ stepKey })
            : '',
        setData: () => {},
      } as unknown as DataTransfer;
    }

    function fakeDragTransfer(): DataTransfer {
      const store = new Map<string, string>();
      return {
        types: [] as string[],
        effectAllowed: 'uninitialized',
        dropEffect: 'none',
        getData: (type: string) => store.get(type) ?? '',
        setData: (type: string, value: string) => {
          store.set(type, value);
        },
      } as unknown as DataTransfer;
    }

    /** Renders `THREE_RUN_STEPS_YAML`'s `build` job with its step list measured -- see `stubStepListGeometry` for the coordinate system. */
    function renderThreeSteps(): HTMLElement {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );
      const region = stepDropRegion();
      stubStepListGeometry(region);
      return region;
    }

    /** The `<ul>`'s children in order, as either a step's label or the drop gap. */
    function listShape(region: HTMLElement): string[] {
      const list = region.querySelector('ul')!;
      return Array.from(list.children).map((child) =>
        child.getAttribute('data-testid') === 'step-drop-slot'
          ? '[gap]'
          : (child.querySelector('[title]')?.getAttribute('title') ?? '?'),
      );
    }

    /**
     * Issue #218 part 3. Before this, both halves of a row were one drop
     * target meaning "index of this row", and the two things that could be
     * dropped on it disagreed about what that index meant: a *new* step
     * (palette card, orb command) was inserted **before** the row -- which is
     * what the row's own `title` promised -- while a *reordered* step landed
     * **after** it, because `move(from, to)` splices the item out first and
     * every index after its old position has therefore already shifted down
     * by one. So dragging step A onto step C put A after C while the identical
     * gesture with a palette card put it before C, and nothing on screen
     * distinguished the two.
     *
     * These two tests pin both directions of the fixed rule: the gap is chosen
     * by which side of a row's midpoint the pointer is on, and it means the same
     * thing for a reorder as the gap that opened there.
     */
    it('dropping above a row moves the step into the gap above that row', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const dataTransfer = fakeDragTransfer();

      fireEvent.dragStart(rowA, { dataTransfer });
      // Row C spans 40..60, so 45 is past B's midpoint and short of C's: gap 2.
      fireDragAt('dragOver', region, { dataTransfer, clientY: 45 });
      fireDragAt('drop', region, { dataTransfer, clientY: 45 });

      const text = useAppStore.getState().text;
      // A landed in the gap *above* C: B, A, C.
      expect(text.indexOf('name: B')).toBeLessThan(text.indexOf('name: A'));
      expect(text.indexOf('name: A')).toBeLessThan(text.indexOf('name: C'));
    });

    it('dropping below the last row moves the step to the very end', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const dataTransfer = fakeDragTransfer();

      fireEvent.dragStart(rowA, { dataTransfer });
      fireDragAt('dragOver', region, { dataTransfer, clientY: 58 });
      fireDragAt('drop', region, { dataTransfer, clientY: 58 });

      const text = useAppStore.getState().text;
      // A landed in the gap *below* C -- the position a row-indexed drop
      // target had no way to name at all: B, C, A.
      expect(text.indexOf('name: B')).toBeLessThan(text.indexOf('name: C'));
      expect(text.indexOf('name: C')).toBeLessThan(text.indexOf('name: A'));
    });

    /**
     * Issue #249 part 1. The owner's verdict on #218's insertion line: *"I click
     * and drag, and yes I see a little plus button indicating I can drop there,
     * but it doesn't really show me where I'm actually putting it in the list"* --
     * so the affordance is now a real `<li>` between the rows, which displaces
     * everything below it.
     *
     * `listShape` reads the `<ul>`'s children in order, which is the assertion
     * that actually matters: it proves the gap is *in the flow between two
     * specific rows*, not merely present somewhere. #218's line was deliberately
     * out of flow (`absolute`) and would fail this.
     */
    it('opens a gap between the two rows the drop will land between', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const dataTransfer = fakeDragTransfer();

      expect(listShape(region)).toEqual(['A', 'B', 'C']);

      fireEvent.dragStart(rowA, { dataTransfer });
      fireDragAt('dragOver', region, { dataTransfer, clientY: 15 });

      expect(listShape(region)).toEqual(['A', '[gap]', 'B', 'C']);
      expect(screen.getAllByTestId('step-drop-slot')).toHaveLength(1);

      fireEvent.dragEnd(rowA);
      expect(listShape(region)).toEqual(['A', 'B', 'C']);
    });

    it('opens the gap before the first row and after the last one', () => {
      const region = renderThreeSteps();
      const rowB = screen.getByTitle('B').closest('li')!;
      const dataTransfer = fakeDragTransfer();
      fireEvent.dragStart(rowB, { dataTransfer });

      // Above every midpoint.
      fireDragAt('dragOver', region, { dataTransfer, clientY: 2 });
      expect(listShape(region)).toEqual(['[gap]', 'A', 'B', 'C']);

      // Below every midpoint -- and below the whole list, over the Add form,
      // which is the same gap and must not disagree with it.
      fireDragAt('dragOver', region, { dataTransfer, clientY: 400 });
      expect(listShape(region)).toEqual(['A', 'B', 'C', '[gap]']);
    });

    /**
     * #249's own acceptance criterion for the reflow: *"a gap that flickers
     * between two indices while the cursor sits still is worse than a static
     * line."*
     *
     * The mechanism is in `stepDropFrame.ts` -- the row midpoints are measured
     * once, before any gap exists, and frozen for the drag, so the gap is a pure
     * function of the pointer and the displacement it causes is not an input.
     * This is that property end-to-end through the component: the browser fires
     * `dragover` continuously while a held pointer sits still, and the geometry
     * is re-stubbed *as displaced* in between to prove the frozen frame is
     * really what is being read. Under a live measurement, the row that moved
     * out from under the pointer would flip the answer.
     */
    it('holds the same gap while the pointer sits still, even as the reflow displaces the rows', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const dataTransfer = fakeDragTransfer();
      fireEvent.dragStart(rowA, { dataTransfer });

      const shapes = new Set<string>();
      for (let tick = 0; tick < 12; tick += 1) {
        fireDragAt('dragOver', region, { dataTransfer, clientY: 35 });
        // Everything below the open gap really has moved down by a row.
        region
          .querySelectorAll<HTMLElement>('[data-step-row]')
          .forEach((row, index) => giveBox(row, index * 20 + 20, 20));
        shapes.add(listShape(region).join(','));
      }

      expect([...shapes]).toEqual(['A,B,[gap],C']);
    });

    /**
     * The gap is a commitment, not a hint: the rows have already moved to show
     * the outcome, so a `drop` uses the gap that was on screen rather than
     * re-deriving one from the release coordinate. #218 chose the opposite for
     * its 2px line, on the grounds that the pointer is ground truth -- correct
     * for a hint, wrong for a commitment. See `onRegionDrop`.
     */
    it('lands the step in the gap that was on screen, not wherever the release lands', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const dataTransfer = fakeDragTransfer();

      fireEvent.dragStart(rowA, { dataTransfer });
      fireDragAt('dragOver', region, { dataTransfer, clientY: 45 });
      expect(listShape(region)).toEqual(['A', 'B', '[gap]', 'C']);
      // Release reported well below the list. The shown gap wins.
      fireDragAt('drop', region, { dataTransfer, clientY: 400 });

      const text = useAppStore.getState().text;
      expect(text.indexOf('name: B')).toBeLessThan(text.indexOf('name: A'));
      expect(text.indexOf('name: A')).toBeLessThan(text.indexOf('name: C'));
    });

    it('keeps the gap open while the pointer crosses between rows inside the list', () => {
      const region = renderThreeSteps();
      const rowA = screen.getByTitle('A').closest('li')!;
      const rowB = screen.getByTitle('B').closest('li')!;
      const dataTransfer = fakeDragTransfer();

      fireEvent.dragStart(rowA, { dataTransfer });
      fireDragAt('dragOver', region, { dataTransfer, clientY: 45 });
      expect(listShape(region)).toEqual(['A', 'B', '[gap]', 'C']);

      // `dragleave` bubbles, so leaving one row for another fires it on the
      // region too -- and clearing on that is what made #218's line blink out on
      // every boundary crossing. The gap survives, because the drag has not left
      // the region: `relatedTarget` is still inside it.
      fireDragLeave(rowB, rowA);
      expect(listShape(region)).toEqual(['A', 'B', '[gap]', 'C']);

      // Leaving the region for good does close it.
      fireDragLeave(region, document.body);
      expect(listShape(region)).toEqual(['A', 'B', 'C']);
    });

    it('dropping onto an empty steps list inserts at the top', () => {
      const { doc, node } = setup(
        `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps: []
workflows:
  main:
    jobs:
      - build
`,
        'build',
      );
      const onDropPaletteStep =
        vi.fn<(jobName: string, index: number, stepKey: string) => void>();
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
          onDropPaletteStep={onDropPaletteStep}
        />,
      );

      // The empty state itself is the drop target, not only the Add form
      // below it (issue #218: "Dropping into an empty step list ... needs to
      // work"). Before this it was inert, silently.
      const region = stepDropRegion();
      stubStepListGeometry(region);
      const emptyState = screen.getByText('No steps yet.');
      const dataTransfer = paletteStepTransfer('checkout');
      fireEvent.dragOver(emptyState, { dataTransfer });

      // #249: an empty list has no rows to displace, so the empty state *is* the
      // gap -- "unambiguous ... into an empty list" -- and it carries the slot's
      // own test id, so one query covers all three boundary cases.
      expect(screen.getByTestId('step-drop-slot')).toBe(emptyState);

      fireEvent.drop(emptyState, { dataTransfer });
      expect(onDropPaletteStep).toHaveBeenCalledWith('build', 0, 'checkout');
    });

    it('refuses a drag it cannot represent before release, with a no-drop cursor and no gap', () => {
      const region = renderThreeSteps();

      // An orb *executor* is a real drag source in this app with no meaning
      // in a steps list. #87's rule is that such a drop is refused before
      // release rather than accepted and then errored: no `preventDefault`
      // (which is what accepting is), plus an explicit `dropEffect = 'none'`
      // so the cursor says so rather than the refusal being silent.
      const dataTransfer = fakeDragTransfer();
      Object.defineProperty(dataTransfer, 'types', {
        value: ['application/x-vce-orb-executor'],
      });
      dataTransfer.dropEffect = 'copy';

      const event = createEvent.dragOver(region, { dataTransfer });
      Object.defineProperty(event, 'clientY', { value: 35 });
      fireEvent(region, event);

      expect(dataTransfer.dropEffect).toBe('none');
      expect(event.defaultPrevented).toBe(false);
      // #249: "must not open a gap that then rejects the item" -- the refusal is
      // decided before anything moves, and the list does not budge.
      expect(screen.queryAllByTestId('step-drop-slot')).toHaveLength(0);
      expect(listShape(region)).toEqual(['A', 'B', 'C']);
    });

    /**
     * Issue #249 part 2, the arrows: *"the arrows -- I think just colour it up a
     * little bit more"*. jsdom applies no stylesheet, so this pins the classes;
     * the rendered contrast and the "no row got taller" measurement are in
     * `e2e/inspector-sections-steps.spec.ts`.
     */
    it('gives the reorder arrows a resting boundary and full-contrast text', () => {
      renderThreeSteps();

      for (const name of ['Move step 2 up', 'Move step 2 down']) {
        const button = screen.getByRole('button', { name });
        // The reported defect was that they "read as incidental": muted text
        // with a hover-only background and no boundary at all.
        // Issue #200: `-border-interactive`, not `-border-strong` -- the
        // latter only measures 1.4:1 against this row's `-panel-raised`
        // fill in light mode, short of 1.4.11's 3:1 floor.
        expect(button.className).toContain('border-cc-border-interactive');
        expect(button.className).toContain('text-cc-text');
        expect(button.className).not.toContain('text-cc-text-muted');
        // ...and a 16px box, exactly the row's own 1rem line box, so the added
        // weight costs no row height (#218 shrank these rows deliberately).
        expect(button.className).toContain('size-4');
      }
    });

    it('the up/down arrows still reorder steps without any drag', () => {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));

      const text = useAppStore.getState().text;
      expect(text.indexOf('name: B')).toBeLessThan(text.indexOf('name: A'));
    });

    it('Alt+Arrow reorders from any control inside the row, adding no tab stop of its own', () => {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      // The keyboard equivalent issue #218 asks for by name. Pressed on a
      // control *inside* the row rather than on the row: the handler lives on
      // the `<li>` deliberately without a `tabIndex`, so it is reachable from
      // whatever in the row already has focus and costs no extra Tab stop per
      // step.
      const rowA = screen.getByTitle('A').closest('li')!;
      expect(rowA).not.toHaveAttribute('tabindex');
      fireEvent.keyDown(screen.getByRole('button', { name: 'Remove step 1' }), {
        key: 'ArrowDown',
        altKey: true,
      });

      const text = useAppStore.getState().text;
      expect(text.indexOf('name: B')).toBeLessThan(text.indexOf('name: A'));
    });

    it('ignores Alt+Arrow past either end of the list', () => {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      const before = useAppStore.getState().text;
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      fireEvent.keyDown(screen.getByRole('button', { name: 'Remove step 1' }), {
        key: 'ArrowUp',
        altKey: true,
      });
      fireEvent.keyDown(screen.getByRole('button', { name: 'Remove step 3' }), {
        key: 'ArrowDown',
        altKey: true,
      });

      expect(useAppStore.getState().text).toBe(before);
    });

    it('a reorder is one undo step that restores the file exactly', () => {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      const before = useAppStore.getState().text;
      useAppStore.setState({ undoStack: [], redoStack: [], canUndo: false });
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));

      expect(useAppStore.getState().undoStack).toHaveLength(1);
      act(() => {
        useAppStore.getState().undo();
      });
      expect(useAppStore.getState().text).toBe(before);
    });

    it('renders the step keyword at the badge type size, not the document default', () => {
      const { doc, node } = setup(THREE_RUN_STEPS_YAML, 'build');
      render(
        <Inspector
          doc={doc}
          workflowName="main"
          node={node}
          onRequestDelete={() => {}}
          autoFocusName={false}
        />,
      );

      // Issue #218 part 1. jsdom applies no stylesheet, so the assertion is on
      // the class rather than on a computed `fontSize` -- the real 16px-vs-11px
      // measurement is in `e2e/inspector-steps.spec.ts`, against the built
      // bundle. What this pins is the specific mistake that caused it: using
      // `.vce-dag-kind-label` without the explicit size class its two other
      // call sites in `JobNode.tsx` both pair it with.
      for (const badge of document.querySelectorAll('.vce-dag-kind-label')) {
        expect(badge.className).toContain('text-2xs');
      }
    });
  });
});

describe('Inspector -- workflow entry options are editable for every node kind (issue #37)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const APPROVAL_YAML = `
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy
      - hold:
          type: approval
          requires:
            - deploy
`;

  it('an approval node still shows Alias/Context/Filters/Pre-steps/Post-steps, with no "Job" field', () => {
    const { doc, node } = setup(APPROVAL_YAML, 'hold');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByLabelText('Alias')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Context' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Filters' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Pre-steps' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Post-steps' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Job')).not.toBeInTheDocument();
  });

  it('adding a context tag to an approval entry converts it to map form', () => {
    const { doc, node } = setup(APPROVAL_YAML, 'hold');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const contextSection = screen
      .getByRole('heading', { name: 'Context' })
      .closest('section')!;
    fireEvent.change(within(contextSection).getByLabelText('Contexts'), {
      target: { value: 'org-global' },
    });
    fireEvent.click(
      within(contextSection).getByRole('button', { name: 'Add' }),
    );

    expect(useAppStore.getState().text).toContain('context:');
    expect(useAppStore.getState().text).toContain('org-global');
  });

  it('removing the only context tag collapses the entry back to a bare string', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build:
          context: org-global
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /remove context org-global/i }),
    );

    expect(useAppStore.getState().text.trim()).toBe(
      `jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build`.trim(),
    );
  });

  it('adding a "branches only" filter commits filters:', () => {
    const { doc, node } = setup(
      `
jobs:
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - deploy
`,
      'deploy',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const filtersSection = screen
      .getByRole('heading', { name: 'Filters' })
      .closest('section')!;
    fireEvent.change(
      within(filtersSection).getByLabelText('Branches -- only'),
      {
        target: { value: 'main' },
      },
    );
    fireEvent.click(
      within(filtersSection).getAllByRole('button', { name: 'Add' })[0]!,
    );

    expect(useAppStore.getState().text).toContain('filters:');
    expect(useAppStore.getState().text).toContain('branches:');
    expect(useAppStore.getState().text).toContain('only:');
  });

  it('adding a pre-step via the "Add a run step" form under Pre-steps writes pre-steps:, not steps:', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const preStepsHeading = screen.getByRole('heading', { name: 'Pre-steps' });
    const preStepsSection = preStepsHeading.closest('section')!;
    const commandBox =
      within(preStepsSection).getByPlaceholderText('Shell command');
    fireEvent.change(commandBox, { target: { value: 'echo pre' } });
    fireEvent.click(
      within(preStepsSection).getByRole('button', { name: 'Add step' }),
    );

    expect(useAppStore.getState().text).toContain('pre-steps:');
    expect(useAppStore.getState().text).toContain('echo pre');
    // The job's own steps: is untouched (still its original flow-seq form).
    expect(useAppStore.getState().text).toMatch(/steps:\s*\[\s*checkout\s*\]/);
  });

  it('an orb job entry gets the same context/filters/pre-steps sections as a local job', () => {
    const { doc, node } = setup(
      `
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`,
      'node/test',
    );
    vi.stubGlobal(
      'fetch',
      jsonFetchStub({ available: false, reason: 'no token in tests' }),
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Context' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Pre-steps' }),
    ).toBeInTheDocument();
  });
});

describe('Inspector -- Job vs Alias (issue #36)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ALIASED_YAML = `
jobs:
  test:
    docker: []
workflows:
  main:
    jobs:
      - test:
          name: test-linux
          requires: []
      - test:
          name: test-macos
          requires: []
`;

  it("shows the entry's own alias, not the shared job name, in the Alias field", () => {
    const { doc, node } = setup(ALIASED_YAML, 'test-linux');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByLabelText('Job name')).toHaveValue('test');
    expect(screen.getByLabelText('Alias')).toHaveValue('test-linux');
  });

  it("editing one entry's alias does not affect the other entry aliasing the same job", () => {
    const { doc, node } = setup(ALIASED_YAML, 'test-linux');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const aliasInput = screen.getByLabelText('Alias');
    fireEvent.change(aliasInput, { target: { value: 'test-linux-v2' } });
    fireEvent.blur(aliasInput);

    const text = useAppStore.getState().text;
    expect(text).toContain('test-linux-v2');
    expect(text).toContain('test-macos');
    // The job definition itself is untouched.
    expect(text).toContain('test:\n    docker: []');
  });

  it('renaming the shared job definition ("Job name") updates every aliased entry, and warns that more than one entry references it', () => {
    const { doc, node } = setup(ALIASED_YAML, 'test-linux');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.getByText(/2 workflow entries use this job definition/i),
    ).toBeInTheDocument();

    const jobNameInput = screen.getByLabelText('Job name');
    fireEvent.change(jobNameInput, { target: { value: 'test-suite' } });
    fireEvent.blur(jobNameInput);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    const text = useAppStore.getState().text;
    expect(text).toContain('test-suite:\n    docker: []');
    // Both aliased entries now point at the renamed job, aliases untouched.
    const entryCount = text.split('test-suite:').length - 1;
    expect(entryCount).toBeGreaterThanOrEqual(3); // the definition + two entry keys
    expect(text).toContain('name: test-linux');
    expect(text).toContain('name: test-macos');
  });

  it('does not warn when only one entry references the job definition', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.queryByText(/workflow entries use this job definition/i),
    ).not.toBeInTheDocument();
  });

  it('setting an alias on an entry that has none works', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const aliasInput = screen.getByLabelText('Alias');
    expect(aliasInput).toHaveValue('');
    fireEvent.change(aliasInput, { target: { value: 'build-primary' } });
    fireEvent.blur(aliasInput);

    expect(useAppStore.getState().text).toContain('name: build-primary');
  });

  it('after setting an alias and rerendering from the new doc, the field reflects the new alias', () => {
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );
    const { rerender } = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.change(screen.getByLabelText('Alias'), {
      target: { value: 'build-primary' },
    });
    fireEvent.blur(screen.getByLabelText('Alias'));

    const after = fromStore('build-primary');
    rerender(
      <Inspector
        key={after.node.id}
        doc={after.doc}
        workflowName="main"
        node={after.node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByLabelText('Alias')).toHaveValue('build-primary');
  });
});

describe('Inspector -- executor resolution (issue #27)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const EXECUTORS_YAML = `
orbs:
  py: circleci/python@1.0.0
executors:
  python-lint-executor:
    docker:
      - image: cimg/python:3.11.13
    resource_class: large
  docker-executor:
    machine:
      image: ubuntu-2404:current
      docker_layer_caching: true
    resource_class: large
jobs:
  lint-backend:
    executor: python-lint-executor
    steps: [checkout]
  build-backend:
    executor: docker-executor
    steps: [checkout]
  ghost-executor-job:
    executor: nope-not-defined
    steps: [checkout]
  orb-executor-job:
    executor: py/default
    steps: [checkout]
workflows:
  main:
    jobs:
      - lint-backend
      - build-backend
      - ghost-executor-job
      - orb-executor-job
`;

  it('a docker-executor job shows the inherited image and resource class, clearly marked as inherited', () => {
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(screen.getByText(/cimg\/python:3\.11\.13/)).toBeInTheDocument();
    expect(
      screen.getByText(/inherited from executor "python-lint-executor"/i),
    ).toBeInTheDocument();
    expect(screen.getByText('large')).toBeInTheDocument();
    // Not presented as this job's own docker image field.
    expect(screen.queryByLabelText(/docker image/i)).not.toBeInTheDocument();
  });

  it('a machine executor shows Docker Layer Caching state, set on the executor', () => {
    const { doc, node } = setup(EXECUTORS_YAML, 'build-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.getByText(/docker layer caching: enabled/i),
    ).toBeInTheDocument();
  });

  it('a job referencing an undefined executor says so honestly', () => {
    const { doc, node } = setup(EXECUTORS_YAML, 'ghost-executor-job');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.getByText(
        /references executor "nope-not-defined", which isn't defined/i,
      ),
    ).toBeInTheDocument();
  });

  it('an orb-provided executor is reported as unresolvable, honestly', () => {
    const { doc, node } = setup(EXECUTORS_YAML, 'orb-executor-job');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    expect(
      screen.getByText(/orb-provided executor "py\/default"/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/can't be resolved here/i)).toBeInTheDocument();
  });

  it('"Override for this job" writes a job-level resource_class without touching the executor', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Override for this job' }),
    );
    // The classes come from `GET /api/resource-classes` now (issue #181), so the
    // options only exist once that fetch has resolved.
    await flushResourceClasses();
    const overrideSelect = screen.getByRole('combobox', {
      name: /resource class/i,
    });
    fireEvent.change(overrideSelect, { target: { value: 'xlarge' } });

    const { doc: after } = parseConfig(useAppStore.getState().text);
    if (!after) throw new Error('resulting text failed to parse');
    expect(getIn(after, ['jobs', 'lint-backend', 'resource_class'])).toBe(
      'xlarge',
    );
    // The executor's own resource_class is untouched.
    expect(
      getIn(after, ['executors', 'python-lint-executor', 'resource_class']),
    ).toBe('large');
  });

  it('"Edit the executor" writes to executors:, affecting every job that uses it', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit the executor' }));
    await flushResourceClasses();
    const executorSelect = screen.getByRole('combobox', {
      name: /resource class/i,
    });
    fireEvent.change(executorSelect, { target: { value: 'xlarge' } });

    const { doc: after } = parseConfig(useAppStore.getState().text);
    if (!after) throw new Error('resulting text failed to parse');
    expect(
      getIn(after, ['executors', 'python-lint-executor', 'resource_class']),
    ).toBe('xlarge');
    // The job itself never gained its own resource_class.
    expect(
      getIn(after, ['jobs', 'lint-backend', 'resource_class']),
    ).toBeUndefined();
  });

  it('reverting an override removes the job-level field, restoring the inherited value', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    const { rerender } = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Override for this job' }),
    );
    await flushResourceClasses();
    fireEvent.change(
      screen.getByRole('combobox', { name: /resource class/i }),
      { target: { value: 'xlarge' } },
    );

    const afterOverride = fromStore('lint-backend');
    rerender(
      <Inspector
        key={afterOverride.node.id}
        doc={afterOverride.doc}
        workflowName="main"
        node={afterOverride.node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    expect(screen.getByText(/overridden for this job/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Revert to inherited' }),
    );
    const { doc: after } = parseConfig(useAppStore.getState().text);
    if (!after) throw new Error('resulting text failed to parse');
    expect(
      getIn(after, ['jobs', 'lint-backend', 'resource_class']),
    ).toBeUndefined();
    expect(
      getIn(after, ['executors', 'python-lint-executor', 'resource_class']),
    ).toBe('large');
  });

  /**
   * Issues #153, #159 and #181, in order. #153 removed the flat resource-class
   * list from the palette's Project section and moved it here, where one is
   * chosen. #159 widened this field from five hardcoded Docker values to the
   * config schema's whole `resource_class` enum. #181 replaced *that* with
   * CircleCI's own resource tables, and this test is the reconciliation: the
   * schema said what is syntactically valid, the tables say what exists, and for
   * this field the tables win.
   *
   * What that buys, concretely: classes grouped by execution environment rather
   * than one flat enum, gen2 classes offered at all, and no `arm.*` shown for a
   * `macos` job.
   */
  it('offers CircleCI’s resource tables, grouped by execution environment, not the schema enum', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Override for this job' }),
    );
    await flushResourceClasses();

    const select = screen.getByRole('combobox', { name: /resource class/i });
    const values = Array.from(
      select.querySelectorAll('option'),
      (option) => option.value,
    );
    // `lint-backend` uses a docker executor, so it gets the three Docker tables
    // -- including Arm, which is the defect issue #181 was filed for, and gen2,
    // which nothing in this app offered before.
    expect(values).toContain('medium');
    expect(values).toContain('arm.large');
    expect(values).toContain('medium.gen2');
    // And not another executor's classes: a flat enum offered `windows.large`
    // and `m4pro.medium` for a Docker job, which are not valid there.
    expect(values).not.toContain('windows.large');
    expect(values).not.toContain('m4pro.medium');

    // Each table is its own group, labelled in CircleCI's own words.
    const groups = Array.from(
      select.querySelectorAll('optgroup'),
      (group) => group.label,
    );
    expect(groups).toEqual(['x86', 'x86 (gen2)', 'Arm']);

    // A free-text escape hatch remains, so a class newer than the vendored
    // snapshot is still writable.
    expect(values).toContain('__custom__');

    // Still honest about what the list is -- now naming the docs, which is where
    // it actually comes from. Not an entitlement check; no API exposes that.
    expect(screen.getByText(/not your plan/i).textContent).toMatch(
      /CircleCI’s resource-class tables/,
    );
  });

  /**
   * The architecture control the owner asked for in issue #181, and the two
   * things it must not become: a config key, and a control that appears where it
   * cannot change anything.
   */
  it('filters the class list by architecture, and says it writes no key', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(EXECUTORS_YAML, 'lint-backend');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Override for this job' }),
    );
    await flushResourceClasses();

    const architecture = screen.getByRole('combobox', { name: 'Architecture' });
    fireEvent.change(architecture, { target: { value: 'arm64' } });

    const select = screen.getByRole('combobox', { name: /resource class/i });
    const values = Array.from(
      select.querySelectorAll('option'),
      (option) => option.value,
    );
    expect(values).toContain('arm.large');
    expect(values).not.toContain('medium');
    expect(values).not.toContain('medium.gen2');

    // Said in the UI, because it is the whole truth about this control: there is
    // no `architecture:` key, so it narrows a list and writes nothing.
    expect(screen.getByText(/filters the list below/i).textContent).toMatch(
      /no architecture key/,
    );

    // Choosing an architecture on its own writes nothing at all.
    const { doc: after } = parseConfig(useAppStore.getState().text);
    if (!after) throw new Error('resulting text failed to parse');
    expect(
      getIn(after, ['jobs', 'lint-backend', 'resource_class']),
    ).toBeUndefined();
  });

  /** macOS states no architecture in its table, so no filter is offered there. */
  it('offers no architecture filter for an executor with only one architecture', async () => {
    stubResourceClassesFetch();
    const { doc, node } = setup(
      `jobs:
  mac-build:
    macos:
      xcode: 15.4.0
    resource_class: m4pro.medium
    steps: [checkout]
workflows:
  main:
    jobs: [mac-build]
`,
      'mac-build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushResourceClasses();

    expect(
      screen.queryByRole('combobox', { name: 'Architecture' }),
    ).not.toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: /resource class/i });
    const values = Array.from(
      select.querySelectorAll('option'),
      (option) => option.value,
    );
    expect(values).toContain('m4pro.medium');
    expect(values).toContain('m4pro.large');
    expect(values).not.toContain('arm.large');
  });
});

describe('Inspector -- orb job invocation parameters (issue #37)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const NODE_ORB_SOURCE = `
jobs:
  test:
    executor: default
    parameters:
      run-command:
        type: string
        default: "npm test"
    steps: [checkout]
`;

  function stubOrbFetch(source: string) {
    vi.stubGlobal(
      'fetch',
      jsonFetchStub({
        available: true,
        name: 'circleci/node',
        version: '5.2.0',
        source,
      }),
    );
  }

  it("renders a parameter field driven by the orb job's own schema, seeded from its default", async () => {
    stubOrbFetch(NODE_ORB_SOURCE);
    const { doc, node } = setup(
      `
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`,
      'node/test',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByLabelText('run-command')).toHaveValue('npm test');
  });

  it('editing an orb invocation parameter after insertion commits via setWorkflowJobEntryParameter', async () => {
    stubOrbFetch(NODE_ORB_SOURCE);
    const { doc, node } = setup(
      `
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test
`,
      'node/test',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const field = screen.getByLabelText('run-command');
    fireEvent.change(field, { target: { value: 'npm run test:ci' } });
    fireEvent.blur(field);

    const text = useAppStore.getState().text;
    expect(text).toContain('node/test:');
    expect(text).toContain('run-command: npm run test:ci');
  });

  it('shows an already-set invocation parameter (from a prior insertion) rather than the orb default', async () => {
    stubOrbFetch(NODE_ORB_SOURCE);
    const { doc, node } = setup(
      `
orbs:
  node: circleci/node@5.2.0
workflows:
  main:
    jobs:
      - node/test:
          run-command: npm run test:ci
`,
      'node/test',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByLabelText('run-command')).toHaveValue('npm run test:ci');
  });
});

describe('Inspector -- editing existing step fields (issue #48)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Flushes `useCircleciSchema`'s fetch effect, same pattern as the orb-fetch tests elsewhere in this file. */
  async function flushSchemaFetch() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  const STEP_KINDS_YAML = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - run:
          name: Build
          command: make build
      - save_cache:
          key: v1-deps
      - deploy_to_prod: {}
      - not_valid_step_shape: 1
        another_key: 2
workflows:
  main:
    jobs:
      - build
`;

  it('editing checkout\'s path promotes the bare "- checkout" step to map form', async () => {
    stubSchemaFetch();
    const { doc, node } = setup(STEP_KINDS_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    expect(useAppStore.getState().text).toContain('- checkout\n');
    fireEvent.click(screen.getByRole('button', { name: 'Expand checkout' }));
    const pathField = screen.getByLabelText('path');
    fireEvent.change(pathField, { target: { value: 'src' } });
    fireEvent.blur(pathField);

    expect(useAppStore.getState().text).toContain('checkout:\n');
    expect(useAppStore.getState().text).toContain('path: src');
  });

  it("editing run's fields (name already set) commits background/when/environment without disturbing command", async () => {
    stubSchemaFetch();
    const { doc, node } = setup(STEP_KINDS_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Build' }));

    // Boolean field, commits immediately (same convention as every other
    // checkbox in this pane).
    fireEvent.click(screen.getByLabelText('background'));
    expect(useAppStore.getState().text).toContain('background: true');

    // Enum field.
    fireEvent.change(screen.getByLabelText('when'), {
      target: { value: 'always' },
    });
    expect(useAppStore.getState().text).toContain('when: always');

    // Environment key/value pair.
    fireEvent.change(screen.getByLabelText('environment variable name'), {
      target: { value: 'NODE_ENV' },
    });
    fireEvent.change(screen.getByLabelText('environment value'), {
      target: { value: 'test' },
    });
    fireEvent.click(
      screen
        .getByLabelText('environment variable name')
        .closest('div')!
        .querySelector('button')!,
    );
    expect(useAppStore.getState().text).toContain('NODE_ENV: test');

    // The original command is untouched by any of the above.
    expect(useAppStore.getState().text).toContain('command: make build');
  });

  it("editing save_cache's paths adds an array field that wasn't previously set", async () => {
    stubSchemaFetch();
    const { doc, node } = setup(STEP_KINDS_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    // save_cache's row label is its own `key:` value ("v1-deps"), same
    // "first string-valued main field" summary every other known step
    // without a name uses (`knownStepLabel`/`builtinDetail`) -- not the
    // keyword "save_cache" itself, which is the row's *badge* instead.
    fireEvent.click(screen.getByRole('button', { name: 'Expand v1-deps' }));
    const pathsInput = screen.getByLabelText('paths');
    fireEvent.change(pathsInput, { target: { value: 'node_modules' } });
    fireEvent.click(
      within(pathsInput.closest('div')!).getByRole('button', { name: 'Add' }),
    );

    const text = useAppStore.getState().text;
    expect(text).toContain('key: v1-deps');
    expect(text).toContain('paths:');
    expect(text).toContain('node_modules');
  });

  it('clearing an optional field back to empty removes the key rather than writing an empty string', async () => {
    stubSchemaFetch();
    const { doc, node } = setup(STEP_KINDS_YAML, 'build');
    const { rerender } = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Expand checkout' }));
    const pathField = screen.getByLabelText('path');
    fireEvent.change(pathField, { target: { value: 'src' } });
    fireEvent.blur(pathField);
    expect(useAppStore.getState().text).toContain('path: src');

    // Re-render from the post-edit doc (same pattern as the executor-field
    // tests above) -- `Inspector` is only ever handed a fresh `doc`/`node`
    // by its real parent (`DagPane`) after a mutation; nothing here retains
    // stale field values across an edit on its own.
    const after1 = fromStore('build');
    rerender(
      <Inspector
        key={after1.node.id}
        doc={after1.doc}
        workflowName="main"
        node={after1.node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Expand checkout' }));
    fireEvent.change(screen.getByLabelText('path'), { target: { value: '' } });
    fireEvent.blur(screen.getByLabelText('path'));

    // Emptying the (optional) only field collapses the step all the way
    // back to the bare "- checkout" it started as.
    expect(useAppStore.getState().text).not.toContain('path:');
    expect(useAppStore.getState().text).toContain('- checkout\n');
  });

  it('an unrecognized (multi-key) step shows an honest, non-destructive notice instead of silently dropping keys', async () => {
    stubSchemaFetch();
    const { doc, node } = setup(STEP_KINDS_YAML, 'build');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    fireEvent.click(
      screen.getByRole('button', { name: /expand \(unrecognized\)/i }),
    );
    expect(screen.getByText(/2 top-level keys/i)).toBeInTheDocument();
    expect(screen.getByText(/not_valid_step_shape/)).toBeInTheDocument();
    // Nothing was rewritten just by expanding/viewing it.
    expect(useAppStore.getState().text).toContain('not_valid_step_shape: 1');
    expect(useAppStore.getState().text).toContain('another_key: 2');
  });

  it("editing a pre-step's field is rooted at the workflow entry, not the job body (issue #37 + #48)", async () => {
    stubSchemaFetch();
    const { doc, node } = setup(
      `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps: [checkout]
workflows:
  main:
    jobs:
      - build:
          pre-steps:
            - checkout
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    const preStepsSection = screen
      .getByRole('heading', { name: 'Pre-steps' })
      .closest('section')!;
    fireEvent.click(
      within(preStepsSection).getByRole('button', { name: 'Expand checkout' }),
    );
    const pathField = within(preStepsSection).getByLabelText('path');
    fireEvent.change(pathField, { target: { value: 'src' } });
    fireEvent.blur(pathField);

    const text = useAppStore.getState().text;
    expect(text).toContain('pre-steps:');
    expect(text).toContain('path: src');
    // The job's own steps: is untouched.
    expect(text).toMatch(/steps:\s*\[\s*checkout\s*\]/);
  });

  it('round-trips a config with comments: editing one step field changes only that region (issue #48)', async () => {
    stubSchemaFetch();
    const before = `# Owned by #platform-eng.
jobs:
  build:
    docker:
      - image: cimg/base:current # pinned base image
    steps:
      # Checks out the repo before anything else.
      - checkout
      - run:
          name: Build
          command: make build # keep in sync with the Makefile
      - save_cache:
          key: v1-{{ checksum "go.sum" }}
          paths:
            - vendor
      # Ship it.
      - run: make deploy
workflows:
  main:
    jobs:
      - build
`;
    const { doc, error } = parseConfig(before);
    if (error || !doc) throw new Error(`fixture failed to parse: ${error}`);
    useAppStore.setState({
      doc,
      text: before,
      savedText: before,
      parseError: null,
      editError: null,
    });
    const graph = buildWorkflowGraph(doc, 'main');
    const node = graph.nodes.find((n) => n.id === 'build');
    if (!node) throw new Error('no "build" node');

    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await flushSchemaFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Build' }));
    fireEvent.change(screen.getByLabelText('working_directory'), {
      target: { value: '~/project' },
    });
    fireEvent.blur(screen.getByLabelText('working_directory'));

    const after = useAppStore.getState().text;
    expect(after).not.toBe(before);
    // The new field, and nothing else structurally.
    expect(after).toContain('working_directory: ~/project');
    // Every comment survives, including ones nowhere near the edited step.
    expect(after).toContain('# Owned by #platform-eng.');
    expect(after).toContain('# pinned base image');
    expect(after).toContain('# Checks out the repo before anything else.');
    expect(after).toContain(
      'command: make build # keep in sync with the Makefile',
    );
    expect(after).toContain('# Ship it.');
    expect(after).toContain('- run: make deploy');
  });
});

// ---------------------------------------------------------------------------
// Issue #12: the rename prompt. Its job is to name the exact sites a rename
// will rewrite -- and the ones it deliberately won't -- before anything is
// touched, and to be silenceable without ever silencing the reconciliation.
// ---------------------------------------------------------------------------

describe('Inspector -- rename reference prompt (#12)', () => {
  const CHAIN = `
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
`;

  beforeEach(() => {
    window.localStorage.clear();
    useConfirmStore.setState({ suppressed: [] });
  });

  it('lists every site by name instead of asking a generic "are you sure"', () => {
    const { doc, node } = setup(CHAIN, 'test');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);

    const dialog = screen.getByRole('dialog', {
      name: /rename "test" to "unit"/i,
    });
    expect(dialog).toHaveTextContent(
      'Renaming test to unit rewrites 3 places.',
    );
    expect(dialog).toHaveTextContent('jobs.test becomes jobs.unit');
    expect(dialog).toHaveTextContent('1 job entry renamed to unit');
    expect(dialog).toHaveTextContent('test is required by deploy');
  });

  it('does not touch the document until the prompt is confirmed', () => {
    const { doc, node } = setup(CHAIN, 'test');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);

    expect(useAppStore.getState().text).toBe(CHAIN);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(useAppStore.getState().text).toContain('unit:');
    expect(useAppStore.getState().text).toContain('- unit');
  });

  it('cancelling leaves the document and the field alone', () => {
    const { doc, node } = setup(CHAIN, 'test');
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(useAppStore.getState().text).toBe(CHAIN);
    expect(screen.getByLabelText('Job name')).toHaveValue('test');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not prompt for a job whose only reference is the entry being looked at', () => {
    // One un-aliased entry, nothing requiring it: the only reference is the
    // node on screen, so a prompt would be friction with no information in it.
    // See `renameNeedsConfirmation`.
    const { doc, node } = setup(
      `
jobs:
  build:
    docker: []
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'compile' } });
    fireEvent.blur(input);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const text = useAppStore.getState().text;
    expect(text).toContain('compile:');
    // ...and the entry was still reconciled, prompt or no prompt.
    expect(text).toContain('- compile');
  });

  it('"don\'t ask again" suppresses the prompt but still reconciles every reference', () => {
    const first = setup(CHAIN, 'test');
    const { unmount } = render(
      <Inspector
        doc={first.doc}
        workflowName="main"
        node={first.node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByLabelText(/don't ask again/i));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    // First rename still reconciled everything.
    expect(useAppStore.getState().text).toContain('- unit');
    expect(useConfirmStore.getState().suppressed).toEqual(['renameJob']);
    unmount();

    // Second rename: no prompt, and the `requires:` reference is *still*
    // rewritten. Suppressing the dialog must never suppress the correctness.
    const second = fromStore('unit');
    render(
      <Inspector
        doc={second.doc}
        workflowName="main"
        node={second.node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    const input2 = screen.getByLabelText('Job name');
    fireEvent.change(input2, { target: { value: 'verify' } });
    fireEvent.blur(input2);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const text = useAppStore.getState().text;
    expect(text).toContain('verify:');
    expect(text).toContain('- verify');
    expect(text).not.toContain('unit');
  });

  it('explains that a workflow aliasing a different job under this name is left alone', () => {
    const { doc, node } = setup(
      `
jobs:
  test:
    docker: []
  shared-runner:
    docker: []
  deploy:
    docker: []
workflows:
  main:
    jobs:
      - test
      - deploy:
          requires:
            - test
  release:
    jobs:
      - shared-runner:
          name: test
      - deploy:
          name: deploy-prod
          requires:
            - test
`,
      'test',
    );
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('workflow "release"');
    expect(dialog).toHaveTextContent('refers to that entry, not this job');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const text = useAppStore.getState().text;
    // `release`'s requires still names the alias, exactly as the prompt said.
    expect(text).toMatch(
      /name: deploy-prod\n          requires:\n            - test/,
    );
  });

  it('the whole reconciliation is one undo step, not one per site', () => {
    const { doc, node } = setup(CHAIN, 'test');
    useAppStore.setState({ undoStack: [], redoStack: [], canUndo: false });
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );

    const input = screen.getByLabelText('Job name');
    fireEvent.change(input, { target: { value: 'unit' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    // Three sites changed (definition, entry key, deploy's requires) in one
    // history entry.
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    act(() => {
      useAppStore.getState().undo();
    });
    expect(useAppStore.getState().text).toBe(CHAIN);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});

/**
 * Issue #219's collapsible sections, in the pane.
 *
 * Three things are worth asserting here rather than only in
 * `inspectorSections.test.ts`: that the defaults actually reach the rendered
 * `<details>`; that the hard "never hide configuration without a signal"
 * requirement holds on a *collapsed* section rather than only in principle; and
 * that an explicit choice outranks the content rule and survives a remount.
 */
describe('Inspector -- collapsible sections (issue #219)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
    window.localStorage.clear();
    useInspectorSectionStore.setState({ open: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const JOB_WITH_POST_STEPS = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          post-steps:
            - run: notify-a
            - run: notify-b
            - run: notify-c
`;

  /** The `<details>` element owning the section whose heading reads `title`. */
  function sectionFor(title: string): HTMLDetailsElement {
    const heading = screen.getByRole('heading', { name: title });
    const details = heading.closest('details');
    if (!details) throw new Error(`"${title}" is not inside a <details>`);
    return details as HTMLDetailsElement;
  }

  /**
   * Clicks a section's summary the way a user would, and then lets the `toggle`
   * event actually arrive.
   *
   * The second half is not optional and is easy to miss. Per the HTML spec a
   * `<details>` fires `toggle` from a *queued element task*, not synchronously
   * with the click -- so jsdom flips the `open` attribute immediately but
   * delivers the event on a later turn. Every test in this file runs on
   * `vi.useFakeTimers()`, which means that turn never comes unless the timers
   * are advanced. Measured while writing these tests: after
   * `fireEvent.click(summary)`, `details.open` was already `true` while React's
   * `onToggle` had not run at all; it ran only after `advanceTimersByTime`.
   *
   * Without this, every assertion about the *persisted* choice would fail while
   * every assertion about `open` passed -- which is exactly the shape of a test
   * that looks like it covers persistence and does not.
   */
  function toggleSection(title: string): void {
    fireEvent.click(screen.getByRole('heading', { name: title }));
    act(() => {
      vi.advanceTimersByTime(1);
    });
  }

  function renderInspector(yaml: string, nodeId: string) {
    const { doc, node } = setup(yaml, nodeId);
    return render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
  }

  it('collapses the empty sections and opens the ones with content', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');

    // Empty in this job -- the crowding #219 is about.
    expect(sectionFor('Pre-steps').open).toBe(false);
    expect(sectionFor('Filters').open).toBe(false);
    expect(sectionFor('Context').open).toBe(false);
    expect(sectionFor('Requires').open).toBe(false);
    // Has content, so it opens on its own without being on any list.
    expect(sectionFor('Post-steps').open).toBe(true);
    // The exception.
    expect(sectionFor('Steps').open).toBe(true);
  });

  it('keeps Steps open for a job with no steps at all, so its Add form stays reachable', () => {
    renderInspector(
      `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps: []
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );

    const steps = sectionFor('Steps');
    expect(steps.open).toBe(true);
    // Scoped to the section: Pre-steps and Post-steps each render an identical
    // Add form, and a closed `<details>` still has its content in the DOM (see
    // the next test), so an unscoped query matches all three.
    expect(
      within(steps).getByPlaceholderText('Shell command'),
    ).toBeInTheDocument();
  });

  it('never hides a section that holds configuration without saying how much', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');

    // The hard requirement in #219: "a collapsed section holding three
    // post-steps must say so on its summary row -- otherwise this trades
    // crowding for invisible configuration, which is worse in a config
    // editor." Collapse it by hand and check the count is still there.
    const postSteps = sectionFor('Post-steps');
    toggleSection('Post-steps');
    expect(postSteps.open).toBe(false);

    // The three steps are now hidden. Asserted as "the section is closed"
    // rather than "the rows are not in the document", because they *are*: a
    // closed `<details>` keeps its subtree in the DOM and the UA stylesheet is
    // what hides it, and jsdom applies no UA stylesheet. Verified while writing
    // this -- `document.body.textContent` still contained a closed section's
    // body text. So the honest jsdom-level assertion is the `open` state above;
    // the visual half is covered in `e2e/inspector-sections.spec.ts` against
    // the real bundle.
    //
    // The part that matters here is what the *summary row* says while that is
    // true: three post-steps are hidden and the row reports three, both
    // visually and to a screen reader.
    const summary = postSteps.querySelector('summary')!;
    expect(within(summary).getByText('3')).toBeInTheDocument();
    expect(within(summary).getByLabelText('3 items')).toBeInTheDocument();
  });

  it('shows no count for a section that is genuinely empty', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');
    const preSteps = sectionFor('Pre-steps');
    expect(preSteps.open).toBe(false);
    // Nothing hidden, so nothing to signal -- a "0" on every closed row would
    // be noise that makes the real signal harder to notice.
    const summary = preSteps.querySelector('summary')!;
    expect(within(summary).queryByText('0')).not.toBeInTheDocument();
    expect(within(summary).queryByLabelText(/items?$/)).not.toBeInTheDocument();
  });

  it('remembers an explicit choice against the content rule, and across a remount', () => {
    const first = renderInspector(JOB_WITH_POST_STEPS, 'build');

    // Post-steps has content, so the rule opens it; close it anyway.
    toggleSection('Post-steps');
    expect(sectionFor('Post-steps').open).toBe(false);
    // Persisted, following `layoutStore`'s pattern -- see
    // `inspectorSectionStore.test.ts` for the storage-level coverage.
    expect(readPersistedSectionChoices()).toEqual({ 'post-steps': false });

    first.unmount();
    renderInspector(JOB_WITH_POST_STEPS, 'build');
    // Still closed: the user's own choice outranks the rule that would open it.
    expect(sectionFor('Post-steps').open).toBe(false);
    // And an untouched section still follows the rule.
    expect(sectionFor('Steps').open).toBe(true);
  });

  it('opening an empty section by hand keeps it open while it is still empty', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');
    expect(sectionFor('Pre-steps').open).toBe(false);
    toggleSection('Pre-steps');
    expect(sectionFor('Pre-steps').open).toBe(true);
    expect(readPersistedSectionChoices()).toEqual({ 'pre-steps': true });
  });

  it('keeps each section heading a real heading, and each summary a real toggle', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');
    // Both roles, on purpose: the heading is how this pane is navigated (by
    // screen reader, and by most of this suite), and the summary is what makes
    // the region operable from the keyboard for free.
    for (const title of ['Steps', 'Pre-steps', 'Post-steps', 'Filters']) {
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.tagName).toBe('H4');
      expect(heading.closest('summary')).not.toBeNull();
    }
  });

  it('following a section docs link does not collapse the section behind you', () => {
    renderInspector(JOB_WITH_POST_STEPS, 'build');
    const filters = sectionFor('Filters');
    toggleSection('Filters');
    expect(filters.open).toBe(true);

    // A `<summary>` activates on a click anywhere inside it, so the docs link
    // (issue #78) has to stop its own -- otherwise reading the docs for a
    // section shuts the section.
    fireEvent.click(
      within(filters.querySelector('summary')!).getByRole('link'),
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(filters.open).toBe(true);
  });

  it('adds no scrollable region of its own (issue #88)', () => {
    const { container } = renderInspector(JOB_WITH_POST_STEPS, 'build');
    // jsdom has no layout, so this cannot measure overflow -- what it *can* do
    // is assert the thing that would cause one: no `overflow-*` utility
    // anywhere inside a section. The measured region count is in
    // `e2e/scroll-regions.spec.ts`, against the real bundle.
    for (const details of container.querySelectorAll('details')) {
      for (const element of details.querySelectorAll('*')) {
        expect(element.className.toString()).not.toMatch(
          /\boverflow-(y|x)?-?(auto|scroll)\b/,
        );
      }
    }
  });
});

/**
 * Issue #252 part 2: an orb command dropped into a job's `steps:` was
 * inspectable in name only.
 *
 * > *"When I drag an orb's commands into the steps of a job that exists --
 * > normally on those steps I'm able to click on it and there's the ability to
 * > edit different things. But I don't get any edit ability. I can't set
 * > different parameters that I can pass in."*
 *
 * Two causes, both covered here. A command inserted without parameters is
 * written as a bare string, which `describeStep` classified as an opaque `bare`
 * step -- no parameters, so no details, so no disclosure at all. And even in the
 * mapping form, only keys *already present* were editable, so the orb's own
 * declared parameters were unreachable from the call site even though the orb
 * browser has listed them since #89/#128.
 */
describe('Inspector -- an orb command step is editable (issue #252)', () => {
  /**
   * An orb with one command carrying the three cases that matter: a required
   * parameter (no `default`, so `parseOrb` marks it required), an optional one
   * with a default, and a boolean. Modelled on `cci-labs/act`, the orb the issue
   * was reported against.
   */
  const ACT_ORB_SOURCE = `
description: Run GitHub Actions locally.
commands:
  install:
    description: Install the act binary.
    parameters:
      version:
        type: string
        description: The act version to install.
      install-dir:
        type: string
        default: /usr/local/bin
      verbose:
        type: boolean
        default: false
    steps:
      - run: echo installing
jobs:
  run-act:
    parameters:
      workflow:
        type: string
    steps:
      - run: echo running
`;

  const JOB_WITH_BARE_ORB_STEP = `
orbs:
  act: cci-labs/act@1.0.0
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - act/install
workflows:
  main:
    jobs:
      - build
`;

  /**
   * Routes `/api/orbs/source` to `source` (or an `available: false` refusal when
   * `source` is null) and everything else to `{}`. The pane makes several
   * unrelated requests per render -- the schema, resource classes, project
   * context -- so a URL-agnostic stub would answer the orb lookup with one of
   * those instead.
   */
  function stubOrbSource(source: string | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        const body = !url.startsWith('/api/orbs/source')
          ? {}
          : source === null
            ? {
                available: false,
                source: 'unavailable',
                reason: 'no CircleCI API token available',
              }
            : {
                available: true,
                name: 'cci-labs/act',
                version: '1.0.0',
                source,
              };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
  }

  /** Renders the pane and flushes the orb fetch, so the parsed parameters exist. */
  async function renderWithOrb(
    yaml: string,
    nodeId: string,
  ): Promise<ReturnType<typeof render>> {
    const { doc, node } = setup(yaml, nodeId);
    const result = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return result;
  }

  /** The `<li>` for the step whose row label reads `label`. */
  function stepRow(label: string): HTMLElement {
    const row = screen.getByText(label).closest('li');
    if (!row) throw new Error(`no step row for "${label}"`);
    return row;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
    window.localStorage.clear();
    useInspectorSectionStore.setState({ open: {} });
    // The parsed-orb cache is deliberately outside the reset above, so an orb
    // resolved by one test would otherwise be served to the next from memory
    // without any fetch -- hiding exactly the unavailable-source path below.
    useOrbStore.setState({ parsedOrbs: {}, orbVersionsCache: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a bare-string orb command as an orb command, not an opaque step', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(JOB_WITH_BARE_ORB_STEP, 'build');

    const row = stepRow('install');
    // The badge is the orb alias, the label the command -- the same treatment
    // the mapping form has always had. Pre-#252 this row read "command" /
    // "act/install" and had no disclosure control at all.
    expect(within(row).getByText('act')).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /expand install/i }),
    ).toBeInTheDocument();
  });

  it("lists the orb's declared parameters even though the step sets none", async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(JOB_WITH_BARE_ORB_STEP, 'build');

    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    const row = stepRow('install');
    for (const name of ['version', 'install-dir', 'verbose']) {
      expect(within(row).getByText(name)).toBeInTheDocument();
    }
  });

  it('flags a required parameter that has no value', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(JOB_WITH_BARE_ORB_STEP, 'build');

    // A required parameter with no value is an invalid config, so the row says
    // so before it is expanded -- otherwise the step looks configured.
    const flag = screen.getByTestId('step-required-unset');
    expect(flag).toHaveTextContent('version unset');
    expect(flag.getAttribute('title')).toMatch(/not a valid config/i);
    // Only `version` is required; the two with defaults are not.
    expect(flag).not.toHaveTextContent(/install-dir|verbose/);
  });

  it('writes a required parameter into the step, converting it to the mapping form', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(JOB_WITH_BARE_ORB_STEP, 'build');
    const before = useAppStore.getState().text;

    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    // One click writes the key, after which it edits like any other field --
    // see `UnsetParamRow` for why an editable field seeded with a default
    // cannot do this job for a required parameter.
    fireEvent.click(screen.getByRole('button', { name: 'Set version' }));

    expect(useAppStore.getState().text).toMatch(/- act\/install:/);
    expect(useAppStore.getState().text).toMatch(/version:/);
    // Surgical: the rest of the file is untouched, comments and all.
    expect(useAppStore.getState().text).toContain('act: cci-labs/act@1.0.0');
    expect(useAppStore.getState().text).toContain('- checkout');

    // One discrete action, therefore one undo entry -- which restores the file
    // byte for byte.
    expect(useAppStore.getState().canUndo).toBe(true);
    act(() => {
      useAppStore.getState().undo();
    });
    expect(useAppStore.getState().text).toBe(before);
  });

  it('edits a parameter the step already sets', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(
      `
orbs:
  act: cci-labs/act@1.0.0
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - act/install:
          version: "0.2.60"
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );

    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    // Labelled as required, and editable in place rather than offered as unset.
    const field = screen.getByLabelText('version (required)');
    fireEvent.change(field, { target: { value: '0.2.61' } });
    fireEvent.blur(field);

    expect(useAppStore.getState().text).toContain('0.2.61');
    expect(screen.queryByTestId('step-required-unset')).not.toBeInTheDocument();
  });

  it('keeps a parameter the orb does not declare, labelled rather than dropped', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    await renderWithOrb(
      `
orbs:
  act: cci-labs/act@1.0.0
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - act/install:
          version: "0.2.60"
          legacy-flag: "yes"
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );

    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    // The pinned version may have renamed or removed it; hiding it would make
    // this pane a worse view of the file than the file.
    expect(screen.getByLabelText('legacy-flag')).toBeInTheDocument();
    expect(
      screen.getByText(/not declared by this version/i),
    ).toBeInTheDocument();
  });

  it('falls back to the already-set parameters, with the reason, when the orb cannot be fetched', async () => {
    stubOrbSource(null);
    await renderWithOrb(
      `
orbs:
  act: cci-labs/act@1.0.0
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - act/install:
          version: "0.2.60"
workflows:
  main:
    jobs:
      - build
`,
      'build',
    );

    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    expect(
      screen.getByText(/no CircleCI API token available/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('version')).toBeInTheDocument();
    // Never "this command has no parameters" just because the lookup failed,
    // and never a required-parameter flag it has no basis for.
    //
    // Scoped to the step row rather than the document: issue #250 added a
    // "Declared parameters" section for the *job*, whose empty state also reads
    // "declares no parameters ... of its own yet". That is a different section
    // about a different thing, and a document-wide query cannot tell them apart
    // -- so this asserts about the command, which is what the case is about.
    expect(
      within(stepRow('install')).queryByText(/declares no parameters/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-required-unset')).not.toBeInTheDocument();
  });

  it('adds no scrollable region, even for the expanded parameter editor (issue #88)', async () => {
    stubOrbSource(ACT_ORB_SOURCE);
    const { container } = await renderWithOrb(JOB_WITH_BARE_ORB_STEP, 'build');
    fireEvent.click(
      within(stepRow('install')).getByRole('button', {
        name: /expand install/i,
      }),
    );

    // A 42-parameter orb is exactly where a nested scroller appears by
    // accident. The steps list is already one of the two scroll regions this
    // inspector has; nothing inside a row may add another.
    for (const row of container.querySelectorAll('li')) {
      for (const element of row.querySelectorAll('*')) {
        expect(element.className.toString()).not.toMatch(
          /\boverflow-(y|x)?-?(auto|scroll)\b/,
        );
      }
    }
  });
});

/**
 * Issue #252 part 1: the orb-job note was technically true and practically
 * misleading, and the parameters it referred to were far enough down the pane to
 * be missed.
 *
 * > *"When I go to the job, you don't have the ability to edit those. I don't
 * > see them. Oh, wait, maybe I do if you scroll down… Okay, I guess you do have
 * > those parameters."*
 *
 * The wording is asserted where the note is rendered (see 'shows a read-only
 * summary (not a form) for an orb-provided job'). What is asserted here is the
 * layout half, because rewording alone would have left the scroll.
 */
describe('Inspector -- an orb job leads with its parameters (issue #252)', () => {
  const ORB_JOB_YAML = `
orbs:
  act: cci-labs/act@1.0.0
workflows:
  main:
    jobs:
      - act/run-act:
          context: build-secrets
          post-steps:
            - run: echo done
`;

  const ORB_SOURCE = `
jobs:
  run-act:
    parameters:
      workflow:
        type: string
      runner-image:
        type: string
        default: catthehacker/ubuntu:act-latest
    steps:
      - run: echo running
`;

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
    window.localStorage.clear();
    useInspectorSectionStore.setState({ open: {} });
    useOrbStore.setState({ parsedOrbs: {}, orbVersionsCache: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation((input: RequestInfo | URL) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).startsWith('/api/orbs/source')
                ? {
                    available: true,
                    name: 'cci-labs/act',
                    version: '1.0.0',
                    source: ORB_SOURCE,
                  }
                : {},
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the parameters section above Context, Filters and the step sections', async () => {
    const { doc, node } = setup(ORB_JOB_YAML, 'act/run-act');
    const { container } = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const headings = [
      ...container.querySelectorAll<HTMLElement>('h4, summary h4'),
    ].map((h) => h.textContent?.trim() ?? '');

    const params = headings.indexOf('Orb job parameters');
    expect(params).toBeGreaterThanOrEqual(0);
    for (const later of ['Context', 'Filters', 'Pre-steps', 'Post-steps']) {
      expect(headings.indexOf(later)).toBeGreaterThan(params);
    }
  });

  it('puts the parameters immediately after the note that explains the missing steps', async () => {
    const { doc, node } = setup(ORB_JOB_YAML, 'act/run-act');
    const { container } = render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const note = screen.getByText(/steps and executor live inside the "act"/i);
    const paramsHeading = screen.getByRole('heading', {
      name: 'Orb job parameters',
    });
    // "Below" in the note has to mean the next thing, not four sections later.
    expect(
      note.compareDocumentPosition(paramsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const sections = [...container.querySelectorAll('section')];
    const paramsSection = paramsHeading.closest('section');
    expect(sections.indexOf(paramsSection as HTMLElement)).toBe(0);
  });
});

/**
 * Issue #250's **job** scope: a job's own `parameters:` declaration, editable in
 * the inspector because that is where a job is edited. The palette's Parameters
 * section covers the pipeline scope and `PaletteParameterSection.test.tsx`
 * covers it there; between them, both scopes named in the issue are exercised in
 * the pane a user actually reaches them from.
 */
describe('declared parameters (issue #250)', () => {
  const PARAMETERIZED = `
jobs:
  build:
    parameters:
      target:
        type: enum
        enum:
          - debug
          - release
        default: debug
    docker: []
    steps:
      - run: pnpm build --mode << parameters.target >>
workflows:
  main:
    jobs:
      - build:
          target: release
`;

  beforeEach(() => {
    window.localStorage.clear();
    useConfirmStore.setState({ suppressed: [] });
  });

  /** Renders the inspector for `build` from the store's current text. */
  function renderBuild() {
    const { doc, node } = fromStore('build');
    return render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={node}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
  }

  /** Seeds the store, stubs the schema with the shared fixture, renders, and flushes the fetch. */
  async function open() {
    __resetCircleciSchemaCacheForTests();
    vi.stubGlobal('fetch', jsonFetchStub(FIXTURE_RAW_SCHEMA));
    setup(PARAMETERIZED, 'build');
    const rendered = renderBuild();
    await act(async () => {
      await Promise.resolve();
    });
    return rendered;
  }

  it('shows the job’s own declaration as editable fields, separately from the entry’s values', async () => {
    await open();

    // The declaration section...
    expect(
      screen.getByRole('heading', { name: 'Declared parameters' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name of target')).toHaveValue('target');
    expect(screen.getByLabelText('Type of target')).toHaveValue('enum');
    // ...and the pre-existing invocation-values section, which is a different
    // thing (issue #37) and must not have been replaced by it.
    expect(
      screen.getByRole('heading', { name: 'Job parameters' }),
    ).toBeInTheDocument();
  });

  it('offers the element type set, which includes types a pipeline parameter cannot have', async () => {
    await open();
    const select = screen.getByLabelText<HTMLSelectElement>('Type of target');
    const values = [...select.options].map((option) => option.value);
    expect(values).toContain('steps');
    expect(values).toContain('env_var_name');
    expect(values).toContain('executor');
  });

  it('adds a job parameter with only the type chosen', async () => {
    await open();

    fireEvent.change(screen.getByLabelText('Name of the new parameter'), {
      target: { value: 'verbose' },
    });
    fireEvent.change(screen.getByLabelText('Type of the new parameter'), {
      target: { value: 'boolean' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));

    const { doc } = useAppStore.getState();
    expect(getIn(doc!, ['jobs', 'build', 'parameters', 'verbose'])).toEqual({
      type: 'boolean',
    });
  });

  it('renames the declaration, the reference and the invocation key as ONE undo step', async () => {
    await open();
    useAppStore.setState({ undoStack: [], redoStack: [], canUndo: false });

    const input = screen.getByLabelText('Name of target');
    fireEvent.change(input, { target: { value: 'flavour' } });
    fireEvent.blur(input);

    // The prompt enumerates the sites first -- every parameter reference is
    // somewhere the user cannot see from this field.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'jobs.build.steps.0.run: << parameters.target >> becomes << parameters.flavour >>',
    );
    expect(dialog).toHaveTextContent(
      'workflow "main": "build" passes this parameter -- that key becomes flavour',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    const text = useAppStore.getState().text;
    expect(text).toContain('      flavour:');
    expect(text).toContain('pnpm build --mode << parameters.flavour >>');
    expect(text).toContain('flavour: release');
    expect(text).not.toContain('target');

    // Three sites, one history entry.
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    act(() => {
      useAppStore.getState().undo();
    });
    expect(useAppStore.getState().text).toBe(PARAMETERIZED);
  });

  it('keeps the enum values when the type moves off enum, and only discards them on request', async () => {
    const { unmount } = await open();

    fireEvent.change(screen.getByLabelText('Type of target'), {
      target: { value: 'string' },
    });
    expect(
      getIn(useAppStore.getState().doc!, [
        'jobs',
        'build',
        'parameters',
        'target',
        'enum',
      ]),
    ).toEqual(['debug', 'release']);
    unmount();

    // The editor says they are now inert and offers one explicit discard.
    renderBuild();
    expect(
      screen.getByText(/no longer constrain anything/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Discard the unused allowed values of target',
      }),
    );
    expect(
      getIn(useAppStore.getState().doc!, [
        'jobs',
        'build',
        'parameters',
        'target',
      ]),
    ).toEqual({ type: 'string', default: 'debug' });
  });

  it('removing a parameter names the references it deliberately leaves dangling', async () => {
    await open();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove parameter target' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'Removing the parameter of job "build" target changes 2 places, and leaves 1 reference pointing at nothing.',
    );
    expect(dialog).toHaveTextContent(/Substituting the default there would be/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const text = useAppStore.getState().text;
    expect(text).not.toContain('      target:');
    // The reference stays exactly as written -- the compiler reports it, we do
    // not invent a replacement.
    expect(text).toContain('pnpm build --mode << parameters.target >>');
  });
});

/**
 * Issue #288: the workflow-level body, rendered instead of a job's own
 * whenever `workflowSelected` is true and `node` is `null`. `node` winning
 * whenever both happen to be set is asserted directly here rather than only
 * trusted from `appStore`'s own mutual-exclusivity tests -- that guarantee
 * only helps if this component actually honours it.
 */
describe('Inspector -- the workflow-level body (issue #288)', () => {
  const WORKFLOW_YAML = `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    when: << pipeline.parameters.run-it >>
    triggers:
      - schedule:
          cron: "0 9 * * 1-5"
          filters:
            branches:
              only: main
    max_auto_reruns: 2
    jobs:
      - build
  empty:
    jobs:
      - build
`;

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderWorkflow(
    workflowName: string,
    overrides: { node?: GraphNode | null; workflowSelected?: boolean } = {},
  ) {
    const { doc, error } = parseConfig(WORKFLOW_YAML);
    if (error || !doc) throw new Error(`fixture failed to parse: ${error}`);
    useAppStore.setState({
      doc,
      text: WORKFLOW_YAML,
      savedText: WORKFLOW_YAML,
    });
    return render(
      <Inspector
        doc={doc}
        workflowName={workflowName}
        node={overrides.node ?? null}
        workflowSelected={overrides.workflowSelected ?? true}
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
  }

  it('shows the workflow name, its when: condition, its trigger, and max_auto_reruns', () => {
    renderWorkflow('main');
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('workflow')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('<< pipeline.parameters.run-it >>'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('0 9 * * 1-5')).toBeInTheDocument();
    expect(screen.getByLabelText('max_auto_reruns')).toHaveValue(2);
  });

  it('offers to add when:/unless: for a workflow with neither', () => {
    renderWorkflow('empty');
    expect(
      screen.getByRole('button', { name: 'Add “when”' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add “unless”' }),
    ).toBeInTheDocument();
  });

  it('setting when: on a workflow with neither writes it surgically', () => {
    renderWorkflow('empty');
    fireEvent.click(screen.getByRole('button', { name: 'Add “when”' }));
    expect(
      getIn(useAppStore.getState().doc!, ['workflows', 'empty', 'when']),
    ).toBe('');
  });

  it('warns, but does not block, when both when: and unless: are set', () => {
    const badYaml = WORKFLOW_YAML.replace(
      'when: << pipeline.parameters.run-it >>',
      'when: << pipeline.parameters.run-it >>\n    unless: << pipeline.parameters.skip-it >>',
    );
    const { doc, error } = parseConfig(badYaml);
    if (error || !doc) throw new Error(`fixture failed to parse: ${error}`);
    useAppStore.setState({ doc, text: badYaml, savedText: badYaml });
    render(
      <Inspector
        doc={doc}
        workflowName="main"
        node={null}
        workflowSelected
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    expect(
      screen.getByText(/does not allow both at once/i),
    ).toBeInTheDocument();
    // Still editable -- the warning does not disable the field.
    expect(
      screen.getByDisplayValue('<< pipeline.parameters.run-it >>'),
    ).toBeEnabled();
  });

  it('adding a schedule trigger via the button is undoable as one mutate() call', () => {
    renderWorkflow('empty');
    const before = useAppStore.getState().undoStack.length;
    fireEvent.click(
      screen.getByRole('button', { name: 'Add a schedule trigger' }),
    );
    expect(useAppStore.getState().undoStack.length).toBe(before + 1);
    expect(
      getIn(useAppStore.getState().doc!, [
        'workflows',
        'empty',
        'triggers',
        0,
        'schedule',
        'cron',
      ]),
    ).toBe('0 0 * * *');
  });

  it('flags a malformed cron without refusing the edit (warn, do not block)', () => {
    renderWorkflow('main');
    const cronInput = screen.getByDisplayValue('0 9 * * 1-5');
    fireEvent.change(cronInput, { target: { value: '99 9 * * 1-5' } });
    expect(screen.getByText(/Malformed cron/i)).toBeInTheDocument();
    // Blurring still commits the (invalid) text -- warn, don't block.
    fireEvent.blur(cronInput);
    expect(
      getIn(useAppStore.getState().doc!, [
        'workflows',
        'main',
        'triggers',
        0,
        'schedule',
        'cron',
      ]),
    ).toBe('99 9 * * 1-5');
  });

  it("treats a pipeline-value cron as 'can't verify', not wrong", () => {
    renderWorkflow('main');
    const cronInput = screen.getByDisplayValue('0 9 * * 1-5');
    fireEvent.change(cronInput, {
      target: { value: '<< pipeline.parameters.cron >>' },
    });
    expect(screen.getByText(/Can't verify this cron/i)).toBeInTheDocument();
    expect(screen.queryByText(/Malformed cron/i)).not.toBeInTheDocument();
  });

  it('a job selection wins over workflowSelected when both are somehow set', () => {
    const { node } = setup(SIMPLE_JOB_YAML, 'build');
    render(
      <Inspector
        doc={node ? useAppStore.getState().doc! : null}
        workflowName="main"
        node={node}
        workflowSelected
        onRequestDelete={() => {}}
        autoFocusName={false}
      />,
    );
    // The job body, not the workflow body.
    expect(screen.getByLabelText(/^job name$/i)).toHaveValue('build');
    expect(screen.queryByText('max_auto_reruns')).not.toBeInTheDocument();
  });

  it('shows the "select a job" placeholder when nothing is selected at all', () => {
    renderWorkflow('main', { workflowSelected: false });
    expect(screen.getByText(/select a job in the graph/i)).toBeInTheDocument();
    expect(screen.queryByText('workflow')).not.toBeInTheDocument();
  });
});
