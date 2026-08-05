import type { ValidationState } from '~/state/appStore';

import { Badge, type BadgeTone } from './Badge';
import { Tooltip } from './Tooltip';

interface ValidationView {
  label: string;
  tone: BadgeTone;
  tooltip?: string;
}

const DEFAULT_UNAVAILABLE_TOOLTIP =
  'Validating against the CircleCI API requires a CIRCLE_TOKEN on this host.';

const DEFAULT_UNAUTHORIZED_TOOLTIP =
  'The CircleCI API rejected the configured token. Replace it to resume validating.';

/**
 * Shown instead of a hard red "Invalid" when `softenInvalid` is set --
 * issue #106's asymmetric-validation requirement. A file that isn't the
 * one this host resolved as its primary config (in practice, almost always
 * a continuation config a setup workflow hands off to) can legitimately
 * fail to compile *in isolation* for reasons that have nothing to do with
 * anything actually wrong in it -- a missing `version`, an unresolved
 * pipeline parameter the setup job would have supplied. CircleCI itself
 * only ever compiles a file like that in the context the continuation step
 * provides; this host compiled it completely out of that context, so a red
 * "Invalid" here would assert something this host cannot actually confirm.
 */
const SOFTENED_INVALID_TOOLTIP =
  "This file isn't the one this host resolved as the primary config, so it was compiled on its own -- outside whatever pipeline parameters or setup-workflow context it may depend on. A failure here doesn't necessarily mean the file itself is broken.";

/**
 * Maps the validation state machine to what a badge should say. Kept
 * separate from the component so the app bar and the YAML pane header can
 * both render the identical status without duplicating this logic.
 */
function describeValidation(
  state: ValidationState,
  reason?: string,
  softenInvalid?: boolean,
): ValidationView | null {
  switch (state) {
    case 'idle':
      return null;
    case 'checking':
      return { label: 'Checking…', tone: 'info' };
    case 'valid':
      return { label: 'Valid', tone: 'success' };
    case 'invalid':
      return softenInvalid
        ? {
            label: 'Not independently valid',
            tone: 'neutral',
            tooltip: SOFTENED_INVALID_TOOLTIP,
          }
        : { label: 'Invalid', tone: 'danger' };
    case 'unavailable':
      return {
        label: 'Validation unavailable',
        tone: 'neutral',
        tooltip: reason ?? DEFAULT_UNAVAILABLE_TOOLTIP,
      };
    case 'unauthorized':
      // Issue #224: a rejected token is a credential problem the user can
      // fix, and a different one from either "no token" (unavailable,
      // neutral tone -- nothing is broken) or "CircleCI unreachable"
      // (error, below -- not the user's fault at all). Danger-toned because
      // it names something actionable on the user's side, same as `invalid`,
      // but its own label so it is never mistaken for the config itself
      // being wrong.
      return {
        label: 'Token rejected',
        tone: 'danger',
        tooltip: reason ?? DEFAULT_UNAUTHORIZED_TOOLTIP,
      };
    case 'error':
      return {
        label: 'Validation error',
        tone: 'danger',
        tooltip: reason ?? 'The validation request failed.',
      };
    case 'not-a-config':
      // Issue #145: distinct from the softened `invalid` branch above on
      // purpose. That branch is for a file this editor knows *is* a
      // CircleCI config but compiled it out of context (a continuation
      // config); this one is for a file the host's own classifier says
      // isn't a CircleCI config at all (a goss/Compose/tooling YAML file
      // that happens to live in `.circleci/`). Neither "Invalid" nor "Not
      // independently valid" is honest for that -- both assert this is a
      // config, just a broken or unconfirmed one -- so this gets its own
      // neutral label and never calls the CircleCI API to begin with.
      return {
        label: 'Not a CircleCI config',
        tone: 'neutral',
        tooltip: reason ?? 'This file is not a CircleCI config.',
      };
  }
}

interface ValidationBadgeProps {
  state: ValidationState;
  reason?: string;
  className?: string;
  /** See `describeValidation`'s softened-invalid branch. Pass `true` for any file other than the host's primary resolved config (issue #106). */
  softenInvalid?: boolean;
}

/**
 * A compact status pill for M4's validation result. Deliberately renders
 * nothing for `idle` (no result to show yet, or a local YAML parse error is
 * already surfacing its own "Invalid YAML" badge) so this never competes
 * with that message.
 */
export function ValidationBadge({
  state,
  reason,
  className,
  softenInvalid,
}: ValidationBadgeProps) {
  const view = describeValidation(state, reason, softenInvalid);
  if (!view) return null;

  const badge = (
    <Badge tone={view.tone} className={className}>
      {view.label}
    </Badge>
  );
  if (!view.tooltip) return badge;

  return (
    <Tooltip content={view.tooltip}>
      <span tabIndex={0}>{badge}</span>
    </Tooltip>
  );
}
