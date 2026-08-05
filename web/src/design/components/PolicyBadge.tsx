/**
 * The config-policy verdict, in the pane's badge row beside `Unsaved`/`Saved`
 * and `Valid` (issue #247, item 1).
 *
 * ## Where the detail went, and why it isn't here
 *
 * #215/#237 shipped this as `PolicyStrip`: a permanent strip of its own,
 * under the diagnostics strip, with its own headline, its own "Check
 * policies" button and its own paragraph of prose. The owner's steer moved
 * the headline to a badge:
 *
 * > *"I was thinking maybe having it as a badge, like where we have save and
 * > valid, and then maybe a policy pass badge where people can hover over and
 * > see what policies it's passing."*
 *
 * A follow-up steer then settled where the *rest* of `PolicyStrip` went --
 * the full rule, its `reason` message, and "Fix with AI" -- once the
 * reference pane was already growing a family of tabs (#248):
 *
 * > *"We mentioned policies over there because that will affect things. So I
 * > think having policies over there would be really helpful."*
 *
 * "Over there" was the reference pane at the time; issue #306 later split
 * Policies (with Project and Caches) out to a second surface sharing that
 * pane's slot, mutually exclusive with Reference -- see `panes/docs/
 * DocsPane.tsx`'s own doc comment. The detail this quote is about still
 * lives in `PolicyRulesView` (now the Project pane's Policies tab), not in a
 * strip, a modal or an expanding panel in the editor. This component is left
 * with exactly what a
 * badge is for -- status at a glance, hoverable for one summary sentence --
 * and `PolicyStrip` itself is gone. Evaluation is no longer a button either
 * (issue #247 again): it now rides `appStore.revalidate`'s own debounce, so
 * this badge is reporting a check that is already running in the
 * background, never one the reader has to go find a button for.
 *
 * ## The one rule this component exists to hold the line on
 *
 * *"This config passes policy"*, *"no policies are configured"* and *"we
 * could not evaluate policies"* must render as three visibly different
 * things -- a false all-clear on a security control is worse than no
 * control. A badge has less room than the strip it replaced, which is
 * exactly why every one of `PolicyStrip`'s old non-pass states survives
 * here rather than being trimmed for space: `describePolicyBadge`'s cases
 * below are the same states, and `PolicyBadge.test.tsx` pins every one of
 * them.
 */
import { useMemo } from 'react';

import {
  isPolicyDecisionStale,
  usePolicyStore,
  type PolicyCheckState,
  type PolicyDecision,
} from '~/state/policyStore';

import { Badge, type BadgeTone } from './Badge';
import { Tooltip } from './Tooltip';

interface PolicyBadgeView {
  label: string;
  tone: BadgeTone;
  tooltip: string;
}

/** A `PASS` against an empty bundle is a true statement about the request and a false one about the config's compliance -- see `policyStore.hasRules`'s own doc comment. Inlined rather than imported so this presentational module depends only on `policyStore`'s *types*. */
function hasEnabledRules(decision: PolicyDecision): boolean {
  return decision.enabledRules.length > 0;
}

/**
 * What the badge says for every state `usePolicyStore` can be in, plus the
 * one local fact this store cannot see for itself: whether the text on
 * screen has a local YAML parse error, which means the policy engine (which
 * parses the file itself) was never asked at all.
 *
 * Ordered so each `if` forecloses the ones after it -- a parse error
 * pre-empts everything else, `checking` pre-empts a stale read of the
 * previous decision, and so on -- which is what keeps this a single
 * unambiguous label rather than a race between several that could apply.
 */
export function describePolicyBadge(
  state: PolicyCheckState,
  decision: PolicyDecision | null,
  stale: boolean,
  reason: string | null,
  hasParseError: boolean,
): PolicyBadgeView {
  if (hasParseError) {
    return {
      label: 'Policy: unchecked',
      tone: 'neutral',
      tooltip:
        "This file doesn't parse as YAML, and CircleCI's policy engine parses the file itself -- so there is nothing yet to send it. Fix the syntax error and a check will run automatically a moment after you stop typing.",
    };
  }
  if (state === 'checking') {
    return {
      label: 'Checking policies…',
      tone: 'info',
      tooltip:
        'Asking CircleCI\'s config-policy engine about this config. This runs automatically in the background, alongside compile validation -- it is a separate request to CircleCI, stated in this editor\'s own guide under "What leaves your machine."',
    };
  }
  if (state === 'unavailable' || state === 'error') {
    return {
      label: 'Policy: not checked',
      tone: 'neutral',
      tooltip:
        `Couldn't check this config against your organization's policies${reason ? `: ${reason}` : '.'} ` +
        'That is not the same as finding no violations -- this config’s policy standing is unknown.',
    };
  }
  if (state !== 'decided' || !decision) {
    return {
      label: 'Policy: not checked',
      tone: 'neutral',
      tooltip:
        'This config has not been checked against your organization’s config policies yet. A check runs automatically in the background a moment after you stop typing -- there is nothing to press.',
    };
  }
  if (stale) {
    return {
      label: 'Policy check out of date',
      tone: 'neutral',
      tooltip:
        'This verdict was for an earlier version of this file. A fresh check runs automatically a moment after you stop typing -- until then, this config’s policy standing is unknown.',
    };
  }

  switch (decision.status) {
    case 'PASS':
      return hasEnabledRules(decision)
        ? {
            label: 'Policy pass',
            tone: 'success',
            tooltip: `CircleCI evaluated this config against ${decision.enabledRules.length} enabled rule${decision.enabledRules.length === 1 ? '' : 's'} and none of them failed.`,
          }
        : {
            label: 'No policies to check',
            tone: 'neutral',
            tooltip: `This organization has no enabled config-policy rules${decision.policyContext ? ` in the ${decision.policyContext} context` : ''}, so this config was checked against nothing. CircleCI answered PASS, but that says nothing about the config.`,
          };
    case 'SOFT_FAIL':
      return {
        label: 'Policy soft fail',
        tone: 'warning',
        tooltip: `${decision.softFailures.length} rule${decision.softFailures.length === 1 ? '' : 's'} flagged this config. Soft failures are recorded and shown but do not block a pipeline -- this is neither a pass nor a refusal. See the Policies tab in the Project pane for the full rule and message.`,
      };
    case 'HARD_FAIL':
      return {
        label: 'Policy hard fail',
        tone: 'danger',
        tooltip: `${decision.hardFailures.length} blocking rule${decision.hardFailures.length === 1 ? '' : 's'} failed${decision.softFailures.length > 0 ? `, plus ${decision.softFailures.length} non-blocking` : ''}. CircleCI would refuse to run a pipeline with this config. See the Policies tab in the Project pane for the full rule and message.`,
      };
    case 'ERROR':
      return {
        label: 'Policy engine error',
        tone: 'warning',
        tooltip: `The policy engine could not reach a decision${decision.decisionReason ? `: ${decision.decisionReason}` : '.'} This is not a pass -- nothing about this config's policy standing is known.`,
      };
  }
}

interface PolicyBadgeProps {
  /** The editor's current text -- compared against `checkedText` to derive staleness. */
  text: string;
  /** Set when the local YAML parse fails: the policy engine was never asked, and never will be until this clears. */
  hasParseError: boolean;
  className?: string;
}

/**
 * Self-contained, like `ThemeToggle`: it reads `usePolicyStore` directly
 * rather than taking the decision as a prop, so every caller renders the
 * same badge from the same one source of truth.
 */
export function PolicyBadge({
  text,
  hasParseError,
  className,
}: PolicyBadgeProps) {
  const state = usePolicyStore((store) => store.state);
  const reason = usePolicyStore((store) => store.reason);
  const decision = usePolicyStore((store) => store.decision);
  const checkedText = usePolicyStore((store) => store.checkedText);

  const stale = useMemo(
    () => isPolicyDecisionStale({ decision, checkedText }, text),
    [decision, checkedText, text],
  );

  const view = describePolicyBadge(
    state,
    decision,
    stale,
    reason,
    hasParseError,
  );

  return (
    <Tooltip content={view.tooltip}>
      <span tabIndex={0}>
        <Badge tone={view.tone} className={className}>
          {view.label}
        </Badge>
      </span>
    </Tooltip>
  );
}
