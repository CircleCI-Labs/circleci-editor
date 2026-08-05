import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWorkflowGraph } from '~/lib/graph/buildGraph';
import * as rpcClient from '~/lib/rpc/client';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import { useAppStore } from '~/state/appStore';
import {
  resetProjectContextStoreForTests,
  useProjectContextStore,
} from '~/state/projectContextStore';

import { usePaletteInsertion } from './usePaletteInsertion';

vi.mock('~/lib/rpc/client', () => ({
  getProjectContext: vi.fn<() => void>(),
  getContextVariables: vi.fn<() => void>(),
}));

const BASE_YAML = `
executors:
  py-executor:
    docker:
      - image: cimg/python:3.11.13
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

function seed(yamlText: string): void {
  const { doc, error } = parseConfig(yamlText);
  if (error || !doc) throw new Error(`fixture failed to parse: ${error}`);
  useAppStore.setState({
    ...RESET_STATE,
    doc,
    text: yamlText,
    savedText: yamlText,
  });
}

describe('usePaletteInsertion', () => {
  beforeEach(() => {
    seed(BASE_YAML);
  });

  afterEach(() => {
    useAppStore.setState(RESET_STATE);
  });

  it('openConfigureFor(builtin) opens the dialog with a unique default job name, and confirmPending creates the job + workflow entry in one call', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.openConfigureFor({
        source: 'builtin',
        builtinId: 'docker',
      });
    });

    expect(result.current.pendingItem).toMatchObject({
      source: 'builtin',
      defaultJobName: 'new-job',
    });

    act(() => {
      result.current.confirmPending({
        jobName: 'new-job',
        image: 'cimg/node:20.0',
        resourceClass: 'large',
      });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'new-job', 'docker', 0, 'image'])).toBe(
      'cimg/node:20.0',
    );
    expect(getIn(doc, ['jobs', 'new-job', 'resource_class'])).toBe('large');
    const jobs = getIn(doc, ['workflows', 'main', 'jobs']) as unknown[];
    expect(jobs).toContain('new-job');
    expect(result.current.pendingItem).toBeNull();
    expect(useAppStore.getState().selectedNodeId).toBe('new-job');
  });

  it('openConfigureFor(local) references the named executor, writing no image/resource_class', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.openConfigureFor({
        source: 'local',
        executorName: 'py-executor',
      });
    });
    act(() => {
      result.current.confirmPending({ jobName: 'lint' });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'lint', 'executor'])).toBe('py-executor');
    expect(getIn(doc, ['jobs', 'lint', 'docker'])).toBeUndefined();
  });

  it('openConfigureForOrbExecutor imports the orb and references its executor', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.openConfigureForOrbExecutor(
        'circleci/python@3.2.0',
        'default',
      );
    });
    act(() => {
      result.current.confirmPending({ jobName: 'py-lint' });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['orbs', 'python'])).toBe('circleci/python@3.2.0');
    expect(getIn(doc, ['jobs', 'py-lint', 'executor'])).toBe('python/default');
  });

  it('confirmPending with saveAsExecutorName saves a reusable executors: entry instead of inlining the fields', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.openConfigureFor({
        source: 'builtin',
        builtinId: 'macos',
      });
    });
    act(() => {
      result.current.confirmPending({
        jobName: 'ios-build',
        image: '15.3.0',
        saveAsExecutorName: 'ios-executor',
      });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['executors', 'ios-executor', 'macos', 'xcode'])).toBe(
      '15.3.0',
    );
    expect(getIn(doc, ['jobs', 'ios-build', 'executor'])).toBe('ios-executor');
  });

  it('creates a fresh workflow when there is none yet, and selects it (empty-config constraint)', () => {
    seed('version: 2.1\n');
    const { result } = renderHook(() => usePaletteInsertion(undefined));

    act(() => {
      result.current.openConfigureFor({
        source: 'builtin',
        builtinId: 'docker',
      });
    });
    act(() => {
      result.current.confirmPending({ jobName: 'build' });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['workflows', 'build-and-test', 'jobs'])).toEqual([
      'build',
    ]);
    expect(useAppStore.getState().selectedWorkflow).toBe('build-and-test');
  });

  it('calls onJobCreated with the new job name after confirmPending', () => {
    const onJobCreated = vi.fn<(jobName: string) => void>();
    const { result } = renderHook(() =>
      usePaletteInsertion('main', onJobCreated),
    );

    act(() => {
      result.current.openConfigureFor({
        source: 'builtin',
        builtinId: 'docker',
      });
    });
    act(() => {
      result.current.confirmPending({ jobName: 'new-job' });
    });

    expect(onJobCreated).toHaveBeenCalledWith('new-job');
  });

  it("dropStepOnJobNode appends the step's default value to a defined job, but refuses on an approval node", () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));
    const doc = useAppStore.getState().doc!;
    const graph = buildWorkflowGraph(doc, 'main');
    const buildNode = graph.nodes.find((n) => n.id === 'build')!;
    const holdNode = graph.nodes.find((n) => n.id === 'hold')!;

    act(() => {
      result.current.dropStepOnJobNode(buildNode, 'store_artifacts');
    });
    expect(
      getIn(useAppStore.getState().doc!, [
        'jobs',
        'build',
        'steps',
        1,
        'store_artifacts',
        'path',
      ]),
    ).toBe('artifacts');

    const textBefore = useAppStore.getState().text;
    act(() => {
      result.current.dropStepOnJobNode(holdNode, 'checkout');
    });
    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(/approval/i);
  });

  /**
   * Issue #251: warn, do not block.
   *
   * The point of asserting the *document* here rather than only the notice is
   * that the requirement is about what did **not** happen -- the edit is not
   * gated on a restriction check, and nothing about a context this project may
   * not be allowed to use can prevent it. The notice is a consequence; the splice
   * is the contract.
   */
  describe('a restricted context is inserted anyway, and warned about (issue #251)', () => {
    beforeEach(() => {
      resetProjectContextStoreForTests();
      vi.mocked(rpcClient.getProjectContext).mockResolvedValue({
        available: true,
        contexts: [{ id: 'ctx-1', name: 'aws-prod' }],
        projectVariables: [],
      });
      vi.mocked(rpcClient.getContextVariables).mockResolvedValue({
        available: true,
        contextId: 'ctx-1',
        variables: [],
        usability: 'other-projects-only',
        restrictionSummary: 'restricted to 1 project',
        restrictions: [{ kind: 'project', name: 'some-other-project' }],
        projectIdentified: true,
      });
    });

    it('dropContextOnJobNode still writes the context, and raises the notice afterwards', async () => {
      await useProjectContextStore.getState().load();

      const { result } = renderHook(() => usePaletteInsertion('main'));
      const graph = buildWorkflowGraph(useAppStore.getState().doc!, 'main');
      const buildNode = graph.nodes.find((n) => n.id === 'build')!;

      await act(async () => {
        result.current.dropContextOnJobNode(buildNode, 'aws-prod');
      });

      // The edit happened. This is the assertion the requirement is about.
      expect(useAppStore.getState().text).toContain('aws-prod');
      // And it was not reported as a refusal.
      expect(useAppStore.getState().editError).toBeNull();

      const notice = useProjectContextStore.getState().restrictionNotice;
      expect(notice?.contextName).toBe('aws-prod');
      expect(notice?.certainty).toBe('refused');
    });

    it('addContextToJobEntry, the keyboard path, warns identically', async () => {
      await useProjectContextStore.getState().load();

      const { result } = renderHook(() => usePaletteInsertion('main'));

      await act(async () => {
        result.current.addContextToJobEntry('build', 'aws-prod');
      });

      expect(useAppStore.getState().text).toContain('aws-prod');
      expect(
        useProjectContextStore.getState().restrictionNotice?.certainty,
      ).toBe('refused');
    });

    it('raises no notice when the edit was actually refused, because nothing was added', async () => {
      await useProjectContextStore.getState().load();

      const { result } = renderHook(() => usePaletteInsertion('main'));
      const graph = buildWorkflowGraph(useAppStore.getState().doc!, 'main');
      const holdNode = graph.nodes.find((n) => n.id === 'hold')!;
      const textBefore = useAppStore.getState().text;

      await act(async () => {
        result.current.dropContextOnJobNode(holdNode, 'aws-prod');
      });

      expect(useAppStore.getState().text).toBe(textBefore);
      expect(useAppStore.getState().editError).toMatch(/approval/i);
      expect(useProjectContextStore.getState().restrictionNotice).toBeNull();
    });
  });

  it('dropStepOnSteps inserts at the given index', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.dropStepOnSteps('build', 0, 'checkout');
    });

    expect(
      getIn(useAppStore.getState().doc!, ['jobs', 'build', 'steps', 0]),
    ).toBe('checkout');
    expect(
      getIn(useAppStore.getState().doc!, ['jobs', 'build', 'steps', 1]),
    ).toBe('checkout');
  });

  it('addStepToJob (the JobPicker keyboard path) appends to the named job', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.addStepToJob('build', 'store_test_results');
    });

    expect(
      getIn(useAppStore.getState().doc!, [
        'jobs',
        'build',
        'steps',
        1,
        'store_test_results',
        'path',
      ]),
    ).toBe('test-results');
  });

  it('refuseStepOnCanvas and refuseExecutorOnJobNode surface a message without mutating the document', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.refuseStepOnCanvas();
    });
    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(/job node/i);

    act(() => {
      result.current.refuseExecutorOnJobNode();
    });
    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(/canvas background/i);
  });

  it('addCommandToJob (issue #79 Commands palette section) appends a bare reference to the named job', () => {
    seed(`commands:
  ci-setup:
    steps:
      - checkout
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
`);
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.addCommandToJob('build', 'ci-setup');
    });

    expect(
      getIn(useAppStore.getState().doc!, ['jobs', 'build', 'steps']),
    ).toEqual(['checkout', 'ci-setup']);
  });

  it('extractExecutor (issue #79 duplicate-executor suggestion) performs the extraction as one mutation', () => {
    seed(`jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  test:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - test
`);
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.extractExecutor(['build', 'test'], 'base-executor');
    });

    const doc = useAppStore.getState().doc!;
    expect(
      getIn(doc, ['executors', 'base-executor', 'docker', 0, 'image']),
    ).toBe('cimg/base:current');
    expect(getIn(doc, ['jobs', 'build', 'executor'])).toBe('base-executor');
    expect(getIn(doc, ['jobs', 'test', 'executor'])).toBe('base-executor');
  });

  it('extractExecutor surfaces a refusal via editError, without mutating, when the jobs no longer match', () => {
    seed(`jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  test:
    docker:
      - image: cimg/other:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - test
`);
    const { result } = renderHook(() => usePaletteInsertion('main'));
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.extractExecutor(['build', 'test'], 'base-executor');
    });

    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(
      /no longer have identical/i,
    );
  });

  it('extractCommand (issue #79 duplicate-steps suggestion) performs the extraction as one mutation', () => {
    seed(`jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
      - run: npm ci
  test:
    docker:
      - image: cimg/python:3.12
    steps:
      - checkout
      - run: npm ci
workflows:
  main:
    jobs:
      - build
      - test
`);
    const { result } = renderHook(() => usePaletteInsertion('main'));

    act(() => {
      result.current.extractCommand(['build', 'test'], 'ci-setup');
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['commands', 'ci-setup', 'steps'])).toEqual([
      'checkout',
      { run: 'npm ci' },
    ]);
    expect(getIn(doc, ['jobs', 'build', 'steps'])).toEqual(['ci-setup']);
    expect(getIn(doc, ['jobs', 'test', 'steps'])).toEqual(['ci-setup']);
  });

  it('cancelPending clears the pending item without touching the document', () => {
    const { result } = renderHook(() => usePaletteInsertion('main'));
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.openConfigureFor({
        source: 'builtin',
        builtinId: 'docker',
      });
    });
    act(() => {
      result.current.cancelPending();
    });

    expect(result.current.pendingItem).toBeNull();
    expect(useAppStore.getState().text).toBe(textBefore);
  });
});
