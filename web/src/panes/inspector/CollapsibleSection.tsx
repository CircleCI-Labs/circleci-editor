/**
 * A collapsible inspector section (issue #219).
 *
 * ## Why this is a `<details>`, and the palette's `<details>` specifically
 *
 * The owner asked for this "kind of like you have on the palette", and taking
 * that literally is the whole point: `panes/dag/palette/Palette.tsx` and
 * `panes/orbs/OrbBrowser.tsx` already collapse sections with native
 * `<details>`/`<summary>` wearing `design/controlAffordance.ts`'s
 * `disclosureSummaryClassName`. Reusing both means collapsing is *one*
 * interaction in this app rather than two that look alike, the keyboard model
 * (Enter/Space on a focused summary) comes from the browser rather than from
 * code that has to be kept correct, and #199's hover/boundary treatment on
 * those summary rows is inherited rather than reimplemented.
 *
 * It also matters for #88: a closed section costs one summary row of
 * height instead of its content's, and it does so *without* adding an
 * `overflow-*` anywhere. The inspector still has exactly one scroll region
 * (`Inspector.tsx`'s own `overflow-y-auto`), which is the constraint a
 * "give each section its own scroller" answer would have broken.
 *
 * ## The heading stays a real heading
 *
 * The `<h4>` lives *inside* the `<summary>` rather than being replaced by it.
 * Two reasons. A `<summary>`'s implicit role is `button`, not `heading`, so
 * putting the text directly in the summary would delete every section heading
 * from the document outline and from `getByRole('heading', { name: 'Steps' })`
 * -- which is how a good deal of this project's own test suite, unit and e2e
 * alike, addresses this pane. And a screen-reader user navigating by heading
 * is exactly the user most helped by knowing a region is collapsible, so
 * losing the heading to gain the toggle would be a bad trade.
 *
 * The `DocsLink` (issue #78) stays on the summary row where it has always
 * been, but has to stop its own clicks: a `<summary>`'s activation behaviour
 * fires for a click anywhere inside it, so without this, following a section's
 * docs link would *also* toggle the section shut behind you. `stopPropagation`
 * on the link -- rather than moving the link out of the row -- keeps the
 * layout `SectionHeading` established and fixes the interaction.
 *
 * ## The content signal is not optional
 *
 * Issue #219 is explicit that a collapsed section holding configuration must
 * say so: "otherwise this trades crowding for invisible configuration, which
 * is worse in a config editor." So `contentCount` renders as a small count
 * badge on the summary row.
 *
 * It renders whenever the section has content, *not* only while collapsed.
 * That looks like redundancy for an open section whose contents are right
 * there, and it is -- deliberately. A signal that only exists in the closed
 * state is a signal that has to be correct in two states, and the failure
 * mode of getting it wrong is silently hiding configuration, which is the one
 * outcome the requirement exists to prevent. Always-on cannot fail that way,
 * and it has a second use: it lets you read "3" off a collapsed Post-steps
 * row and "3" off the open one and know you are looking at the same thing.
 */
import type { ReactNode } from 'react';

import { disclosureSummaryClassName } from '~/design/controlAffordance';
import { DocsLink } from '~/design/components/DocsLink';
import {
  useInspectorSectionStore,
  type InspectorSectionId,
} from '~/state/inspectorSectionStore';

export function CollapsibleSection({
  id,
  title,
  docsLink,
  contentCount,
  defaultOpen,
  children,
}: {
  /** Stable storage identity for this section -- see `inspectorSectionStore`. */
  id: InspectorSectionId;
  title: string;
  docsLink?: { label: string; url: string };
  /**
   * How many things this section currently holds, for the summary-row signal.
   * `0` renders no badge. Sections whose content isn't a countable list (the
   * executor, the filters form) pass `undefined` and rely on `defaultOpen`
   * plus their own "nothing set" copy instead of inventing a number.
   */
  contentCount?: number;
  /**
   * Whether this section is open when the user has expressed no explicit
   * choice for it -- the content rule, computed by the caller via
   * `defaultSectionOpen`. Ignored once a choice exists in the store.
   */
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const choices = useInspectorSectionStore((state) => state.open);
  const setSectionOpen = useInspectorSectionStore(
    (state) => state.setSectionOpen,
  );
  const choice = choices[id];
  const open = choice === undefined ? defaultOpen : choice;

  return (
    // The `<section>` is kept around the `<details>` rather than replaced by
    // it. It carries the spacing, and it keeps "the region of this pane that
    // is about X" addressable as a section -- which is how a good deal of this
    // project's own test suite scopes its queries
    // (`getByRole('heading', { name: 'Context' }).closest('section')`), and
    // which is a contract worth not breaking for the sake of removing one
    // wrapper div's worth of markup.
    <section className="mb-4 min-w-0">
      <details
        // `open`/`onToggle` rather than `defaultOpen`: the store is the source
        // of truth, so a section must re-render to match it (e.g. when another
        // instance of this pane toggles the same section id, or when the
        // content rule's answer changes because a step was added).
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          // `toggle` fires on every render that changes the attribute,
          // including ones this component itself caused -- writing
          // unconditionally would persist a "choice" the user never made,
          // pinning a section against the content rule forever.
          if (next !== open) setSectionOpen(id, next);
        }}
        className="min-w-0"
      >
        <summary className={`${disclosureSummaryClassName} mb-2`}>
          {/*
          The row is an inner `inline-flex`, not `flex` on the `<summary>`
          itself: `controlAffordance.ts` is explicit that overriding a
          summary's `display: list-item` drops the browser's own disclosure
          triangle -- the one part of these controls that already said "this
          opens and closes", and the affordance #219 is trying to add, not
          remove. So the summary keeps its display and its marker, and the
          layout happens one level in.
        */}
          <span className="inline-flex items-center gap-1.5 align-middle">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-cc-text-muted">
              {title}
            </h4>
            {contentCount !== undefined && contentCount > 0 ? (
              <span
                // Not a `<Badge>`: this sits inside a `<summary>` whose own
                // hover treatment already paints a boundary, and a second
                // bordered pill inside it reads as two controls.
                className="shrink-0 rounded-sm bg-cc-panel-raised px-1 text-2xs font-medium tabular-nums text-cc-text-muted"
                aria-label={`${contentCount} ${contentCount === 1 ? 'item' : 'items'}`}
              >
                {contentCount}
              </span>
            ) : null}
            {docsLink ? (
              // See the module comment: a click inside a `<summary>` toggles
              // it, so without this, following the link would collapse the
              // section behind you.
              <span
                onClick={(event) => event.stopPropagation()}
                className="inline-flex items-center"
              >
                <DocsLink label={docsLink.label} url={docsLink.url} />
              </span>
            ) : null}
          </span>
        </summary>
        {children}
      </details>
    </section>
  );
}
