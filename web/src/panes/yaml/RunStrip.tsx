/**
 * "Run this config without committing it", and the honest report of whether
 * that is even possible (issue #194).
 *
 * ## Why a strip
 *
 * The three questions this editor can answer about a config form a ladder in
 * order of cost: does it compile (free), is it allowed (free), does it *work*
 * (costs money). `DiagnosticsStrip` answers the first; the second (config
 * policies) is answered by `PolicyBadge` in the badge row plus the Project
 * pane's Policies tab (issue #306 moved it out of the reference pane; see
 * `panes/docs/DocsPane.tsx`) rather than a strip (issue #247's later
 * redirection -- see `PolicyRulesView`); this is the third, in the same place
 * `DiagnosticsStrip` occupies, in the same shape. Putting it in the app bar
 * instead would have cost the app bar's own furniture budget a permanent
 * slot for a control most projects cannot even use.
 *
 * ## The six availability states, and the two that must never look alike
 *
 * `organization-disabled` and `project-disabled` are settled noes with a fix:
 * they name the setting and who can change it. `unknown` is *not* a no -- it is
 * "we could not find out", and it is worded so nobody reads it as the feature
 * being off. `no-token` and `no-project` are the two preconditions this editor
 * causes rather than CircleCI, so they are worded as things to do rather than
 * things to be refused. That is issue #194's degradation requirement, and
 * `RunStrip.test.tsx` pins each one.
 *
 * ## Why this is a header control, not a third strip -- measured twice
 *
 * Measured, not predicted -- applied the hard way. A first cut carried the full
 * explanation as a paragraph: 139px. A second cut cut it to a one-line summary
 * plus a `Why?` disclosure: still 127px, because at pane widths the badge and
 * two buttons wrap. Both broke the same two e2e guarantees -- "no
 * second scrolling region in the YAML pane" (#88's "there's 5 different scroll
 * bars there"), and the ability to click a `.cm-line` at all, because with
 * `DiagnosticsStrip` and (at the time) `PolicyStrip` already stacked there the
 * editor was squeezed to ~110px and the strips covered it. `PolicyStrip` is
 * gone now (#247 moved its detail into the reference pane instead), but the
 * measurement's conclusion about this control still holds.
 *
 * The measurement's answer is that this pane has no room for a third
 * always-present strip, so the affordance is split by *when it is needed*:
 *
 *  - `RunControl` -- a short badge, rendered in the pane's own header beside
 *    `Save` (issue #208's `headerExtra`), plus a button *only* when a run is
 *    actually offerable or blocked for a reason the badge itself doesn't
 *    carry (issue #290 -- see that function's own comment on why a second,
 *    permanently-inert "Run…" button next to a badge that already says
 *    "turned off" taught the owner nothing). The header is already a
 *    flex-wrap row with slack, so in the steady state this costs no new row
 *    at all. Every availability state still has its own badge label, and the
 *    host's full `reason` rides on a tooltip reachable by hover *or*
 *    keyboard focus -- never reworded, never truncated, and never silently
 *    unreachable the way a `title` on a `disabled` button is.
 *  - `RunStrip` -- prose, and only once the user has *acted* (a result, a
 *    refusal, an error) or hit the one refusal that needs explaining
 *    (`unroutable`). Its vertical cost is paid at exactly the moment it is
 *    wanted, and it is absent the rest of the time.
 *
 * The two states where the feature is not applicable (`no-token`,
 * `no-project`) render nothing anywhere, on `CircleciReachability`'s blessed
 * precedent: the app bar's token badge and `ProjectIdentity` already report
 * both, so repeating them permanently would cost every user space forever.
 *
 * ## What happens after a run, and what deliberately does not
 *
 * A pipeline number and a link. No spinner that watches it, no status that
 * refreshes, no job list. This app keeps observation UI out of the product
 * while letting the *assistant* consult run data, so the strip's job
 * ends at handing over the link -- and "ask the assistant why it failed" is
 * offered as a seeded prompt, on the rule that seeding the composer is not
 * sending it (issue #148).
 */
import { useEffect, useState } from 'react';

import { Badge, type BadgeTone } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Tooltip } from '~/design/components/Tooltip';
import type { RunAvailabilityStatus } from '~/lib/rpc/client';
import { isRunResultStale, useRunStore } from '~/state/runStore';

import { RunDialog } from './RunDialog';

/** The headline for each availability state: what to call it, and in which tone. */
export function runHeadline(
  status: RunAvailabilityStatus | null,
  availabilityState: string,
): { label: string; tone: BadgeTone } {
  if (availabilityState === 'checking')
    return { label: 'Run: checking…', tone: 'info' };
  if (
    availabilityState === 'error' ||
    status === null ||
    status === 'unknown'
  ) {
    // Neither success nor danger. The honest colour for "we don't know" is the
    // same one issue #105 gives an unevaluable context restriction.
    return { label: 'Run: unknown', tone: 'warning' };
  }
  switch (status) {
    case 'available':
      return { label: 'Can run uncommitted', tone: 'success' };
    case 'organization-disabled':
    case 'project-disabled':
      return { label: 'Run: turned off', tone: 'neutral' };
    case 'no-token':
    case 'no-project':
      return { label: 'Run: unavailable', tone: 'neutral' };
    case 'unroutable':
      // Warning, not neutral: this is a refusal that exists to stop a wrong
      // green, and the user should understand it as a real limitation rather
      // than as the feature being switched off.
      return { label: 'Run: unsafe here', tone: 'warning' };
  }
}

/**
 * The run affordance in its steady state: one badge, and a button only when
 * there's something for it to do or explain, no rows of its own. Lives in the
 * YAML pane's header beside `Save`.
 *
 * Every availability state has its own badge label, so the six-way distinction
 * survives the compaction. The host's full `reason` rides verbatim on a
 * tooltip -- the badge's own, or the button's, depending on which one owns the
 * explanation for the current state -- see the file's header comment and
 * issue #290 for why the prose is not inline and why it isn't always on the
 * button.
 */
export function RunControl({
  filename,
  blockedReason,
}: {
  /** The file name, for the confirmation's diff header. */
  filename: string;
  /** Set when a run cannot be attempted from this end at all -- a local YAML parse error. */
  blockedReason?: string;
}) {
  const availability = useRunStore((store) => store.availability);
  const availabilityState = useRunStore((store) => store.availabilityState);
  const availabilityError = useRunStore((store) => store.availabilityError);
  const checkAvailability = useRunStore((store) => store.checkAvailability);
  const state = useRunStore((store) => store.state);

  const [dialogOpen, setDialogOpen] = useState(false);

  // Reading two settings starts nothing and spends nothing, so unlike the
  // policy check this *is* safe to do on mount -- and it has to be, because the
  // control cannot word itself honestly without the answer.
  useEffect(() => {
    if (availabilityState === 'idle') void checkAvailability();
  }, [availabilityState, checkAvailability]);

  const status = availability?.status ?? null;

  // Renders nothing where the feature is not applicable. Same rule
  // CircleciReachability follows: the app bar's token badge and ProjectIdentity
  // already report both, so a permanent control repeating them would cost every
  // user space forever. Not a silent failure -- nothing is hidden that the rest
  // of the app is not already saying.
  if (status === 'no-token' || status === 'no-project') return null;

  const headline = runHeadline(status, availabilityState);
  const runnable =
    status === 'available' &&
    blockedReason === undefined &&
    state !== 'triggering';

  const detail =
    blockedReason ??
    (availabilityState === 'error'
      ? availabilityError
      : (availability?.reason ?? null));

  const badge = <Badge tone={headline.tone}>{headline.label}</Badge>;

  // Issue #290: `status === 'available'` is the one case the badge's own
  // words ("Can run uncommitted") don't already cover why there might be no
  // button -- a local YAML parse error or an in-flight request block the
  // button for a reason the badge never claims, so that explanation has to
  // live on the button itself. Every other non-runnable state (a settled
  // "off", `unknown`, `unroutable`, `checking`) is *fully* explained by the
  // badge's own tooltip below, and the previous design stacked a second,
  // permanently-inert "Run…" button next to it regardless -- which is what
  // the owner read as "Run turned off" and a broken button sitting side by
  // side, both starting with the same word. One honest control beats two
  // that disagree about whether anything is wrong.
  const showButton = status === 'available';

  return (
    <span className="flex items-center gap-1.5" data-testid="run-control">
      {/* The badge is the one element every non-runnable state relies on to
          say why -- so, like `ValidationBadge`/`PolicyBadge`, it carries the
          host's full prose on a tooltip reachable by hover *or* keyboard
          focus. A `title` on a `disabled` button cannot do this: a disabled
          native button receives neither pointer nor focus events in any
          browser, so hovering it (what the owner tried, twice) does
          nothing -- there was never a tooltip to see. */}
      {detail ? (
        <Tooltip content={detail}>
          <span tabIndex={0}>{badge}</span>
        </Tooltip>
      ) : (
        badge
      )}
      {availabilityState === 'error' ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void checkAvailability()}
          title="Ask the host again whether this config can be run without committing it"
        >
          Retry
        </Button>
      ) : null}
      {showButton ? (
        runnable ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialogOpen(true)}
            aria-label="Run this config on CircleCI without committing it"
          >
            Run uncommitted
          </Button>
        ) : (
          // Still disabled -- a local parse error, or a run already in
          // flight -- but for a reason the badge above doesn't carry, so
          // the same hover/focus-reachable wrapper the badge uses applies
          // here too rather than a bare `disabled` button's inert `title`.
          <Tooltip content={detail ?? 'This run cannot be started right now.'}>
            <span tabIndex={0}>
              <Button
                size="sm"
                variant="secondary"
                disabled
                aria-label="Run this config on CircleCI without committing it"
              >
                Run uncommitted
              </Button>
            </span>
          </Tooltip>
        )
      ) : null}
      <RunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        filename={filename}
      />
    </span>
  );
}

interface RunStripProps {
  /** The config text a run would use -- the editor's current text. */
  text: string;
  /**
   * Set when a run cannot be attempted from this end at all -- a local YAML
   * parse error. The button is disabled and says why, rather than spending a
   * request (and possibly a pipeline) to be told what the editor already knows.
   */
  blockedReason?: string;
  /**
   * Seeds the assistant's composer with a question about a failed run, per
   * issue #148: the prompt is written into the composer for review and
   * never sent. Optional -- without it, no such button is offered.
   */
  onAskAssistant?: (prompt: string) => void;
}

export function RunStrip({
  text,
  blockedReason,
  onAskAssistant,
}: RunStripProps) {
  const availability = useRunStore((store) => store.availability);
  const availabilityState = useRunStore((store) => store.availabilityState);
  const availabilityError = useRunStore((store) => store.availabilityError);
  const state = useRunStore((store) => store.state);
  const reason = useRunStore((store) => store.reason);
  const lastRun = useRunStore((store) => store.lastRun);

  const [showDetail, setShowDetail] = useState(false);

  const status = availability?.status ?? null;
  const stale = isRunResultStale({ lastRun }, text);

  // Whether the user has acted. After a run the prose is shown inline: its cost
  // is paid at exactly the moment it is wanted.
  const acted =
    state === 'triggering' ||
    state === 'triggered' ||
    state === 'refused' ||
    state === 'error';

  // The host's own words for a state the user cannot act on yet. Always
  // reachable, never reworded and never truncated -- just not occupying a line
  // until asked for.
  const detail =
    blockedReason ??
    (availabilityState === 'error'
      ? availabilityError
      : (reason ?? availability?.reason ?? null));

  // The gate that keeps this pane's editor usable: prose only once the user has
  // acted, or for the one refusal that has to explain itself. Everything else
  // is said by RunControl in the header, at no vertical cost.
  if (!acted && status !== 'unroutable' && blockedReason === undefined) {
    return null;
  }

  return (
    <div
      data-testid="run-strip"
      role="region"
      aria-label="Run this config on CircleCI"
      className="shrink-0 border-t border-cc-border bg-cc-bg px-3 py-2"
    >
      {/* One line in every steady state. See the "Why the steady state is one
          line" section above: this pane has a measured vertical budget and a
          paragraph here cost the editor its clickable area. */}
      <p
        className="mt-1 truncate text-2xs leading-relaxed text-cc-text-muted"
        data-testid="run-summary"
        title={detail ?? undefined}
      >
        {blockedReason !== undefined ? (
          blockedReason
        ) : availabilityState === 'checking' ? (
          'Reading this project’s and organization’s settings…'
        ) : availabilityState === 'error' ? (
          <span className="text-cc-warning" data-testid="run-unknown">
            Couldn&apos;t find out whether this can run — <strong>not</strong>{' '}
            the same as it being turned off.
          </span>
        ) : status === 'unknown' ? (
          <span className="text-cc-warning" data-testid="run-unknown">
            Couldn&apos;t find out whether this can run — <strong>not</strong>{' '}
            the same as it being turned off.
          </span>
        ) : status === 'unroutable' ? (
          <span className="text-cc-warning" data-testid="run-unroutable">
            Won&apos;t run this: a run here could report success while testing
            the committed config instead.
          </span>
        ) : status === 'organization-disabled' ? (
          <span data-testid="run-disabled">
            Your organization has not turned on running an uncommitted config.
          </span>
        ) : status === 'project-disabled' ? (
          <span data-testid="run-disabled">
            This project has opted out of running an uncommitted config.
          </span>
        ) : status === 'no-token' || status === 'no-project' ? (
          <span data-testid="run-unavailable">Can&apos;t run from here.</span>
        ) : state === 'triggering' ? (
          'Asking CircleCI to start a pipeline…'
        ) : state === 'error' ? (
          <span className="text-cc-danger" data-testid="run-error">
            The run request failed. This editor <strong>cannot tell</strong>{' '}
            whether a pipeline was created — check CircleCI before retrying.
          </span>
        ) : state === 'refused' ? (
          <span className="text-cc-warning" data-testid="run-refused">
            No pipeline was started.
          </span>
        ) : state === 'triggered' && lastRun ? (
          <span data-testid="run-triggered">
            {lastRun.configVerified === 'mismatch' ? (
              <span className="text-cc-danger">
                Pipeline{' '}
                {lastRun.pipelineNumber === null
                  ? 'started'
                  : `#${lastRun.pipelineNumber}`}{' '}
                is <strong>not</strong> running your config — CircleCI used the
                one committed to {lastRun.branch}.{' '}
              </span>
            ) : stale ? (
              <>
                Pipeline{' '}
                {lastRun.pipelineNumber === null
                  ? 'started'
                  : `#${lastRun.pipelineNumber}`}{' '}
                ran an <strong>earlier version</strong> of this file.{' '}
              </>
            ) : lastRun.configVerified === 'unverified' ? (
              <span className="text-cc-warning">
                Started pipeline{' '}
                {lastRun.pipelineNumber === null
                  ? ''
                  : `#${lastRun.pipelineNumber} `}
                on {lastRun.branch}; couldn&apos;t confirm it picked up your
                edits.{' '}
              </span>
            ) : (
              <>
                Started pipeline{' '}
                {lastRun.pipelineNumber === null
                  ? ''
                  : `#${lastRun.pipelineNumber} `}
                on {lastRun.branch}, running your config.{' '}
              </>
            )}
            {lastRun.webUrl ? (
              <a
                className="text-cc-accent underline"
                href={lastRun.webUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open it in CircleCI
              </a>
            ) : (
              // No name-addressed URL form exists for this project's VCS type,
              // or the response carried no pipeline number, so the
              // number is given as text rather than as a link that would 404.
              <span className="text-cc-text-faint">
                Find pipeline{' '}
                {lastRun.pipelineNumber ?? lastRun.pipelineId ?? ''} in the
                CircleCI web app
              </span>
            )}
            {' — not followed from here. '}
            {onAskAssistant && lastRun.pipelineNumber !== null ? (
              <button
                type="button"
                className="text-cc-accent underline"
                onClick={() =>
                  onAskAssistant(
                    `Pipeline #${lastRun.pipelineNumber} on ${lastRun.projectSlug ?? 'this project'} ` +
                      `(branch ${lastRun.branch ?? 'unknown'}) ran the config currently open in this editor. ` +
                      `Look at what it did and explain anything that failed, and whether the config caused it.`,
                  )
                }
              >
                Ask the assistant
              </button>
            ) : null}
          </span>
        ) : status === 'available' ? (
          'Runs this config on CircleCI without committing it — costs credits, visible to your team.'
        ) : (
          'This editor has not yet established whether this config can be run without committing it.'
        )}
      </p>

      {/* The host's full words, one click away: never reworded, never
          truncated, just not occupying a line until asked for. Same disclosure
          shape PolicyRulesView uses for its rule list. */}
      {detail && !acted ? (
        <>
          <button
            type="button"
            className="mt-1 text-2xs text-cc-accent underline"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((open) => !open)}
          >
            {showDetail ? 'Hide details' : 'Why?'}
          </button>
          {showDetail ? (
            <p
              className="mt-1 text-2xs leading-relaxed text-cc-text-muted"
              data-testid="run-detail"
            >
              {detail}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
