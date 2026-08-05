import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

// Tint alpha for tone backgrounds: 10%, down from the original 16%. At
// 16%, the danger tone's text-on-tinted-background contrast measured
// ~4.16-4.17:1 against this app's panel surfaces (one of the three
// contrast failures this styling pass fixes) even after moving
// --color-cc-danger to CircleCI's real (lighter) negative red -- 16% tint
// was still too dark a background for AA. 10% clears AA on every tone,
// with the least margin on the tightest case (danger: ~4.6-5:1).
//
// These have to be written as complete, literal class strings (not built
// via template interpolation) because Tailwind's build-time scanner finds
// candidate classes by matching literal text in source files -- it can't
// evaluate a template expression, so an interpolated `${alpha}` inside a
// `bg-[...]` arbitrary value would silently fail to generate any CSS.
const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-cc-panel-raised text-cc-text-muted border-cc-border-strong',
  info: 'bg-[color-mix(in_srgb,var(--color-cc-info)_10%,transparent)] text-cc-info border-[color-mix(in_srgb,var(--color-cc-info)_45%,transparent)]',
  success:
    'bg-[color-mix(in_srgb,var(--color-cc-success)_10%,transparent)] text-cc-success border-[color-mix(in_srgb,var(--color-cc-success)_45%,transparent)]',
  warning:
    'bg-[color-mix(in_srgb,var(--color-cc-warning)_10%,transparent)] text-cc-warning border-[color-mix(in_srgb,var(--color-cc-warning)_45%,transparent)]',
  danger:
    'bg-[color-mix(in_srgb,var(--color-cc-danger)_10%,transparent)] text-cc-danger border-[color-mix(in_srgb,var(--color-cc-danger)_45%,transparent)]',
};

/** A small status pill, e.g. for token/validation state or "Coming soon". */
export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
