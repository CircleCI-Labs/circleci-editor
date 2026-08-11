/**
 * AI pane state (issue #92): provider/key configuration status, the chat
 * transcript, and any proposed config change awaiting the user's approval.
 *
 * Deliberately a separate store from `appStore`, same rationale as
 * `orbStore`: none of this is config state, and the *only* way anything
 * here ever touches the document is `approveAction` calling
 * `useAppStore.getState().mutate(...)` -- exactly the same entry point
 * every other visual edit in this app uses, applying exactly the mutation
 * a human clicking through the DAG/inspector would trigger (see
 * `lib/ai/actions.ts`). Nothing here ever writes YAML text directly, and
 * nothing here ever calls `save()` -- persisting to disk still requires the
 * same explicit Save-dialog step as any other edit.
 */
import { create } from 'zustand';

import { buildAiContext, buildDirectoryContext } from '~/lib/ai/context';
import type { DirectoryContext } from '~/lib/ai/context';
import {
  applyAction,
  extractAction,
  type ProposedAction,
} from '~/lib/ai/actions';
import type { FixTopic } from '~/lib/ai/deterministicSources';
import {
  ApiError,
  deleteAiKey,
  deleteAiMcp,
  getAiMcpStatus,
  getAiStatus,
  deleteAiMcpOAuth,
  getAiMcpOAuthStatus,
  getConfigFiles,
  postAiChat,
  putAiKey,
  putAiMcp,
  startAiMcpOAuth,
  type AiChatMessage,
  type AiChatSource,
  type AiCircleCIStatus,
  type AiKeyStorage,
  type AiMcpOAuthStatus,
  type AiMcpStatus,
  type AiProviderStatus,
} from '~/lib/rpc/client';
import { useAppStore } from './appStore';
import {
  isPolicyDecisionStale,
  policyViolations,
  usePolicyStore,
} from './policyStore';

/** `directoryContext` before the first `refreshDirectoryContext()` resolves, and its permanent fallback on failure. */
const EMPTY_DIRECTORY_CONTEXT: DirectoryContext = {
  otherFiles: [],
  skippedFiles: [],
};

export type AiStatusState = 'loading' | 'ready' | 'error';

/** Whether a proposed action attached to an assistant message has been acted on yet. */
export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'failed';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The assistant's full reply, including any fenced ```action block -- `stripActionBlock` is applied only at render time, so the raw text (and therefore the exact model output) is never lost from history. */
  content: string;
  /** Set when this reply is a degraded-state or transport-failure notice rather than a real provider reply (e.g. "no key configured", "request failed") -- rendered distinctly, and never fed back to the provider as conversation history. */
  isNotice?: boolean;
  action?: ProposedAction;
  actionStatus?: ActionStatus;
  /** Set when `actionStatus` is `'failed'` -- the message `configMutations.ts` threw (e.g. "job already exists"), shown instead of a diff. */
  actionError?: string;
  /**
   * Links the provider's MCP tool calls turned up (issue #103's "citations in
   * replies"), rendered by `ChatMessageView` independent of whatever the reply
   * text itself says. Empty/absent whenever no docs MCP server is configured,
   * or one is but wasn't used for this particular reply.
   *
   * Each carries the human title the host resolved offline from the vendored
   * docs snapshot, where it could (issue #156); `~/lib/ai/sources` turns these
   * into rows. Stored exactly as received, so how they are presented can change
   * without the transcript having lost anything.
   */
  sources?: AiChatSource[];
  /**
   * What the turn this reply answers was *about*, when it answers a prompt
   * seeded by the validation strip's "Fix with AI" (issues #148/#210).
   *
   * It is what lets `AssistantMessage` attach the citations this app holds with
   * certainty -- the orb's own registry page, the vendored Orbs pages -- and rank
   * the retrieved ones by whether they concern the same thing. Stored rather than
   * re-derived because the diagnostic that produced it is long gone by the time
   * the reply lands: the user may have fixed the config, or broken it differently,
   * while the request was in flight.
   *
   * Absent for an ordinary question, and that is the point: relevance is attached
   * where it is *known*, never guessed (see `~/lib/ai/deterministicSources`).
   */
  sourceTopic?: FixTopic;
  /**
   * Set on an assistant reply that a docs-grounding MCP server *was*
   * configured for but which could not use it (an expired sign-in, a revoked
   * credential). Rendered as a visible notice by `ChatMessageView`, because
   * the failure worth catching here is the user believing answers are sourced
   * when they have quietly gone back to being recalled -- issue #103's
   * "degrade honestly".
   *
   * Deliberately absent when nothing is configured at all: "you never set
   * this up" is not a warning worth repeating on every single reply.
   */
  groundingReason?: string;
}

let nextMessageId = 0;
function newMessageId(): string {
  nextMessageId += 1;
  return `msg-${nextMessageId}`;
}

/**
 * The failing config-policy rules worth sending as context on the next chat
 * request (issue #247 item 6) -- reading `policyStore` directly, the same
 * way `buildFixPrompt`'s callers read a specific `Diagnostic`, rather than
 * `buildAiContext` reaching into it itself (that function stays a pure,
 * narrowly-typed transform of a plain `AiContextSource`, testable without
 * either store; see its own doc comment).
 *
 * A stale decision -- one made against text that has since changed -- is
 * withheld exactly as `PolicyRulesView` withholds its violations for the same
 * reason: a verdict about a config that no longer exists is not a fact
 * about the one on screen, and telling the model it is would be sending it
 * something false rather than nothing.
 */
function currentPolicyContext() {
  const { decision, checkedText } = usePolicyStore.getState();
  const text = useAppStore.getState().text;
  if (isPolicyDecisionStale({ decision, checkedText }, text)) return [];
  return policyViolations(decision).map((violation) => ({
    rule: violation.rule,
    reason: violation.reason,
    blocking: violation.kind === 'hard',
  }));
}

interface AiState {
  statusState: AiStatusState;
  providers: AiProviderStatus[];
  storage: AiKeyStorage | null;
  /**
   * Issue #11's CircleCI MCP server status -- `null` only until `loadStatus`
   * has resolved at least once, the same convention `storage` already
   * follows. Refreshed by the same request as every provider's status, so
   * there is no separate loading state to track for it.
   */
  circleCI: AiCircleCIStatus | null;
  statusError: string | null;
  /** The provider the chat form will send to. Defaults to the first provider `loadStatus` reports; `AiPane` lets the user change it if more than one is ever registered. */
  selectedProvider: string;
  messages: ChatMessage[];
  sending: boolean;
  /** A chat-request-level failure (network/transport/non-2xx) -- distinct from a per-message notice, since it means the request never got a reply at all. */
  chatError: string | null;
  savingKey: boolean;
  keyError: string | null;
  /** This app's one optional docs-grounding MCP server (issue #111/#103), or `null` until `loadMcpStatus` has resolved at least once. */
  mcpStatus: AiMcpStatus | null;
  mcpSaving: boolean;
  mcpError: string | null;
  /**
   * The docs-grounding MCP sign-in (issue #103), or `null` until
   * `loadMcpOAuthStatus` has resolved once. Never holds a token -- see
   * `AiMcpOAuthStatus`; the host performs the flow and keeps the credential.
   */
  mcpOAuthStatus: AiMcpOAuthStatus | null;
  mcpOAuthStarting: boolean;
  mcpOAuthError: string | null;
  /**
   * The read-only "other files" half of the AI context (issue #102) --
   * every sibling file in the indexed directory that fits the token
   * budget, and every one that doesn't (with why). Refreshed by
   * `refreshDirectoryContext` and used verbatim by `sendMessage`.
   *
   * It had a second reader until #253: `AiPane`'s transparency line, which
   * described the next request from this same value so the two could never
   * disagree about what a message was about to send. The line is gone;
   * `skippedFiles` keeps its other, load-bearing reader, which was
   * never the UI -- the host names those files in the system prompt so the
   * model knows a directory it wasn't given the whole of (see
   * `internal/host/ai.go`'s `buildSystemPrompt`).
   */
  directoryContext: DirectoryContext;
  directoryContextStatus: 'idle' | 'loading' | 'ready' | 'error';
  /**
   * A prompt composed elsewhere in the app -- today the YAML pane's
   * validation strip, via its "Fix with AI" button (issue #148) -- and
   * dropped into this pane's composer for the user to read and send.
   *
   * Emphatically *not* a queued message: nothing here ever calls
   * `sendMessage`, so seeding a prompt costs no tokens, needs no key, and
   * cannot mutate the config. `seq` is what makes re-seeding the same text
   * take effect again after the user has edited (or cleared) the draft --
   * without it, `AiPane`'s effect would see an unchanged value and leave a
   * stale draft in place.
   */
  promptSeed: { text: string; seq: number; topic?: FixTopic } | null;

  loadStatus: () => Promise<void>;
  /**
   * Refetches every file in the open file's directory (with contents) and
   * re-derives `directoryContext` against whichever file is currently
   * open. `AiPane` calls this whenever the open file or the directory
   * listing changes; a failure degrades to "no sibling context" rather
   * than blocking the pane -- issue #102 is a strict enhancement over the
   * single-file context that already worked.
   */
  refreshDirectoryContext: () => Promise<void>;
  setSelectedProvider: (id: string) => void;
  saveKey: (provider: string, key: string) => Promise<boolean>;
  removeKey: (provider: string) => Promise<void>;
  loadMcpStatus: () => Promise<void>;
  saveMcp: (url: string) => Promise<boolean>;
  removeMcp: () => Promise<void>;
  loadMcpOAuthStatus: () => Promise<void>;
  /**
   * Starts an interactive sign-in and opens the returned authorization URL in
   * a new tab. Returns the URL so a caller that would rather render a link
   * than have a tab opened for it can do that instead -- and so a test can
   * assert on it without a real browser.
   *
   * The tab is opened here, in page JavaScript, rather than by the host
   * shelling out to `open`: `internal/host/browser.go` refuses to launch
   * anything but a loopback http URL, and that refusal is a security control
   * worth keeping rather than widening for this one feature.
   */
  startMcpOAuth: (url?: string) => Promise<string | null>;
  removeMcpOAuth: () => Promise<void>;
  /**
   * Puts `text` in the composer without sending it (see `promptSeed`), and
   * kicks `loadStatus()` if provider status hasn't landed yet -- a preset
   * that doesn't render the AI pane never mounts it, so nothing would
   * otherwise have loaded the status the caller needs in order to tell the
   * user honestly whether a key is configured.
   *
   * `topic` says what the prompt is *about*, in the diagnostic classifier's own
   * terms (#210). It is carried, never acted on: seeding still sends nothing,
   * costs nothing and cannot mutate the config.
   */
  seedPrompt: (text: string, topic?: FixTopic) => void;
  clearPromptSeed: () => void;
  /**
   * Sends `content` to the selected provider. `topic` is attached to the
   * resulting reply so its citations can be aimed at what the fix is about
   * (#210) -- see `ChatMessage.sourceTopic`.
   */
  sendMessage: (content: string, topic?: FixTopic) => Promise<void>;
  /** Applies a pending action's message via `appStore.mutate()` -- the one and only place this store touches the document. */
  approveAction: (messageId: string) => void;
  rejectAction: (messageId: string) => void;
  clearChatError: () => void;
}

/** The provider ids this store currently knows are configured, derived from `providers` -- exported as a helper (not state) so components don't have to re-derive it themselves. */
export function isProviderConfigured(
  providers: AiProviderStatus[],
  id: string,
): boolean {
  return providers.some((p) => p.id === id && p.configured);
}

export const useAiStore = create<AiState>((set, get) => ({
  statusState: 'loading',
  providers: [],
  storage: null,
  circleCI: null,
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
  directoryContext: EMPTY_DIRECTORY_CONTEXT,
  directoryContextStatus: 'idle',
  promptSeed: null,

  seedPrompt: (text, topic) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    set((state) => ({
      promptSeed: {
        text: trimmed,
        seq: (state.promptSeed?.seq ?? 0) + 1,
        ...(topic === undefined ? {} : { topic }),
      },
    }));
    if (get().statusState !== 'ready') {
      void get().loadStatus();
    }
  },

  clearPromptSeed: () => set({ promptSeed: null }),

  refreshDirectoryContext: async () => {
    set({ directoryContextStatus: 'loading' });
    try {
      const resp = await getConfigFiles(true);
      const activePath = useAppStore.getState().configPath;
      const directory = buildDirectoryContext(activePath, resp.files);
      set({ directoryContext: directory, directoryContextStatus: 'ready' });
    } catch {
      set({
        directoryContext: EMPTY_DIRECTORY_CONTEXT,
        directoryContextStatus: 'error',
      });
    }
  },

  loadStatus: async () => {
    set({ statusState: 'loading', statusError: null });
    try {
      const status = await getAiStatus();
      set((state) => ({
        statusState: 'ready',
        providers: status.providers,
        storage: status.storage,
        // `?? null` guards against an older host build's response, which
        // simply has no such field: `undefined` would otherwise reach
        // `CircleCIToolsStatus` as neither its "not yet loaded" (`null`)
        // nor its "loaded and off" (`{available: false}`) case, which is
        // exactly the "state this component cannot determine must never
        // render as though determined" failure that component's own doc
        // comment guards against on the render side -- this is that same
        // guarantee applied where the value first enters the store.
        circleCI: status.circleCI ?? null,
        // Keep an already-chosen provider if it's still in the list;
        // otherwise default to the first one so the chat form always has
        // something selected once any provider exists.
        selectedProvider:
          state.selectedProvider &&
          status.providers.some((p) => p.id === state.selectedProvider)
            ? state.selectedProvider
            : (status.providers[0]?.id ?? ''),
      }));
    } catch (error) {
      set({
        statusState: 'error',
        statusError:
          error instanceof Error ? error.message : 'Failed to load AI status',
      });
    }
  },

  setSelectedProvider: (id) => set({ selectedProvider: id }),

  saveKey: async (provider, key) => {
    set({ savingKey: true, keyError: null });
    try {
      await putAiKey(provider, key);
      await get().loadStatus();
      set({ savingKey: false });
      return true;
    } catch (error) {
      set({
        savingKey: false,
        keyError:
          error instanceof Error ? error.message : 'Failed to save the API key',
      });
      return false;
    }
  },

  removeKey: async (provider) => {
    set({ savingKey: true, keyError: null });
    try {
      await deleteAiKey(provider);
      await get().loadStatus();
    } catch (error) {
      set({
        keyError:
          error instanceof Error
            ? error.message
            : 'Failed to remove the API key',
      });
    } finally {
      set({ savingKey: false });
    }
  },

  loadMcpStatus: async () => {
    try {
      const status = await getAiMcpStatus();
      set({ mcpStatus: status, mcpError: null });
    } catch (error) {
      set({
        mcpError:
          error instanceof Error
            ? error.message
            : 'Failed to load the docs MCP server configuration',
      });
    }
  },

  saveMcp: async (url) => {
    set({ mcpSaving: true, mcpError: null });
    try {
      const status = await putAiMcp(url);
      set({ mcpSaving: false, mcpStatus: status });
      return true;
    } catch (error) {
      set({
        mcpSaving: false,
        mcpError:
          error instanceof Error
            ? error.message
            : 'Failed to save the docs MCP server configuration',
      });
      return false;
    }
  },

  removeMcp: async () => {
    set({ mcpSaving: true, mcpError: null });
    try {
      const status = await deleteAiMcp();
      set({ mcpStatus: status });
    } catch (error) {
      set({
        mcpError:
          error instanceof Error
            ? error.message
            : 'Failed to remove the docs MCP server configuration',
      });
    } finally {
      set({ mcpSaving: false });
    }
  },

  loadMcpOAuthStatus: async () => {
    try {
      const status = await getAiMcpOAuthStatus();
      set({ mcpOAuthStatus: status, mcpOAuthError: null });
    } catch (error) {
      set({
        mcpOAuthError:
          error instanceof Error
            ? error.message
            : 'Failed to load the docs MCP sign-in status',
      });
    }
  },

  startMcpOAuth: async (url) => {
    set({ mcpOAuthStarting: true, mcpOAuthError: null });
    try {
      const status = await startAiMcpOAuth(url);
      set({ mcpOAuthStarting: false, mcpOAuthStatus: status });
      const target = status.authorizationUrl ?? null;
      if (target) {
        // `noopener` matters: without it the identity-provider page we just
        // opened gets a handle back to this window through `window.opener`.
        window.open(target, '_blank', 'noopener,noreferrer');
      }
      return target;
    } catch (error) {
      set({
        mcpOAuthStarting: false,
        mcpOAuthError:
          error instanceof Error
            ? error.message
            : 'Failed to start the docs MCP sign-in',
      });
      return null;
    }
  },

  removeMcpOAuth: async () => {
    set({ mcpOAuthStarting: true, mcpOAuthError: null });
    try {
      const status = await deleteAiMcpOAuth();
      set({ mcpOAuthStatus: status });
    } catch (error) {
      set({
        mcpOAuthError:
          error instanceof Error
            ? error.message
            : 'Failed to remove the docs MCP sign-in',
      });
    } finally {
      set({ mcpOAuthStarting: false });
    }
  },

  sendMessage: async (content, topic) => {
    const trimmed = content.trim();
    if (trimmed === '') return;

    const provider = get().selectedProvider;
    const userMessage: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: trimmed,
    };
    set((state) => ({
      messages: [...state.messages, userMessage],
      sending: true,
      chatError: null,
    }));

    // Only real (non-notice) turns are replayed to the provider as history
    // -- a "no key configured"/transport-failure notice was never actually
    // said by either side of the conversation, so echoing it back would
    // misrepresent the transcript to the model.
    const history: AiChatMessage[] = get()
      .messages.filter((m) => !m.isNotice)
      .map((m) => ({ role: m.role, content: m.content }));

    const context = buildAiContext(
      { ...useAppStore.getState(), policyViolations: currentPolicyContext() },
      get().directoryContext,
    );

    try {
      const response = await postAiChat(provider, history, context);
      if (!response.available) {
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: newMessageId(),
              role: 'assistant',
              content: response.reason ?? 'No AI provider is configured.',
              isNotice: true,
            },
          ],
          sending: false,
        }));
        return;
      }

      const replyText = response.content ?? '';
      const action = extractAction(replyText);
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: newMessageId(),
            role: 'assistant',
            content: replyText,
            action,
            actionStatus: action ? 'pending' : undefined,
            sources: response.sources,
            sourceTopic: topic,
            groundingReason: response.groundingReason,
          },
        ],
        sending: false,
      }));
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'The request failed.';
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: newMessageId(),
            role: 'assistant',
            content: message,
            isNotice: true,
          },
        ],
        sending: false,
        chatError: message,
      }));
    }
  },

  approveAction: (messageId) => {
    const message = get().messages.find((m) => m.id === messageId);
    if (!message?.action || message.actionStatus !== 'pending') return;

    const action = message.action;
    // applyAction throws exactly the way every other configMutations-backed
    // edit does (e.g. "job already exists"); appStore.mutate() already
    // knows how to catch that, discard the clone, and surface it via
    // editError -- this closure just lets the throw propagate to it.
    useAppStore.getState().mutate((doc) => {
      applyAction(doc, action);
    }, `AI: ${action.type}`);

    const failure = useAppStore.getState().editError ?? undefined;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? failure
            ? { ...m, actionStatus: 'failed', actionError: failure }
            : { ...m, actionStatus: 'applied' }
          : m,
      ),
    }));
  },

  rejectAction: (messageId) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, actionStatus: 'rejected' } : m,
      ),
    }));
  },

  clearChatError: () => set({ chatError: null }),
}));
