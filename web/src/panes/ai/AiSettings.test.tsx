import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProviderStatus } from '~/lib/rpc/client';
import { useAiStore } from '~/state/aiStore';

import { AiSettings } from './AiSettings';

const AI_STATE_RESET = {
  statusState: 'ready' as const,
  providers: [] as AiProviderStatus[],
  storage: { backend: 'file' as const, location: '/fake/keys.json' },
  circleCI: { available: false },
  statusError: null,
  selectedProvider: '',
  messages: [],
  sending: false,
  chatError: null,
  savingKey: false,
  keyError: null,
  mcpStatus: { configured: false, hasToken: false },
  mcpSaving: false,
  mcpError: null,
};

const ENV_VAR = 'CIRCLECI_EDITOR_AI_KEY_ANTHROPIC';

/** A provider entry with every field `AiSettings`/`ProviderRow` reads, so each test only has to override what it's actually exercising. */
function provider(overrides: Partial<AiProviderStatus>): AiProviderStatus {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    model: 'claude-test-model',
    configured: false,
    source: 'none',
    envVar: ENV_VAR,
    storedKeyShadowed: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Routes fetch calls by method + URL substring to a canned response queue.
 * `removeKey` makes two calls in sequence -- `DELETE /api/ai/key`, then
 * `GET /api/ai/status` (via `loadStatus`) -- so tests need to tell those
 * apart even though the second URL contains the first's path segment.
 *
 * `AiSettings` also renders `McpSettings`, which fetches its own status and
 * OAuth state on mount (see `McpSettings.test.tsx`'s own `mockFetchByPath`)
 * regardless of what this test is actually exercising; those two are always
 * answered with "nothing configured" here so every test doesn't have to
 * mock a feature it isn't testing.
 */
function mockFetchByMethodAndPath(
  routes: Record<string, Response[]>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queues = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, [...v]]),
  );
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/ai/mcp/oauth')) {
      return Promise.resolve(
        jsonResponse(200, { state: 'idle', authorized: false }),
      );
    }
    if (url.includes('/api/ai/mcp')) {
      return Promise.resolve(
        jsonResponse(200, { configured: false, hasToken: false }),
      );
    }
    const key = `${method} ${url.split('?')[0]}`;
    const next = queues[key]?.shift();
    if (!next) throw new Error(`unmocked fetch: ${key}`);
    return Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AiSettings', () => {
  beforeEach(() => {
    useAiStore.setState(AI_STATE_RESET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers an ordinary Remove button for a key that is actually stored, and it really removes it', async () => {
    useAiStore.setState({
      providers: [provider({ configured: true, source: 'store' })],
    });
    mockFetchByMethodAndPath({
      'DELETE /api/ai/key': [
        jsonResponse(200, {
          provider: 'anthropic',
          configured: false,
          storage: { backend: 'file', location: '/fake/keys.json' },
          source: 'none',
          envVar: ENV_VAR,
          storedKeyShadowed: false,
        }),
      ],
      'GET /api/ai/status': [
        jsonResponse(200, {
          providers: [provider({ configured: false, source: 'none' })],
          storage: { backend: 'file', location: '/fake/keys.json' },
          circleCI: { available: false },
        }),
      ],
    });
    render(<AiSettings />);

    const row = await screen.findByTestId('ai-provider-anthropic');
    expect(row.textContent).toMatch(/configured/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^remove key$/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/anthropic api key/i)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('ai-provider-anthropic').textContent).toMatch(
      /not configured/i,
    );
  });

  it('withholds Remove entirely for an environment-supplied key with nothing stored -- there is nothing it could honestly delete', async () => {
    useAiStore.setState({
      providers: [
        provider({
          configured: true,
          source: 'environment',
          storedKeyShadowed: false,
        }),
      ],
    });
    // Only McpSettings' own mount-time fetches happen in this test; routed
    // to their "nothing configured" fallback by mockFetchByMethodAndPath.
    mockFetchByMethodAndPath({});
    render(<AiSettings />);
    // findBy* (rather than getBy*) lets McpSettings' own mount-time fetches
    // settle first, so its unrelated state updates don't fire after this
    // test has already moved on to assertions.
    await screen.findByTestId('ai-provider-anthropic-env-note');

    // This is issue #7 itself: before the fix, a Remove button appeared
    // here regardless, deleted a key that was never there, and reported
    // success. There is no honest label for a button that would do
    // nothing, so none is rendered.
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(
      screen.getByTestId('ai-provider-anthropic-env-note').textContent,
    ).toMatch(new RegExp(ENV_VAR));
    expect(
      screen.getByTestId('ai-provider-anthropic-env-note').textContent,
    ).toMatch(/nothing is stored/i);
    // Configured is still true -- the key does work, it's just not one
    // Remove can touch.
    expect(
      within(screen.getByTestId('ai-provider-anthropic')).getByText(
        'Configured',
        { exact: true },
      ),
    ).toBeVisible();
  });

  it('re-labels Remove for a shadowed stored key, and stays honest that the environment key is still in effect afterwards', async () => {
    useAiStore.setState({
      providers: [
        provider({
          configured: true,
          source: 'environment',
          storedKeyShadowed: true,
        }),
      ],
    });
    mockFetchByMethodAndPath({
      'DELETE /api/ai/key': [
        jsonResponse(200, {
          provider: 'anthropic',
          // The stored key really was deleted, but the environment
          // variable is untouched -- a key is still configured and still
          // sourced from the environment afterwards.
          configured: true,
          storage: { backend: 'file', location: '/fake/keys.json' },
          source: 'environment',
          envVar: ENV_VAR,
          storedKeyShadowed: false,
        }),
      ],
      'GET /api/ai/status': [
        jsonResponse(200, {
          providers: [
            provider({
              configured: true,
              source: 'environment',
              storedKeyShadowed: false,
            }),
          ],
          storage: { backend: 'file', location: '/fake/keys.json' },
          circleCI: { available: false },
        }),
      ],
    });
    render(<AiSettings />);
    await screen.findByTestId('ai-provider-anthropic-env-note');

    expect(
      screen.getByTestId('ai-provider-anthropic-env-note').textContent,
    ).toMatch(/stored key also exists but is ignored/i);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: /^remove stored key$/i }),
    );

    // After the removal completes and status is refetched: still
    // "Configured" (the environment variable never went away), no longer
    // shadowed (nothing is stored any more), and -- because there is now
    // nothing left for Remove to act on -- no Remove control at all.
    await waitFor(() =>
      expect(
        screen.getByTestId('ai-provider-anthropic-env-note').textContent,
      ).toMatch(/nothing is stored/i),
    );
    expect(
      within(screen.getByTestId('ai-provider-anthropic')).getByText(
        'Configured',
        { exact: true },
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('shows "Not configured" and a save form when nothing is configured at all', async () => {
    useAiStore.setState({ providers: [provider({})] });
    mockFetchByMethodAndPath({});
    render(<AiSettings />);
    await screen.findByLabelText(/anthropic api key/i);

    expect(screen.getByTestId('ai-provider-anthropic').textContent).toMatch(
      /not configured/i,
    );
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  // Issue #11: the read-only CircleCI MCP status line. Both states are
  // asserted from `useAiStore.setState` directly (like every other test in
  // this file reads `state.storage`/`state.providers` off the store rather
  // than re-deriving it from a fetch) -- `loadStatus` populating this field
  // correctly is `aiStore.test.ts`'s job, not this component's.
  it('reports CircleCI tools unavailable, with the host’s own reason, when no token is available', async () => {
    useAiStore.setState({
      providers: [provider({})],
      circleCI: {
        available: false,
        reason: 'no CircleCI API token available in this environment',
      },
    });
    mockFetchByMethodAndPath({});
    render(<AiSettings />);
    await screen.findByLabelText(/anthropic api key/i);

    const section = await screen.findByTestId('circleci-mcp-status');
    expect(within(section).getByText(/not available/i)).toBeTruthy();
    expect(section.textContent).toMatch(
      /no circleci api token available in this environment/i,
    );
  });

  it('reports CircleCI tools available, and says plainly that they are read-only', async () => {
    useAiStore.setState({
      providers: [provider({})],
      circleCI: { available: true },
    });
    mockFetchByMethodAndPath({});
    render(<AiSettings />);
    await screen.findByLabelText(/anthropic api key/i);

    const section = await screen.findByTestId('circleci-mcp-status');
    expect(within(section).getByText(/^available$/i)).toBeTruthy();
    expect(section.textContent).toMatch(/read-only/i);
    expect(section.textContent).toMatch(/cannot trigger, cancel, or rerun/i);
  });
});
