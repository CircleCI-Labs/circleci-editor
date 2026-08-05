/**
 * How tall the AI pane's message box is, and where that survives a reload
 * (issues #186 and #209).
 *
 * The owner's original report: *"When I click Fix with AI it copies the prompt
 * into the chat window, but the chat box where I type doesn't expand, so I can't
 * really see the overall prompt, and there's no way to resize that little text
 * input area."* The composer was a hard `rows={2}`, and a prompt seeded by "Fix
 * with AI" (#163) is roughly thirty lines — so the affordance whose entire
 * point is that the user *reads* what they are about to send was showing them
 * two lines of it.
 *
 * #186 answered that in two halves: this sizing, and a card above the transcript
 * that rendered the whole draft. The owner rejected the second half — *"you have
 * this draft prompt thing. I don't think that's needed, and it just looks really
 * really weird there"* — so #209 deleted it, and the requirement it existed for
 * came back here: **the input itself has to be what shows the draft.**
 *
 * # One number, three inputs, no modes
 *
 * `resolveComposerHeight` is a pure function of:
 *
 *  - `contentPx` — how tall the text actually is (the textarea's own
 *    `scrollHeight`), so the box grows as a seeded prompt arrives with no
 *    action from the user;
 *  - `preferredPx` — the size the user dragged it to, persisted (see below);
 *  - `availablePx` — how much room the transcript and this box have to share.
 *
 * There is deliberately **no "auto" versus "manual" mode**. The user's size is
 * a *floor*: the box is never smaller than what they chose, and still grows
 * beyond it when the content needs more. That is what makes the behaviour
 * describable in one sentence, and it means there is no hidden mode to reset —
 * dragging (or `Home`-ing) back down to the minimum is the whole of "undo".
 *
 * # The room is measured, not predicted (#209)
 *
 * `availablePx` is the height of the region the transcript and the composer
 * **actually share**, which `AiPane` measures rather than predicts. Before #209
 * this module carried a ~46px *estimate* of the transparency line
 * ("Sends: N files…") that then sat between the two, and the estimate was wrong
 * in both directions: it was ~17px of text on a wide bottom pane, and several
 * wrapped lines in the tall, narrow `three-column` arrangement — where
 * over-estimating the room available is exactly how the box ends up taller than
 * the pane can show. Measuring it followed the same precedent as the app bar,
 * which stopped predicting what its own furniture costs for this same reason.
 *
 * #253 then deleted that line outright (the disclosure it carried now
 * lives in this editor's docs page), so the region is simply the pane's column
 * and the whole ~25px it used to cost goes back to the two rows that remain. The
 * measured-not-predicted rule stands either way, and is why deleting a row above
 * the composer needed no number in this file changed.
 *
 * What remains predicted here is only the composer's *own* furniture, which is
 * fixed by its markup rather than by wrapping text: see `COMPOSER_CHROME_PX`
 * and `COMPOSER_HINT_PX`.
 *
 * # It grows into all the room there is, and still never takes the last line
 *
 * `TRANSCRIPT_RESERVE_PX` keeps one line of conversation on screen however long
 * the draft is. Within that, the box grows with its content all the way to the
 * top of the range — #186 capped automatic growth at *half* the range on the
 * explicit reasoning that the draft-preview card was a better use of the other
 * half. With the card gone that reasoning inverts: the box is the only thing
 * that shows an unsent draft, so it takes the room.
 *
 * And because `contentPx` shrinks when the draft does, sending a long prompt
 * hands the space straight back.
 *
 * # What this cannot fix, and where that lives instead
 *
 * Measured on the running app (1280×720, the default `graph-focus` preset): the
 * AI pane is 178px tall, which leaves a 99px column — all of it shared with the
 * transcript since #253. A thirty-line prompt is ~600px of text. **No
 * arrangement of a 99px column shows it**, so at that size the box sits at its
 * 56px minimum and reading the draft means scrolling the box — which `Composer`
 * says in as many words, with the line count, instead of letting the text run
 * off silently.
 *
 * On a taller window, or in the `three-column` preset where this pane is a
 * full-height column, the same code shows the whole prompt at once. The pane's
 * default *share* is layout's business, not this module's: see #205, still open.
 */

/** The smallest the box ever gets: two lines of 14px text plus its padding — the pre-#186 `rows={2}`. */
export const COMPOSER_MIN_PX = 56;

/**
 * The composer's own furniture, above and below the text area: its 12px resize
 * handle plus the ~12px of padding the form draws around itself. Fixed by the
 * markup (a handle is a handle at every pane width), which is why this one is a
 * constant while the room the pane can spare is measured — see this module's
 * header.
 */
export const COMPOSER_CHROME_PX = 24;

/**
 * The Enter/Shift+Enter (or, while the draft overflows, the "N lines" scroll)
 * hint under the box. Occupies space only once the box is bigger than its
 * minimum — at the minimum it is `sr-only` — so it is charged against the
 * *range* rather than against the floor.
 */
export const COMPOSER_HINT_PX = 18;

/**
 * One line of conversation, kept on screen however long the draft is.
 *
 * A backstop with a specific job: without it, pasting a long prompt would leave
 * the transcript at zero and the pane would look as though it had lost the
 * conversation. It is not a promise that the transcript is *usable* at every
 * pane size — see this module's header for the sizes where it isn't, and #205.
 */
export const TRANSCRIPT_RESERVE_PX = 40;

/**
 * The ceiling used when the pane has not been measured — before the first
 * layout effect, and permanently in jsdom, which implements no layout at all
 * (see `layout/useElementSize`). Mirrors `clampRatio`'s reasoning in
 * `layout/constants.ts`: a size-independent fallback, so a keyboard resize in a
 * test still does something instead of silently clamping to nothing.
 */
export const UNMEASURED_MAX_PX = 400;

/** Pixels one arrow keypress moves the divider — the same step every other resizable thing in this app uses (`KEYBOARD_STEP_PX`). */
export const COMPOSER_KEYBOARD_STEP_PX = 16;

export const COMPOSER_STORAGE_KEY = 'vce.aiComposer';
export const COMPOSER_SCHEMA_VERSION = 1;

/**
 * The largest height the box may reach, given the room the transcript and the
 * composer have to share. Reached by content and by a gesture alike: after #209
 * an explicit drag buys nothing automatic growth cannot, because there is no
 * longer a second surface competing for the space.
 */
export function maxComposerPx(availablePx: number): number {
  if (!Number.isFinite(availablePx) || availablePx <= 0) {
    return UNMEASURED_MAX_PX;
  }
  return Math.max(
    COMPOSER_MIN_PX,
    Math.round(
      availablePx -
        COMPOSER_CHROME_PX -
        COMPOSER_HINT_PX -
        TRANSCRIPT_RESERVE_PX,
    ),
  );
}

/** Clamps a height into the range a user may drag to. */
export function clampComposerPx(px: number, availablePx: number): number {
  const max = maxComposerPx(availablePx);
  if (!Number.isFinite(px)) return COMPOSER_MIN_PX;
  return Math.min(max, Math.max(COMPOSER_MIN_PX, Math.round(px)));
}

export interface ComposerHeightInput {
  /** The textarea's own content height (`scrollHeight`), or 0 when unmeasured. */
  contentPx: number;
  /** The height the user dragged to, or `null` if they never have. */
  preferredPx: number | null;
  /** The height of the region the composer shares with the transcript, or 0 when unmeasured. */
  availablePx: number;
}

export interface ComposerHeight {
  /** The height to render. */
  heightPx: number;
  /**
   * True when the text is taller than the box, i.e. the textarea is scrolling
   * internally.
   *
   * After #209 this is not a signal to render the draft somewhere else — it is
   * what the composer says out loud, with the line count, so a user can tell
   * "there is more of this below" from "that is all of it". A box that
   * overflowed *silently* was the actual complaint behind #186.
   */
  overflowing: boolean;
  /** The ceiling a drag or an arrow key may reach, for `aria-valuemax`. */
  maxPx: number;
  /**
   * False when the ceiling equals the floor: the pane has no room to give, so
   * there is nothing a drag or an arrow key could do. `Composer` hides the
   * handle in that case rather than offering a control that cannot move — which
   * also hands its 12px back to the box on exactly the panes that are short of
   * them.
   */
  resizable: boolean;
}

/**
 * The composer's height: its content grows it, the user's stored size floors
 * it, and the room the pane can spare caps it.
 */
export function resolveComposerHeight({
  contentPx,
  preferredPx,
  availablePx,
}: ComposerHeightInput): ComposerHeight {
  const maxPx = maxComposerPx(availablePx);
  const preferred =
    preferredPx === null
      ? COMPOSER_MIN_PX
      : clampComposerPx(preferredPx, availablePx);

  const wanted = Math.max(preferred, Math.round(contentPx));
  const heightPx = Math.min(maxPx, Math.max(COMPOSER_MIN_PX, wanted));
  return {
    heightPx,
    // A pixel of slack: `scrollHeight` rounds, and a box exactly as tall as its
    // text must not report itself as overflowing.
    overflowing: contentPx > heightPx + 1,
    maxPx,
    resizable: maxPx > COMPOSER_MIN_PX,
  };
}

interface PersistedComposer {
  schemaVersion: number;
  heightPx: number;
}

function isPersistedComposer(value: unknown): value is PersistedComposer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === COMPOSER_SCHEMA_VERSION &&
    typeof candidate.heightPx === 'number' &&
    Number.isFinite(candidate.heightPx)
  );
}

/**
 * The persisted height, or `null` when the user has never set one — a first
 * run, unparseable JSON, a schema mismatch, or a `localStorage` that throws.
 * Never throws.
 *
 * Returned unclamped on purpose, the same way `layoutStore` returns a persisted
 * ratio unclamped and `renderRatio` clamps it per render: the stored value is
 * the user's *intent*, recorded on whatever window they set it on, and a narrow
 * window must not overwrite it (see `layout/constants.ts`'s `renderRatio`).
 */
export function readPersistedComposerHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(COMPOSER_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedComposer(parsed) ? parsed.heightPx : null;
  } catch {
    return null;
  }
}

export function writePersistedComposerHeight(heightPx: number): void {
  try {
    window.localStorage.setItem(
      COMPOSER_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: COMPOSER_SCHEMA_VERSION,
        heightPx: Math.round(heightPx),
      }),
    );
  } catch {
    // Resizing still works for the rest of this session even if it can't persist.
  }
}

/**
 * How many lines the draft holds. Shown beside the overflow notice, because
 * "there is more of this below" is a great deal more useful when it says how
 * much more — and it is the one number a user can check the box's own scroll
 * against.
 */
export function draftLineCount(draft: string): number {
  if (draft === '') return 0;
  return draft.split('\n').length;
}
