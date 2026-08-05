/**
 * The geometry behind "open a gap where the step will land" (issue #249).
 *
 * ## What changed, and why it needed its own module
 *
 * Issue #218 drew a 2px line in the gutter between two rows. The owner's
 * verdict on it: *"I click and drag, and yes I see a little plus button
 * indicating I can drop there, but it doesn't really show me where I'm
 * actually putting it in the list."* #249 asks for the rows to **reflow** --
 * an actual gap, opened by displacing the rows below it.
 *
 * #218 had a specific reason not to do that, recorded on `StepInsertionLine`
 * and worth quoting because this module exists to answer it:
 *
 * > `absolute` ... deliberately not a real element in the flow: a 2px block
 * > appearing between rows mid-drag shifts every row below it by 2px, which
 * > moves the row under the pointer out from under the pointer and produces a
 * > `dragover`/`dragleave` storm (the indicator flickers and the target
 * > oscillates between two gaps).
 *
 * That is a real failure mode, and #249 names it as the thing that would make
 * the change worse than no change: *"a gap that flickers between two indices
 * while the cursor sits still is worse than a static line."* A ~26px gap is
 * more than ten times the displacement #218 refused to put in the flow, so
 * "just render it in the flow" would have hit that storm ten times harder.
 *
 * ## The fix: decide the gap in a coordinate frame the reflow cannot move
 *
 * The oscillation is a feedback loop -- the displayed gap displaces the rows,
 * the displaced rows change which gap the pointer is over, and round it goes.
 * Hysteresis, damping and rAF throttling all *reduce* it; none of them removes
 * it, and every one of them adds a tuning constant that is wrong on some list
 * length or scroll position.
 *
 * So the loop is cut instead. On the first `dragover` -- before any gap has
 * been opened, so while the list is still undisplaced -- the row midpoints are
 * measured once into a `StepDropFrame` and frozen for the rest of the drag.
 * Every subsequent gap is `gapForPointer(frame, ...)`: a **pure function of the
 * pointer's Y coordinate**. Displacement is not an input, so it cannot be a
 * cause. A cursor that sits still cannot flicker, because nothing that the
 * function reads is changing -- not "flickers rarely", *cannot*, and that is a
 * property a test can pin (`stepDropFrame.test.ts`, and the real-browser
 * version in `e2e/inspector-sections-steps.spec.ts`).
 *
 * The frozen frame is also what makes the interaction feel right rather than
 * merely stable, which is less obvious. Walk a three-row list downward: the
 * pointer passes row B's midpoint, so a gap opens below B and pushes C down.
 * The pointer is still over B; nothing above it moved. Push on and the pointer
 * enters the gap it just opened -- still below B's midpoint and above C's, so
 * still the same gap, correctly, because the pointer is inside the slot it
 * asked for. Past C's *original* midpoint the gap moves below C, C springs back
 * up, and the pointer lands over C's lower half -- exactly where the new gap
 * says it is. The frame being stale is not a compromise; it is the frame the
 * gesture actually started in.
 *
 * ## Coordinates are relative to the drop region, not the viewport
 *
 * `midpoints` are stored relative to the drop region's own top edge, and
 * `gapForPointer` takes the region's *current* top. That makes the whole thing
 * immune to scrolling mid-drag -- the browser auto-scrolls the inspector's
 * single scroll region when a drag nears its edge, which would
 * invalidate frozen viewport coordinates within one row's height. The region's
 * top does not move when a gap opens inside it: the gap grows the list
 * downward, and everything above the region is untouched.
 */

/** The gap height used when the list has no measurable rows -- an empty list, or a test environment without layout. Matches one collapsed step row: 1px border + 4px `py-1` + 16px line-height, twice over vertically. */
export const SLOT_HEIGHT_FALLBACK = 26;

/**
 * The floor and ceiling on the opened gap's height.
 *
 * The gap represents *a position in the order*, not the size of the step's
 * expanded detail, so it is one row tall even when the row being dragged is an
 * expanded `run:` step several hundred pixels high (a `CommandField` editor is
 * open inside it). Uncapped, dragging such a row would displace the rest of the
 * list off-screen and trigger the browser's own drag auto-scroll -- a gap so
 * large it stops reading as a gap.
 *
 * The floor guards the other direction: a sub-20px slot in a list of 26px rows
 * reads as a rendering glitch rather than as a slot.
 */
export const SLOT_HEIGHT_MIN = 20;
export const SLOT_HEIGHT_MAX = 44;

/**
 * A frozen snapshot of the step list's *undisplaced* row geometry, taken once
 * per drag and never updated while that drag is in flight. See the module
 * comment: that it is frozen is the entire anti-thrash mechanism.
 */
export interface StepDropFrame {
  /**
   * Each row's vertical midpoint in region-relative pixels, in row order.
   * A pointer at or past `midpoints[i]` is past row `i`, so the gap index is
   * simply how many midpoints it has passed.
   */
  midpoints: number[];
  /** The height to give the opened gap, in px. */
  slotHeight: number;
}

/**
 * Measures the frame. Call this while the list is undisplaced -- i.e. on the
 * `dragover` that discovers there is no frame yet, *before* the state update
 * that opens a gap.
 *
 * `rows` must be the top-level step rows in document order; nested
 * `when`/`unless` steps are deliberately not included, since they are not
 * addressable by the index-based mutation helpers and dropping onto one means
 * "before or after the group that contains it".
 */
export function captureStepDropFrame(
  region: HTMLElement,
  rows: HTMLElement[],
): StepDropFrame {
  const originTop = region.getBoundingClientRect().top;
  const midpoints: number[] = [];
  const heights: number[] = [];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    midpoints.push(rect.top + rect.height / 2 - originTop);
    if (rect.height > 0) heights.push(rect.height);
  }
  // The *smallest* row, not the first or the dragged one: in any real list at
  // least one row is collapsed, and the smallest is that row's own height, so
  // the gap matches a row of the list it is opening in. `heights` is empty for
  // an empty list, and in jsdom (no layout at all), which is why the fallback
  // is a real measured constant rather than zero.
  const smallest =
    heights.length > 0 ? Math.min(...heights) : SLOT_HEIGHT_FALLBACK;
  return {
    midpoints,
    slotHeight: Math.min(
      Math.max(Math.round(smallest), SLOT_HEIGHT_MIN),
      SLOT_HEIGHT_MAX,
    ),
  };
}

/**
 * The insertion gap a pointer at `clientY` names: `0` above the first row,
 * `midpoints.length` below the last, `n` between rows `n-1` and `n`.
 *
 * `regionTop` is the drop region's *current* `getBoundingClientRect().top`, so
 * that a mid-drag scroll moves the pointer and the reference together -- see
 * the module comment.
 *
 * A non-finite `clientY` yields `0`. That is not a defensive flourish: jsdom's
 * `DragEvent` constructor drops the `MouseEventInit` half, so every drag event
 * fired by testing-library without the explicit patching in
 * `Inspector.test.tsx` arrives with `clientY === undefined`. Returning the top
 * of the list is the same answer a browser gives for a pointer above every row,
 * so an unpatched test gets a coherent index instead of `NaN` comparisons
 * quietly resolving to "past every midpoint", i.e. append.
 */
export function gapForPointer(
  frame: StepDropFrame,
  regionTop: number,
  clientY: number,
): number {
  const offset = clientY - regionTop;
  if (!Number.isFinite(offset)) return 0;
  let gap = 0;
  for (const midpoint of frame.midpoints) {
    if (offset >= midpoint) gap += 1;
  }
  return gap;
}

/**
 * Turns an "insert at this gap" index into the `toIndex` a *reorder* needs
 * (issue #218 parts 2/3; moved here from `Inspector.tsx` by #249 so the gap
 * arithmetic and the geometry that produces it are tested as one unit).
 *
 * The two are not the same number, and conflating them was a real off-by-one in
 * the pre-#218 code. A gap index `g` in `0..steps.length` names a position
 * *between* rows, and `root.move(from, to)` is implemented as "splice the item
 * out, then splice it back in at `to`" (`documentUtils.moveSeqItem`) -- so once
 * the item has been removed, every gap *after* where it used to be has shifted
 * down by one. Dragging step 0 onto the gap between steps 1 and 2 (`g === 2`)
 * with `to = 2` produced `[B, C, A]` where the line the user was looking at
 * said `[B, A, C]`: the step overshot by exactly one position, every time, in
 * the downward direction only.
 *
 * Returns `null` when the move is a no-op -- both gaps adjacent to a row name
 * that row's own current position, so dragging a step a few pixels onto its own
 * boundary must do nothing rather than write an identical document (which would
 * still cost an undo entry).
 */
export function reorderTargetForGap(
  fromIndex: number,
  gap: number,
): number | null {
  const to = gap > fromIndex ? gap - 1 : gap;
  return to === fromIndex ? null : to;
}
