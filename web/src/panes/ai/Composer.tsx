/**
 * The AI pane's message box (issues #186 and #209).
 *
 * Four behaviours, and each exists because something specific was broken:
 *
 *  1. **It grows with its content, with no action from the user.** A prompt
 *     seeded by "Fix with AI" (#163) is ~30 lines, and the whole point of
 *     seeding rather than sending is that the user reads it first. The pre-#186
 *     fixed `rows={2}` made that safety property useless.
 *  2. **It can be resized, by pointer or keyboard, and the size persists.** The
 *     owner asked for it to be customisable. The handle is a `role="separator"`
 *     with the same arrow/Home/End contract as `layout/Splitter` and
 *     `DagPane`'s `InspectorDivider`, so it is not a mouse-only affordance. It
 *     is absent — not disabled — on a pane with no room to give, because a
 *     control that cannot move is worse than no control, and its 12px are worth
 *     more to the text area on exactly those panes.
 *  3. **Enter versus newline does not change as it grows.** Enter always sends,
 *     Shift+Enter always adds a line, at every size. A rule that changed with the
 *     height (send only on ⌘Enter once multiline, say) would be the opposite of
 *     predictable, and getting it wrong costs a user a half-edited prompt sent to
 *     a paid API.
 *  4. **It says when it is holding more than it is showing** (#209). #186 met
 *     "the user must be able to see what they are about to send" with a second
 *     surface above the transcript that rendered the whole draft; the owner found
 *     that confusing — *"you have this draft prompt thing. I don't think that's
 *     needed"* — so it is gone, and the box itself is now what tells the truth
 *     about its contents: how many lines it holds, and that the rest is a scroll
 *     away. Silence was the actual defect; a peephole that admits it is a
 *     peephole is not.
 *
 * A seeded prompt also lands **scrolled to its top, caret at the start**. Filling
 * a textarea programmatically leaves the caret at the end, so the one thing a
 * reader needs first — the error the prompt opens with — was the one part off
 * screen.
 *
 * The sizing itself is `./composerSize`, deliberately a pure function plus a
 * versioned `localStorage` value: what the box does is testable without a
 * layout, and where it persists follows `layoutStore`'s pattern rather than
 * introducing a second one.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { Button } from '~/design/components/Button';

import {
  COMPOSER_KEYBOARD_STEP_PX,
  COMPOSER_MIN_PX,
  clampComposerPx,
  draftLineCount,
  readPersistedComposerHeight,
  resolveComposerHeight,
  writePersistedComposerHeight,
} from './composerSize';

export interface ComposerProps {
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Called when the user sends: Enter, or the Send button. Never called by anything in this file on its own. */
  onSubmit: () => void;
  /** Whether a provider key is configured -- when false the box stays inert and says why (issue #92's honest degrade). */
  configured: boolean;
  sending: boolean;
  /**
   * The measured height of the region the transcript and this composer share --
   * the pane's column, measured by `AiPane` rather than estimated here (#209; see
   * `composerSize`'s header). Since #253 removed the transparency line that used
   * to sit between the two rows, that is the whole column. 0 before the first
   * measurement, and forever in jsdom (see `layout/useElementSize`); treated as
   * "not measured", never as "no space".
   */
  availablePx: number;
  /**
   * Bumped by `AiPane` every time a prompt is seeded from elsewhere in the app
   * (the validation strip's "Fix with AI", issue #148). Not the draft text:
   * scrolling the box to the top is right when a ~30-line prompt *arrives*, and
   * wrong on every keystroke afterwards. Mirrors `aiStore.promptSeed`'s own
   * `seq` for the same reason -- see its doc comment.
   */
  seedSeq?: number;
}

export function Composer({
  draft,
  onDraftChange,
  onSubmit,
  configured,
  sending,
  availablePx,
  seedSeq,
}: ComposerProps) {
  const textareaId = useId();
  const hintId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [contentPx, setContentPx] = useState(0);
  // Read once, on first render, so the very first paint is already the size the
  // user chose last time -- same reasoning as `DagPane` reading its inspector
  // width from `localStorage` in a `useState` initialiser rather than an effect.
  const [preferredPx, setPreferredPx] = useState<number | null>(() =>
    readPersistedComposerHeight(),
  );

  const { heightPx, overflowing, maxPx, resizable } = resolveComposerHeight({
    contentPx,
    preferredPx,
    availablePx,
  });

  // Measure the text's own height. `height: auto` for the duration of the read
  // is what makes `scrollHeight` report the *content*, not the box; the previous
  // inline value is put straight back so this never fights the height React is
  // rendering. Deps are the things that change the content's height -- the text
  // itself, and the width the pane gives it (a narrower box wraps more).
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const previous = element.style.height;
    element.style.height = 'auto';
    const measured = element.scrollHeight;
    element.style.height = previous;
    setContentPx((current) => (current === measured ? current : measured));
  }, [draft, availablePx]);

  // A prompt that arrived from elsewhere is read from its beginning: the box
  // scrolls to the top and the caret goes to offset 0. Keyed on `seedSeq`, so
  // typing afterwards never yanks the view back. Optional-called and guarded
  // because jsdom implements neither scrolling nor selection geometry.
  useEffect(() => {
    if (seedSeq === undefined) return;
    const element = textareaRef.current;
    if (!element) return;
    element.scrollTop = 0;
    element.setSelectionRange?.(0, 0);
  }, [seedSeq]);

  const applyHeight = useCallback((next: number) => {
    setPreferredPx(next);
    writePersistedComposerHeight(next);
  }, []);

  // Same `useRef`-stabilised window listeners as `layout/Splitter` and
  // `InspectorDivider`: the drag must keep tracking the pointer after it leaves
  // this 12px handle, which means the handlers live on `window` and their
  // identity has to stay stable for `removeEventListener` to find them again.
  const dragOrigin = useRef<{
    pointerY: number;
    heightPx: number;
    availablePx: number;
  } | null>(null);
  const applyHeightRef = useRef(applyHeight);
  applyHeightRef.current = applyHeight;

  const handlePointerMoveRef = useRef((event: PointerEvent) => {
    const drag = dragOrigin.current;
    if (!drag) return;
    // Dragging *up* makes the box taller: the handle is its top edge.
    const delta = drag.pointerY - event.clientY;
    applyHeightRef.current(
      clampComposerPx(drag.heightPx + delta, drag.availablePx),
    );
  });
  const handlePointerUpRef = useRef(() => {
    dragOrigin.current = null;
    window.removeEventListener('pointermove', handlePointerMoveRef.current);
    window.removeEventListener('pointerup', handlePointerUpRef.current);
  });

  const startDragging = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      dragOrigin.current = {
        pointerY: event.clientY,
        heightPx,
        availablePx,
      };
      window.addEventListener('pointermove', handlePointerMoveRef.current);
      window.addEventListener('pointerup', handlePointerUpRef.current);
    },
    [availablePx, heightPx],
  );

  // Defensive cleanup only -- see `Splitter`'s identical effect for why the
  // cleanup reads the refs into locals first.
  useEffect(() => {
    const move = handlePointerMoveRef.current;
    const up = handlePointerUpRef.current;
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const handleHandleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Measured from the *rendered* height, so an arrow key nudges the box from
      // wherever auto-grow has put it rather than from a stale stored value.
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        applyHeight(
          clampComposerPx(heightPx + COMPOSER_KEYBOARD_STEP_PX, availablePx),
        );
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        applyHeight(
          clampComposerPx(heightPx - COMPOSER_KEYBOARD_STEP_PX, availablePx),
        );
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyHeight(COMPOSER_MIN_PX);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyHeight(maxPx);
      }
    },
    [applyHeight, availablePx, heightPx, maxPx],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const lines = draftLineCount(draft);

  return (
    <div className="shrink-0">
      {/* The resize handle is the composer's top edge. `role="separator"` with
          `aria-valuenow` in pixels is the same contract `Splitter` uses, so a
          screen reader announces a resizable divider and arrow keys work
          without a pointer. Rendered only when there is a range to move it
          through -- see `ComposerHeight.resizable`. */}
      {resizable ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the message box"
          aria-valuemin={COMPOSER_MIN_PX}
          aria-valuemax={maxPx}
          aria-valuenow={heightPx}
          tabIndex={0}
          onPointerDown={startDragging}
          onKeyDown={handleHandleKeyDown}
          data-testid="ai-composer-resize"
          className="group flex h-3 cursor-row-resize touch-none items-center justify-center border-t border-cc-border bg-transparent outline-none"
        >
          {/* A short centred grip rather than a full-width hairline: the border
              above already draws the edge, and this says "grab me". */}
          <div
            aria-hidden
            className="h-0.5 w-6 rounded-full bg-cc-border-strong transition-colors group-hover:bg-cc-accent group-focus-visible:bg-cc-accent"
          />
        </div>
      ) : (
        // The edge itself is not optional -- it is what separates the box from
        // the conversation above it. Only the grip goes away.
        <div aria-hidden className="border-t border-cc-border" />
      )}

      <form
        className="flex flex-col gap-1 px-3 pb-2 pt-1"
        onSubmit={handleSubmit}
      >
        <div className="flex items-end gap-2">
          <label htmlFor={textareaId} className="sr-only">
            Message the AI assistant
          </label>
          <div className="relative min-w-0 flex-1">
            <textarea
              id={textareaId}
              ref={textareaRef}
              aria-describedby={hintId}
              disabled={!configured || sending}
              value={draft}
              style={{ height: `${heightPx}px` }}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                // Unconditional, at every height: see this file's header.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              placeholder={
                configured
                  ? 'Ask the assistant to edit your pipeline…'
                  : 'Add an API key in Settings first…'
              }
              // `resize-none` because the browser's own resize corner would be a
              // second, unpersisted sizing mechanism fighting the handle above --
              // and it can only grow the box, never past the pane, and never in a
              // way that survives a reload.
              className="block w-full resize-none rounded-md border border-cc-border-interactive bg-cc-panel-raised px-3 py-2 text-sm text-cc-text placeholder:text-cc-text-faint disabled:cursor-not-allowed"
            />
            {/* Issue #209, and the one piece of this that had to cost no height:
                on `graph-focus` the box sits at its 56px minimum with nowhere to
                put a line of prose (see `composerSize`'s header for the measured
                numbers), and that is precisely the case where a user is about to
                send thirty lines having read two. So the count rides *inside* the
                box's own bottom-right corner instead of taking a row of its own.
                `pointer-events-none` so it never intercepts a click meant for the
                text; `aria-hidden` because the same fact is in the text area's
                `aria-describedby` hint below, in a full sentence. */}
            {overflowing ? (
              <span
                aria-hidden
                data-testid="ai-composer-overflow"
                className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-cc-panel px-1 py-0.5 text-2xs font-medium text-cc-text-muted"
              >
                {lines} lines · scroll
              </span>
            ) : null}
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!configured || sending || draft.trim() === ''}
            aria-label="Send message"
          >
            Send
          </Button>
        </div>
        {/* Always present for assistive technology (it is the text area's
            `aria-describedby`), visible once the box is bigger than its minimum
            *or* once it is holding more than it can show.

            The visibility rule is about *cost*, not about the rules it states:
            `graph-focus` leaves this pane ~99px of column, where a permanent
            18px line comes straight out of the conversation -- and a two-line box
            is where Enter-to-send is the universal chat convention anyway. The
            overflow case is the exception, and deliberately so: that is precisely
            when a user is about to send something they have not read all of, and
            #209 makes this box the only thing that can tell them. */}
        <p
          id={hintId}
          data-testid="ai-composer-hint"
          className={
            heightPx > COMPOSER_MIN_PX
              ? 'text-2xs text-cc-text-faint'
              : 'sr-only'
          }
        >
          {overflowing
            ? `This draft is ${lines} lines and taller than the box — scroll it to read the rest before sending. `
            : null}
          Enter sends · Shift+Enter adds a line
          {resizable ? ' · drag or arrow-key the handle above to resize' : null}
        </p>
      </form>
    </div>
  );
}
