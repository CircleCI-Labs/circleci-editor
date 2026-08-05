/**
 * The banner shown after a context that may not work here is added to a job
 * (issue #251).
 *
 * ## Warn, do not block
 *
 * The owner considered refusing the drag and then argued themselves out of it:
 * *"I guess maybe we should warn, maybe not restrict — if we do drag it and we
 * know this project isn't going to be allowed, we should at least warn: hey, you
 * might want to go edit it, and provide a link or documentation."* That is what
 * this is. The edit has already happened by the time this renders, and nothing
 * here undoes it.
 *
 * Refusing would have been wrong for a reason worth writing down: this editor's
 * knowledge is genuinely partial. Group membership is not resolvable from the
 * host, an expression is a rule about a pipeline that does not exist yet, and the
 * restrictions call can simply fail. A gate built on that would block real work
 * on the strength of an "I don't know" — and the states where we *do* know are
 * exactly the states where a warning is already enough.
 *
 * ## Why this is not `EditErrorBanner`
 *
 * That banner is `role="alert"`, danger-toned, and means *your edit did not
 * happen*. Reusing it here would say the opposite of what is true. This one is
 * `role="status"`: the edit happened, and here is something about it.
 *
 * ## Two voices, on purpose
 *
 * `certain` decides the tone, the heading, and whether the copy is allowed to
 * predict a failure. "CircleCI will refuse this" is right for a project
 * restriction that does not include us — verified, since a restriction's value is
 * always a project UUID and no base62 id can accidentally match one — and it is a
 * lie for a group we cannot evaluate. A warning that reads identically in both
 * cases teaches people to dismiss it, which is the same failure #179 avoided with
 * the unsaved-changes prompt. So the uncertain states say plainly that they may
 * well be fine.
 */
import { Badge } from '~/design/components/Badge';
import { DocsLink } from '~/design/components/DocsLink';
import { RESTRICTION_PRESENTATION } from '~/lib/contexts/usability';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { useProjectContextStore } from '~/state/projectContextStore';

import { ContextRestrictionList } from './palette/ContextRestrictionList';

/** The heading each certainty gets. Never shared between a known and an unknown state. */
const HEADLINE = {
  refused: 'is restricted, and this project is not on the list',
  unevaluable: 'is restricted in a way this editor cannot check',
  'project-unknown': 'is restricted to specific projects',
  'check-failed': 'may be restricted — this editor could not check',
} as const;

export function ContextRestrictionNotice() {
  const notice = useProjectContextStore((state) => state.restrictionNotice);
  const dismiss = useProjectContextStore(
    (state) => state.dismissRestrictionNotice,
  );

  if (!notice) return null;
  // Total over `RestrictionCertainty` minus the two that never raise a notice
  // (`unrestricted`, `allowed`); the store filters those out before setting one.
  if (notice.certainty === 'unrestricted' || notice.certainty === 'allowed') {
    return null;
  }

  const presentation = RESTRICTION_PRESENTATION[notice.certainty];
  const certain = presentation.certain;

  return (
    <div
      role="status"
      data-testid="context-restriction-notice"
      className={`mb-3 rounded-md border px-3 py-2 text-xs ${
        certain
          ? 'border-cc-danger/40 bg-[color-mix(in_srgb,var(--color-cc-danger)_10%,transparent)]'
          : 'border-cc-warning/40 bg-[color-mix(in_srgb,var(--color-cc-warning)_10%,transparent)]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={certain ? 'text-cc-danger' : 'text-cc-warning'}>
          <span className="font-mono">{notice.contextName}</span>{' '}
          {HEADLINE[notice.certainty]}.
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone={presentation.tone}>{presentation.label}</Badge>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss context restriction notice"
            className="rounded px-1 text-cc-text-muted hover:bg-cc-border hover:text-cc-text"
          >
            &times;
          </button>
        </div>
      </div>

      {/* The edit is stated as done, first, so nobody reads a warning as a
          refusal and goes looking for the change that did not happen. */}
      <p className="mt-1 text-2xs text-cc-text-muted">
        It was added to the job anyway — this is a warning, not a refusal.{' '}
        {presentation.note}
      </p>

      {notice.restrictions.length > 0 ? (
        <div className="mt-1.5">
          <ContextRestrictionList restrictions={notice.restrictions} />
        </div>
      ) : null}

      {/* The two links the owner asked for: the page that can change this, and
          the concept. `webUrl` is absent when the host could not build one, and
          then no link is rendered rather than a dead one. */}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-cc-text-faint">
        {notice.webUrl ? (
          <a
            href={notice.webUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded text-cc-accent underline outline-none hover:text-cc-accent focus-visible:ring-1 focus-visible:ring-cc-accent"
          >
            Edit this context’s restrictions ↗
          </a>
        ) : null}
        <DocsLink
          label={DOCS_LINKS.workflows.contextRestrictions.label}
          url={DOCS_LINKS.workflows.contextRestrictions.url}
        >
          How context restrictions work
        </DocsLink>
      </p>
    </div>
  );
}
