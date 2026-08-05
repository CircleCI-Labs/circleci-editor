import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePolicyStore } from './policyStore';

import { useAppStore } from './appStore';

const META = {
  version: '0.1.0',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  projectSlug: 'gh/acme/widgets',
  hasToken: true,
  host: 'localhost:8080',
  cwd: '/repo',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Every `setText`/`mutate`/`load()` call now also schedules a debounced
 * `revalidate()`, which -- if a test advances fake timers far enough --
 * calls `fetch('/api/validate', ...)` on its own, and (issue #247) fires
 * `fetch('/api/policy/decide', ...)` from the very same debounce. Routing
 * both to canned responses here (instead of letting either consume from the
 * same FIFO queue as the test's real assertions) keeps every pre-existing
 * test oblivious to both; tests that care about one specifically pass their
 * own `validate`/`policy` responses.
 */
function mockFetchSequence(
  responses: Response[],
  options: { validate?: Response[]; policy?: Response[] } = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queue = [...responses];
  const validateQueue = options.validate ? [...options.validate] : undefined;
  const policyQueue = options.policy ? [...options.policy] : undefined;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/validate')) {
      const next =
        validateQueue?.shift() ??
        jsonResponse(200, {
          available: false,
          source: 'unavailable',
          valid: false,
          reason: 'no token in this test',
        });
      return Promise.resolve(next);
    }
    if (url.includes('/api/policy/decide')) {
      const next =
        policyQueue?.shift() ??
        jsonResponse(200, {
          available: false,
          source: 'unavailable',
          reason: 'no token in this test',
        });
      return Promise.resolve(next);
    }
    const next = queue.shift();
    if (!next) {
      throw new Error('no more mocked responses');
    }
    return Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** How many times `fetchMock` was called against a given path, ignoring `/api/validate` noise. */
function callsTo(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  path: string,
): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === path)
    .length;
}

describe('appStore', () => {
  beforeEach(() => {
    // Fake timers by default: `revalidate()` now schedules a real
    // `setTimeout` on every edit, and a test that never advances timers
    // must never let that timer actually fire (with real timers it always
    // would, ~800ms later, possibly after the test itself has finished).
    vi.useFakeTimers();
    useAppStore.setState({
      meta: null,
      configPath: '',
      files: [],
      filesError: null,
      docCache: {},
      doc: null,
      text: '',
      savedText: '',
      parseError: null,
      isDirty: false,
      status: 'loading',
      error: null,
      autosave: false,
      selectedWorkflow: null,
      dagDirection: 'RIGHT',
      selectedNodeId: null,
      workflowSelected: false,
      validation: { state: 'idle', errors: [] },
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
      editError: null,
    });
    // Issue #247: `revalidate()`'s debounce now reaches into this module-
    // level singleton too, so a decision (or an in-flight `pendingText`)
    // left over from one test must not change whether the next test's
    // `evaluateInBackground` call decides there is nothing new to ask.
    usePolicyStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('load() populates meta, text, and a parsed doc from the API', async () => {
    mockFetchSequence([
      jsonResponse(200, META),
      jsonResponse(200, {
        path: META.configPath,
        contents: 'version: 2.1\n',
        exists: true,
      }),
    ]);

    await useAppStore.getState().load();

    const state = useAppStore.getState();
    expect(state.meta).toEqual(META);
    expect(state.text).toBe('version: 2.1\n');
    expect(state.savedText).toBe('version: 2.1\n');
    expect(state.isDirty).toBe(false);
    expect(state.status).toBe('ready');
    expect(state.parseError).toBeNull();
    expect(state.doc).not.toBeNull();
    expect(state.doc?.toString()).toBe('version: 2.1\n');
  });

  it('load() surfaces API failures as an error status', async () => {
    mockFetchSequence([
      jsonResponse(500, { error: { message: 'boom' } }),
      jsonResponse(200, { path: '', contents: '', exists: false }),
    ]);

    await useAppStore.getState().load();

    const state = useAppStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('boom');
  });

  it('setText marks the document dirty when it diverges from savedText', () => {
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 1\n',
      isDirty: false,
    });

    useAppStore.getState().setText('a: 2\n');
    expect(useAppStore.getState().isDirty).toBe(true);

    useAppStore.getState().setText('a: 1\n');
    expect(useAppStore.getState().isDirty).toBe(false);
  });

  it('setText re-parses valid YAML into a new doc', () => {
    useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
    useAppStore.getState().setText('a: 2\nb: 3\n');

    const state = useAppStore.getState();
    expect(state.parseError).toBeNull();
    expect(state.doc?.toString()).toBe('a: 2\nb: 3\n');
  });

  it('setText on invalid YAML sets parseError, keeps the text, and leaves doc untouched', () => {
    useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
    useAppStore.getState().setText('a: 1\n'); // establish a real doc first
    const priorDoc = useAppStore.getState().doc;
    expect(priorDoc).not.toBeNull();

    useAppStore.getState().setText('foo: [1, 2\n');

    const state = useAppStore.getState();
    expect(state.text).toBe('foo: [1, 2\n');
    expect(state.parseError).not.toBeNull();
    expect(state.doc).toBe(priorDoc);
  });

  it('mutate() clones doc to a new reference and re-derives text from it', () => {
    useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
    useAppStore.getState().setText('a: 1\n');
    const priorDoc = useAppStore.getState().doc;
    expect(priorDoc).not.toBeNull();

    useAppStore.getState().mutate((doc) => {
      doc.set('a', 2);
    });

    const state = useAppStore.getState();
    expect(state.doc).not.toBe(priorDoc);
    expect(state.text).toBe('a: 2\n');
    expect(state.isDirty).toBe(true);
  });

  it('mutate() is a no-op (and reports a problem) when there is no doc or a parse error', () => {
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 1\n',
      doc: null,
      parseError: null,
    });

    useAppStore.getState().mutate((doc) => {
      doc.set('a', 2);
    });

    const state = useAppStore.getState();
    expect(state.text).toBe('a: 1\n');
    expect(state.error).not.toBeNull();
  });

  it('mutate() leaves doc/text completely unchanged and sets editError when the mutation throws', () => {
    useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
    useAppStore.getState().setText('a: 1\n'); // seed a real doc
    const priorDoc = useAppStore.getState().doc;
    const priorText = useAppStore.getState().text;
    const priorUndoStackLength = useAppStore.getState().undoStack.length;

    useAppStore.getState().mutate(() => {
      throw new Error('would create a cycle');
    });

    const state = useAppStore.getState();
    expect(state.doc).toBe(priorDoc);
    expect(state.text).toBe(priorText);
    expect(state.editError).toBe('would create a cycle');
    // The failed attempt must not itself become an undo entry.
    expect(state.undoStack).toHaveLength(priorUndoStackLength);
  });

  it('clearEditError() clears a surfaced mutation error', () => {
    useAppStore.setState({ editError: 'would create a cycle' });
    useAppStore.getState().clearEditError();
    expect(useAppStore.getState().editError).toBeNull();
  });

  /**
   * Issue #288's own stated risk: "selecting the workflow must not break
   * selecting a job, or clear a job selection surprisingly." The two
   * actions are kept mutually exclusive at the store level -- each one
   * clears the other's field -- so a caller (`DagPane`) never has to get
   * that invariant right on its own by remembering to clear both.
   */
  describe('selectNode / selectWorkflowEntity (issue #288)', () => {
    it('selectNode(id) selects a job and clears workflowSelected', () => {
      useAppStore.setState({ workflowSelected: true, selectedNodeId: null });
      useAppStore.getState().selectNode('build');
      const state = useAppStore.getState();
      expect(state.selectedNodeId).toBe('build');
      expect(state.workflowSelected).toBe(false);
    });

    it('selectWorkflowEntity() selects the workflow and clears selectedNodeId', () => {
      useAppStore.setState({
        workflowSelected: false,
        selectedNodeId: 'build',
      });
      useAppStore.getState().selectWorkflowEntity();
      const state = useAppStore.getState();
      expect(state.workflowSelected).toBe(true);
      expect(state.selectedNodeId).toBeNull();
    });

    it('selectNode(null) clears both -- "nothing selected" is not "the workflow"', () => {
      useAppStore.setState({ workflowSelected: true, selectedNodeId: 'build' });
      useAppStore.getState().selectNode(null);
      const state = useAppStore.getState();
      expect(state.selectedNodeId).toBeNull();
      expect(state.workflowSelected).toBe(false);
    });

    it('the two are never simultaneously true through any sequence of calls', () => {
      const { selectNode, selectWorkflowEntity } = useAppStore.getState();
      selectWorkflowEntity();
      selectNode('test');
      let state = useAppStore.getState();
      expect(state.selectedNodeId).toBe('test');
      expect(state.workflowSelected).toBe(false);

      selectWorkflowEntity();
      state = useAppStore.getState();
      expect(state.selectedNodeId).toBeNull();
      expect(state.workflowSelected).toBe(true);
    });
  });

  describe('undo/redo', () => {
    it('a successful mutate() is undoable: undo() restores the prior text/doc and updates canUndo/canRedo', () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      useAppStore.getState().setText('a: 1\n'); // seed a real doc, own undo entry aside
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().mutate((doc) => {
        doc.set('a', 2);
      });
      expect(useAppStore.getState().text).toBe('a: 2\n');
      expect(useAppStore.getState().canUndo).toBe(true);
      expect(useAppStore.getState().canRedo).toBe(false);

      useAppStore.getState().undo();

      const state = useAppStore.getState();
      expect(state.text).toBe('a: 1\n');
      expect(state.doc?.toString()).toBe('a: 1\n');
      expect(state.canUndo).toBe(false);
      expect(state.canRedo).toBe(true);
    });

    it('redo() re-applies a change that was just undone', () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      useAppStore.getState().setText('a: 1\n');
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().mutate((doc) => {
        doc.set('a', 2);
      });
      useAppStore.getState().undo();
      expect(useAppStore.getState().text).toBe('a: 1\n');

      useAppStore.getState().redo();

      const state = useAppStore.getState();
      expect(state.text).toBe('a: 2\n');
      expect(state.canUndo).toBe(true);
      expect(state.canRedo).toBe(false);
    });

    it('undo() is a no-op when there is nothing to undo', () => {
      useAppStore.setState({
        text: 'a: 1\n',
        savedText: 'a: 1\n',
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().undo();

      const state = useAppStore.getState();
      expect(state.text).toBe('a: 1\n');
      expect(state.canUndo).toBe(false);
    });

    it('undo() itself never pushes a new undo entry', () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      useAppStore.getState().setText('a: 1\n');
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().mutate((doc) => {
        doc.set('a', 2);
      });
      expect(useAppStore.getState().undoStack).toHaveLength(1);

      useAppStore.getState().undo();
      // Undoing pops the one entry it just used; it must not also push a
      // fresh one for the state it's restoring *from*.
      expect(useAppStore.getState().undoStack).toHaveLength(0);
    });

    it('a new mutate() after undo() clears the redo stack (no redo past a fresh edit)', () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      useAppStore.getState().setText('a: 1\n');
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().mutate((doc) => doc.set('a', 2));
      useAppStore.getState().undo();
      expect(useAppStore.getState().canRedo).toBe(true);

      useAppStore.getState().mutate((doc) => doc.set('b', 3));

      expect(useAppStore.getState().canRedo).toBe(false);
      expect(useAppStore.getState().redoStack).toHaveLength(0);
    });

    it('the undo stack is bounded to 50 entries', () => {
      useAppStore.setState({ savedText: 'a: 0\n', text: 'a: 0\n' });
      useAppStore.getState().setText('a: 0\n');
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      for (let i = 1; i <= 60; i++) {
        useAppStore.getState().mutate((doc) => doc.set('a', i));
      }

      expect(useAppStore.getState().undoStack.length).toBeLessThanOrEqual(50);
    });

    it('setText() coalesces a burst of rapid typing into a single undo entry', () => {
      vi.useFakeTimers();
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      useAppStore.getState().setText('a: 1\n'); // seed a real doc
      vi.advanceTimersByTime(600); // let the seed call's own typing burst end
      useAppStore.setState({
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
      });

      useAppStore.getState().setText('a: 12\n');
      useAppStore.getState().setText('a: 123\n');
      useAppStore.getState().setText('a: 1234\n');
      expect(useAppStore.getState().undoStack).toHaveLength(1);
      expect(useAppStore.getState().text).toBe('a: 1234\n');

      // Advance past the ~500ms quiet gap, then type again: this starts a
      // *new* burst, so it gets its own entry.
      vi.advanceTimersByTime(600);
      useAppStore.getState().setText('a: 12345\n');
      expect(useAppStore.getState().undoStack).toHaveLength(2);

      // Undoing once restores the text from just before the *second* burst,
      // not one keystroke back.
      useAppStore.getState().undo();
      expect(useAppStore.getState().text).toBe('a: 1234\n');
    });
  });

  it('save() PUTs the current text and clears dirty state on success', async () => {
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 2\n',
      isDirty: true,
      status: 'ready',
    });
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { path: '/repo/.circleci/config.yml', bytes: 8 }),
    ]);

    await useAppStore.getState().save();

    const state = useAppStore.getState();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe(JSON.stringify({ contents: 'a: 2\n' }));
    expect(state.savedText).toBe('a: 2\n');
    expect(state.isDirty).toBe(false);
    expect(state.status).toBe('ready');
  });

  it('save() is a no-op when the document is not dirty', async () => {
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 1\n',
      isDirty: false,
      status: 'ready',
    });
    const fetchMock = mockFetchSequence([]);

    await useAppStore.getState().save();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces autosave and only fires while autosave is on and the doc is dirty', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 1\n',
      isDirty: false,
      status: 'ready',
      autosave: true,
    });
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { path: '/repo/.circleci/config.yml', bytes: 8 }),
    ]);

    useAppStore.getState().setText('a: 2\n');
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1200);

    expect(callsTo(fetchMock, '/api/config')).toBe(1);
    expect(useAppStore.getState().isDirty).toBe(false);
  });

  it('autosave also fires after a mutate() edit, bypassing any save dialog', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      savedText: 'a: 1\n',
      text: 'a: 1\n',
      isDirty: false,
      status: 'ready',
      autosave: true,
    });
    useAppStore.getState().setText('a: 1\n'); // seed a real doc
    const fetchMock = mockFetchSequence([
      jsonResponse(200, { path: '/repo/.circleci/config.yml', bytes: 8 }),
    ]);

    useAppStore.getState().mutate((doc) => {
      doc.set('a', 2);
    });
    await vi.advanceTimersByTimeAsync(1200);

    expect(callsTo(fetchMock, '/api/config')).toBe(1);
    expect(useAppStore.getState().isDirty).toBe(false);
  });

  describe('validation', () => {
    it('revalidate() debounces: rapid edits only produce one request, ~800ms after the last one', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      const fetchMock = mockFetchSequence([], {
        validate: [
          jsonResponse(200, {
            available: true,
            source: 'api',
            valid: true,
            outputYaml: 'a: 1\n',
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(400);
      useAppStore.getState().setText('a: 3\n');
      await vi.advanceTimersByTimeAsync(400);
      expect(callsTo(fetchMock, '/api/validate')).toBe(0);

      await vi.advanceTimersByTimeAsync(400);
      expect(callsTo(fetchMock, '/api/validate')).toBe(1);
      expect(useAppStore.getState().validation.state).toBe('valid');
    });

    it('available: false maps to the "unavailable" state, not "invalid"', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      mockFetchSequence([], {
        validate: [
          jsonResponse(200, {
            available: false,
            source: 'unavailable',
            valid: false,
            reason:
              'no CircleCI API token available; validation requires a token',
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800);

      const { validation } = useAppStore.getState();
      expect(validation.state).toBe('unavailable');
      expect(validation.reason).toContain('token');
      expect(validation.errors).toEqual([]);
    });

    it('valid: false maps to "invalid" and carries the error list', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      mockFetchSequence([], {
        validate: [
          jsonResponse(200, {
            available: true,
            source: 'api',
            valid: false,
            errors: [{ message: 'job "broken" not found: [#/jobs/broken]' }],
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800);

      const { validation } = useAppStore.getState();
      expect(validation.state).toBe('invalid');
      expect(validation.errors).toEqual([
        { message: 'job "broken" not found: [#/jobs/broken]' },
      ]);
    });

    it('a transport failure maps to the "error" state', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      mockFetchSequence([], {
        validate: [
          jsonResponse(502, {
            error: { message: 'CircleCI API rejected the configured token' },
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800);

      const { validation } = useAppStore.getState();
      expect(validation.state).toBe('error');
      expect(validation.reason).toContain('rejected');
    });

    // Issue #224: a rejected token must not read as the same "error" state
    // an unreachable API gets -- the two demand opposite fixes.
    it('available: false with source "unauthorized" maps to the "unauthorized" state, not "error" or "unavailable"', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      mockFetchSequence([], {
        validate: [
          jsonResponse(200, {
            available: false,
            source: 'unauthorized',
            valid: false,
            reason:
              'the CircleCI API rejected the configured token (HTTP 401).',
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800);

      const { validation } = useAppStore.getState();
      expect(validation.state).toBe('unauthorized');
      expect(validation.reason).toContain('401');
      expect(validation.errors).toEqual([]);
    });

    it('does not call the API while a local parse error is set', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });
      const fetchMock = mockFetchSequence([]);

      useAppStore.getState().setText('a: [1, 2\n'); // malformed
      expect(useAppStore.getState().parseError).not.toBeNull();
      await vi.advanceTimersByTimeAsync(800);

      expect(callsTo(fetchMock, '/api/validate')).toBe(0);
      expect(useAppStore.getState().validation.state).toBe('idle');
    });

    it('ignores a stale response that resolves after a newer request has already superseded it', async () => {
      useAppStore.setState({ savedText: 'a: 1\n', text: 'a: 1\n' });

      let resolveFirst!: (value: Response) => void;
      const firstResponse = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === 'string' ? input : String(input);
        if (!url.includes('/api/validate')) {
          throw new Error('unexpected non-validate fetch in this test');
        }
        if (fetchMock.mock.calls.length === 1) {
          return firstResponse;
        }
        return Promise.resolve(
          jsonResponse(200, {
            available: true,
            source: 'api',
            valid: false,
            errors: [{ message: 'second' }],
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800); // first request fires and is in flight

      useAppStore.getState().setText('a: 3\n');
      await vi.advanceTimersByTimeAsync(800); // second request fires and resolves

      expect(useAppStore.getState().validation.state).toBe('invalid');
      expect(useAppStore.getState().validation.errors).toEqual([
        { message: 'second' },
      ]);

      // The first (stale) request finally resolves as a *valid* result --
      // it must be ignored, or it would clobber the newer "invalid" state.
      resolveFirst(
        jsonResponse(200, {
          available: true,
          source: 'api',
          valid: true,
          outputYaml: 'a: 1\n',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(useAppStore.getState().validation.state).toBe('invalid');
    });
  });

  // Issue #106: "open any config in .circleci/". loadFiles populates the
  // directory index; switchFile is the "one Document per file, with
  // per-file dirty state" answer to that issue's own open question --
  // these tests exist specifically to pin down that switching away from a
  // dirty file and back never discards the edit.
  describe('loadFiles', () => {
    it('populates files from GET /api/config-files', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\n',
      });
      const filesResp = {
        dir: '/repo/.circleci',
        primaryPath: '/repo/.circleci/config.yml',
        files: [
          {
            path: '/repo/.circleci/config.yml',
            relPath: 'config.yml',
            size: 10,
            isPrimary: true,
          },
          {
            path: '/repo/.circleci/continue-config.yml',
            relPath: 'continue-config.yml',
            size: 20,
            isPrimary: false,
          },
        ],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, filesResp)),
      );

      await useAppStore.getState().loadFiles();

      expect(useAppStore.getState().files).toEqual(filesResp.files);
      expect(useAppStore.getState().filesError).toBeNull();
    });

    it('degrades to a single-entry list built from the open file when the request fails, rather than failing the whole app', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\n',
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } })),
      );

      await useAppStore.getState().loadFiles();

      const state = useAppStore.getState();
      expect(state.files).toEqual([
        {
          path: '/repo/.circleci/config.yml',
          relPath: 'config.yml',
          size: 'version: 2.1\n'.length,
          isPrimary: true,
          // The listing failed, which is no reason to start doubting that
          // the file already open in the editor is a config (issue #135).
          isConfig: true,
          configReason: 'The config file this editor opened.',
        },
      ]);
      expect(state.filesError).toBe('boom');
    });
  });

  describe('switchFile', () => {
    it('is a no-op when path is already the active file', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\n',
      });
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);

      await useAppStore.getState().switchFile('/repo/.circleci/config.yml');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches and opens a file never opened this session, resetting undo history and selection', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\n',
        savedText: 'version: 2.1\n',
        undoStack: ['old'],
        canUndo: true,
        selectedWorkflow: 'main',
        selectedNodeId: 'build',
      });
      mockFetchSequence([
        jsonResponse(200, {
          path: '/repo/.circleci/continue-config.yml',
          contents: 'version: 2.1\njobs: {}\n',
          exists: true,
        }),
      ]);

      await useAppStore
        .getState()
        .switchFile('/repo/.circleci/continue-config.yml');

      const state = useAppStore.getState();
      expect(state.configPath).toBe('/repo/.circleci/continue-config.yml');
      expect(state.text).toBe('version: 2.1\njobs: {}\n');
      expect(state.isDirty).toBe(false);
      expect(state.undoStack).toEqual([]);
      expect(state.canUndo).toBe(false);
      expect(state.selectedWorkflow).toBeNull();
      expect(state.selectedNodeId).toBeNull();

      // Leaving config.yml snapshotted its state, undo history included.
      const snapshot = state.docCache['/repo/.circleci/config.yml'];
      expect(snapshot).toBeDefined();
      expect(snapshot?.undoStack).toEqual(['old']);
    });

    it('never discards unsaved edits in the file being left -- switching away and back restores them exactly', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\nextra: true\n',
        savedText: 'version: 2.1\n',
        isDirty: true,
      });
      mockFetchSequence([
        jsonResponse(200, {
          path: '/repo/.circleci/continue-config.yml',
          contents: 'version: 2.1\n',
          exists: true,
        }),
      ]);

      await useAppStore
        .getState()
        .switchFile('/repo/.circleci/continue-config.yml');
      expect(useAppStore.getState().isDirty).toBe(false);

      // Switching back must not need a fetch at all -- it's cached.
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      await useAppStore.getState().switchFile('/repo/.circleci/config.yml');

      expect(fetchMock).not.toHaveBeenCalled();
      const state = useAppStore.getState();
      expect(state.text).toBe('version: 2.1\nextra: true\n');
      expect(state.isDirty).toBe(true);
    });

    it('surfaces a fetch failure as an error status, and leaves the file being left snapshotted rather than lost', async () => {
      useAppStore.setState({
        configPath: '/repo/.circleci/config.yml',
        text: 'version: 2.1\nextra: true\n',
        savedText: 'version: 2.1\n',
        isDirty: true,
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse(500, { error: { message: 'disk error' } }),
          ),
      );

      await useAppStore
        .getState()
        .switchFile('/repo/.circleci/continue-config.yml');

      const state = useAppStore.getState();
      expect(state.status).toBe('error');
      expect(state.error).toBe('disk error');
      expect(state.docCache['/repo/.circleci/config.yml']?.text).toBe(
        'version: 2.1\nextra: true\n',
      );
    });
  });

  // Issue #145: a file the host's own classifier says isn't a CircleCI
  // config (isConfig: false) must never be sent to POST /api/validate --
  // compiling e.g. goss.yaml against the CircleCI schema produces errors
  // that are noise about a file that was never a config to begin with.
  describe('a non-config open file (issue #145)', () => {
    it('skips the API call entirely and reports "not-a-config"', async () => {
      useAppStore.setState({
        savedText: 'command:\n  wait-for: {}\n',
        text: 'command:\n  wait-for: {}\n',
        configPath: '/repo/.circleci/goss.yaml',
        files: [
          {
            path: '/repo/.circleci/goss.yaml',
            relPath: 'goss.yaml',
            size: 30,
            isPrimary: false,
            isConfig: false,
            configReason:
              'No CircleCI structure: has "command:", not "commands:".',
          },
        ],
      });
      const fetchMock = mockFetchSequence([]);

      useAppStore.getState().setText('command:\n  wait-for: {port: 80}\n');
      await vi.advanceTimersByTimeAsync(800);

      expect(callsTo(fetchMock, '/api/validate')).toBe(0);
      const { validation } = useAppStore.getState();
      expect(validation.state).toBe('not-a-config');
      expect(validation.reason).toContain('command:');
    });

    it('still skips the API call even when the file also has a local YAML parse error', async () => {
      useAppStore.setState({
        savedText: 'command:\n  wait-for: {}\n',
        text: 'command:\n  wait-for: {}\n',
        configPath: '/repo/.circleci/goss.yaml',
        files: [
          {
            path: '/repo/.circleci/goss.yaml',
            relPath: 'goss.yaml',
            size: 30,
            isPrimary: false,
            isConfig: false,
            configReason:
              'No CircleCI structure: has "command:", not "commands:".',
          },
        ],
      });
      const fetchMock = mockFetchSequence([]);

      useAppStore.getState().setText('command: [1, 2\n'); // malformed YAML
      expect(useAppStore.getState().parseError).not.toBeNull();
      await vi.advanceTimersByTimeAsync(800);

      expect(callsTo(fetchMock, '/api/validate')).toBe(0);
      expect(useAppStore.getState().validation.state).toBe('not-a-config');
    });

    it('a config file (isConfig: true) validates normally, unaffected by other non-config entries in the list', async () => {
      useAppStore.setState({
        savedText: 'a: 1\n',
        text: 'a: 1\n',
        configPath: '/repo/.circleci/config.yml',
        files: [
          {
            path: '/repo/.circleci/config.yml',
            relPath: 'config.yml',
            size: 10,
            isPrimary: true,
            isConfig: true,
            configReason: 'Declares version: 2.1.',
          },
          {
            path: '/repo/.circleci/goss.yaml',
            relPath: 'goss.yaml',
            size: 30,
            isPrimary: false,
            isConfig: false,
            configReason: 'No CircleCI structure.',
          },
        ],
      });
      mockFetchSequence([], {
        validate: [
          jsonResponse(200, {
            available: true,
            source: 'api',
            valid: true,
            outputYaml: 'a: 1\n',
          }),
        ],
      });

      useAppStore.getState().setText('a: 2\n');
      await vi.advanceTimersByTimeAsync(800);

      expect(useAppStore.getState().validation.state).toBe('valid');
    });
  });
});
