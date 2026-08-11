import type { ReactNode } from 'react';

import { Tooltip } from '~/design/components/Tooltip';

interface InfoHintProps {
  /** What the hint explains. Rendered inside the tooltip panel. */
  content: ReactNode;
  /**
   * Names the subject for anyone not seeing the glyph, e.g. "Kapa". Becomes
   * "More about Kapa" as the button's accessible name -- a bare "More info"
   * repeated down a settings pane tells a screen-reader user nothing about
   * which control they have landed on.
   */
  subject: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * A small "ⓘ" a user can hover or focus for background on the control next to
 * it, for the case where a feature needs a sentence of explanation that would
 * be clutter if it were always on screen.
 *
 * Exists because of feedback on the AI pane's MCP section (issue #71): a
 * reviewer looking at it with customer eyes did not know what Kapa was, and
 * the pane offered nowhere to find out. The alternative -- more permanent
 * prose under every heading -- is what made that pane dense enough to bounce
 * off in the first place.
 *
 * A `<button type="button">` rather than a styled `<span>` so it is reachable
 * by keyboard and announced as interactive; Radix's tooltip opens on focus as
 * well as hover, so the content is not mouse-only. The glyph is text, matching
 * how every other icon in this app is drawn (see `ThemeToggle`) -- this
 * project has no icon dependency and this hint is not a reason to add one.
 */
export function InfoHint({ content, subject, side = 'top' }: InfoHintProps) {
  return (
    <Tooltip content={content} side={side}>
      <button
        type="button"
        aria-label={`More about ${subject}`}
        // `cursor-help` rather than `cursor-pointer`: clicking does nothing,
        // and a pointer cursor would promise an action that isn't there.
        className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-cc-border-strong text-2xs leading-none text-cc-text-faint transition-colors hover:border-cc-text-muted hover:text-cc-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cc-accent"
      >
        <span aria-hidden="true">i</span>
      </button>
    </Tooltip>
  );
}
