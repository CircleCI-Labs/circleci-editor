import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiStore } from '~/state/aiStore';
import { useAppStore } from '~/state/appStore';

import { AiPane } from './AiPane';

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

const AI_STATE_RESET = {
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
  promptSeed: null,
};

/**
 * Stubs the height jsdom cannot compute (it implements no layout, so every
 * `scrollHeight` is 0), and returns the undo. `scrollHeight` lives on
 * `Element.prototype` there, not `HTMLElement.prototype`, so the restore has to
 * *delete* the own property this adds rather than write a captured descriptor
 * back -- getting that wrong leaks the stub into every later test in the file.
 */
function stubContentHeight(px: number): () => void {
  const own = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => px,
  });
  return () => {
    if (own) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', own);
      return;
    }
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollHeight;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Routes fetch calls by URL substring to a canned response queue.
 * `/api/ai/mcp` gets an "unconfigured" default when a test doesn't supply
 * its own -- `AiSettings` (via `McpSettings`) now fetches it on every
 * mount, same as `/api/ai/status` always has, and every test in this file
 * predates that endpoint existing at all; giving it a default here means
 * none of them have to know about an endpoint their scenario has nothing
 * to do with.
 */
function mockFetchByPath(
  routes: Record<string, Response[]>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queues = Object.fromEntries(
    Object.entries({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false, hasToken: false }),
      ],
      // AiPane now refreshes the directory context (issue #102) on every
      // mount -- a default empty listing means the many tests in this file
      // that have nothing to do with sibling files don't need to know this
      // endpoint exists at all, same rationale as the mcp default above.
      '/api/config-files': [
        jsonResponse(200, { dir: '', primaryPath: '', files: [] }),
      ],
      ...routes,
    }).map(([k, v]) => [k, [...v]]),
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

function statusResponse(configured: boolean) {
  return jsonResponse(200, {
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        configured,
        model: 'claude-test-model',
      },
    ],
    storage: {
      backend: 'keychain',
      location: 'macOS Keychain (service "circleci-editor")',
    },
  });
}

describe('AiPane', () => {
  beforeEach(() => {
    useAiStore.setState(AI_STATE_RESET);
    useAppStore.setState({
      savedText: FIXTURE_CONFIG,
      text: FIXTURE_CONFIG,
      doc: null,
      parseError: null,
    });
    useAppStore.getState().setText(FIXTURE_CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a "No key" badge and a disabled composer when no provider is configured, and explains how to fix it', async () => {
    mockFetchByPath({ '/api/ai/status': [statusResponse(false)] });
    render(<AiPane />);

    await waitFor(() => expect(screen.getByText('No key')).toBeInTheDocument());

    const textarea = screen.getByLabelText(/message the ai assistant/i);
    expect(textarea).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /send message/i }),
    ).toBeDisabled();
    // The settings panel auto-opens so "how do I fix this" is answered
    // without a second click.
    //
    // Awaited rather than asserted synchronously, because the badge above and
    // this panel are one commit apart *by construction*: the badge renders as
    // soon as the status fetch lands in the store, and the panel opens from an
    // effect keyed on that same state (see AiPane's own auto-open effect). So
    // waiting for the badge does not mean the panel has rendered yet. React
    // usually batches the two closely enough that a synchronous assertion
    // passes, which is why this failed only on CI and only sometimes -- a
    // timing assumption, not a broken product.
    expect(await screen.findByText(/AI provider keys/i)).toBeInTheDocument();
  });

  it('enables the composer once the selected provider is configured', async () => {
    mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
    render(<AiPane />);

    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    expect(screen.getByLabelText(/message the ai assistant/i)).toBeEnabled();
  });

  it('sends a message and renders the assistant reply, including the context it sent', async () => {
    const fetchMock = mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, {
          available: true,
          content: 'The build job checks out and runs steps.',
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/message the ai assistant/i),
      'what does build do?',
    );
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(
        screen.getByText('The build job checks out and runs steps.'),
      ).toBeInTheDocument(),
    );

    const chatCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/ai/chat'),
    );
    expect(chatCall).toBeDefined();
    const body = JSON.parse(
      String(((chatCall as unknown[])[1] as RequestInit).body),
    );
    expect(body.context.jobNames).toEqual(['build']);
    expect(body.context.configText).toBe(FIXTURE_CONFIG);
  });

  it('renders a "Sources" footer for a reply that cites docs, using the curated label when the URL is known', async () => {
    mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, {
          available: true,
          content: 'A resource class controls the compute tier a job runs on.',
          sources: [
            {
              url: 'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
              title: 'resource_class',
            },
            // An image asset that reached the frontend anyway (an older host,
            // a page not in the vendored snapshot): never shown as a source.
            { url: 'https://circleci.com/docs/guides/_images/workspace.png' },
          ],
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/message the ai assistant/i),
      'what is a resource class?',
    );
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(screen.getByText('Sources')).toBeInTheDocument(),
    );
    // "Resource classes" is DOCS_LINKS.executors.resourceClass's own
    // curated label -- proving the raw MCP URL resolved through
    // lookupDocLink rather than being shown as a bare string, and that the
    // curated label still beats the host-resolved title (issue #156).
    expect(screen.getByText('Resource classes')).toBeInTheDocument();
    // The destination is shown under the title rather than as the title.
    expect(
      screen.getByText(
        'circleci.com/docs/reference/configuration-reference/#resourceclass',
      ),
    ).toBeInTheDocument();
    // The whole row is one link, and it is safe to click.
    const row = screen.getByRole('link', { name: /Resource classes/ });
    expect(row).toHaveAttribute('rel', 'noopener noreferrer');
    expect(row).toHaveAttribute('target', '_blank');
    // The image asset is not a source, and never becomes one.
    expect(screen.queryByText(/workspace\.png/)).not.toBeInTheDocument();
  });

  it('never shows a "Sources" footer when the reply carries none', async () => {
    mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, {
          available: true,
          content: 'The build job checks out and runs steps.',
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/message the ai assistant/i), 'hi');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(
        screen.getByText('The build job checks out and runs steps.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('renders a graceful notice, not a broken reply, when the provider request fails', async () => {
    mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(502, {
          error: { message: 'Anthropic rejected the configured API key' },
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/message the ai assistant/i), 'hi');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(
        screen.getAllByText(/rejected the configured api key/i).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText('Notice')).toBeInTheDocument();
  });

  // Issue #253: the pane carried a per-request transparency line between the
  // transcript and the composer ("Sends: 2 files (config.yml, setup.yml)
  // (~N tokens…) with every message"). The owner asked for it to go, and
  // explicitly declined an info icon or hover affordance in its place after
  // weighing the accessibility trade-off -- so this asserts the absence of a
  // *replacement* as well as of the line, since "moved it to a tooltip" is the
  // failure mode this test exists to catch. The disclosure now lives in
  // internal/guides/editor/using-this-editor.adoc ("What leaves your machine").
  it('says nothing inline about request size, and offers no affordance in its place', async () => {
    mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    expect(screen.queryByTestId('ai-sends-line')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sends:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing else in this repository is sent/),
    ).not.toBeInTheDocument();

    // And no hover/focus affordance took its place: the line's own skipped-file
    // disclosure was a `cursor-help` tooltip trigger, which is the shape an info
    // icon would reuse.
    expect(document.querySelector('.cursor-help')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /what is sent|context|info/i }),
    ).not.toBeInTheDocument();
  });

  // The other half of #253: removing the line must not change *what is sent*.
  // Issue #102's promise -- every sibling file that fits is included, and one
  // over the budget is reported rather than silently truncated -- is now
  // observable only in the request itself, so that is where it is pinned.
  it('still sends every included sibling file and still reports one skipped over the token budget', async () => {
    useAppStore.setState({
      configPath: '/repo/.circleci/config.yml',
      files: [
        {
          path: '/repo/.circleci/config.yml',
          relPath: 'config.yml',
          size: FIXTURE_CONFIG.length,
          isPrimary: true,
          isConfig: true,
          configReason: 'Declares version: 2.1.',
        },
        {
          path: '/repo/.circleci/setup.yml',
          relPath: 'setup.yml',
          size: 12,
          isPrimary: false,
          isConfig: true,
          configReason: 'Has CircleCI top-level keys: setup.',
        },
        {
          path: '/repo/.circleci/huge.yml',
          relPath: 'huge.yml',
          size: 90_000,
          isPrimary: false,
          isConfig: true,
          configReason: 'Declares version: 2.1.',
        },
      ],
    });
    // ~22,500 tokens at the ~4-chars-per-token estimate -- over
    // DIRECTORY_CONTEXT_TOKEN_BUDGET (20,000), so this file alone must be
    // reported skipped rather than partially included.
    const huge = 'x'.repeat(90_000);
    const fetchMock = mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, { available: true, content: 'Two files, noted.' }),
      ],
      '/api/config-files': [
        jsonResponse(200, {
          dir: '/repo/.circleci',
          primaryPath: '/repo/.circleci/config.yml',
          files: [
            {
              path: '/repo/.circleci/config.yml',
              relPath: 'config.yml',
              size: FIXTURE_CONFIG.length,
              isPrimary: true,
              isConfig: true,
              configReason: 'Declares version: 2.1.',
              contents: FIXTURE_CONFIG,
            },
            {
              path: '/repo/.circleci/setup.yml',
              relPath: 'setup.yml',
              size: 12,
              isPrimary: false,
              isConfig: true,
              configReason: 'Has CircleCI top-level keys: setup.',
              contents: 'setup: true\n',
            },
            {
              path: '/repo/.circleci/huge.yml',
              relPath: 'huge.yml',
              size: huge.length,
              isPrimary: false,
              isConfig: true,
              configReason: 'Declares version: 2.1.',
              contents: huge,
            },
          ],
        }),
      ],
    });

    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    await waitFor(() =>
      expect(useAiStore.getState().directoryContext.otherFiles).toHaveLength(1),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/message the ai assistant/i), 'hi');
    await user.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() =>
      expect(screen.getByText('Two files, noted.')).toBeInTheDocument(),
    );

    const chatCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/ai/chat'),
    );
    expect(chatCall).toBeDefined();
    const body = JSON.parse(
      String(((chatCall as unknown[])[1] as RequestInit).body),
    );
    // The open file's own text, plus the one sibling that fit the budget.
    expect(body.context.configPath).toBe('/repo/.circleci/config.yml');
    expect(body.context.otherFiles).toEqual([
      { path: '/repo/.circleci/setup.yml', text: 'setup: true\n' },
    ]);
    // huge.yml is reported skipped, with why -- never partially included.
    expect(body.context.skippedFiles).toEqual([
      { path: '/repo/.circleci/huge.yml', reason: 'token budget exceeded' },
    ]);
    expect(JSON.stringify(body)).not.toContain(huge);
  });

  it('a proposed action can be reviewed as a diff and approved, applying it to the open document', async () => {
    mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, {
          available: true,
          // Markdown prose *and* an action block, which is the realistic
          // shape (issue #156): the prose must render as Markdown and the
          // machine-readable block must stay stripped and unrendered.
          content:
            'Sure, adding a **lint** job:\n\n```yaml\nlint:\n  docker:\n    - image: cimg/base:current\n```\n\n```action\n{"type": "addJob", "name": "lint"}\n```',
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/message the ai assistant/i),
      'add a lint job',
    );
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() =>
      expect(screen.getByText('Add job "lint"')).toBeInTheDocument(),
    );
    expect(screen.getByText('Proposed')).toBeInTheDocument();

    // The prose rendered as Markdown ...
    const bubble = screen.getByTestId('markdown');
    expect(bubble.querySelector('strong')?.textContent).toBe('lint');
    expect(bubble.querySelector('pre')?.textContent).toContain(
      'image: cimg/base:current',
    );
    // ... and stripActionBlock still removed the machine-readable block, so it
    // is neither shown as prose nor rendered as a second code fence.
    expect(bubble.textContent).not.toContain('addJob');
    expect(bubble.querySelectorAll('pre')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /review change/i }));

    const dialog = await screen.findByRole('dialog');
    // The diff shows the exact addition -- this is the approval surface
    // issue #92 requires before anything is written.
    expect(within(dialog).getByText(/lint:/)).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: /apply to editor/i }),
    );

    expect(useAppStore.getState().text).toContain('lint:');
    // Persisting to disk is still a separate, explicit step -- this
    // dialog only ever touches the in-memory document.
    expect(useAppStore.getState().isDirty).toBe(true);
  });

  it('rejecting a proposed action leaves the document untouched', async () => {
    mockFetchByPath({
      '/api/ai/status': [statusResponse(true)],
      '/api/ai/chat': [
        jsonResponse(200, {
          available: true,
          content: '```action\n{"type": "addJob", "name": "lint"}\n```',
        }),
      ],
    });
    render(<AiPane />);
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/message the ai assistant/i),
      'add a lint job',
    );
    await user.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => screen.getByRole('button', { name: /review change/i }));
    const priorText = useAppStore.getState().text;

    await user.click(screen.getByRole('button', { name: /review change/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /reject/i }));

    expect(useAppStore.getState().text).toBe(priorText);
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });
  /**
   * Issue #148: the YAML pane's "Fix with AI" button composes a prompt and
   * hands it to this pane through `aiStore.promptSeed`. The whole point is
   * that it lands *unsent* -- the user reads it, edits it if they like, and
   * presses Send themselves.
   */
  describe('a prompt seeded from a validation error (issue #148)', () => {
    it('lands in the composer without being sent', async () => {
      mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
      render(<AiPane />);
      await waitFor(() =>
        expect(screen.getByText('Ready')).toBeInTheDocument(),
      );

      act(() => useAiStore.getState().seedPrompt('please fix line 7'));

      expect(screen.getByLabelText(/message the ai assistant/i)).toHaveValue(
        'please fix line 7',
      );
      // Nothing sent: no user turn in the transcript, no request in flight.
      expect(useAiStore.getState().messages).toEqual([]);
      expect(useAiStore.getState().sending).toBe(false);
    });

    it('is consumed once, so it cannot re-apply over later typing', async () => {
      mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
      render(<AiPane />);
      await waitFor(() =>
        expect(screen.getByText('Ready')).toBeInTheDocument(),
      );

      act(() => useAiStore.getState().seedPrompt('first seed'));
      expect(useAiStore.getState().promptSeed).toBeNull();

      const user = userEvent.setup();
      const textarea = screen.getByLabelText(/message the ai assistant/i);
      await user.clear(textarea);
      await user.type(textarea, 'my own question');
      expect(textarea).toHaveValue('my own question');
    });

    /**
     * Issues #186 and #209: the seeded prompt is ~30 lines, and the composer used
     * to be a fixed two rows -- so the affordance whose whole point is that the
     * user *reads* what they are about to send showed them two lines of it.
     *
     * #186 answered that with a second surface above the transcript rendering the
     * whole draft; the owner found it confusing and #209 deleted it. What replaces
     * it is the input telling the truth about its own contents. jsdom measures
     * nothing, so the text's height is stubbed.
     */
    it('says a seeded prompt is longer than the box, in the box, without sending it', async () => {
      const restore = stubContentHeight(900);
      try {
        mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
        render(<AiPane />);
        await waitFor(() =>
          expect(screen.getByText('Ready')).toBeInTheDocument(),
        );

        const seeded = [
          'My CircleCI config is failing validation.',
          '',
          'Error:',
          '```',
          'extraneous key [stpes] is not permitted',
          '```',
        ].join('\n');
        act(() => useAiStore.getState().seedPrompt(seeded));

        // The deleted surface is gone, and stays gone.
        expect(
          screen.queryByTestId('ai-draft-preview'),
        ).not.toBeInTheDocument();

        // The input holds the whole thing, editable, and says how much of it there
        // is -- the requirement from #186, met by the input this time.
        const textarea = screen.getByLabelText(/message the ai assistant/i);
        expect(textarea).toHaveValue(seeded);
        const overflow = await screen.findByTestId('ai-composer-overflow');
        expect(overflow.textContent).toContain('6 lines');

        // #163's hard constraint, re-asserted here: seeding sends nothing.
        expect(useAiStore.getState().messages).toEqual([]);
        expect(useAiStore.getState().sending).toBe(false);
      } finally {
        restore();
      }
    });

    it('says nothing about scrolling when the composer can show the whole draft', async () => {
      mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
      render(<AiPane />);
      await waitFor(() =>
        expect(screen.getByText('Ready')).toBeInTheDocument(),
      );

      act(() => useAiStore.getState().seedPrompt('please fix line 7'));
      expect(
        screen.queryByTestId('ai-composer-overflow'),
      ).not.toBeInTheDocument();
    });

    /**
     * Issue #210. A prompt seeded from an orb diagnostic carries what the error is
     * *about*, and the reply it produces cites the orb's own registry page and the
     * vendored Orbs pages -- alongside, and above, whatever retrieval returned.
     */
    it('cites the orb itself for a reply to a seeded orb fix, and ranks a stray Slack page below it', async () => {
      mockFetchByPath({
        '/api/ai/status': [statusResponse(true)],
        '/api/ai/chat': [
          jsonResponse(200, {
            available: true,
            content: 'That version was never published. Try 5.1.1.',
            // The owner's actual list, in the owner's actual order.
            sources: [
              {
                url: 'https://app.slack.com/block-kit-builder',
                title: 'Block Kit Builder',
              },
              { url: 'https://semver.org/' },
              {
                url: 'https://circleci.com/docs/reference/reusing-config/',
                title: 'Reusable config',
              },
            ],
          }),
        ],
      });
      render(<AiPane />);
      await waitFor(() =>
        expect(screen.getByText('Ready')).toBeInTheDocument(),
      );

      act(() =>
        useAiStore.getState().seedPrompt('this orb does not resolve', {
          kind: 'orb',
          orb: {
            namespace: 'circleci',
            name: 'slack',
            requestedVersion: '4.12.5',
            versions: ['5.1.1', '5.0.0'],
            latestVersion: '5.1.1',
          },
        }),
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() =>
        expect(screen.getByTestId('ai-sources')).toBeInTheDocument(),
      );
      const sources = screen.getByTestId('ai-sources');
      const rows = Array.from(sources.querySelectorAll('li')).map(
        (li) => li.textContent ?? '',
      );
      // The orb's own registry page is first, and it names the orb rather than the
      // product -- "Slack" is exactly the ambiguity that produced the Block Kit
      // citation in the first place.
      expect(rows[0]).toContain('circleci/slack orb in the registry');
      expect(rows[0]).toContain('latest published: 5.1.1');
      expect(rows[1]).toContain('Orbs introduction');
      expect(rows[2]).toContain('Orb concepts');
      // Capped at four, so the retrieved tail is dropped -- and said out loud.
      expect(rows).toHaveLength(4);
      expect(screen.getByTestId('ai-sources-dropped').textContent).toContain(
        'not shown',
      );
      // The Block Kit builder is not in the list at all now.
      expect(sources.textContent).not.toContain('Block Kit');
      // ...and the rows this editor attached are labelled as such.
      expect(screen.getAllByTestId('ai-source-editor')).toHaveLength(3);
    });

    it('re-seeds after the draft has been edited, because the seq advances', async () => {
      mockFetchByPath({ '/api/ai/status': [statusResponse(true)] });
      render(<AiPane />);
      await waitFor(() =>
        expect(screen.getByText('Ready')).toBeInTheDocument(),
      );

      act(() => useAiStore.getState().seedPrompt('same prompt'));
      const user = userEvent.setup();
      const textarea = screen.getByLabelText(/message the ai assistant/i);
      await user.clear(textarea);
      expect(textarea).toHaveValue('');

      // Clicking "Fix with AI" again on the same error must put it back.
      act(() => useAiStore.getState().seedPrompt('same prompt'));
      expect(textarea).toHaveValue('same prompt');
    });
  });
});
