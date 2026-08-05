/**
 * The hole `Panel`'s header row leaves for the layout engine to fill, and the
 * handshake that lets `layout/PaneSlot` know whether anyone filled it
 * (issue #208).
 *
 * ## Why this exists
 *
 * The owner, after #199 gave `Move`/`Collapse` a resting border:
 *
 * > *"The move and collapse buttons are definitely buttons now, but they get a
 * > little too close to the actual elements -- the next box... And honestly,
 * > maybe just rolling the move and collapse button into the top section where
 * > it says Workflow or Config or AI Assistant -- you already have settings and
 * > all the different labels there, might be a little bit cleaner."*
 *
 * Which closes the loop #183 opened: that change removed the chrome
 * strip's *label* for four panes, leaving a 24px strip whose only remaining job
 * was to carry these two controls. Folding them into the pane's own header
 * deletes the strip and recovers 24px of vertical space per pane -- one of the
 * two candidates recorded for exactly that (see #178).
 *
 * ## Why a context, rather than a prop on every pane
 *
 * `PaneSlot` is deliberately built on not knowing what a pane contains, and the
 * fold has to cross that somehow. The two candidates were:
 *
 * 1. **Every pane header takes a shared controls slot** -- each of the five
 *    pane components accepts and renders the controls. Rejected: it puts
 *    layout-engine plumbing in five pane components' prop lists, and a sixth
 *    pane that forgot to render them would silently lose its Move and Collapse.
 * 2. **`PaneSlot` injects into a known landmark** -- this. `Panel` is that
 *    landmark: it is used by exactly the five layout panes and nothing else, it
 *    is each pane's accessible heading, and it is already the row the pane's
 *    real controls hang off. No pane component changes at all, so `PaneSlot`
 *    still does not know what a pane contains -- it *offers* a node, and the
 *    shared header primitive decides where in its row that node goes.
 *
 * The context lives here, in `design/`, rather than in `layout/`: `Panel` is a
 * design primitive and must not import from the layout engine. `layout/` is the
 * side that reaches down.
 *
 * ## The handshake, and why the offer can go unclaimed
 *
 * A landmark that might not be there is the honest weakness of option 2, so it
 * is made explicit rather than assumed. The offer carries an `onClaim`
 * callback; `usePaneHeaderSlot` fires it in a layout effect. If no `Panel`
 * consumed the offer -- a pane built out of something else entirely, or a
 * `PaneSlot` rendered in isolation by a test -- `PaneSlot` keeps rendering its
 * own strip, so `Move` and `Collapse` are never unreachable. #80's collapse and
 * #121's Move menu hold unconditionally, not "as long as every pane remembers
 * to use `Panel`".
 *
 * `useLayoutEffect`, not `useEffect`: the claim must be committed before the
 * browser paints, or the strip would be visible for one frame and the pane's
 * content would shift 24px on load.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from 'react';

export interface PaneHeaderSlotOffer {
  /** What to render in the pane header's control row. `null` when the pane is
   * collapsed -- its header is hidden then, and the collapsed strip carries the
   * one control that state needs (see `layout/PaneSlot`). */
  controls: ReactNode;
  /** Called by the consumer that rendered `controls`, so the offering side can
   * stop rendering its own fallback. */
  onClaim: () => void;
}

export const PaneHeaderSlotContext = createContext<PaneHeaderSlotOffer | null>(
  null,
);

/**
 * Returns the controls this header should render, claiming the offer as a side
 * effect. Returns `null` outside a `PaneHeaderSlotContext` provider, which is
 * every use of `Panel` that is not a layout pane.
 */
export function usePaneHeaderSlot(): ReactNode {
  const offer = useContext(PaneHeaderSlotContext);
  const onClaim = offer?.onClaim;
  // Depends on `onClaim` alone, not on the whole offer: the offer object is
  // rebuilt on every render of the providing component (its `controls` are
  // fresh JSX each time), while `onClaim` is stable -- so this fires once per
  // provider, not once per render.
  useLayoutEffect(() => {
    onClaim?.();
  }, [onClaim]);
  return offer?.controls ?? null;
}
