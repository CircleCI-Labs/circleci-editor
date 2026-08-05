/**
 * Reports an element's own content-box size, kept current as the window (or
 * any ancestor) resizes. Issue #154: the layout engine has to *decide* things
 * from real pixels -- whether a split's persisted ratio would push a pane
 * under its minimum usable size, whether the file switcher's row of buttons
 * still fits the space the app bar has left -- and a ratio alone can't answer
 * either question without knowing what it's a ratio *of*.
 *
 * `useLayoutEffect`, not `useEffect`: both the callers above render one thing
 * at the measured size and a different thing when it won't fit, so a
 * post-paint first measurement would show the wrong one for a frame (a full
 * row of file buttons flashing before collapsing to a menu, or a pane
 * rendering at a squeezed ratio before being clamped off it). A layout effect
 * runs before the browser paints, so the corrected render is the first one
 * anyone sees.
 *
 * Returns `{ width: 0, height: 0 }` until the first measurement, and forever
 * in jsdom -- which implements no layout at all, so every box there is 0×0
 * regardless. Callers must treat 0 as "not measured yet" and fall back to
 * behaviour that doesn't depend on a size (see `renderRatio` in
 * `./constants`, and `ConfigFileSwitcher`'s own note), never as "no space".
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

const UNMEASURED: ElementSize = { width: 0, height: 0 };

export function useElementSize(
  ref: RefObject<HTMLElement | null>,
): ElementSize {
  const [size, setSize] = useState<ElementSize>(UNMEASURED);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    function read() {
      const target = ref.current;
      if (!target) return;
      const next = { width: target.clientWidth, height: target.clientHeight };
      // Bail on an unchanged value rather than setting state unconditionally:
      // this runs on every resize notification, and a no-op `setState` with a
      // fresh object literal would re-render every consumer for nothing.
      setSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    }

    read();
    // Mirrors `DagPane`'s own guard: jsdom implements no ResizeObserver, and
    // the initial `read()` above is all a test environment with no layout can
    // ever produce anyway.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
