/**
 * "CircleCI could not be reached", derived from calls this app *actually made*
 * and watched fail -- issue #214's third item, and the one place this project
 * says something about the platform's health.
 *
 * ## Why this, and not a status feed
 *
 * The owner asked for the status checker their web UI has:
 *
 * > *"I think we have a status checker currently in our UI that lets you know if
 * > CircleCI is up or down. It might be nice to actually have that in the top
 * > bar as well. I know that's expanding scope just a little bit."*
 *
 * The value is real but narrow: it explains a validation or orb failure that is
 * not the user's fault. A poll of `status.circleci.com` would buy that at the
 * cost of a third-party network dependency in a tool that otherwise makes no
 * request it cannot justify, plus an indicator that is wrong whenever it
 * is stale, plus a question about what it should say before the first poll
 * lands.
 *
 * None of which is needed, because **we already know when our own calls fail**.
 * Surfacing that needs no poll, cannot go stale, and cannot be wrong about
 * something it did not observe. So:
 *
 * - **Nothing is rendered while nothing has failed.** Silence is not a claim
 *   that CircleCI is up; the bar simply says nothing about it, which is what it
 *   honestly knows. That also means this costs the app bar's measured furniture
 *   budget (#175) exactly zero at rest -- the tier ladder is unmoved in
 *   the healthy case, which is every case the responsive specs measure.
 * - **No polling, ever.** Not even after a failure. The authoritative answer
 *   lives at status.circleci.com, and this links there rather than scraping it.
 * - **Nothing blocks on it.** It is a passive read of two stores.
 *
 * ## What counts as an observed failure
 *
 * Both signals are already *classified* upstream, so nothing here matches on
 * prose:
 *
 * - `projectLookup(...).status === 'unreachable'` -- the project-context store's
 *   own verdict, which separates "CircleCI answered 404" (`absent`) from "we
 *   could not get an answer" by status code, not by wording. See
 *   `state/projectContextStore`.
 * - `validation.state === 'error'` -- a `POST /api/validate` that failed at the
 *   transport layer or came back non-2xx. Distinct from `invalid` (CircleCI
 *   answered, and said no) and from `unavailable` (this host declined to ask).
 *
 * Gated on `meta.hasToken`, which is the structural discriminator that keeps
 * this from firing on a host that never asked at all: without a token the
 * project lookup reports `unavailable` -> `unreachable` for a reason that has
 * nothing to do with CircleCI's health, and the "No token" badge beside this one
 * already says so.
 *
 * ## What this deliberately excludes: a rejected token (issue #224)
 *
 * `validation.state === 'unauthorized'` is *not* one of the two signals
 * above, on purpose. It used to be indistinguishable from this component's
 * point of view -- the host turned `IsUnauthorized` into an HTTP 502, which
 * the frontend could only see as `validation.state === 'error'`, so a
 * rejected token rendered as "CircleCI unreachable" even though CircleCI had
 * answered, clearly, "no". `POST /api/validate` now reports that case at
 * HTTP 200 with `available: false, source: "unauthorized"` (mirroring how
 * `/api/project-context`'s warnings already separate "CircleCI answered 404"
 * from "we could not get an answer"), `ValidationState` carries `unauthorized`
 * as its own value, and `ValidationBadge` says "Token rejected". None of
 * that reaches `observedCircleciFailures` above: a rejected token is a
 * credential problem the user can fix, not evidence that CircleCI itself is
 * unwell, so this component has nothing to say about it and the "Token
 * rejected" badge is the whole of the user-facing story.
 *
 * The third case worth naming explicitly, because it is easy to conflate
 * with either of the above: a project CircleCI cannot find (most
 * often a renamed repository whose git remote still resolves). That is not
 * a validation failure at all -- `POST /api/validate` never names a project,
 * only `GET /api/project-context` does -- and it already renders as its own
 * `absent` status in `projectContextStore`, distinct from `unreachable`
 * (this component's second signal) by HTTP status code rather than by
 * guesswork. This component does not need to, and must not, re-derive that
 * distinction.
 */
import { Badge } from '~/design/components/Badge';
import { Tooltip } from '~/design/components/Tooltip';
import { useAppStore } from '~/state/appStore';
import {
  projectLookup,
  useProjectContextStore,
} from '~/state/projectContextStore';

/** CircleCI's own status page -- linked, never fetched. */
export const CIRCLECI_STATUS_URL = 'https://status.circleci.com';

/** One CircleCI call this app made and watched fail. */
export interface ObservedFailure {
  /** What was being attempted, in the user's terms. */
  what: string;
  /** The reason the host or the transport gave, verbatim where there is one. */
  reason: string;
}

/**
 * The observed failures, in the order they matter to someone whose config will
 * not validate. Pure, so it is unit-testable without a store.
 */
export function observedCircleciFailures({
  hasToken,
  validationState,
  validationReason,
  lookupStatus,
  lookupReason,
}: {
  hasToken: boolean;
  validationState: string;
  validationReason?: string;
  lookupStatus: string;
  lookupReason: string | null;
}): ObservedFailure[] {
  if (!hasToken) return [];

  const failures: ObservedFailure[] = [];
  if (validationState === 'error') {
    failures.push({
      what: 'Validating this config',
      reason: validationReason ?? 'the request failed.',
    });
  }
  if (lookupStatus === 'unreachable') {
    failures.push({
      what: 'Looking up this project',
      reason: lookupReason ?? 'the request failed.',
    });
  }
  return failures;
}

export function CircleciReachability() {
  const meta = useAppStore((state) => state.meta);
  const validation = useAppStore((state) => state.validation);
  const project = useProjectContextStore((state) => state.project);
  const state = useProjectContextStore((state) => state.state);
  const warnings = useProjectContextStore((state) => state.warnings);
  const reason = useProjectContextStore((state) => state.reason);

  // Deliberately no `load()` here: this reports on calls other components
  // already make (`ProjectIdentity` and the palette share one project-context
  // load), and a status indicator that provoked a request in order to have
  // something to say would be the polling dependency this exists to avoid.
  const lookup = projectLookup({ state, warnings, project, reason });
  const failures = observedCircleciFailures({
    hasToken: meta?.hasToken ?? false,
    validationState: validation.state,
    validationReason: validation.reason,
    lookupStatus: lookup.status,
    lookupReason: lookup.warning?.detail ?? lookup.reason,
  });

  if (failures.length === 0) return null;

  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1.5">
          <span>
            CircleCI could not be reached for{' '}
            {failures.length === 1 ? 'one request' : 'these requests'} this
            editor made. Whatever is failing is very likely not your config.
          </span>
          {failures.map((failure) => (
            <span key={failure.what} className="text-cc-text-muted">
              {failure.what}: {failure.reason}
            </span>
          ))}
          <span>
            This is what this editor observed, not a live status feed — it
            reports its own failed calls and never polls. For the authoritative
            answer, open {CIRCLECI_STATUS_URL}.
          </span>
        </span>
      }
    >
      <a
        href={CIRCLECI_STATUS_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-cc-accent"
        data-testid="circleci-reachability"
        aria-label={`CircleCI unreachable: ${failures.length} request${failures.length === 1 ? '' : 's'} failed. Opens CircleCI's status page.`}
      >
        <Badge tone="warning">CircleCI unreachable</Badge>
      </a>
    </Tooltip>
  );
}
