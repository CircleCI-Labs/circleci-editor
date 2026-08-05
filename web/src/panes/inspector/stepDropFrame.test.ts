import { describe, expect, it } from 'vitest';

import {
  captureStepDropFrame,
  gapForPointer,
  reorderTargetForGap,
  SLOT_HEIGHT_FALLBACK,
  SLOT_HEIGHT_MAX,
  SLOT_HEIGHT_MIN,
  type StepDropFrame,
} from './stepDropFrame';

/**
 * jsdom has no layout -- every `getBoundingClientRect()` is zeroes -- so these
 * tests hand the module the boxes a browser would have measured. That is the
 * whole reason this geometry lives in its own module: the rule can be pinned
 * exactly here, and `e2e/inspector-sections-steps.spec.ts` then checks that a
 * real browser's real boxes produce the same behaviour.
 */
function boxed(top: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 200,
      width: 200,
    }) as DOMRect;
  return element;
}

/** A region at viewport `top`, holding `count` 20px rows stacked from its top edge. */
function frameOf(
  count: number,
  { top = 0, rowHeight = 20 } = {},
): { frame: StepDropFrame; regionTop: number } {
  const region = boxed(top, count * rowHeight);
  const rows = Array.from({ length: count }, (_unused, index) =>
    boxed(top + index * rowHeight, rowHeight),
  );
  return { frame: captureStepDropFrame(region, rows), regionTop: top };
}

describe('captureStepDropFrame', () => {
  it('records each row midpoint relative to the region, in row order', () => {
    const { frame } = frameOf(3);
    expect(frame.midpoints).toEqual([10, 30, 50]);
  });

  it('is relative to the region, not the viewport, so a scrolled list measures the same', () => {
    expect(frameOf(3, { top: 0 }).frame.midpoints).toEqual(
      frameOf(3, { top: -137 }).frame.midpoints,
    );
  });

  it('sizes the gap from the smallest row, so an expanded row does not open a huge one', () => {
    const region = boxed(0, 400);
    // One collapsed 26px row and one expanded 320px `run:` step with a
    // CommandField editor open inside it.
    const frame = captureStepDropFrame(region, [boxed(0, 26), boxed(26, 320)]);
    expect(frame.slotHeight).toBe(26);
  });

  it('clamps the gap height into one row-sized band', () => {
    const region = boxed(0, 1000);
    expect(captureStepDropFrame(region, [boxed(0, 4)]).slotHeight).toBe(
      SLOT_HEIGHT_MIN,
    );
    expect(captureStepDropFrame(region, [boxed(0, 900)]).slotHeight).toBe(
      SLOT_HEIGHT_MAX,
    );
  });

  it('falls back to one row of height for an empty list', () => {
    const frame = captureStepDropFrame(boxed(0, 0), []);
    expect(frame.midpoints).toEqual([]);
    expect(frame.slotHeight).toBe(SLOT_HEIGHT_FALLBACK);
  });
});

describe('gapForPointer', () => {
  const { frame, regionTop } = frameOf(3); // midpoints 10, 30, 50

  it('names every gap, including before the first row and after the last', () => {
    expect(gapForPointer(frame, regionTop, 0)).toBe(0);
    expect(gapForPointer(frame, regionTop, 9)).toBe(0);
    expect(gapForPointer(frame, regionTop, 10)).toBe(1);
    expect(gapForPointer(frame, regionTop, 29)).toBe(1);
    expect(gapForPointer(frame, regionTop, 30)).toBe(2);
    expect(gapForPointer(frame, regionTop, 50)).toBe(3);
    // Below the whole list -- the Add form, or the empty space beside it. Still
    // the last gap, which is why that box needs no drop handler of its own.
    expect(gapForPointer(frame, regionTop, 400)).toBe(3);
  });

  it('is a pure function of the pointer, so a still cursor cannot flicker', () => {
    // #249's own acceptance criterion: "a gap that flickers between two indices
    // while the cursor sits still is worse than a static line." The reflow
    // cannot feed back into this, because the frame is frozen and displacement
    // is not one of the inputs -- so the same coordinate is the same answer
    // however many times the browser reports it.
    const answers = new Set(
      Array.from({ length: 50 }, () => gapForPointer(frame, regionTop, 31)),
    );
    expect([...answers]).toEqual([2]);
  });

  it('tracks a mid-drag scroll of the region rather than drifting a whole row', () => {
    // The browser auto-scrolls the inspector's one scroll region when a drag
    // nears its edge. The pointer stays put in viewport coordinates while the
    // region moves under it, and both move together here.
    expect(gapForPointer(frame, regionTop, 31)).toBe(2);
    expect(gapForPointer(frame, regionTop - 20, 11)).toBe(2);
  });

  it('always names an empty list at gap 0', () => {
    const empty = captureStepDropFrame(boxed(0, 40), []);
    expect(gapForPointer(empty, 0, 0)).toBe(0);
    expect(gapForPointer(empty, 0, 39)).toBe(0);
  });

  it('yields the top of the list for a pointer with no measurable coordinate', () => {
    // jsdom's `DragEvent` drops `MouseEventInit`, so an unpatched
    // `fireEvent.dragOver(el)` really does arrive with `clientY === undefined`.
    expect(
      gapForPointer(frame, regionTop, undefined as unknown as number),
    ).toBe(0);
    expect(gapForPointer(frame, regionTop, Number.NaN)).toBe(0);
  });
});

describe('reorderTargetForGap', () => {
  it('shifts a downward move down by one, because the splice removes first', () => {
    expect(reorderTargetForGap(0, 2)).toBe(1);
    expect(reorderTargetForGap(0, 3)).toBe(2);
  });

  it('leaves an upward move alone', () => {
    expect(reorderTargetForGap(2, 0)).toBe(0);
    expect(reorderTargetForGap(2, 1)).toBe(1);
  });

  it('refuses both gaps adjacent to the row itself, which are no-ops', () => {
    expect(reorderTargetForGap(1, 1)).toBeNull();
    expect(reorderTargetForGap(1, 2)).toBeNull();
  });
});
