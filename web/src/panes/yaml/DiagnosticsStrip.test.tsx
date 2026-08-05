import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORB_NOT_FOUND,
  SCHEMA_EXTRANEOUS_KEY,
  UNKNOWN_EXECUTOR,
} from '~/lib/validation/apiFixtures';
import { buildDiagnostics } from '~/lib/validation/build';
import { parseConfig } from '~/lib/yaml/documentUtils';
import { useAiStore } from '~/state/aiStore';
import { useAppStore } from '~/state/appStore';

import { DiagnosticsStrip } from './DiagnosticsStrip';

const CONFIG = `# Keep this comment.
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:stable
    stpes:
      - checkout
workflows:
  main:
    jobs:
      - build
`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Seeds `appStore` with a document, and `aiStore` with a given key situation. */
function seedStores({
  text = CONFIG,
  aiConfigured,
}: {
  text?: string;
  /** `undefined` leaves `statusState: 'loading'`, i.e. "the AI pane never mounted". */
  aiConfigured?: boolean;
} = {}) {
  const { doc, error } = parseConfig(text);
  useAppStore.setState({
    doc,
    text,
    parseError: error,
    configPath: '/repo/.circleci/config.yml',
  });
  useAiStore.setState({
    statusState: aiConfigured === undefined ? 'loading' : 'ready',
    statusError: null,
    providers:
      aiConfigured === undefined
        ? []
        : [
            {
              id: 'anthropic',
              label: 'Anthropic',
              configured: aiConfigured,
              model: 'claude-test-model',
            },
          ],
    selectedProvider: aiConfigured === undefined ? '' : 'anthropic',
    promptSeed: null,
  });
}

function renderStrip(
  messages: string[],
  over: Parameters<typeof buildDiagnostics>[0]['validation'] = {
    state: 'invalid',
    errors: messages.map((message) => ({ message })),
  },
) {
  const state = useAppStore.getState();
  const result = buildDiagnostics({
    doc: state.doc,
    text: state.text,
    parseError: state.parseError,
    validation: over,
  });
  const onGoToLine = vi.fn<(line: number, column: number) => void>();
  const onIndexChange = vi.fn<(index: number) => void>();
  const utils = render(
    <DiagnosticsStrip
      result={result}
      index={0}
      onIndexChange={onIndexChange}
      onGoToLine={onGoToLine}
    />,
  );
  return { ...utils, result, onGoToLine, onIndexChange };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      available: false,
      source: 'unavailable',
      reason: 'no token',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagnosticsStrip', () => {
  it('renders nothing at all for a config with no findings', () => {
    seedStores({
      text: 'version: 2.1\njobs:\n  build:\n    steps: [checkout]\n',
    });
    const { container } = renderStrip([], { state: 'valid', errors: [] });
    // The "no permanent warning furniture for a config that's fine"
    // requirement, asserted rather than assumed.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the compiler's own headline, not a paraphrase of it", () => {
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    expect(screen.getByTestId('diagnostic-title')).toHaveTextContent(
      'Key "stpes" is not allowed in jobs.build',
    );
  });

  it('labels the source as the CircleCI compiler when the API produced it', () => {
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    expect(screen.getByText('CircleCI compiler')).toBeInTheDocument();
  });

  it('labels an offline finding as a local check and says the config was never compiled', () => {
    const broken = `version: 2.1
jobs:
  build:
    steps: [checkout]
workflows:
  main:
    jobs:
      - build:
          requires:
            - gone
`;
    seedStores({ text: broken });
    renderStrip([], {
      state: 'unavailable',
      errors: [],
      reason: 'no CircleCI API token available; validation requires a token',
    });
    expect(screen.getByText('Local check')).toBeInTheDocument();
    expect(
      screen.getByText(/has not been compiled by CircleCI/),
    ).toBeInTheDocument();
    expect(screen.queryByText('CircleCI compiler')).not.toBeInTheDocument();
  });

  it('offers a keyboard-reachable jump to a resolved line', async () => {
    seedStores();
    const { onGoToLine } = renderStrip(SCHEMA_EXTRANEOUS_KEY);
    const jump = screen.getByRole('button', { name: /line 7/ });
    // Reachable by keyboard, not only by pointer.
    jump.focus();
    await userEvent.keyboard('{Enter}');
    expect(onGoToLine).toHaveBeenCalledWith(7, 5);
  });

  it('says the location is unknown rather than offering a guessed line', () => {
    seedStores();
    renderStrip(UNKNOWN_EXECUTOR);
    expect(screen.getByText('Location unknown')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^line \d/ }),
    ).not.toBeInTheDocument();
    // And the error itself is still shown, not dropped.
    expect(screen.getByTestId('diagnostic-title')).toHaveTextContent(
      'Cannot find a definition for executor named nope',
    );
  });

  it('shows one problem at a time with Prev/Next, not a scrolling list', async () => {
    seedStores();
    const { onIndexChange } = renderStrip([
      'At least one job in the workflow must have no dependencies.',
      'The following jobs are unreachable: a, b',
    ]);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    // Only the current one is on screen.
    expect(
      screen.queryByText('The following jobs are unreachable: a, b'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Previous problem' }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next problem' }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('keeps the full compiler output available behind a disclosure, verbatim', async () => {
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    const toggle = screen.getByRole('button', {
      name: /show full circleci compiler output/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    // Including the `oneOf` lines this app declines to act on.
    expect(
      screen.getByText(/required key \[type\] not found/),
    ).toBeInTheDocument();
  });

  it('names the compile scope the error was reported under', () => {
    seedStores();
    renderStrip(UNKNOWN_EXECUTOR);
    expect(
      screen.getByText(/workflow "main" → job "build"/),
    ).toBeInTheDocument();
  });
});

describe('DiagnosticsStrip: suggestions', () => {
  it('offers the mechanically justified fix, with its rationale', () => {
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    expect(
      screen.getByRole('button', { name: 'Rename "stpes" to "steps"' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/CircleCI listed the keys permitted here/),
    ).toBeInTheDocument();
  });

  it('applies through the store as one undoable step, preserving comments', async () => {
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    await userEvent.click(
      screen.getByRole('button', { name: 'Rename "stpes" to "steps"' }),
    );
    const after = useAppStore.getState();
    expect(after.text).toContain('    steps:\n');
    expect(after.text).not.toContain('stpes');
    expect(after.text).toContain('# Keep this comment.');
    expect(after.canUndo).toBe(true);
    // Exactly one undo entry -- one click, one step.
    expect(after.undoStack).toHaveLength(1);
    act(() => useAppStore.getState().undo());
    expect(useAppStore.getState().text).toBe(CONFIG);
  });

  it('says plainly that there is no automatic fix when it declines to guess', () => {
    seedStores();
    renderStrip([
      'At least one job in the workflow must have no dependencies.',
    ]);
    expect(screen.getByText(/No automatic fix offered/)).toBeInTheDocument();
  });

  it('does not offer an orb fix when the registry cannot be reached', async () => {
    const withOrb = `version: 2.1
orbs:
  slack: circleci/slack@99.99.99
jobs:
  build:
    steps: [checkout]
`;
    seedStores({ text: withOrb });
    renderStrip(ORB_NOT_FOUND);
    await waitFor(() =>
      expect(screen.getByText(/No automatic fix offered/)).toBeInTheDocument(),
    );
  });

  it('offers the registry-backed version fix once the lookup lands', async () => {
    const withOrb = `version: 2.1
orbs:
  slack: circleci/slack@99.99.99
jobs:
  build:
    steps: [checkout]
`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        available: true,
        name: 'circleci/slack',
        source: 'version: 2.1\n',
        versions: ['4.13.3', '4.13.2'],
        latestVersion: '4.13.3',
      }),
    );
    seedStores({ text: withOrb });
    renderStrip(ORB_NOT_FOUND);
    expect(
      await screen.findByRole('button', { name: 'Use circleci/slack@4.13.3' }),
    ).toBeInTheDocument();
  });
});

describe('DiagnosticsStrip: Fix with AI', () => {
  it('seeds the AI composer without sending anything', async () => {
    seedStores({ aiConfigured: true });
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));

    const seed = useAiStore.getState().promptSeed;
    expect(seed?.text).toContain('extraneous key [stpes] is not permitted');
    expect(seed?.text).toContain('/repo/.circleci/config.yml');
    // Nothing was sent, and no message was appended to the transcript.
    expect(useAiStore.getState().messages).toEqual([]);
    expect(useAiStore.getState().sending).toBe(false);
    expect(
      screen.getByText(/Prompt added to the AI pane's message box/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing has been sent/)).toBeInTheDocument();
  });

  it('explains the missing key instead of appearing broken, and seeds nothing', async () => {
    seedStores({ aiConfigured: false });
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));

    expect(
      screen.getByText(/No AI provider key is configured/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/everything else on this strip works without it/),
    ).toBeInTheDocument();
    expect(useAiStore.getState().promptSeed).toBeNull();
  });

  it('loads provider status first rather than assuming "no key" because nothing looked', async () => {
    // The AI pane may not be mounted in the active preset, so nothing will
    // have called `loadStatus`. Claiming "no key" in that state would be a
    // guess dressed up as a fact.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        providers: [{ id: 'anthropic', label: 'Anthropic', configured: true }],
        storage: { kind: 'file', description: 'a file' },
      }),
    );
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    await waitFor(() =>
      expect(useAiStore.getState().promptSeed?.text).toContain('stpes'),
    );
  });

  it('reports honestly when provider status could not be loaded at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    seedStores();
    renderStrip(SCHEMA_EXTRANEOUS_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    expect(
      await screen.findByText(
        /Couldn't check whether an AI provider is configured/,
      ),
    ).toBeInTheDocument();
    expect(useAiStore.getState().promptSeed).toBeNull();
  });
});
