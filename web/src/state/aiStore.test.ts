import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from './appStore';
import { useAiStore } from './aiStore';
import { usePolicyStore } from './policyStore';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RESET_STATE = {
  statusState: 'loading' as const,
  providers: [],
  storage: null,
  statusError: null,
  selectedProvider: '',
  messages: [],
  sending: false,
  chatError: null,
  savingKey: false,
  keyError: null,
  mcpStatus: null,
  mcpSaving: false,
  mcpError: null,
  directoryContext: { otherFiles: [], skippedFiles: [] },
  directoryContextStatus: 'idle' as const,
};

const FIXTURE_CONFIG = `version: 2.1
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
`;

/** Routes fetch calls by URL substring to a canned response queue, mirroring appStore.test.ts's own helper. */
function mockFetchByPath(
  routes: Record<string, Response[]>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queues = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, [...v]]),
  );
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === 'string' ? input : String(input);
    for (const [path, queue] of Object.entries(queues)) {
      if (url.includes(path)) {
        const next = queue.shift();
        if (!next) throw new Error(`no more mocked responses for ${path}`);
        return Promise.resolve(next);
      }
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('aiStore', () => {
  beforeEach(() => {
    useAiStore.setState(RESET_STATE);
    useAppStore.setState({
      savedText: FIXTURE_CONFIG,
      text: FIXTURE_CONFIG,
      doc: null,
      parseError: null,
    });
    useAppStore.getState().setText(FIXTURE_CONFIG); // seeds a real parsed doc
    usePolicyStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('loadStatus', () => {
    it('populates providers/storage and defaults selectedProvider to the first provider', async () => {
      mockFetchByPath({
        '/api/ai/status': [
          jsonResponse(200, {
            providers: [
              {
                id: 'anthropic',
                label: 'Anthropic',
                configured: false,
                model: 'claude-test',
              },
            ],
            storage: { backend: 'keychain', location: 'macOS Keychain' },
          }),
        ],
      });

      await useAiStore.getState().loadStatus();

      const state = useAiStore.getState();
      expect(state.statusState).toBe('ready');
      expect(state.providers).toHaveLength(1);
      expect(state.selectedProvider).toBe('anthropic');
      expect(state.storage).toEqual({
        backend: 'keychain',
        location: 'macOS Keychain',
      });
    });

    it('sets statusError on failure without touching providers', async () => {
      mockFetchByPath({
        '/api/ai/status': [jsonResponse(500, { error: { message: 'boom' } })],
      });

      await useAiStore.getState().loadStatus();

      const state = useAiStore.getState();
      expect(state.statusState).toBe('error');
      expect(state.statusError).toBe('boom');
      expect(state.providers).toEqual([]);
    });
  });

  describe('saveKey', () => {
    it('stores the key, then refreshes status, and never keeps the key in state', async () => {
      mockFetchByPath({
        '/api/ai/key': [
          jsonResponse(200, {
            provider: 'anthropic',
            configured: true,
            storage: { backend: 'file', location: '/x/keys.json' },
          }),
        ],
        '/api/ai/status': [
          jsonResponse(200, {
            providers: [
              {
                id: 'anthropic',
                label: 'Anthropic',
                configured: true,
                model: 'claude-test',
              },
            ],
            storage: { backend: 'file', location: '/x/keys.json' },
          }),
        ],
      });

      const ok = await useAiStore
        .getState()
        .saveKey('anthropic', 'sk-ant-test-key');

      expect(ok).toBe(true);
      const state = useAiStore.getState();
      expect(state.savingKey).toBe(false);
      expect(state.keyError).toBeNull();
      expect(state.providers[0]?.configured).toBe(true);
      // Nothing in this store's own state shape has anywhere to hold a key.
      expect(JSON.stringify(state)).not.toContain('sk-ant-test-key');
    });

    it('sets keyError and returns false on failure, leaving providers untouched', async () => {
      mockFetchByPath({
        '/api/ai/key': [
          jsonResponse(400, { error: { message: 'unknown provider "nope"' } }),
        ],
      });

      const ok = await useAiStore.getState().saveKey('nope', 'sk-ant-test-key');

      expect(ok).toBe(false);
      expect(useAiStore.getState().keyError).toBe('unknown provider "nope"');
    });
  });

  describe('removeKey', () => {
    it('removes the key and refreshes status', async () => {
      mockFetchByPath({
        '/api/ai/key': [
          jsonResponse(200, {
            provider: 'anthropic',
            configured: false,
            storage: { backend: 'file', location: '/x/keys.json' },
          }),
        ],
        '/api/ai/status': [
          jsonResponse(200, {
            providers: [
              {
                id: 'anthropic',
                label: 'Anthropic',
                configured: false,
                model: 'claude-test',
              },
            ],
            storage: { backend: 'file', location: '/x/keys.json' },
          }),
        ],
      });

      await useAiStore.getState().removeKey('anthropic');

      expect(useAiStore.getState().providers[0]?.configured).toBe(false);
      expect(useAiStore.getState().savingKey).toBe(false);
    });
  });

  describe('loadMcpStatus / saveMcp / removeMcp', () => {
    it('loadMcpStatus populates mcpStatus from the host', async () => {
      mockFetchByPath({
        '/api/ai/mcp': [
          jsonResponse(200, {
            configured: true,
            url: 'https://circleci.mcp.kapa.ai/sse',
            hasToken: true,
          }),
        ],
      });

      await useAiStore.getState().loadMcpStatus();

      expect(useAiStore.getState().mcpStatus).toEqual({
        configured: true,
        url: 'https://circleci.mcp.kapa.ai/sse',
        hasToken: true,
      });
      expect(useAiStore.getState().mcpError).toBeNull();
    });

    it('saveMcp stores the url/token and never keeps the token in state', async () => {
      mockFetchByPath({
        '/api/ai/mcp': [
          jsonResponse(200, {
            configured: true,
            url: 'https://circleci.mcp.kapa.ai/sse',
            hasToken: true,
          }),
        ],
      });

      const ok = await useAiStore
        .getState()
        .saveMcp('https://circleci.mcp.kapa.ai/sse', 'mcp-test-token');

      expect(ok).toBe(true);
      const state = useAiStore.getState();
      expect(state.mcpSaving).toBe(false);
      expect(state.mcpError).toBeNull();
      expect(state.mcpStatus?.configured).toBe(true);
      // Nothing in this store's state shape has anywhere to hold the token.
      expect(JSON.stringify(state)).not.toContain('mcp-test-token');
    });

    it('saveMcp sets mcpError and returns false on failure', async () => {
      mockFetchByPath({
        '/api/ai/mcp': [
          jsonResponse(400, {
            error: { message: 'url must start with https://' },
          }),
        ],
      });

      const ok = await useAiStore
        .getState()
        .saveMcp('http://insecure.example.com', '');

      expect(ok).toBe(false);
      expect(useAiStore.getState().mcpError).toBe(
        'url must start with https://',
      );
    });

    it('removeMcp clears the configuration', async () => {
      mockFetchByPath({
        '/api/ai/mcp': [
          jsonResponse(200, { configured: false, hasToken: false }),
        ],
      });

      await useAiStore.getState().removeMcp();

      expect(useAiStore.getState().mcpStatus).toEqual({
        configured: false,
        hasToken: false,
      });
      expect(useAiStore.getState().mcpSaving).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('appends a user message, then an assistant reply, and sends repo-aware context', async () => {
      const fetchMock = mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content: 'The build job checks out and builds.',
            model: 'claude-test',
          }),
        ],
      });

      await useAiStore.getState().sendMessage('what does build do?');

      const state = useAiStore.getState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]).toMatchObject({
        role: 'user',
        content: 'what does build do?',
      });
      expect(state.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'The build job checks out and builds.',
      });
      expect(state.sending).toBe(false);

      const [, init] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.context.jobNames).toEqual(['build']);
      expect(body.context.workflowNames).toEqual(['main']);
    });

    it('extracts a proposed action from the reply and marks it pending', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content:
              'Sure.\n\n```action\n{"type": "addJob", "name": "lint"}\n```',
          }),
        ],
      });

      await useAiStore.getState().sendMessage('add a lint job');

      const assistant = useAiStore.getState().messages.at(-1);
      expect(assistant?.action).toEqual({ type: 'addJob', name: 'lint' });
      expect(assistant?.actionStatus).toBe('pending');
    });

    it('carries "sources" from the response onto the assistant message', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content: 'A resource class controls the compute tier.',
            sources: [
              'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
            ],
          }),
        ],
      });

      await useAiStore.getState().sendMessage('what is a resource class?');

      const assistant = useAiStore.getState().messages.at(-1);
      expect(assistant?.sources).toEqual([
        'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
      ]);
    });

    it('carries "groundingReason" onto the message so a silently ungrounded answer is visibly labelled', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content: 'A resource class controls the compute tier.',
            grounded: false,
            groundingReason:
              'the docs MCP sign-in expired and the server issued no refresh token; sign in again to restore docs grounding',
          }),
        ],
      });

      await useAiStore.getState().sendMessage('what is a resource class?');

      const assistant = useAiStore.getState().messages.at(-1);
      // The reply still arrives -- issue #103's "never block" -- but it is
      // flagged, so the user is never left believing an unsourced answer was
      // sourced.
      expect(assistant?.content).toContain('compute tier');
      expect(assistant?.isNotice).toBeUndefined();
      expect(assistant?.groundingReason).toMatch(/sign in again/);
    });

    it('leaves "groundingReason" unset when no docs server is configured at all', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content: 'Sure.',
            grounded: false,
          }),
        ],
      });

      await useAiStore.getState().sendMessage('hi');

      // "You never set this up" is not a warning worth repeating on every
      // reply, so nothing is rendered for it.
      expect(
        useAiStore.getState().messages.at(-1)?.groundingReason,
      ).toBeUndefined();
    });

    it('renders an "unavailable" reply as a notice, not a real assistant answer', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(200, {
            available: false,
            reason: 'no API key configured for Anthropic',
          }),
        ],
      });

      await useAiStore.getState().sendMessage('hi');

      const assistant = useAiStore.getState().messages.at(-1);
      expect(assistant?.isNotice).toBe(true);
      expect(assistant?.content).toContain('no API key');
    });

    it('surfaces a transport failure as chatError and a notice message', async () => {
      mockFetchByPath({
        '/api/ai/chat': [
          jsonResponse(502, {
            error: { message: 'Anthropic rejected the configured API key' },
          }),
        ],
      });

      await useAiStore.getState().sendMessage('hi');

      const state = useAiStore.getState();
      expect(state.chatError).toContain('rejected');
      expect(state.messages.at(-1)?.isNotice).toBe(true);
      expect(state.sending).toBe(false);
    });

    it('does nothing for blank/whitespace-only input', async () => {
      const fetchMock = mockFetchByPath({});
      await useAiStore.getState().sendMessage('   ');
      expect(useAiStore.getState().messages).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // Issue #102: sendMessage must send whatever refreshDirectoryContext
    // last computed, never a second, independently-fetched context that
    // could disagree with it. Since #253 removed the pane's transparency
    // line, this request is the *only* record of what a message carried,
    // which makes the assertion below more load-bearing rather than less.
    it('sends the directoryContext already in state as otherFiles/skippedFiles, without fetching anything itself', async () => {
      useAiStore.setState({
        directoryContext: {
          otherFiles: [
            {
              path: '/repo/.circleci/continue-config.yml',
              text: 'version: 2.1\njobs: {}\n',
            },
          ],
          skippedFiles: [
            {
              path: '/repo/.circleci/huge.yml',
              reason: 'token budget exceeded',
            },
          ],
        },
      });
      const fetchMock = mockFetchByPath({
        '/api/ai/chat': [jsonResponse(200, { available: true, content: 'ok' })],
      });

      await useAiStore
        .getState()
        .sendMessage('what does continue-config.yml do?');

      // Exactly one request went out, and it was the chat request -- no
      // /api/config-files round trip happened as a side effect of sending.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.context.otherFiles).toEqual([
        {
          path: '/repo/.circleci/continue-config.yml',
          text: 'version: 2.1\njobs: {}\n',
        },
      ]);
      expect(body.context.skippedFiles).toEqual([
        { path: '/repo/.circleci/huge.yml', reason: 'token budget exceeded' },
      ]);
    });

    // Issue #247 item 6: the assistant needs the policies, so a chat request
    // carries the current, non-stale failing rules exactly as `PolicyStrip`
    // shows them.
    it('sends the current policy violations from policyStore, rule and reason verbatim', async () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: {
          status: 'HARD_FAIL',
          enabledRules: ['required_jobs_in_workflow'],
          hardFailures: [
            {
              rule: 'required_jobs_in_workflow',
              reason: "Job 'security-scan' is enforced by your Security Team",
              kind: 'hard',
            },
          ],
          softFailures: [],
          metadataSent: [],
          compiledConfigIncluded: true,
        },
        checkedText: FIXTURE_CONFIG,
      });
      const fetchMock = mockFetchByPath({
        '/api/ai/chat': [jsonResponse(200, { available: true, content: 'ok' })],
      });

      await useAiStore.getState().sendMessage('how do I fix this?');

      const [, init] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.context.policyViolations).toEqual([
        {
          rule: 'required_jobs_in_workflow',
          reason: "Job 'security-scan' is enforced by your Security Team",
          blocking: true,
        },
      ]);
    });

    it('withholds a stale policy decision -- a verdict about an earlier version of this file is not a fact about this one', async () => {
      usePolicyStore.setState({
        state: 'decided',
        decision: {
          status: 'HARD_FAIL',
          enabledRules: ['r'],
          hardFailures: [{ rule: 'r', reason: 'blocked', kind: 'hard' }],
          softFailures: [],
          metadataSent: [],
          compiledConfigIncluded: true,
        },
        // Checked against different text than what's open now.
        checkedText: `${FIXTURE_CONFIG}# edited\n`,
      });
      const fetchMock = mockFetchByPath({
        '/api/ai/chat': [jsonResponse(200, { available: true, content: 'ok' })],
      });

      await useAiStore.getState().sendMessage('how do I fix this?');

      const [, init] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.context.policyViolations).toEqual([]);
    });
  });

  describe('refreshDirectoryContext', () => {
    it('fetches every file with contents and builds a directory context excluding the active file', async () => {
      useAppStore.setState({ configPath: '/repo/.circleci/config.yml' });
      mockFetchByPath({
        '/api/config-files': [
          jsonResponse(200, {
            dir: '/repo/.circleci',
            primaryPath: '/repo/.circleci/config.yml',
            files: [
              {
                path: '/repo/.circleci/config.yml',
                relPath: 'config.yml',
                size: 10,
                isPrimary: true,
                isConfig: true,
                configReason: 'Declares version: 2.1.',
                contents: FIXTURE_CONFIG,
              },
              {
                path: '/repo/.circleci/continue-config.yml',
                relPath: 'continue-config.yml',
                size: 20,
                isPrimary: false,
                isConfig: true,
                configReason: 'Declares version: 2.1.',
                contents: 'version: 2.1\njobs: {}\n',
              },
            ],
          }),
        ],
      });

      await useAiStore.getState().refreshDirectoryContext();

      const state = useAiStore.getState();
      expect(state.directoryContextStatus).toBe('ready');
      expect(state.directoryContext.otherFiles).toEqual([
        {
          path: '/repo/.circleci/continue-config.yml',
          text: 'version: 2.1\njobs: {}\n',
        },
      ]);
      expect(state.directoryContext.skippedFiles).toEqual([]);
    });

    it('degrades to an empty directory context on failure, rather than throwing', async () => {
      mockFetchByPath({
        '/api/config-files': [
          jsonResponse(500, { error: { message: 'boom' } }),
        ],
      });

      await useAiStore.getState().refreshDirectoryContext();

      const state = useAiStore.getState();
      expect(state.directoryContextStatus).toBe('error');
      expect(state.directoryContext).toEqual({
        otherFiles: [],
        skippedFiles: [],
      });
    });
  });

  describe('approveAction / rejectAction', () => {
    it('approveAction applies the action to the live document via appStore.mutate()', () => {
      useAiStore.setState({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: '```action\n{"type": "addJob", "name": "lint"}\n```',
            action: { type: 'addJob', name: 'lint' },
            actionStatus: 'pending',
          },
        ],
      });

      useAiStore.getState().approveAction('m1');

      expect(useAppStore.getState().text).toContain('lint:');
      expect(useAiStore.getState().messages[0]?.actionStatus).toBe('applied');
    });

    it('approveAction marks the message failed (and leaves the document untouched) when the mutation throws', () => {
      useAiStore.setState({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content:
              '```action\n{"type": "deleteJob", "name": "does-not-exist"}\n```',
            action: { type: 'deleteJob', name: 'does-not-exist' },
            actionStatus: 'pending',
          },
        ],
      });
      const priorText = useAppStore.getState().text;

      useAiStore.getState().approveAction('m1');

      expect(useAppStore.getState().text).toBe(priorText);
      const message = useAiStore.getState().messages[0];
      expect(message?.actionStatus).toBe('failed');
      expect(message?.actionError).toBeTruthy();
    });

    it('approveAction is a no-op for a message with no action, or one already resolved', () => {
      useAiStore.setState({
        messages: [
          { id: 'm1', role: 'assistant', content: 'just an answer' },
          {
            id: 'm2',
            role: 'assistant',
            content: 'x',
            action: { type: 'addJob', name: 'lint' },
            actionStatus: 'applied',
          },
        ],
      });
      const priorText = useAppStore.getState().text;

      useAiStore.getState().approveAction('m1');
      useAiStore.getState().approveAction('m2');

      expect(useAppStore.getState().text).toBe(priorText);
    });

    it('rejectAction marks the action rejected without touching the document', () => {
      useAiStore.setState({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'x',
            action: { type: 'addJob', name: 'lint' },
            actionStatus: 'pending',
          },
        ],
      });
      const priorText = useAppStore.getState().text;

      useAiStore.getState().rejectAction('m1');

      expect(useAppStore.getState().text).toBe(priorText);
      expect(useAiStore.getState().messages[0]?.actionStatus).toBe('rejected');
    });
  });
});
