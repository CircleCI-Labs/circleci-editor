import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

// `disabled:text-cc-text-muted`, not `disabled:text-cc-text-faint`, on
// `primary`/`danger`: this is the exact "disabled Save button label"
// contrast failure this pass fixes (measured 2.62:1 against `cc-border`).
// Even brightened, --color-cc-text-faint only reaches 4.03:1 against
// `cc-border` -- still short of 4.5:1 -- because `cc-border` is the
// lightest of this app's "dark surface" tokens, leaving little headroom
// for a *faint* text colour. --color-cc-text-muted clears it at 4.70:1
// while still reading as visually de-emphasised next to the default
// full-brightness `cc-text` used on enabled buttons.
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-cc-accent text-cc-on-accent hover:bg-cc-accent-hover disabled:bg-cc-border disabled:text-cc-text-muted',
  secondary:
    'bg-cc-panel-raised text-cc-text border border-cc-border-interactive hover:border-cc-accent disabled:text-cc-text-faint disabled:hover:border-cc-border-interactive',
  // Issue #183, the "quiet control" half of the affordance rule (see
  // `design/controlAffordance.ts`): `ghost` is this app's text-shaped button --
  // Undo/Redo/Re-layout, the AI pane's Settings, the diagnostics strip's
  // Prev/Next -- and hovering it used to change only its colour, which is the
  // weakest possible signal that a thing is a control. It now grows a real
  // boundary as well. `border-transparent` at rest, so the box is the same size
  // in every state (and the same size as `secondary`'s, which always had a
  // border -- ghost buttons were 2px shorter than their neighbours in the same
  // header row). Still `bg-transparent` at rest: a permanent border on every
  // button in a five-button pane header reads as noise, not as affordance.
  ghost:
    'bg-transparent text-cc-text-muted border border-transparent hover:text-cc-text hover:bg-cc-panel-raised hover:border-cc-border-interactive disabled:text-cc-text-faint',
  // A real destructive/danger variant -- Compass has `DestructiveButton`;
  // this app previously hand-patched a one-off danger look at a single
  // call site instead of having a variant (see the styling-pass report for
  // where that call site lives and should switch to this).
  danger:
    'bg-cc-danger text-cc-on-danger hover:bg-cc-danger-hover disabled:bg-cc-border disabled:text-cc-text-muted',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
