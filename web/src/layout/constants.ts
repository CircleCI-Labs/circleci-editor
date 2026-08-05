/**
 * Sizing constants for the layout engine, and the ratio math shared by
 * `Splitter` (pointer drag + keyboard) and `LayoutRoot` (clamping a persisted
 * ratio that would put a pane under its minimum usable size at the window's
 * current width -- issue #154).
 */
import {
  isFullyCollapsed,
  type LayoutNode,
  type PaneId,
  type SplitDirection,
} from './types';

/** A flexible region can never be dragged/keyboard-resized below this many
 * pixels. Below it there's not enough room to read the pane's own content,
 * and *unrecoverably* thin was the exact failure mode collapse exists to
 * replace with something intentional and reversible -- so this floor, not
 * "let it shrink to zero", is what a splitter drag clamps against.
 *
 * Issue #154 kept this as the *fallback* only: it is what a region whose
 * contents aren't known (a caller that doesn't pass a measured minimum)
 * clamps against. Every real split now clamps against `MIN_PANE_PX` summed
 * over whichever panes actually live on each side -- see `minPaneExtent`. */
export const MIN_REGION_PX = 200;

/**
 * The minimum usable size of each pane, per axis. Issue #154 asked for these
 * to exist at all: "establish and honour a minimum usable size per pane, so
 * the graph in particular can't be squeezed into uselessness -- the single
 * most recurring complaint in this project."
 *
 * They are deliberately *per pane* rather than one shared `MIN_REGION_PX`,
 * because the panes genuinely differ: the workflow graph has a fixed-size
 * object in it (a job node) and the palette is a list of short labels, so one
 * number would either be too small to save the graph or too large for the
 * palette to be allowed to exist.
 *
 * These are floors on *usefulness*, not on legibility -- a pane at its
 * minimum is cramped but can still do its job. They are also not hard
 * guarantees: a window narrower than the sum of the minimums along an axis
 * can't satisfy all of them at once, and `clampRatioToMinimums` then shares
 * the space out *in proportion to* the minimums rather than picking a pane to
 * crush (see its own doc comment). Collapsing a pane is the way to genuinely
 * recover space on a small window, and that still works exactly as it did.
 *
 * Where each number comes from:
 *
 * - `dag` 360×220. A job node is a fixed 256px wide (`lib/graph/layout.ts`'s
 *   `NODE_WIDTH`, matched to production's own card in #90); below roughly 360
 *   the canvas can't show one node at 1:1 with any margin around it *and*
 *   `CanvasControls`' own bar, so the graph stops being a graph and becomes a
 *   viewport onto one clipped box -- the exact "node boxes clipped at its left
 *   edge" case measured on a real 12-job config with every pane expanded. 220
 *   tall is two 44px node ranks plus the edge spacing between them and the
 *   controls bar, i.e. enough to see a `requires` relationship, which is the
 *   least a DAG view can usefully show.
 * - `yaml` 300×160. CodeMirror's line-number gutter is ~40px before any text;
 *   300 leaves roughly 35 columns of 12px IBM Plex Mono, which fits a real
 *   config's deepest ordinary line (`      - image: cimg/node:20.0`) without
 *   wrapping. 160 tall is ~8 lines plus the pane's own header row.
 * - `ai` 320×160. The assistant is prose in both directions; below ~320 the
 *   message bubbles wrap to two or three words a line, which reads as broken
 *   rather than narrow.
 * - `palette` 200×160. The widest section label plus its disclosure chevron
 *   and count, which is what `MIN_REGION_PX` was originally chosen for.
 * - `docs` 260×160. Schema key names sit next to a type badge on one row;
 *   260 is what keeps a realistic key (`resource_class`) and its badge on
 *   that row instead of stacking.
 */
export const MIN_PANE_PX: Record<PaneId, { width: number; height: number }> = {
  dag: { width: 360, height: 220 },
  yaml: { width: 300, height: 160 },
  ai: { width: 320, height: 160 },
  palette: { width: 200, height: 160 },
  docs: { width: 260, height: 160 },
};

/** The fixed thickness of a collapsed pane's strip (its width if it sits in
 * a `row` split, its height if in a `column` split). Wide/tall enough for a
 * label and an "Expand" affordance, thin enough to read as "tucked away". */
export const COLLAPSED_STRIP_PX = 32;

/** The full thickness of a splitter's *hit area* -- `Splitter`'s own `w-3`/
 * `h-3` track, which is what actually occupies space in a split's flex row.
 * The painted hairline down its centre is 1px; see `Splitter`'s comment for
 * why the two differ. Issue #154 needs the real, occupied number, because a
 * split's minimum size is its two sides' minimums *plus* the divider between
 * them. */
export const SPLITTER_TRACK_PX = 12;

/** Arrow-key resize step, in pixels of the split's total (row width / column
 * height) -- matches `InspectorDivider`'s `INSPECTOR_KEYBOARD_STEP`. */
export const KEYBOARD_STEP_PX = 16;

/** Which key of `MIN_PANE_PX`'s per-pane record a split's own direction
 * measures along: a `row` split apportions width between its children, a
 * `column` split apportions height. */
export function extentAxis(direction: SplitDirection): 'width' | 'height' {
  return direction === 'row' ? 'width' : 'height';
}

/**
 * The smallest `axis` extent this subtree can occupy while every pane in it
 * stays at or above its `MIN_PANE_PX` floor.
 *
 * Recursive because a split's minimum depends on how its own direction
 * relates to the axis being measured: two panes *side by side* both need
 * their width at once, so a `row` split's minimum width is the sum of its
 * children's (plus the splitter between them), while its minimum *height* is
 * only the larger of the two -- they share the same vertical space rather
 * than dividing it. A collapsed pane contributes only its strip, which is the
 * whole point of collapsing: it is how a user genuinely buys space back on a
 * window too small for everything at once.
 */
export function minPaneExtent(
  node: LayoutNode,
  axis: 'width' | 'height',
  collapsed: ReadonlySet<PaneId>,
): number {
  if (node.type === 'pane') {
    return collapsed.has(node.pane)
      ? COLLAPSED_STRIP_PX
      : MIN_PANE_PX[node.pane][axis];
  }
  const [first, second] = node.children;
  const firstMin = minPaneExtent(first, axis, collapsed);
  const secondMin = minPaneExtent(second, axis, collapsed);
  if (extentAxis(node.direction) !== axis) {
    return Math.max(firstMin, secondMin);
  }
  // The splitter only occupies space along the split's own axis, and only
  // renders at all when both sides are flexible -- the same condition
  // `LayoutRoot` uses to decide whether to render one.
  const hasSplitter =
    !isFullyCollapsed(first, collapsed) && !isFullyCollapsed(second, collapsed);
  return firstMin + secondMin + (hasSplitter ? SPLITTER_TRACK_PX : 0);
}

/**
 * Clamps `ratio` (the first child's share, 0..1) so that neither side of a
 * `containerPx`-wide split falls below its own minimum.
 *
 * When the container is too small to satisfy both minimums at once, this
 * hands out space *in proportion to* them instead of clamping. That is the
 * deliberate degradation: at that point some pane is going below its floor no
 * matter what, and the alternative -- honouring the first side's minimum and
 * letting the remainder fall where it may -- crushes whichever pane happens
 * to sit on the second side, which is precisely the failure this whole
 * mechanism exists to prevent. Proportional means both sides end up equally
 * far below their floors, and (because the minimums encode how much each pane
 * actually needs) the graph still gets more of a cramped window than the
 * palette does.
 */
export function clampRatioToMinimums(
  ratio: number,
  containerPx: number,
  minFirstPx: number,
  minSecondPx: number,
): number {
  const totalMin = minFirstPx + minSecondPx;
  if (totalMin <= 0) return Math.min(1, Math.max(0, ratio));
  if (totalMin >= containerPx) return minFirstPx / totalMin;
  const minRatio = minFirstPx / containerPx;
  const maxRatio = 1 - minSecondPx / containerPx;
  return Math.min(maxRatio, Math.max(minRatio, ratio));
}

/**
 * The ratio a split should *render* at, given its measured size. Returns
 * `ratio` untouched when the container hasn't been measured yet (before the
 * first layout effect, or in jsdom, which has no layout at all) -- rendering
 * the user's own persisted ratio is the right answer when there is no
 * evidence it doesn't fit, and it means an unmeasured render is never a
 * *different* layout, just an unclamped one.
 *
 * Deliberately does not write back to the store: a window narrow enough to
 * clamp a ratio must not overwrite the arrangement the user chose on a bigger
 * one, or maximising the window would fail to restore it. The persisted value
 * is the intent; this is what fits on screen right now.
 */
export function renderRatio(
  ratio: number,
  containerPx: number,
  minFirstPx: number,
  minSecondPx: number,
): number {
  if (!Number.isFinite(containerPx) || containerPx <= 0) return ratio;
  return clampRatioToMinimums(ratio, containerPx, minFirstPx, minSecondPx);
}

/**
 * Clamps a ratio a *user gesture* produced (a splitter drag, or an arrow/
 * Home/End keypress) against the same minimums. Falls back to a generous,
 * size-independent clamp when the container hasn't been measured -- e.g. in a
 * test that never calls `getBoundingClientRect` -- rather than dividing by
 * zero; unlike `renderRatio`, returning the input unchanged would make a
 * keyboard resize silently do nothing there.
 */
export function clampRatio(
  ratio: number,
  containerPx: number,
  minFirstPx: number = MIN_REGION_PX,
  minSecondPx: number = MIN_REGION_PX,
): number {
  if (!Number.isFinite(containerPx) || containerPx <= 0) {
    return Math.min(0.95, Math.max(0.05, ratio));
  }
  return clampRatioToMinimums(ratio, containerPx, minFirstPx, minSecondPx);
}
