/**
 * Renders a preset's `LayoutNode` tree (issue #30): recursively walks
 * `split` nodes into two flex children plus a draggable `Splitter`, and
 * `pane` nodes into the matching entry of `panes` wrapped in `PaneSlot`.
 *
 * This is the one place a preset's *shape* turns into DOM structure --
 * every preset in `./presets` is data describing a tree, not its own
 * component, specifically so a new arrangement never needs a new render
 * path here.
 *
 * Splitter drags and collapse/expand toggles only ever change numbers
 * (a ratio, a `collapsed` set) in `useLayoutStore` -- they never change
 * which `LayoutNode` sits where, so `panes.yaml`/`panes.ai`/`panes.dag`
 * stay mounted at the same position in this tree across both. That's what
 * keeps a drag from resetting e.g. the YAML editor's scroll position:
 * React reconciles the same component instance in place rather than
 * unmounting and remounting it. (Switching *presets* does change the
 * tree's shape, so pane components are *not* guaranteed to survive that --
 * see the report for why that trade-off was accepted.)
 */
import { useRef, type CSSProperties, type ReactNode } from 'react';

import {
  activeLayoutRoot,
  activeLayoutState,
  useLayoutStore,
} from '~/state/layoutStore';

import {
  COLLAPSED_STRIP_PX,
  SPLITTER_TRACK_PX,
  extentAxis,
  minPaneExtent,
  renderRatio,
} from './constants';
import type { PaneEdge } from './moves';
import { PaneSlot } from './PaneSlot';
import { Splitter } from './Splitter';
import {
  PANE_LABELS,
  isFullyCollapsed,
  type LayoutNode,
  type PaneId,
  type SplitDirection,
} from './types';
import { useElementSize } from './useElementSize';

/** A human-readable description of the two regions a splitter sits
 * between, e.g. "Config" or "AI Assistant / Workflow Graph" for a
 * splitter whose far side is itself a nested split. Used only for the
 * splitter's `aria-label`. */
function describe(node: LayoutNode): string {
  if (node.type === 'pane') return PANE_LABELS[node.pane];
  return `${describe(node.children[0])} / ${describe(node.children[1])}`;
}

/**
 * Style for one side of a split that `isFullyCollapsed` -- the fixed side
 * of the pair `NodeRenderer` renders below. Bug: collapsing a pane used to
 * leave dead space next to its now-expanded sibling (e.g. collapsing the AI
 * assistant in "Columns" mode left a gap between it and the workflow
 * graph). The cause was this fixed side being sized with only
 * `flex: '0 0 auto'` and no explicit dimension, which leaves the *browser*
 * to size it from rendered content -- here, `PaneChrome`'s collapsed
 * "Expand" button, whose box depends on font metrics, the writing-mode
 * rotation for a `row`-split strip, and per-browser text layout. Whatever
 * that content-derived width came out to, it was never guaranteed to equal
 * `COLLAPSED_STRIP_PX`, and the flexible sibling's `flex-grow` share is
 * computed against the *remaining* space after this side is laid out -- so
 * any gap between the two was reclaimed by neither, and rendered as dead
 * space between them instead.
 *
 * The fix is to make the fixed side's own size a value this code actually
 * controls: a pane leaf gets an explicit `COLLAPSED_STRIP_PX` `flex-basis`
 * (and matching `width`/`height`, redundant with the `flex-basis` but kept
 * so the box is still right if this element is ever read outside a flex
 * context, e.g. by a test's plain `style` assertion) along whichever axis
 * this split's `direction` runs. A fully-collapsed *sub-split* keeps
 * `flex: '0 0 auto'` with no explicit size: its own two children are each
 * sized by this same function (recursively, one level down), so its
 * natural size is simply their sum -- see the module doc comment.
 */
function fixedChildStyle(
  node: LayoutNode,
  direction: SplitDirection,
): CSSProperties {
  if (node.type !== 'pane') return { flex: '0 0 auto' };
  const px = `${COLLAPSED_STRIP_PX}px`;
  return direction === 'row'
    ? { flex: `0 0 ${px}`, width: px, minWidth: px }
    : { flex: `0 0 ${px}`, height: px, minHeight: px };
}

interface RenderProps {
  node: LayoutNode;
  /** The direction of the split this node is a child of -- `null` only at
   * the tree's root, which every current preset avoids by always starting
   * with a `split` node. Needed by a `pane` leaf so its collapsed strip
   * (see `PaneSlot`) knows which axis it's constrained to. */
  parentDirection: SplitDirection | null;
  ratios: Record<string, number>;
  collapsed: ReadonlySet<PaneId>;
  onRatioChange: (splitId: string, ratio: number) => void;
  onToggleCollapsed: (pane: PaneId) => void;
  /** Issue #121's "Move pane" menu -- see `PaneSlot`. Threaded down
   * alongside `onToggleCollapsed` rather than read from `useLayoutStore`
   * inside `PaneSlot` itself, matching how every other per-pane callback
   * already reaches it: `LayoutRoot` is the one place that owns the store
   * subscription, so a pane's own re-render is driven by *this* tree walk
   * re-running, not by each leaf subscribing independently. */
  onSwapPane: (a: PaneId, b: PaneId) => void;
  onMovePaneToEdge: (pane: PaneId, edge: PaneEdge) => void;
  panes: Record<PaneId, ReactNode>;
}

function NodeRenderer({
  node,
  parentDirection,
  ratios,
  collapsed,
  onRatioChange,
  onToggleCollapsed,
  onSwapPane,
  onMovePaneToEdge,
  panes,
}: RenderProps) {
  // Called unconditionally (before the `pane` early return below) so these
  // stay rules-of-hooks-compliant; they're simply unused for a `pane` leaf,
  // which only ever needs the split branch's container measured. (For a leaf,
  // `containerRef` is never attached to anything, so `useElementSize`
  // short-circuits on a null ref and stays at its unmeasured 0×0.)
  const containerRef = useRef<HTMLDivElement>(null);
  const containerSize = useElementSize(containerRef);

  if (node.type === 'pane') {
    return (
      <PaneSlot
        pane={node.pane}
        collapsed={collapsed.has(node.pane)}
        // Non-null: every current preset's root is a `split`, so a `pane`
        // leaf always has a split parent. Falling back to `'row'` keeps
        // this total rather than throwing if a future preset ever nested
        // a bare pane at the root.
        parentDirection={parentDirection ?? 'row'}
        onToggleCollapsed={() => onToggleCollapsed(node.pane)}
        onSwapWith={(other) => onSwapPane(node.pane, other)}
        onMoveToEdge={(edge) => onMovePaneToEdge(node.pane, edge)}
      >
        {panes[node.pane]}
      </PaneSlot>
    );
  }

  const [first, second] = node.children;
  const storedRatio = ratios[node.id] ?? node.ratio;
  const firstFixed = isFullyCollapsed(first, collapsed);
  const secondFixed = isFullyCollapsed(second, collapsed);
  const showSplitter = !firstFixed && !secondFixed;

  // Issue #154: the minimum pixels each side of this split needs before the
  // panes inside it stop being usable, and the ratio that actually gets
  // rendered once those minimums are applied to this split's *measured* size.
  //
  // `storedRatio` is the user's (or the preset's) intent and stays untouched
  // in the store; `ratio` is what fits on screen right now. Keeping them
  // separate is what lets a persisted arrangement survive being viewed on a
  // window too narrow for it -- clamping is applied on the way *out*, per
  // render, not written back (see `renderRatio`). On an unmeasured render (the
  // first one, and every render in jsdom) the two are identical.
  const axis = extentAxis(node.direction);
  const minFirstPx = minPaneExtent(first, axis, collapsed);
  const minSecondPx = minPaneExtent(second, axis, collapsed);
  // The ratio divides the space left *after* the splitter's own track, not the
  // container's full extent -- the two children are `flex-basis: 0%` items
  // sharing the free space, and the splitter is a `shrink-0` sibling that takes
  // its 12px off the top. Clamping against the container total instead would
  // land each side ~4px under its floor at a typical width (measured: a 200px
  // palette floor rendered at 196px), which is exactly the kind of
  // almost-right that makes a minimum not mean anything.
  const flexiblePx = Math.max(
    0,
    containerSize[axis] - (showSplitter ? SPLITTER_TRACK_PX : 0),
  );
  const ratio = renderRatio(storedRatio, flexiblePx, minFirstPx, minSecondPx);

  // A flexible side always gets a `flex-basis` of `0%` so its rendered size
  // is driven entirely by `flex-grow`, and (when both sides are flexible) a
  // per-pane minimum floor via `ratio` above -- so it can never be squeezed
  // to unreadable/zero by its sibling.
  //
  // Deliberately *not* a CSS `min-width`/`min-height` on the flex children
  // themselves, which would have been the obvious way to express a minimum:
  // when the sum of the children's minimums exceeds the row, CSS resolves
  // that by letting the row's content overflow its box, and every container
  // here is `overflow-hidden` -- so a window one pixel too narrow would
  // *clip* a pane off the right edge instead of shrinking it. Clamping the
  // ratio keeps every pane inside the box at every width and degrades to
  // proportional shares when the window genuinely can't afford the minimums
  // (see `clampRatioToMinimums`), which is the honest behaviour rather than
  // hiding a pane's edge.
  //
  // Bug: when the *other* side is fixed (collapsed), this side used to keep
  // its ordinary `ratio`/`1 - ratio` flex-grow factor (e.g. 0.64) instead of
  // `1`. Per the flexbox spec (CSS Flexbox ยง9.7.3, "resolve the flexible
  // lengths"): when the sum of the flex-grow factors among a row's flexible
  // items is *less than 1*, browsers scale the free space to distribute by
  // that sum rather than handing out all of it -- so a lone flexible item
  // with grow `0.64` only ever claims 64% of the space freed by its
  // collapsed sibling, leaving the remaining 36% as genuinely unclaimed
  // dead space, not a rendering glitch. Verified directly: a bare two-node
  // flex row with `flex: 0 0 32px` / `flex: 0.64 1 0%` at 987px renders the
  // second node at 611.19px (987 - 32) * 0.64, not the expected 955px; the
  // *same* markup with `flex: 1 1 0%` renders it at the full 955px. Two
  // flexible siblings' factors already sum to exactly `ratio + (1 - ratio)
  // == 1`, which is why an ordinary (non-collapsed) split never showed
  // this -- it's specific to the collapsed case, where only one side is
  // still flexible.
  const firstStyle = firstFixed
    ? fixedChildStyle(first, node.direction)
    : { flex: `${secondFixed ? 1 : ratio} 1 0%`, minWidth: 0, minHeight: 0 };
  const secondStyle = secondFixed
    ? fixedChildStyle(second, node.direction)
    : { flex: `${firstFixed ? 1 : 1 - ratio} 1 0%`, minWidth: 0, minHeight: 0 };

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 overflow-hidden ${
        node.direction === 'row' ? 'flex-row' : 'flex-col'
      }`}
    >
      <div className="min-h-0 min-w-0 overflow-hidden" style={firstStyle}>
        <NodeRenderer
          node={first}
          parentDirection={node.direction}
          ratios={ratios}
          collapsed={collapsed}
          onRatioChange={onRatioChange}
          onToggleCollapsed={onToggleCollapsed}
          onSwapPane={onSwapPane}
          onMovePaneToEdge={onMovePaneToEdge}
          panes={panes}
        />
      </div>
      {showSplitter ? (
        <Splitter
          direction={node.direction}
          ratio={ratio}
          containerRef={containerRef}
          onChange={(next) => onRatioChange(node.id, next)}
          label={`Resize ${describe(first)} / ${describe(second)}`}
          minFirstPx={minFirstPx}
          minSecondPx={minSecondPx}
        />
      ) : null}
      <div className="min-h-0 min-w-0 overflow-hidden" style={secondStyle}>
        <NodeRenderer
          node={second}
          parentDirection={node.direction}
          ratios={ratios}
          collapsed={collapsed}
          onRatioChange={onRatioChange}
          onToggleCollapsed={onToggleCollapsed}
          onSwapPane={onSwapPane}
          onMovePaneToEdge={onMovePaneToEdge}
          panes={panes}
        />
      </div>
    </div>
  );
}

export function LayoutRoot({ panes }: { panes: Record<PaneId, ReactNode> }) {
  // Issue #121: both of these now resolve through `activeLayoutState`/
  // `activeLayoutRoot` rather than indexing `presetStates` directly by
  // `activePreset`, since that can now be `'custom'` -- a key
  // `presetStates` never has (the user's own arrangement lives in a
  // separate `custom` slot; see `state/layoutStore.ts`).
  const layoutState = useLayoutStore(activeLayoutState);
  const root = useLayoutStore(activeLayoutRoot);
  const setSplitRatio = useLayoutStore((state) => state.setSplitRatio);
  const toggleCollapsed = useLayoutStore((state) => state.toggleCollapsed);
  const swapPanes = useLayoutStore((state) => state.swapPanes);
  const movePaneToEdge = useLayoutStore((state) => state.movePaneToEdge);

  // Unreachable via the UI (`PresetSwitcher` only ever sets a known
  // `PresetId`, and `activePreset: 'custom'` only ever occurs alongside a
  // real `custom.root` -- see that store's own invariants), but typed as a
  // lookup rather than an indexed access, so guard rather than assert --
  // falling back to rendering nothing beats a runtime crash if
  // `activePreset` were ever corrupted into something else entirely.
  if (!root) return null;

  const collapsed = new Set(layoutState.collapsed);

  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-hidden">
      <NodeRenderer
        node={root}
        parentDirection={null}
        ratios={layoutState.ratios}
        collapsed={collapsed}
        onRatioChange={setSplitRatio}
        onToggleCollapsed={toggleCollapsed}
        onSwapPane={swapPanes}
        onMovePaneToEdge={movePaneToEdge}
        panes={panes}
      />
    </div>
  );
}
