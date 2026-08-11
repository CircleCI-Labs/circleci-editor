import { useEffect, useId, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { InfoHint } from '~/design/components/InfoHint';
import { Spinner } from '~/design/components/Spinner';
import { useAiStore } from '~/state/aiStore';

/**
 * What the hover next to the heading says. Issue #71: a reviewer with customer
 * eyes did not know what Kapa was, and "Docs grounding (MCP)" told them
 * nothing -- "grounding" is an LLM term of art and "MCP" was expanded nowhere
 * in the app, while Kapa appeared only as an unexplained hostname in a
 * placeholder. Being asked to connect to an outside service you cannot name is
 * a reasonable thing to refuse.
 *
 * So: what the protocol is, who the default server belongs to, and what
 * actually leaves the machine. No pitch -- the point is that a user can decide,
 * which means the sentence about their questions being sent has to be as plain
 * as the rest.
 */
function DocsSearchHint() {
  return (
    <span className="block space-y-1.5">
      <span className="block">
        Documentation search runs over <strong>MCP</strong> (Model Context
        Protocol), an open standard for letting an assistant call an outside
        tool -- here, a documentation search index.
      </span>
      <span className="block">
        The default server is run by <strong>Kapa</strong>, a documentation
        search service, and indexes CircleCI's public documentation.
      </span>
      <span className="block text-cc-text-faint">
        With this on, your question is sent to that server to search against.
        You can point it at any MCP server instead, or leave it off entirely.
      </span>
    </span>
  );
}

/**
 * Configuration for this app's one optional documentation-search MCP server
 * (issue #111's "are we able to add an MCP server with bring your own
 * key" and issue #103's Kapa docs server specifically).
 *
 * The user-facing wording deliberately leads with what the feature *does*
 * ("Search CircleCI documentation") rather than how it works. It used to read
 * "Docs grounding (MCP)", which assumed the reader knew "grounding" as an LLM
 * term and knew what MCP was, and left Kapa as a bare hostname in a
 * placeholder -- issue #71, from a review done with customer eyes. The
 * mechanics and the third party are still stated, in the hover next to the
 * heading (`DocsSearchHint`), where they inform rather than gate.
 *
 * Deliberately one fixed slot, not a general multi-server manager: this
 * app has exactly one documented use for a remote MCP server today (docs
 * search), and every request/response mechanics are already generic at
 * the wire level (see internal/ai/anthropic's package doc) -- a second
 * slot is cheap to add later if a real second use shows up, and guessing
 * at that UI now would be speculative.
 *
 * The URL and credential stay BYO, same as a provider API key: this app has no
 * CircleCI-owned credential to ship, and no opinion about which server a user
 * points it at. Kapa is now named in the hover, which is a change of position
 * worth recording -- this component used to name no vendor at all. Declining to
 * name the default host was meant as neutrality, but the host was in the
 * placeholder regardless, so in practice it just meant an unexplained third
 * party. Naming it is what lets someone say no.
 *
 * Two ways to authenticate, both BYO in the sense that matters -- neither
 * ships a credential in this repo:
 *
 *  - **Sign in** (`McpOAuthSection`): the host runs a real OAuth 2.1 flow
 *    (dynamic client registration, PKCE, a loopback callback) and keeps the
 *    resulting tokens in the same keystore as a provider key, refreshing them
 *    itself. Verified to work against CircleCI's own docs MCP server --
 *    see issue #103.
 *  - **Paste a token**: for a server that issues long-lived tokens directly,
 *    or one whose authorization server has no dynamic client registration.
 */
export function McpSettings() {
  const status = useAiStore((state) => state.mcpStatus);
  const saving = useAiStore((state) => state.mcpSaving);
  const error = useAiStore((state) => state.mcpError);
  const loadMcpStatus = useAiStore((state) => state.loadMcpStatus);
  const saveMcp = useAiStore((state) => state.saveMcp);
  const removeMcp = useAiStore((state) => state.removeMcp);
  const loadMcpOAuthStatus = useAiStore((state) => state.loadMcpOAuthStatus);

  useEffect(() => {
    void loadMcpStatus();
    void loadMcpOAuthStatus();
    // Both are stable zustand action references; re-running this whenever
    // they "change" would just mean once, on mount -- the intent here is
    // exactly that, so they're omitted from the dependency array rather than
    // wrapped in a useCallback purely to satisfy the linter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlInputId = useId();
  const tokenInputId = useId();
  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');

  const handleSave = async () => {
    if (urlDraft.trim() === '') return;
    const ok = await saveMcp(urlDraft.trim(), tokenDraft.trim());
    if (ok) {
      setUrlDraft('');
      setTokenDraft('');
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-cc-border pt-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-cc-text">
          Search CircleCI documentation
          <InfoHint
            subject="documentation search"
            content={<DocsSearchHint />}
          />
        </h3>
        <p className="mt-1 text-xs text-cc-text-muted">
          Lets the assistant look up CircleCI's published documentation while it
          answers, instead of relying only on what the model was trained on.
          Optional: everything above works exactly the same with nothing set up
          here.
        </p>
      </div>

      {error ? <p className="text-xs text-cc-danger">{error}</p> : null}

      <McpOAuthSection />

      {status?.configured ? (
        <div
          className="rounded-md border border-cc-border-strong p-3"
          data-testid="mcp-configured"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone="success">Configured</Badge>
              <span className="font-mono text-2xs text-cc-text-faint">
                {status.hasToken ? 'token set' : 'no token'}
              </span>
            </div>
          </div>
          <p className="mt-1 truncate font-mono text-2xs text-cc-text-muted">
            {status.url}
          </p>
          <div className="mt-2">
            <Button
              variant="danger"
              size="sm"
              disabled={saving}
              onClick={() => void removeMcp()}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div>
            <label htmlFor={urlInputId} className="sr-only">
              MCP server URL
            </label>
            <input
              id={urlInputId}
              type="url"
              autoComplete="off"
              spellCheck={false}
              // The root endpoint, not `/sse`: probed live 2026-07-28, only
              // `https://circleci.mcp.kapa.ai/` answers -- `/sse` and `/mcp`
              // both 404, and CircleCI's own support article documents the
              // bare URL.
              placeholder="https://circleci.mcp.kapa.ai"
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              className="w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2.5 py-1.5 text-sm text-cc-text placeholder:text-cc-text-faint"
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor={tokenInputId} className="sr-only">
                MCP server auth token (optional)
              </label>
              <input
                id={tokenInputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Auth token (optional)"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSave();
                }}
                className="w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2.5 py-1.5 text-sm text-cc-text placeholder:text-cc-text-faint"
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={saving || urlDraft.trim() === ''}
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner size={12} label="Saving" /> : null}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How long a pending sign-in is polled for before the UI stops asking. The
 * host's own loopback listener gives up at five minutes; polling a little
 * longer than that would only ever report a timeout the host already recorded.
 */
const OAUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POLL_INTERVAL_MS = 1500;

/**
 * The interactive sign-in half of the docs-grounding settings.
 *
 * Nothing here ever sees a token. It shows whether one is stored, when it
 * expires, and -- the field that actually matters -- whether the server issued
 * something renewable. `hasRefreshToken: false` is called out prominently and
 * on purpose: that is the state in which the user *will* be asked to sign in
 * again, and issue #103's whole framing is that a feature which silently
 * re-prompts is worse than one that admits it up front. CircleCI's own support
 * article on this server is about exactly that failure mode occurring in
 * another client (`mcp-remote`, which did not persist its tokens), so saying
 * it out loud is the least this can do.
 */
function McpOAuthSection() {
  const oauth = useAiStore((state) => state.mcpOAuthStatus);
  const starting = useAiStore((state) => state.mcpOAuthStarting);
  const error = useAiStore((state) => state.mcpOAuthError);
  const mcpStatus = useAiStore((state) => state.mcpStatus);
  const startMcpOAuth = useAiStore((state) => state.startMcpOAuth);
  const removeMcpOAuth = useAiStore((state) => state.removeMcpOAuth);
  const loadMcpOAuthStatus = useAiStore((state) => state.loadMcpOAuthStatus);

  const pending = oauth?.state === 'pending';

  // While a sign-in is pending the outcome arrives on the host's own
  // goroutine, so the only way to learn it is to ask. Polling stops as soon
  // as the state moves off `pending`, and the interval is cleared on unmount
  // so a closed settings panel does not keep talking to the host.
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }
      void loadMcpOAuthStatus();
    }, OAUTH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // Signing in needs a URL from somewhere: either one already saved, or the
  // one the user is about to save. When neither exists the host would reject
  // the request, so the button says why instead of failing.
  const hasURL = Boolean(mcpStatus?.configured && mcpStatus.url);

  return (
    <div
      className="rounded-md border border-cc-border-strong p-3"
      data-testid="mcp-oauth"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={oauth?.authorized ? 'success' : 'neutral'}>
            {oauth?.authorized ? 'Signed in' : 'Not signed in'}
          </Badge>
          {pending ? (
            <span className="flex items-center gap-1 text-2xs text-cc-text-faint">
              <Spinner size={12} label="Waiting for sign-in" />
              waiting for the browser…
            </span>
          ) : null}
        </div>
        {oauth?.authorized ? (
          <Button
            variant="danger"
            size="sm"
            disabled={starting}
            onClick={() => void removeMcpOAuth()}
          >
            Sign out
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={starting || !hasURL}
            onClick={() => void startMcpOAuth()}
          >
            {starting ? <Spinner size={12} label="Starting" /> : null}
            {starting ? 'Starting…' : 'Sign in'}
          </Button>
        )}
      </div>

      {!hasURL && !oauth?.authorized ? (
        <p className="mt-1 text-2xs text-cc-text-muted">
          Save an MCP server URL below first, then sign in.
        </p>
      ) : null}

      {oauth?.authorized ? (
        <SignedInDetails
          expiresAt={oauth.token?.expiresAt}
          hasRefreshToken={oauth.token?.hasRefreshToken ?? false}
        />
      ) : null}

      {/* The host's own message: a plain-language failure reason, or the
          "no refresh token" warning it records the moment it becomes known. */}
      {oauth?.message ? (
        <p
          className={
            oauth.state === 'failed'
              ? 'mt-1 text-2xs text-cc-danger'
              : 'mt-1 text-2xs text-cc-warning'
          }
          data-testid="mcp-oauth-message"
        >
          {oauth.message}
        </p>
      ) : null}

      {error ? <p className="mt-1 text-2xs text-cc-danger">{error}</p> : null}
    </div>
  );
}

/** The non-secret facts about a stored sign-in, including the durability warning. */
function SignedInDetails({
  expiresAt,
  hasRefreshToken,
}: {
  expiresAt?: string;
  hasRefreshToken: boolean;
}) {
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <p className="text-2xs text-cc-text-muted">
        {expiresAt
          ? `Session expires ${new Date(expiresAt).toLocaleString()}.`
          : 'The server did not state a session lifetime.'}
      </p>
      <p
        className={
          hasRefreshToken
            ? 'text-2xs text-cc-text-faint'
            : 'text-2xs text-cc-warning'
        }
        data-testid="mcp-oauth-durability"
      >
        {hasRefreshToken
          ? 'Renewed automatically — you should not need to sign in again.'
          : 'This server issued no refresh token, so you will have to sign in again when the session expires.'}
      </p>
    </div>
  );
}
