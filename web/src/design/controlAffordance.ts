/**
 * The one rule this app has for "does this look clickable?" (issue #183).
 *
 * The owner's framing was explicitly a design-language request, not a fix for
 * two labels: *"it'd be nice to make them more button-ish so people know they
 * can click on them. I want to make it very clear in the design language
 * what's clickable and what's not."* So this module holds the treatment, one
 * definition, rather than each call site inventing its own -- the same reason
 * `layout/DisclosureMenu.tsx` exports `menuItemClassName` instead of three
 * menus hand-rolling one shape.
 *
 * The rule has four parts, in order of how much help the control needs:
 *
 * 1. **Every enabled control gets a pointer cursor.** Not expressed here but
 *    in `styles.css`'s base layer, because it has to reach controls that never
 *    import anything from this module (Radix's switch, React Flow's canvas
 *    buttons, every `<button>` in the app). Worth knowing *why* it was missing
 *    everywhere: Tailwind v4's Preflight deliberately dropped the
 *    `button { cursor: pointer }` reset v3 shipped, so every button in this app
 *    had been rendering with the UA default arrow. Measured on the real running
 *    app before this change: `getComputedStyle(moveButton).cursor === 'default'`.
 *
 * 2. **A control that shares a row with other controls stays quiet at rest and
 *    grows a boundary on hover/focus** -- `quietControlClassName`. Resting
 *    quiet is right there: the row itself is already legible as a toolbar, and
 *    giving every button a permanent border in a header that holds five of them
 *    reads as noise, not as affordance.
 *
 * 3. **A control that sits alone on an otherwise bare surface gets a resting
 *    boundary and a raised fill** -- `chromeControlClassName`. This is the case
 *    issue #183 was reported against: `Move` and `Collapse` were two bare text
 *    labels on an empty strip with nothing else in the row to establish that
 *    the row was interactive at all.
 *
 * 4. **A control on a surface that is *already* raised gets (3)'s resting
 *    boundary with no fill** -- `raisedControlClassName`. Not a fourth look: it
 *    is (3) with the one part of (3) that cannot work here removed. A
 *    `bg-cc-panel-raised` control on a `bg-cc-panel-raised` row is the same
 *    colour as the row -- which is exactly the "before #185 a raised control on
 *    a `Panel` header was the same colour as the header" problem the note below
 *    records, reappearing one ramp step up. The boundary carries the whole
 *    affordance instead, and the hover fill steps to `--color-cc-border` (the
 *    next ramp step) rather than repeating the surface.
 *
 * The resting form in (3) is not invented here. It is the treatment this app
 * already used for its two most unambiguous "this is a button" surfaces --
 * `Button`'s `secondary` variant and `PaneSlot`'s own collapsed *Expand* strip
 * -- both of which are a `--color-cc-panel-raised` fill inside a border that
 * brightens to `--color-cc-accent` on hover. Reusing it is what makes this a
 * rule rather than a fourth look.
 *
 * `--color-cc-panel-raised` as the fill is load-bearing given issue #185's
 * companion change in `styles.css`: chrome surfaces moved to
 * `--color-cc-bg`, so a `-panel-raised` control now always sits one ramp step
 * *above* whatever chrome it is placed on, in both themes. Before #185 a
 * raised control on a `Panel` header was the same colour as the header.
 */

/**
 * A control alone on bare chrome: resting boundary, raised fill, accent border
 * on hover. Sized for a 24px chrome strip (`h-5` inside it), which is why the
 * height is baked in -- see `layout/PaneSlot.tsx`, whose strip height is what
 * `layout/constants.ts`'s collapsed-strip arithmetic is measured against.
 *
 * `leading-none` plus `inline-flex items-center` is what makes two of these
 * share a vertical centre exactly, which is the measured defect in #183: the
 * `Move` trigger used to be an `inline-block` button inside a plain wrapper
 * `<div>`, so it sat on that div's text baseline (with the line box's descender
 * space *below* it) while `Collapse`, a direct flex item, was blockified and
 * centred. Measured on the real running app before the fix: centres 74px vs
 * 72px, i.e. `Move` rendered 2px low -- exactly the "Move is actually slightly
 * down and collapse is slightly up" in the report. Both are direct flex items
 * of one `items-center` row now, and `e2e/layout.spec.ts` asserts the centres
 * are equal so it cannot drift back.
 */
export const chromeControlClassName =
  'inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-sm border border-cc-border-interactive bg-cc-panel-raised px-1.5 text-2xs font-medium leading-none text-cc-text-muted transition-colors hover:border-cc-accent hover:text-cc-text';

/**
 * A control that shares a row with other controls: no resting fill or border,
 * but a real boundary *and* a raised fill on hover/focus rather than only a
 * colour change. Composed onto a call site's own type/spacing classes, since
 * these rows vary in density (a pane header's buttons, a segmented toggle's
 * segments, a `<details>` summary).
 */
export const quietControlClassName =
  'rounded-sm border border-transparent transition-colors hover:border-cc-border-interactive hover:bg-cc-panel-raised hover:text-cc-text';

/**
 * A control on an already-raised surface -- an inspector step row, not bare
 * chrome (issue #249 part 2).
 *
 * The owner asked for the step list's reorder arrows to be *"colour[ed] up a
 * little bit more"*, because they *"read as incidental"*, and #249 asks for that
 * to be "consistent with the button treatment #217 landed on the pane headers"
 * -- that is, `chromeControlClassName`'s resting boundary rather than tier 2's
 * hover-only one. The direct copy does not work: those pane headers sit on
 * `--color-cc-bg`, while a step row is a `bg-cc-panel-raised` card, so the
 * raised fill would be invisible and the button would still read as a bare
 * glyph. So the boundary is kept, the fill dropped, and the hover fill moves one
 * ramp step further to `--color-cc-border`.
 *
 * Deliberately carries no size or type classes: the arrows are 16px squares
 * inside an 11px row, which is a good deal denser than a 24px chrome strip, and
 * baking `h-5` in the way tier 3 does would grow every step row -- the wrong
 * direction for one of the two scroll regions issue #88 left standing.
 *
 * `enabled:hover:` rather than plain `hover:`, unlike the other three: a
 * disabled `<button>` still matches `:hover`, and the disabled arrow on the
 * first and last rows of a list is a state users hover constantly. `:enabled`
 * only matches form controls, which is why this variant is safe here and would
 * not be in `quietControlClassName` (whose call sites include a `<summary>`).
 */
export const raisedControlClassName =
  'rounded-sm border border-cc-border-interactive text-cc-text transition-colors enabled:hover:border-cc-accent enabled:hover:bg-cc-border disabled:border-cc-border disabled:text-cc-text-faint';

/**
 * A `<details>` disclosure heading -- the palette's and the orb browser's
 * section headers, which were styled as plain uppercase meta text and read as
 * labels rather than as the toggles they are.
 *
 * Deliberately does *not* set `display`: a `<summary>` is `display: list-item`,
 * and switching it to `inline-flex` would drop the browser's own disclosure
 * triangle -- the one part of these controls that already said "this opens and
 * closes". `w-fit` keeps the hover surface hugging the text instead of spanning
 * the full width of a 200px-wide palette pane.
 */
export const disclosureSummaryClassName = `w-fit select-none px-1 text-2xs font-semibold uppercase tracking-wide text-cc-text-muted ${quietControlClassName}`;
