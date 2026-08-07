import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWorkflowGraph } from '~/lib/graph/buildGraph';
import type { OrbElement } from '~/lib/orbs/types';
import { getIn, parseConfig } from '~/lib/yaml/documentUtils';
import { useAppStore } from '~/state/appStore';

import { useOrbInsertion } from './useOrbInsertion';

const BASE_YAML = `
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
      - deploy:
          requires:
            - build
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

const NO_PARAMS_JOB: OrbElement = { name: 'test', kind: 'job', parameters: [] };

const REQUIRED_PARAM_COMMAND: OrbElement = {
  name: 'install-packages',
  kind: 'command',
  parameters: [{ name: 'pkg-manager', type: 'string', required: true }],
};

const REQUIRED_PARAM_EXECUTOR: OrbElement = {
  name: 'default',
  kind: 'executor',
  parameters: [{ name: 'tag', type: 'string', required: true }],
};

describe('useOrbInsertion', () => {
  beforeEach(() => {
    seed(BASE_YAML);
  });

  afterEach(() => {
    useAppStore.setState(RESET_STATE);
  });

  it('inserts an orb job with no required params immediately, adding orbs: and the workflow entry', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.insertJob('circleci/node@5.2.0', NO_PARAMS_JOB);
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.0');
    const jobs = getIn(doc, ['workflows', 'main', 'jobs']) as unknown[];
    expect(jobs).toContain('node/test');
    expect(result.current.pendingElement).toBeNull();
  });

  it('opens the parameter dialog for a command with a required parameter instead of inserting immediately', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.insertCommand(
        'circleci/node@5.2.0',
        REQUIRED_PARAM_COMMAND,
        'build',
      );
    });

    expect(result.current.pendingElement).toEqual(REQUIRED_PARAM_COMMAND);
    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['orbs'])).toBeUndefined(); // nothing written yet

    act(() => {
      result.current.confirmPending({ 'pkg-manager': 'yarn' });
    });

    const updatedDoc = useAppStore.getState().doc!;
    expect(getIn(updatedDoc, ['orbs', 'node'])).toBe('circleci/node@5.2.0');
    expect(getIn(updatedDoc, ['jobs', 'build', 'steps', 1])).toEqual({
      'node/install-packages': { 'pkg-manager': 'yarn' },
    });
    expect(result.current.pendingElement).toBeNull();
  });

  it('cancelling the pending dialog inserts nothing', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.insertCommand(
        'circleci/node@5.2.0',
        REQUIRED_PARAM_COMMAND,
        'build',
      );
    });
    act(() => {
      result.current.cancelPending();
    });

    expect(result.current.pendingElement).toBeNull();
    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['orbs'])).toBeUndefined();
  });

  it('inserts an orb executor immediately even with required params (no dialog -- see module doc)', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.insertExecutor(
        'circleci/node@5.2.0',
        REQUIRED_PARAM_EXECUTOR,
        'build',
      );
    });

    expect(result.current.pendingElement).toBeNull();
    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'build', 'executor'])).toBe('node/default');
  });

  it('refuses to add a command to an approval node, without mutating the document', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));
    const doc = useAppStore.getState().doc!;
    const graph = buildWorkflowGraph(doc, 'main');
    const holdNode = graph.nodes.find((n) => n.id === 'hold')!;
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.dropOnJobNode(holdNode, {
        kind: 'command',
        orbRef: 'circleci/node@5.2.0',
        element: REQUIRED_PARAM_COMMAND,
      });
    });

    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(/approval/i);
    expect(result.current.pendingElement).toBeNull();
  });

  it('refuses to drop an orb job onto the canvas when there is no active workflow', () => {
    const { result } = renderHook(() => useOrbInsertion(undefined));
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.dropOnCanvas({
        kind: 'job',
        orbRef: 'circleci/node@5.2.0',
        element: NO_PARAMS_JOB,
      });
    });

    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(/workflow/i);
  });

  it('dropOnSteps inserts an orb command at the given index in the inspector-driven path', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.dropOnSteps('build', 0, {
        kind: 'command',
        orbRef: 'circleci/node@5.2.0',
        element:
          NO_PARAMS_JOB.parameters.length === 0
            ? { ...NO_PARAMS_JOB, kind: 'command' }
            : NO_PARAMS_JOB,
      });
    });

    const doc = useAppStore.getState().doc!;
    expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('node/test');
    expect(getIn(doc, ['jobs', 'build', 'steps', 1])).toBe('checkout');
  });

  /**
   * Issue #21: the pre-steps/post-steps counterpart of `dropOnSteps` above --
   * same drag payload, addressed at a workflow entry instead of a job.
   */
  it('dropOnEntrySteps inserts an orb command at the given index in a workflow entry’s pre-steps', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));

    act(() => {
      result.current.dropOnEntrySteps('main', 'deploy', 'pre-steps', 0, {
        kind: 'command',
        orbRef: 'circleci/node@5.2.0',
        element: { ...NO_PARAMS_JOB, kind: 'command' },
      });
    });

    const doc = useAppStore.getState().doc!;
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 2, 'deploy', 'pre-steps', 0]),
    ).toBe('node/test');
    // The sibling `requires:` -- deploy's only other option -- is untouched.
    expect(
      getIn(doc, ['workflows', 'main', 'jobs', 2, 'deploy', 'requires']),
    ).toEqual(['build']);
  });

  it('dropOnEntrySteps refuses anything other than a command, without mutating the document', () => {
    const { result } = renderHook(() => useOrbInsertion('main'));
    const textBefore = useAppStore.getState().text;

    act(() => {
      result.current.dropOnEntrySteps('main', 'deploy', 'post-steps', 0, {
        kind: 'job',
        orbRef: 'circleci/node@5.2.0',
        element: NO_PARAMS_JOB,
      });
    });

    expect(useAppStore.getState().text).toBe(textBefore);
    expect(useAppStore.getState().editError).toMatch(
      /only accepts orb commands/i,
    );
  });
});
