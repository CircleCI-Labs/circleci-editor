import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Panel } from '~/design/components/Panel';
import { Spinner } from '~/design/components/Spinner';
import { Tooltip } from '~/design/components/Tooltip';
import { useElementSize } from '~/layout/useElementSize';
import type { FixTopic } from '~/lib/ai/deterministicSources';
import { useAiStore } from '~/state/aiStore';
import { useAppStore } from '~/state/appStore';

import { AiSettings } from './AiSettings';
import { ChatMessageView } from './ChatMessageView';
import { Composer } from './Composer';
import { EmptyTranscript } from './EmptyTranscript';
import { MessageRow } from './MessageRow';
import { ThinkingMessage } from './ThinkingMessage';
import { useStickToBottom } from './useStickToBottom';

/**
 * The AI pane (issue #92): a chat that answers questions about the open
 * config using real, already-loaded context, and can propose a change --
 * always as a diff the user approves before anything is written (see
 * `ProposeChangeDialog`).
 *
 * Degrades honestly at every layer, per the issue's own requirement:
 *  - No key configured for the selected provider: the composer stays
 *    disabled and explains how to add one (via `AiSettings`), rather than
 *    accepting a message it can only fail on. Editing and the DAG are
 *    unaffected -- they never touch this pane's state at all.
 *  - No network / a provider outage: `useAiStore.sendMessage` catches the
 *    failure and renders it as a notice in the transcript instead of
 *    throwing or hanging the pane.
 *  - A `GET /api/ai/status` failure at load: shown inline, and does not
 *    block the rest of the app from rendering.
 *
 * ## Its shape, after #209
 *
 * The transcript is a component per message role (`ChatMessageView` routes,
 * `MessageRow` frames), "thinking" is a message in the thread rather than a
 * spinner beside it, and the newest message is kept in view unless the user has
 * scrolled away (`useStickToBottom`, issue #207).
 *
 * The column is two rows, and the order in which they give up space matters:
 * the transcript -- the pane's **one** scroll region (#88) -- shrinks
 * first, the composer never. Before #209 the composer was the row that lost, and
 * on the default preset its bottom 26px (the Send button included) sat below the
 * pane's own fold. See `composerSize`'s header for the measurements.
 *
 * ## What this pane no longer says inline (#253)
 *
 * A third row used to sit between the transcript and the composer, naming every
 * file a request would send and its estimated token count. It is gone, and
 * nothing replaced it here -- not an icon, not a tooltip, not a disclosure. The
 * disclosure it carried is standing context rather than an event, so it lives in
 * this editor's own docs page ("What leaves your machine" in
 * `internal/guides/editor/using-this-editor.adoc`), which is where a reader can
 * find it before they ever open this pane.
 *
 * The per-reply notices are a different thing and stay: `NoticeMessage` reports
 * something that happened to *that answer*, and `SourcesList` says what a
 * particular reply was grounded in.
 */
export function AiPane() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // Issues #186/#209: the composer sizes itself against the room it and the
  // transcript actually share, which since #253 removed the transparency line
  // between them is the whole of this column. 0 until measured, and forever in
  // jsdom; `resolveComposerHeight` treats that as "unmeasured", not "no space".
  const columnRef = useRef<HTMLDivElement | null>(null);
  const { height: columnPx } = useElementSize(columnRef);

  const statusState = useAiStore((state) => state.statusState);
  const statusError = useAiStore((state) => state.statusError);
  const providers = useAiStore((state) => state.providers);
  const selectedProvider = useAiStore((state) => state.selectedProvider);
  const setSelectedProvider = useAiStore((state) => state.setSelectedProvider);
  const messages = useAiStore((state) => state.messages);
  const sending = useAiStore((state) => state.sending);
  const chatError = useAiStore((state) => state.chatError);
  const loadStatus = useAiStore((state) => state.loadStatus);
  const sendMessage = useAiStore((state) => state.sendMessage);
  const approveAction = useAiStore((state) => state.approveAction);
  const rejectAction = useAiStore((state) => state.rejectAction);
  const promptSeed = useAiStore((state) => state.promptSeed);
  const clearPromptSeed = useAiStore((state) => state.clearPromptSeed);

  useEffect(() => {
    void loadStatus();
    // Runs once on mount -- loadStatus is a stable store action, and this
    // pane has no props/state that should re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * What the draft currently in the box is *about*, when it arrived from the
   * validation strip's "Fix with AI" (issues #148/#210). It rides with the draft
   * rather than with the conversation: it is attached to the reply that answers
   * this prompt and cleared on send, so an unrelated question asked afterwards
   * does not inherit an orb error's citations.
   */
  const [draftTopic, setDraftTopic] = useState<FixTopic | undefined>(undefined);

  // Issue #148: a prompt composed by the validation strip's "Fix with AI"
  // button lands in the composer, unsent. Keyed on `seq`, not on the text,
  // so clicking the button again after editing (or clearing) the draft
  // re-seeds it -- see `aiStore.promptSeed`. `[seq]` is the whole dependency
  // list deliberately: including `promptSeed` itself would re-run on any
  // identity change and stomp on whatever the user had started typing.
  const seedSeq = promptSeed?.seq;
  useEffect(() => {
    if (seedSeq === undefined) return;
    const seed = useAiStore.getState().promptSeed;
    setDraft(seed?.text ?? '');
    setDraftTopic(seed?.topic);
    // The seed has been handed over; leaving it in the store would re-apply
    // it to the next pane that mounts.
    clearPromptSeed();
  }, [seedSeq, clearPromptSeed]);

  const activeProvider = providers.find((p) => p.id === selectedProvider);
  const configured = activeProvider?.configured ?? false;

  // Auto-open Settings the first time this pane has something to configure
  // and nothing configured yet -- this is the "explains how to add one"
  // half of the no-key degrade, surfaced proactively rather than only after
  // a failed send.
  useEffect(() => {
    if (
      statusState === 'ready' &&
      providers.length > 0 &&
      !providers.some((p) => p.configured)
    ) {
      setSettingsOpen(true);
    }
  }, [statusState, providers]);

  // The two things `refreshDirectoryContext` is keyed off. The config's own
  // text, document and validation state are deliberately *not* subscribed to
  // here: `aiStore.sendMessage` reads them itself when a request is actually
  // built (see `buildAiContext`), and until #253 this pane only held them to
  // render the estimated size of a request nobody had sent yet.
  const configPath = useAppStore((state) => state.configPath);
  const files = useAppStore((state) => state.files);

  const refreshDirectoryContext = useAiStore(
    (state) => state.refreshDirectoryContext,
  );

  // Issue #102: re-derive the read-only "other files" context whenever the
  // open file changes (switching files -- issue #106 -- changes which file
  // is "active" and therefore which ones are "other") or the directory
  // listing itself changes (initial load, or a file appearing/disappearing
  // on disk). `files.length`/`configPath` are enough to key this off --
  // this is a cheap, local, idempotent refetch, not something worth a
  // finer-grained diff.
  useEffect(() => {
    void refreshDirectoryContext();
  }, [configPath, files, refreshDirectoryContext]);

  // Issue #207: the transcript sticks to its newest message, and stops the
  // moment the user scrolls up to read history. Keyed on the message count and
  // whether a reply is in flight -- the two things that change what "newest"
  // means -- rather than on the messages array itself.
  const transcript = useStickToBottom<HTMLDivElement>([
    messages.length,
    sending,
  ]);

  const handleSubmit = useCallback(() => {
    const current = draft;
    if (current.trim() === '' || sending || !configured) return;
    setDraft('');
    const topic = draftTopic;
    setDraftTopic(undefined);
    void sendMessage(current, topic);
  }, [configured, draft, draftTopic, sendMessage, sending]);

  return (
    <Panel
      title="AI Assistant"
      headerExtra={
        <>
          {providers.length > 1 ? (
            <select
              aria-label="AI provider"
              value={selectedProvider}
              onChange={(event) => setSelectedProvider(event.target.value)}
              className="rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1 text-xs text-cc-text"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : null}
          {statusState === 'ready' ? (
            <Tooltip
              content={
                configured
                  ? `Using ${activeProvider?.label}`
                  : 'No API key configured'
              }
            >
              <span tabIndex={0}>
                <Badge tone={configured ? 'success' : 'neutral'}>
                  {configured ? 'Ready' : 'No key'}
                </Badge>
              </span>
            </Tooltip>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-pressed={settingsOpen}
          >
            {settingsOpen ? 'Hide settings' : 'Settings'}
          </Button>
        </>
      }
      contentClassName="p-0"
    >
      <div ref={columnRef} className="flex h-full min-h-0 flex-col">
        {settingsOpen ? (
          <div className="shrink-0 border-b border-cc-border">
            <AiSettings />
          </div>
        ) : null}

        {statusState === 'error' ? (
          <p className="shrink-0 px-4 py-2 text-xs text-cc-danger">
            Failed to load AI status: {statusError}
          </p>
        ) : null}

        {/* `min-h-0` is what lets the transcript be the row that yields when the
            pane is short: without it a flex item refuses to shrink below its own
            content, which is how the composer -- the one row a user must always
            be able to reach -- ended up with its bottom 26px below the pane's
            own fold on the default preset. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={transcript.ref}
            data-testid="ai-transcript"
            // `role="log"` matches what this is: an append-only record whose
            // newest entry is the interesting one. It carries an implicit
            // `aria-live="polite"`, so a reply is announced without the focus
            // being taken out of the composer.
            role="log"
            aria-label="Conversation"
            className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-3"
          >
            {statusState === 'loading' ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner label="Loading AI status" />
              </div>
            ) : messages.length === 0 && !sending ? (
              <EmptyTranscript configured={configured} />
            ) : (
              <>
                {messages.map((message) => (
                  <ChatMessageView
                    key={message.id}
                    message={message}
                    onApprove={() => approveAction(message.id)}
                    onReject={() => rejectAction(message.id)}
                  />
                ))}
                {/* Issue #192: a message in the thread, in the place its answer
                    will appear, rather than a spinner off to one side. */}
                {sending ? (
                  <MessageRow role="assistant">
                    <ThinkingMessage />
                  </MessageRow>
                ) : null}
              </>
            )}
          </div>

          {/* Issue #207's other half: when the transcript is *not* stuck to its
              bottom, say so and offer the way back. Floating over the transcript
              rather than sitting in the column, so it costs no height in a pane
              that has none to spare -- and it is an ordinary button, so it is
              reachable by keyboard like anything else. */}
          {!transcript.atBottom ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
              <Button
                size="sm"
                variant="secondary"
                onClick={transcript.scrollToBottom}
                data-testid="ai-scroll-to-newest"
                className="pointer-events-auto shadow-sm"
              >
                Jump to newest ↓
              </Button>
            </div>
          ) : null}
        </div>

        {chatError ? (
          <p className="shrink-0 px-4 py-1 text-xs text-cc-danger">
            {chatError}
          </p>
        ) : null}

        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={handleSubmit}
          configured={configured}
          sending={sending}
          availablePx={columnPx}
          seedSeq={seedSeq}
        />
      </div>
    </Panel>
  );
}
