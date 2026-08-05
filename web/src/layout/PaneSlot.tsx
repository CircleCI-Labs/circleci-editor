/**
 * Wraps one pane's rendered content with this layout engine's own chrome:
 * `Move`/`Collapse` when expanded, or -- when collapsed -- a full-region
 * "Expand" button in its place.
 *
 * Issue #183 removed the strip's *label* for four panes, leaving a 24px strip
 * whose only remaining job was to carry those two controls. **Issue #208 folds
 * them into each pane's own header and deletes the strip**, which is what
 * recovers the 24px per pane recorded as one of two candidates for
 * reclaiming vertical space (see #178) -- and, as a consequence, removes the
 * near-collision the owner reported, rather than spacing around it:
 *
 * > *"The move and collapse buttons... get a little too close to the actual
 * > elements -- the next box. For example on the config one you have config.yml,
 * > unsaved, invalid, and then Source/Compiled on that little box, and the
 * > buttons look like they kind of touch it... maybe just rolling the move and
 * > collapse button into the top section where it says Workflow or Config or AI
 * > Assistant."*
 *
 * ## How the fold crosses the "PaneSlot doesn't know what a pane contains" line
 *
 * It doesn't. This module *offers* the two controls through
 * `design/components/paneHeaderSlot`, and `Panel` -- the header primitive all
 * five panes already use, and nothing else does -- renders them in its control
 * row. No pane component changed. See that module for why the injection goes
 * this way round rather than through five panes' props, and for the `onClaim`
 * handshake.
 *
 * ## Two states this still has to get right
 *
 * - **Collapsed.** There is no pane header to fold into -- the pane's own
 *   `Panel` is `hidden` -- so the collapsed strip is unchanged: a full-region
 *   `Expand` button, still carrying the pane's label, which is the one state
 *   where nothing else says what the region is.
 * - **Unclaimed.** If nothing rendered the offer (a pane built out of something
 *   other than `Panel`, or a `PaneSlot` rendered on its own in a test), this
 *   falls back to the pre-#208 strip. So #80's collapse and #121's Move menu
 *   are never unreachable, whatever a pane is made of.
 *
 * The one pane that shows its name in *both* the strip and its own header used
 * to be `yaml`, and it did so for free: its header shows `config.yml` plus its
 * save/validation badges, never the word "Config".
 *
 * The outer wrapper always renders exactly the same two children in the
 * same order -- the chrome position, then the div holding `children` --
 * whether collapsed or not; only the chrome's own (stateless) contents and
 * the content div's `hidden` attribute change. That stable shape matters: if
 * collapsing swapped in an entirely different tree around `children` (say,
 * an "Expand" button as the *only* child, with `children` nested inside
 * it instead of a sibling), React would see a structural mismatch at that
 * position on the next toggle and remount `children` -- losing whatever
 * state it holds. #208 keeps that invariant by rendering `null` in the chrome
 * position once the header has claimed the controls, rather than dropping the
 * position: `children` stays at index 1 across every state. `children` is
 * *always* rendered, collapsed or not, and only ever hidden via the `hidden`
 * attribute (`display: none`), never removed from the tree, for the same
 * reason: the YAML editor's cursor/scroll position (the concrete case this
 * matters for) must survive a collapse/expand round trip.
 *
 * Issue #121 added "Move" here: a keyboard-accessible menu ("Swap with…" /
 * "Move to edge…"), rather than the FancyZones-style drag overlay the issue's
 * owner first described -- a spike against the real running app found the
 * overlay's edge zones too cramped to hit reliably at a sidebar-scale pane's
 * width, so the menu shipped as the issue's own named fallback instead. See
 * `layout/moves.ts` for the tree surgery each menu item performs.
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { PaneHeaderSlotContext } from '~/design/components/paneHeaderSlot';
import { chromeControlClassName } from '~/design/controlAffordance';

import {
  DisclosureMenu,
  menuItemClassName,
  menuSectionClassName,
} from './DisclosureMenu';
import type { PaneEdge } from './moves';
import {
  PANE_IDS,
  PANE_LABELS,
  type PaneId,
  type SplitDirection,
} from './types';

const EDGES: readonly { edge: PaneEdge; label: string }[] = [
  { edge: 'left', label: 'Left edge' },
  { edge: 'right', label: 'Right edge' },
  { edge: 'top', label: 'Top edge' },
  { edge: 'bottom', label: 'Bottom edge' },
];

/**
 * The "Move" button and its dropdown. This is deliberately the *only* way to
 * reach a move -- there is no drag path at all (see this module's doc comment)
 * -- so it doubles as this feature's keyboard-accessibility story, not just a
 * convenience alongside a drag one.
 *
 * The disclosure mechanics (portaled panel, Escape/outside-click dismissal,
 * focus returning to the trigger) moved to `./DisclosureMenu` in issue #154,
 * which introduced two more menus of exactly this shape when the app bar
 * learned to collapse. Behaviour here is unchanged -- see that module for why
 * a portal is required rather than an `absolute`-positioned child, which was
 * discovered against the real running app during #121 and is now true of the
 * app bar as well as of every pane.
 *
 * Issue #183: the trigger no longer sits inside a `relative shrink-0` wrapper
 * `<div>`. That wrapper is what made `Move` and `Collapse` disagree about their
 * vertical centre by 2px -- it made the trigger an `inline-block` on a text
 * baseline instead of a direct, blockified, vertically-centred flex item of the
 * strip, the way `Collapse` already was. Nothing needed the wrapper: the
 * `relative` was vestigial (`DisclosureMenu` portals its panel to
 * `document.body` and positions it `fixed` from the trigger's measured rect --
 * there is no `absolute` child to anchor), and `shrink-0` moved onto the button
 * itself via `chromeControlClassName`.
 */
function MovePaneMenu({
  pane,
  label,
  onSwapWith,
  onMoveToEdge,
}: {
  pane: PaneId;
  label: string;
  onSwapWith: (other: PaneId) => void;
  onMoveToEdge: (edge: PaneEdge) => void;
}) {
  const otherPanes = PANE_IDS.filter((id) => id !== pane);

  return (
    <DisclosureMenu
      menuLabel={`Move ${label} panel`}
      triggerTitle={`Move ${label} pane`}
      triggerContent="Move"
      triggerClassName={chromeControlClassName}
    >
      {(close) => (
        <>
          <div className={menuSectionClassName}>Swap with</div>
          {otherPanes.map((other) => (
            <button
              key={other}
              type="button"
              role="menuitem"
              onClick={() => {
                onSwapWith(other);
                close();
              }}
              className={menuItemClassName}
            >
              {PANE_LABELS[other]}
            </button>
          ))}
          <div className="my-1 border-t border-cc-border" role="separator" />
          <div className={menuSectionClassName}>Move to</div>
          {EDGES.map(({ edge, label: edgeLabel }) => (
            <button
              key={edge}
              type="button"
              role="menuitem"
              onClick={() => {
                onMoveToEdge(edge);
                close();
              }}
              className={menuItemClassName}
            >
              {edgeLabel}
            </button>
          ))}
        </>
      )}
    </DisclosureMenu>
  );
}

/**
 * The two layout-engine controls, as a fragment so they can be *direct*
 * children of whichever `items-center` row ends up holding them -- the pane
 * header's control row after issue #208, or the fallback strip below.
 *
 * That they are direct siblings with nothing wrapping either one is the fix
 * from #183, not a detail: a wrapper `<div>` around `Move` made it an
 * `inline-block` on a text baseline while `Collapse` was a blockified,
 * vertically-centred flex item, and the two centres disagreed by 2px.
 * `e2e/layout.spec.ts` asserts they share a centre; keep them unwrapped.
 */
function PaneControls({
  pane,
  label,
  onToggle,
  onSwapWith,
  onMoveToEdge,
}: {
  pane: PaneId;
  label: string;
  onToggle: () => void;
  onSwapWith: (other: PaneId) => void;
  onMoveToEdge: (edge: PaneEdge) => void;
}) {
  return (
    <>
      <MovePaneMenu
        pane={pane}
        label={label}
        onSwapWith={onSwapWith}
        onMoveToEdge={onMoveToEdge}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Collapse ${label} panel`}
        // Names the pane, matching `Move`'s own `title` and this button's
        // `aria-label`. With the chrome strip's label gone (#183) and then the
        // strip itself gone (#208), a tooltip that just said "Collapse panel"
        // would be the one place these controls stopped saying *which* panel --
        // which matters more now that they sit in a header shared with the
        // pane's own controls.
        title={`Collapse ${label} panel`}
        className={chromeControlClassName}
      >
        Collapse
      </button>
    </>
  );
}

/** The collapsed pane's whole region: one button that expands it again, still
 * carrying the label, because the pane's own header is hidden in this state and
 * there is nothing else to say what the region is. */
function CollapsedStrip({
  label,
  vertical,
  onToggle,
}: {
  label: string;
  /** Whether this strip is a narrow, full-height vertical bar (the pane's split
   * parent runs `row`) rather than a short, full-width horizontal one
   * (`column`). */
  vertical: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Expand ${label} panel`}
      title={`Expand ${label} panel`}
      // The resting form `chromeControlClassName` generalises (issue #183):
      // a `-panel-raised` fill inside a border that brightens to the accent
      // colour on hover. Kept spelled out here rather than composed from that
      // constant because this one is a full-region strip, not a 20px chrome
      // button -- it needs `flex-1` and a writing-mode flip, and it has never
      // had the ambiguity #183 is about. `-border-interactive`, not
      // `-border-strong` (issue #200): this control's resting boundary is the
      // only thing that says "collapsed pane, click to expand" when nothing
      // else on the strip does, and `-border-strong` measured 1.4:1 against
      // this fill in light mode -- short of 1.4.11's 3:1 floor.
      className={`flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-cc-border-interactive bg-cc-panel-raised text-2xs font-semibold uppercase tracking-wide text-cc-text-muted transition-colors hover:border-cc-accent hover:text-cc-text ${
        vertical ? 'flex-col' : 'flex-row'
      }`}
    >
      <span
        className={
          vertical
            ? 'whitespace-nowrap [writing-mode:vertical-rl]'
            : 'whitespace-nowrap'
        }
      >
        {label}
      </span>
    </button>
  );
}

export function PaneSlot({
  pane,
  collapsed,
  parentDirection,
  onToggleCollapsed,
  onSwapWith,
  onMoveToEdge,
  children,
}: {
  pane: PaneId;
  collapsed: boolean;
  /** The direction of the split this pane sits inside -- see
   * `PaneChrome`'s `vertical` prop for why the collapsed strip's shape
   * depends on it. */
  parentDirection: SplitDirection;
  onToggleCollapsed: () => void;
  /** Issue #121: swap this pane's position with `other`'s. */
  onSwapWith: (other: PaneId) => void;
  /** Issue #121: move this pane to occupy a whole edge of the layout. */
  onMoveToEdge: (edge: PaneEdge) => void;
  children: ReactNode;
}) {
  const label = PANE_LABELS[pane];

  // Issue #208's fallback, and the reason it is expressed as "did *nobody*
  // claim?" rather than "did somebody claim?".
  //
  // The optimistic direction is the load-bearing part: this starts out assuming
  // the pane's header will take the controls, so the common path renders them
  // exactly once, in the header. Starting the other way round would render the
  // strip *and* the header's copy on the first pass -- two `Move` buttons in one
  // pane until the claim landed.
  //
  // `claimed` is a ref, not state, because it is read from a layout effect and
  // must not itself schedule a render. React commits layout effects child-first,
  // so a `Panel` inside `children` has already claimed by the time this one
  // runs; if nothing did, the strip is put back before the browser paints, so
  // there is no visible flash and no 24px shift.
  const claimed = useRef(false);
  const [needsFallbackStrip, setNeedsFallbackStrip] = useState(false);
  const onClaim = useCallback(() => {
    claimed.current = true;
    setNeedsFallbackStrip(false);
  }, []);
  useLayoutEffect(() => {
    if (!claimed.current) setNeedsFallbackStrip(true);
    // Mount only. A claim is sticky for this `PaneSlot`'s lifetime: re-checking
    // per render would make the strip flicker back for a pane whose header is
    // momentarily unmounted, and the only thing this guards is a pane that never
    // had a header at all.
  }, []);

  const controls = collapsed ? null : (
    <PaneControls
      pane={pane}
      label={label}
      onToggle={onToggleCollapsed}
      onSwapWith={onSwapWith}
      onMoveToEdge={onMoveToEdge}
    />
  );
  // Deliberately not memoised. `controls` is fresh JSX on every render, so a
  // `useMemo` keyed on it could never hit -- and nothing needs it to: this
  // component re-renders only when `LayoutRoot`'s tree walk re-runs, which
  // recreates `children` anyway, and the consuming side's claim effect depends
  // on the stable `onClaim` rather than on this object's identity.
  const offer = { controls, onClaim };

  return (
    <div
      // Issue #88's own e2e measurement (counting simultaneously-scrollable
      // regions "in the graph pane") needs a stable way to scope a query to
      // one pane's DOM subtree without depending on its rendered label text
      // (which a screen-reader-facing string change could otherwise
      // silently break) -- generic here, on every pane, rather than a
      // one-off added just for `dag`, since any future pane-scoped e2e check
      // needs the exact same hook.
      data-testid={`pane-${pane}`}
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {/* Index 0 is always the chrome position, even when it renders nothing --
          see this module's doc comment for why `children` must stay at index 1
          across every state. */}
      {collapsed ? (
        <CollapsedStrip
          label={label}
          vertical={parentDirection === 'row'}
          onToggle={onToggleCollapsed}
        />
      ) : needsFallbackStrip ? (
        // The pre-#208 strip, for a pane whose content did not render a `Panel`
        // to fold these into. `h-6` and its surface are unchanged, so a pane
        // that lands here behaves exactly as every pane did before.
        <div className="flex h-6 shrink-0 items-center justify-end gap-1 bg-cc-bg px-2">
          {controls}
        </div>
      ) : null}
      <div
        hidden={collapsed}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <PaneHeaderSlotContext.Provider value={offer}>
          {children}
        </PaneHeaderSlotContext.Provider>
      </div>
    </div>
  );
}
