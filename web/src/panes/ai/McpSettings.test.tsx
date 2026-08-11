import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiStore } from '~/state/aiStore';

import { McpSettings } from './McpSettings';

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
  mcpOAuthStatus: null,
  mcpOAuthStarting: false,
  mcpOAuthError: null,
};

const OAUTH_PATH = '/api/ai/mcp/oauth';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The sign-in endpoint's "nothing stored" answer, which most tests don't care about. */
function notSignedIn(): Response {
  return jsonResponse(200, { state: 'idle', authorized: false });
}

/**
 * Routes fetch calls by URL substring to a canned response queue.
 *
 * Two things this has to get right, both discovered by getting them wrong:
 *
 *  - **Longest path wins.** `/api/ai/mcp/oauth` *contains* `/api/ai/mcp`, so
 *    insertion-order matching would let the sign-in endpoint eat the config
 *    endpoint's queued responses (or the reverse), depending purely on which
 *    key happened to be declared first.
 *  - **The sign-in endpoint answers by default.** `McpSettings` loads it on
 *    mount, so otherwise every test here would have to mock an endpoint it is
 *    not testing. A test that *does* care supplies its own queue, which takes
 *    precedence; when that queue runs out this falls back to "not signed in"
 *    rather than throwing, since the component polls while a flow is pending.
 */
function mockFetchByPath(
  routes: Record<string, Response[]>,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const queues = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, [...v]]),
  );
  const paths = Object.keys(queues).sort((a, b) => b.length - a.length);

  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === 'string' ? input : String(input);
    // Checked before the loop, not inside it: a test that did not mock the
    // sign-in endpoint must not have its `/api/ai/mcp` queue consumed by a
    // request to `/api/ai/mcp/oauth` that merely contains that prefix.
    if (url.includes(OAUTH_PATH) && !(OAUTH_PATH in queues)) {
      return Promise.resolve(notSignedIn());
    }
    for (const path of paths) {
      if (!url.includes(path)) continue;
      const next = queues[path]?.shift();
      if (next) return Promise.resolve(next);
      if (path === OAUTH_PATH) return Promise.resolve(notSignedIn());
      throw new Error(`no more mocked responses for ${path}`);
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('McpSettings', () => {
  beforeEach(() => {
    useAiStore.setState(AI_STATE_RESET);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows nothing configured, and works with the docs MCP server never touched at all -- the "no MCP configured" default this whole feature must not regress', async () => {
    mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false, hasToken: false }),
      ],
    });
    render(<McpSettings />);

    await waitFor(() =>
      expect(screen.getByLabelText(/mcp server url/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mcp-configured')).not.toBeInTheDocument();
  });

  it('saves a URL, with no token to supply -- signing in is a separate step', async () => {
    const fetchMock = mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false }),
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai',
        }),
      ],
    });
    render(<McpSettings />);
    await waitFor(() =>
      expect(screen.getByLabelText(/mcp server url/i)).toBeInTheDocument(),
    );

    // Issue #70: there is no token field to find any more. Asserted rather
    // than merely not used, so reintroducing one is a test failure and not a
    // silent regression back to this host holding a pasted secret.
    expect(
      screen.queryByLabelText(/mcp server auth token/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/auth token/i),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/mcp server url/i),
      'https://circleci.mcp.kapa.ai',
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(screen.getByTestId('mcp-configured')).toBeInTheDocument(),
    );
    expect(screen.getByText('https://circleci.mcp.kapa.ai')).toBeVisible();

    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const sent = JSON.parse(String((putCall![1] as RequestInit).body));
    expect(sent).toEqual({ url: 'https://circleci.mcp.kapa.ai' });

    // The configured card no longer claims anything about a token: whether one
    // exists is the sign-in section's question, and two widgets answering it
    // is how they come to disagree.
    expect(screen.queryByText('token set')).not.toBeInTheDocument();
    expect(screen.queryByText('no token')).not.toBeInTheDocument();
  });

  it('removing a configured server clears it back to the empty form', async () => {
    mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai/sse',
          hasToken: false,
        }),
        jsonResponse(200, { configured: false, hasToken: false }),
      ],
    });
    render(<McpSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('mcp-configured')).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/mcp server url/i)).toBeInTheDocument(),
    );
  });

  it('shows an error message and stays on the form when saving fails', async () => {
    mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false, hasToken: false }),
        jsonResponse(400, {
          error: { message: 'url must start with https://' },
        }),
      ],
    });
    render(<McpSettings />);
    await waitFor(() =>
      expect(screen.getByLabelText(/mcp server url/i)).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/mcp server url/i),
      'http://insecure.example.com',
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(
        screen.getByText('url must start with https://'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mcp-configured')).not.toBeInTheDocument();
  });

  it('cannot sign in until a server URL exists, and says why', async () => {
    mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false, hasToken: false }),
      ],
    });
    render(<McpSettings />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled();
    expect(
      screen.getByText(/save an mcp server url below first/i),
    ).toBeVisible();
  });

  it('starts a sign-in by opening the host-supplied authorization URL, and never receives a token', async () => {
    const openSpy = vi.fn<typeof window.open>();
    vi.stubGlobal('open', openSpy);

    const authorizationUrl =
      'https://mcp.kapa.ai/auth/public/authorize?client_id=abc&state=xyz&code_challenge=chal';
    const fetchMock = mockFetchByPath({
      [OAUTH_PATH]: [
        jsonResponse(200, { state: 'idle', authorized: false }),
        // The POST to .../start.
        jsonResponse(200, {
          state: 'pending',
          authorized: false,
          authorizationUrl,
        }),
      ],
      '/api/ai/mcp': [
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai',
          hasToken: false,
        }),
      ],
    });
    render(<McpSettings />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^sign in$/i })).toBeEnabled(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    // `noopener` matters: the identity-provider page must not get a handle
    // back to this window.
    expect(openSpy).toHaveBeenCalledWith(
      authorizationUrl,
      '_blank',
      'noopener,noreferrer',
    );

    const startCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/oauth/start') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(startCall).toBeDefined();
  });

  it('states plainly that a session without a refresh token will need signing in again', async () => {
    mockFetchByPath({
      [OAUTH_PATH]: [
        jsonResponse(200, {
          state: 'authorized',
          authorized: true,
          resource: 'https://circleci.mcp.kapa.ai/',
          message:
            'signed in, but this server issued no refresh token, so you will need to sign in again when the session expires',
          token: { hasRefreshToken: false, expiresAt: '2026-07-28T12:00:00Z' },
        }),
      ],
      '/api/ai/mcp': [
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai',
          hasToken: false,
        }),
      ],
    });
    render(<McpSettings />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth-durability')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mcp-oauth-durability').textContent).toMatch(
      /issued no refresh token, so you will have to sign in again/i,
    );
    // And the host's own warning is surfaced, not swallowed.
    expect(screen.getByTestId('mcp-oauth-message').textContent).toMatch(
      /no refresh token/i,
    );
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled();
  });

  it('says a renewable session will not need signing in again', async () => {
    mockFetchByPath({
      [OAUTH_PATH]: [
        jsonResponse(200, {
          state: 'authorized',
          authorized: true,
          token: { hasRefreshToken: true, expiresAt: '2026-07-28T12:00:00Z' },
        }),
      ],
      '/api/ai/mcp': [
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai',
          hasToken: false,
        }),
      ],
    });
    render(<McpSettings />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth-durability')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mcp-oauth-durability').textContent).toMatch(
      /renewed automatically/i,
    );
    expect(screen.queryByTestId('mcp-oauth-message')).not.toBeInTheDocument();
  });

  it('surfaces a failed sign-in reason from the host', async () => {
    mockFetchByPath({
      [OAUTH_PATH]: [
        jsonResponse(200, {
          state: 'failed',
          authorized: false,
          message: 'sign-in timed out; no response came back from the browser',
        }),
      ],
      '/api/ai/mcp': [
        jsonResponse(200, {
          configured: true,
          url: 'https://circleci.mcp.kapa.ai',
          hasToken: false,
        }),
      ],
    });
    render(<McpSettings />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-oauth-message')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mcp-oauth-message').textContent).toMatch(
      /timed out/i,
    );
    expect(screen.getByText(/not signed in/i)).toBeVisible();
  });
});

/**
 * Issue #71: the section used to be headed "Docs grounding (MCP)" with Kapa
 * appearing only as a hostname in a placeholder, and a reviewer looking at it
 * with customer eyes could not tell what it was or who it involved.
 */
describe('explaining what this is', () => {
  beforeEach(() => {
    useAiStore.setState(AI_STATE_RESET);
    mockFetchByPath({
      '/api/ai/mcp': [
        jsonResponse(200, { configured: false, hasToken: false }),
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leads with what the feature does, not how it works', async () => {
    render(<McpSettings />);
    expect(
      await screen.findByRole('heading', {
        name: /Search CircleCI documentation/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Docs grounding/)).not.toBeInTheDocument();
  });

  it('names Kapa, expands MCP, and says what gets sent -- on hover', async () => {
    render(<McpSettings />);
    await userEvent.hover(
      await screen.findByRole('button', {
        name: 'More about documentation search',
      }),
    );
    expect(await screen.findByText(/Kapa/)).toBeInTheDocument();
    expect(screen.getByText(/Model Context Protocol/)).toBeInTheDocument();
    // The disclosure a user needs in order to decline, not just to consent.
    expect(
      screen.getByText(/your question is sent to that server/),
    ).toBeInTheDocument();
  });
});
