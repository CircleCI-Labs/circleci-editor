/**
 * One draggable/clickable card in the palette -- the shared row shape for
 * both the Executors and Steps sections (issue #71). Modelled on Bitrise's
 * `StepSelectorDrawer`'s `AlgoliaStepListItem` (avatar-with-initials,
 * corner badge, a clamped description, a hover "+" affordance), adapted to
 * this app's own tokens and to the two ways a card here can be reached: a
 * mouse drag, or a click/Enter/Space -- see the module doc on `onActivate`.
 *
 * A single `<button>`, not a `<div draggable>` wrapping a nested button:
 * a `<button>` is focusable and keyboard-activatable for free, which is
 * exactly what issue #71's "drag-and-drop cannot be the only path" bar
 * requires -- the archived predecessor's own `Definition.tsx` made the same
 * choice (a focusable, draggable button that is *also* a click target), and
 * it is the one part of that project's UI this rebuild deliberately keeps.
 */
import type { DragEvent } from 'react';

import { DocsLink } from '~/design/components/DocsLink';
import { avatarInitials, avatarTone, type AvatarTone } from '~/lib/orbs/avatar';

const toneClassNames: Record<AvatarTone, string> = {
  accent:
    'bg-[color-mix(in_srgb,var(--color-cc-accent)_22%,transparent)] text-cc-accent',
  success:
    'bg-[color-mix(in_srgb,var(--color-cc-success)_22%,transparent)] text-cc-success',
  warning:
    'bg-[color-mix(in_srgb,var(--color-cc-warning)_22%,transparent)] text-cc-warning',
  danger:
    'bg-[color-mix(in_srgb,var(--color-cc-danger)_22%,transparent)] text-cc-danger',
  info: 'bg-[color-mix(in_srgb,var(--color-cc-info)_22%,transparent)] text-cc-info',
};

/** A small colored monogram, keyed off `seed` -- same generation `OrbAvatar` uses (see `~/lib/orbs/avatar`), reused here for any card label, not just an orb name. */
function CardAvatar({ seed }: { seed: string }) {
  const tone = avatarTone(seed);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-xs font-semibold leading-none ${toneClassNames[tone]}`}
    >
      {avatarInitials(seed)}
    </span>
  );
}

export interface PaletteCardProps {
  /** Seeds the avatar's tone/initials -- typically the same string as `title`. */
  avatarSeed: string;
  title: string;
  /** Small text badge in the row's corner, e.g. a kind ("docker") or a count ("3 params"). */
  badge?: string;
  description?: string;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  /**
   * Fired on click, and on Enter/Space (native `<button>` behavior) --
   * the keyboard/no-mouse equivalent of dragging this card onto its
   * default target. Every card must define what "activate without
   * dragging" means; see `PaletteExecutorSection`/`PaletteStepSection` for
   * what each one actually does with it.
   */
  onActivate?: () => void;
  disabled?: boolean;
  /** Shown via `title` (a native tooltip) when `disabled`, explaining why. */
  disabledReason?: string;
  /** Issue #78: a small "learn more" link to this card's own docs page, e.g. the Docker executor's `using-docker` page. Rendered *outside* the card's own `<button>` (a sibling, positioned into its corner), never inside it -- an `<a>` nested inside a `<button>` is invalid HTML and would make the link unreachable by keyboard as its own stop. */
  docsLink?: { label: string; url: string };
}

export function PaletteCard({
  avatarSeed,
  title,
  badge,
  description,
  draggable = true,
  onDragStart,
  onDragEnd,
  onActivate,
  disabled,
  disabledReason,
  docsLink,
}: PaletteCardProps) {
  return (
    <div className="relative">
      <button
        type="button"
        draggable={draggable && !disabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onActivate}
        disabled={disabled}
        title={
          disabled ? disabledReason : 'Drag onto the graph, or click to add'
        }
        className={`group flex w-full items-start gap-2 rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-left transition-colors ${
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-grab hover:border-cc-accent active:cursor-grabbing'
        }`}
      >
        <CardAvatar seed={avatarSeed} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-cc-text">
              {title}
            </span>
            {badge ? (
              <span className="shrink-0 rounded-full bg-cc-panel px-1.5 py-0.5 text-2xs text-cc-text-faint">
                {badge}
              </span>
            ) : null}
            {/* Reserves room for the docs link overlaid on top (below) so
                the badge/title never sit underneath it. */}
            {docsLink ? (
              <span aria-hidden="true" className="w-3 shrink-0" />
            ) : null}
          </span>
          {description ? (
            <span className="mt-0.5 line-clamp-3 block text-2xs text-cc-text-muted">
              {description}
            </span>
          ) : null}
        </span>
        {/* The hover "+" affordance Bitrise's row uses to hint "this is
            addable", separate from `badge` -- shown on hover/focus only so
            it doesn't compete with the badge for attention at rest. */}
        {!disabled ? (
          <span
            aria-hidden="true"
            className="shrink-0 self-center text-sm text-cc-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            +
          </span>
        ) : null}
      </button>
      {docsLink ? (
        <DocsLink
          label={docsLink.label}
          url={docsLink.url}
          className="absolute right-2 top-1.5 rounded bg-cc-panel-raised"
        />
      ) : null}
    </div>
  );
}
