/**
 * A draggable, keyboard-resizable divider between the two children of a
 * `SplitNode` (issue #30). This is deliberately the same approach
 * `DagPane`'s existing `InspectorDivider` uses for the inspector/canvas
 * divider -- a native `pointermove`/`pointerup` pair on `window` (not React
 * props on this element) drives the drag so it keeps tracking the pointer
 * even once it leaves this thin handle, and the same `useRef`-stabilised
 * handler trick avoids the classic stale-closure bug that would otherwise
 * make `removeEventListener` fail to find a handler created fresh each
 * render. See that component for the fuller rationale; this one
 * generalises it to work for either a `row` or a `column` split, driven by
 * a 0..1 ratio rather than a fixed pixel width.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { KEYBOARD_STEP_PX, SPLITTER_TRACK_PX, clampRatio } from './constants';
import type { SplitDirection } from './types';

/** Reads the size the split's ratio actually divides up: its container's
 * width for a `row` split, height for a `column` one, less this splitter's
 * own track. The track subtraction matters (issue #154) because the ratio
 * applies to the two `flex-basis: 0%` children sharing the *free* space,
 * which is what's left after this `shrink-0` sibling takes its 12px -- so
 * ratio math against the container total is off by the track's width, and a
 * minimum clamped that way comes out slightly under the minimum. A splitter
 * only ever renders when both sides are flexible, so the track is always
 * present when this is called.
 *
 * Returns 0 before the first paint or in a test that never attaches a real
 * layout (e.g. jsdom), which `clampRatio` already treats as "can't measure
 * yet" and falls back to a fixed, size-independent clamp for. */
function measureFlexiblePx(
  container: HTMLDivElement | null,
  direction: SplitDirection,
): number {
  if (!container) return 0;
  const rect = container.getBoundingClientRect();
  const total = direction === 'row' ? rect.width : rect.height;
  return Math.max(0, total - SPLITTER_TRACK_PX);
}

export function Splitter({
  direction,
  ratio,
  containerRef,
  onChange,
  label,
  minFirstPx,
  minSecondPx,
}: {
  direction: SplitDirection;
  ratio: number;
  /** The split's own wrapping flex element -- measured on drag start (and
   * on every keypress) to convert a pixel delta into a ratio delta. */
  containerRef: RefObject<HTMLDivElement | null>;
  onChange: (ratio: number) => void;
  label: string;
  /** Issue #154: the minimum pixels each side of this split needs (see
   * `minPaneExtent`), so a drag stops at the same floor the rendered layout
   * is already clamped to. Passing them here rather than letting `clampRatio`
   * fall back to `MIN_REGION_PX` is what makes dragging *feel* like it hits
   * the pane's own limit instead of overshooting it and being silently
   * corrected on the next render. */
  minFirstPx: number;
  minSecondPx: number;
}) {
  // See `InspectorDivider` for why these three refs exist: the drag
  // handlers below are created exactly once (via `useRef`'s lazy-init
  // argument) so their identity is stable for `removeEventListener`, which
  // means they must read the *latest* ratio/onChange through refs rather
  // than by closing over a particular render's values.
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Same reason as `ratioRef`/`onChangeRef`: the drag handlers below are
  // created exactly once, so they must read the current minimums through a
  // ref rather than closing over the render that created them (they change
  // whenever a pane on either side collapses or expands).
  const minimumsRef = useRef({ minFirstPx, minSecondPx });
  minimumsRef.current = { minFirstPx, minSecondPx };
  const dragOrigin = useRef<{
    pointerPos: number;
    ratio: number;
    containerPx: number;
  } | null>(null);

  const handlePointerMoveRef = useRef((event: PointerEvent) => {
    const drag = dragOrigin.current;
    if (!drag) return;
    const pointerPos = direction === 'row' ? event.clientX : event.clientY;
    const deltaRatio =
      drag.containerPx > 0
        ? (pointerPos - drag.pointerPos) / drag.containerPx
        : 0;
    const { minFirstPx: minFirst, minSecondPx: minSecond } =
      minimumsRef.current;
    onChangeRef.current(
      clampRatio(
        drag.ratio + deltaRatio,
        drag.containerPx,
        minFirst,
        minSecond,
      ),
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
        pointerPos: direction === 'row' ? event.clientX : event.clientY,
        ratio: ratioRef.current,
        containerPx: measureFlexiblePx(containerRef.current, direction),
      };
      window.addEventListener('pointermove', handlePointerMoveRef.current);
      window.addEventListener('pointerup', handlePointerUpRef.current);
    },
    [containerRef, direction],
  );

  // Defensive cleanup only -- see `InspectorDivider`'s identical effect for
  // why this doesn't just read `handlePointerMoveRef.current` inside the
  // cleanup itself (the lint rule can't tell these refs are set once and
  // never reassigned).
  useEffect(() => {
    const handlePointerMove = handlePointerMoveRef.current;
    const handlePointerUp = handlePointerUpRef.current;
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const containerPx = measureFlexiblePx(containerRef.current, direction);
      const step = containerPx > 0 ? KEYBOARD_STEP_PX / containerPx : 0.05;
      const decreaseKey = direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = direction === 'row' ? 'ArrowRight' : 'ArrowDown';

      if (event.key === decreaseKey) {
        event.preventDefault();
        onChange(
          clampRatio(ratio - step, containerPx, minFirstPx, minSecondPx),
        );
      } else if (event.key === increaseKey) {
        event.preventDefault();
        onChange(
          clampRatio(ratio + step, containerPx, minFirstPx, minSecondPx),
        );
      } else if (event.key === 'Home') {
        event.preventDefault();
        onChange(clampRatio(0, containerPx, minFirstPx, minSecondPx));
      } else if (event.key === 'End') {
        event.preventDefault();
        onChange(clampRatio(1, containerPx, minFirstPx, minSecondPx));
      }
    },
    [containerRef, direction, minFirstPx, minSecondPx, onChange, ratio],
  );

  return (
    <div
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={startDragging}
      onKeyDown={handleKeyDown}
      // The separator is deliberately wider than the line drawn inside it.
      // It used to be a 6px bar filled edge-to-edge with `bg-cc-border`, so
      // the two panes butted directly against a solid divider with no gutter
      // -- they read as stacked on top of each other rather than as separate
      // surfaces. Now the track itself is transparent (letting the app
      // background show through as breathing room on both sides) and only a
      // hairline is painted down its centre.
      //
      // Splitting it this way also keeps the two concerns independent: the
      // *hit area* is the full 12px track (a 6px pointer target was already
      // on the small side, and this is the same reasoning as the DAG connect
      // handles' 14px hit area vs their 6px dot), while the *visual* weight
      // drops to 1px. Widening a solid bar would have improved the grab
      // target at the cost of an even heavier divider.
      className={`group flex shrink-0 touch-none items-center justify-center bg-transparent ${
        direction === 'row' ? 'w-3 cursor-col-resize' : 'h-3 cursor-row-resize'
      }`}
    >
      <div
        aria-hidden
        className={`bg-cc-border transition-colors group-hover:bg-cc-accent group-focus-visible:bg-cc-accent ${
          direction === 'row' ? 'h-full w-px' : 'w-full h-px'
        }`}
      />
    </div>
  );
}
