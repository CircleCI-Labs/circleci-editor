import type { ReactNode } from 'react';

/**
 * The one external-link affordance every "link to circleci.com/docs" call
 * site in this app renders through (issue #78). Every URL comes from
 * `~/lib/docs/docsLinks`'s table, never a literal here -- see that
 * module's doc comment for why.
 *
 * Deliberately tiny: issue #78 calls for "a small affordance, not a wall of
 * links" in panes that are already dense. Icon-only by default (an
 * `aria-label`, not visible text, carries the accessible name -- matching
 * this app's existing icon-only controls like the inspector's `&times;`
 * remove buttons), with an optional visible label for the handful of
 * lower-density spots (a section header, a dialog) where a bare glyph would
 * be too subtle to notice at all.
 *
 * `target="_blank"` + `rel="noreferrer"` (issue #78's own external-link
 * requirement) -- `noreferrer` over just `noopener` because this is a
 * link to a third party the app has no relationship with; there's no
 * reason for CircleCI's docs site to see this app as a referrer.
 */
export function DocsLink({
  label,
  url,
  children,
  className = '',
}: {
  /** The accessible name (and native tooltip) -- what this points to, e.g. `"Docker execution environment"`. Always required, even when `children` supplies visible text, so a screen reader announces something more specific than "docs" for every link on a page that may have several. */
  label: string;
  url: string;
  /** Visible text before the icon, for the lower-density spots where an icon alone would be too easy to miss. Omit for the default icon-only affordance. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={
        children ? undefined : `${label} (opens CircleCI docs in a new tab)`
      }
      className={`inline-flex shrink-0 items-center gap-0.5 rounded text-cc-text-faint outline-none hover:text-cc-accent focus-visible:text-cc-accent focus-visible:ring-1 focus-visible:ring-cc-accent ${
        children ? 'text-2xs' : ''
      } ${className}`}
    >
      {children}
      {/* A north-east arrow, not an SVG -- this app has no icon-asset
          convention (every other affordance here, e.g. `&larr;`/`&times;`,
          is a text glyph), so introducing one just for this would be a
          second visual language for one feature. `aria-hidden` since the
          link's own accessible name (via `aria-label`/`children`) already
          says "opens ... in a new tab" -- the glyph is a purely visual
          external-link cue, not additional information. */}
      <span aria-hidden="true" className={children ? undefined : 'text-2xs'}>
        &#8599;
      </span>
    </a>
  );
}
