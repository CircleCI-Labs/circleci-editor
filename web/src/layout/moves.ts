/**
 * Pure tree-surgery for issue #121's pane-rearrangement feature. This ships
 * as a "Move pane" menu on `PaneChrome` rather than a FancyZones-style
 * drag-and-drop overlay because a spike against the real running app found
 * the overlay's edge zones too cramped to hit reliably at a sidebar-scale
 * pane's width -- the menu was the issue's own named fallback. This module
 * only knows about `LayoutNode` trees; `useLayoutStore`'s
 * `swapPanes`/`movePaneToEdge` actions call it and own turning the result
 * into the persisted "custom" layout (see `state/layoutStore.ts`).
 */
import {
  pane,
  split,
  type LayoutNode,
  type PaneId,
  type SplitDirection,
} from './types';

export type PaneEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * Swaps two panes' *positions* in the tree, leaving every split's id,
 * direction and ratio untouched -- the cheapest, safest move available.
 * Only the two leaves' `pane` fields change, so nothing about sizing is
 * disturbed and no split ever needs a new id.
 */
export function swapLeaves(root: LayoutNode, a: PaneId, b: PaneId): LayoutNode {
  if (root.type === 'pane') {
    if (root.pane === a) return pane(b);
    if (root.pane === b) return pane(a);
    return root;
  }
  const first = swapLeaves(root.children[0], a, b);
  const second = swapLeaves(root.children[1], a, b);
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

/**
 * Removes `target`'s leaf from the tree, promoting its sibling to take its
 * parent split's place -- the split disappears along with it, since a
 * split with only one remaining child isn't a split. Returns `null` only if
 * `root` itself *is* the leaf being removed (the whole tree was just that
 * one pane); unreachable with this app's five-pane presets (there's always
 * at least one sibling), but handled rather than assumed away.
 */
function removeLeaf(root: LayoutNode, target: PaneId): LayoutNode | null {
  if (root.type === 'pane') {
    return root.pane === target ? null : root;
  }
  const first = removeLeaf(root.children[0], target);
  const second = removeLeaf(root.children[1], target);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

let idSeq = 0;
/**
 * A split id guaranteed not to collide with any id already in the tree
 * being edited: every id this module mints is only ever compared against
 * ids present in the persisted tree *at the moment of creation* -- never
 * against one minted in some other browser tab or an earlier session --
 * so a per-module monotonic counter combined with the current time is
 * enough, without needing `crypto.randomUUID` (unavailable in some test
 * environments) or a global id registry.
 */
function nextSplitId(prefix: string): string {
  idSeq += 1;
  return `custom-${prefix}-${idSeq}-${Date.now()}`;
}

/**
 * The default share the *moved* pane gets of its new edge slot -- sized
 * like `presets.ts`'s own `withDocsSidebar` sidebar share (0.2), comfortably
 * clear of `constants.ts`'s `MIN_REGION_PX` floor on any realistic window
 * rather than a sliver a user would need to immediately fix by dragging.
 */
const EDGE_SHARE = 0.28;

/**
 * Moves `target` to occupy an entire edge of the whole layout: "move to
 * left" means "this pane is now the full-height strip on the left; every
 * other pane keeps its previous relative arrangement in whatever's left,"
 * matching the issue's own "I just want it on the whole top" framing.
 *
 * Implemented as remove-then-rewrap: `removeLeaf` first collapses away
 * whichever split used to hold `target`, then exactly one new split is
 * added at the very top with `target` on `edge`'s side and the untouched
 * rest on the other. Net depth added per call is *at most* one, regardless
 * of how deep `target` used to sit -- removing it can itself collapse a
 * level elsewhere in the tree, which can cancel out the one level the new
 * wrap adds. Repeatedly moving the *same* pane between edges always
 * un-nests its previous wrapper before adding a new one, so a single pane
 * bounced between edges can never accumulate depth (see `moves.test.ts`).
 * Every split id other than the one new wrapper is untouched, so ratios for
 * the rest of the tree survive the move exactly -- the "preserve untouched
 * splits' ratios" requirement holds by construction, not by copying values
 * around.
 */
export function moveToEdge(
  root: LayoutNode,
  target: PaneId,
  edge: PaneEdge,
): { root: LayoutNode; newSplitId: string } {
  const rest = removeLeaf(root, target);
  // `rest === null` only if `root` was nothing but `target` (see
  // `removeLeaf`'s doc comment) -- falls back to leaving `target` as the
  // whole tree rather than crashing.
  const survivor = rest ?? pane(target);
  const moved = pane(target);
  const direction: SplitDirection =
    edge === 'left' || edge === 'right' ? 'row' : 'column';
  const newSplitId = nextSplitId(`${target}-${edge}`);
  const children: readonly [LayoutNode, LayoutNode] =
    edge === 'left' || edge === 'top' ? [moved, survivor] : [survivor, moved];
  const ratio = edge === 'left' || edge === 'top' ? EDGE_SHARE : 1 - EDGE_SHARE;
  return { root: split(newSplitId, direction, ratio, children), newSplitId };
}

/**
 * Every pane in a tree, in depth-first document order -- used to build the
 * "swap with..." menu's own entries (every *other* pane, in a stable order)
 * and by tests to assert a move/swap neither duplicated nor dropped a pane.
 */
export function collectPaneIds(node: LayoutNode, out: PaneId[] = []): PaneId[] {
  if (node.type === 'pane') {
    out.push(node.pane);
    return out;
  }
  collectPaneIds(node.children[0], out);
  collectPaneIds(node.children[1], out);
  return out;
}
