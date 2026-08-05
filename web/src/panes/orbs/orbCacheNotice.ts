/**
 * What to say about the orb *cache* — as opposed to about a query or a filter —
 * when the list on screen is empty or is not current.
 *
 * ## Why this is a module and not four inline ternaries
 *
 * Issue #257: `internal/orbs.Cache` has always recorded why a refresh failed,
 * and the status payload had nowhere to carry it, so "there are no orbs" and
 * "we could not fetch the orbs" arrived at the browser identical and rendered
 * identically. Every other surface in this app refuses to do that — the context
 * four-state model (#105), the three-state project binding, the
 * reachability strip — and this one silently did.
 *
 * The copy lives here, apart from the JSX, for one reason: the constraint on it
 * is that **every sentence must be true of the state it is shown for**, and that
 * is a property worth asserting in a unit test rather than eyeballing in a
 * rendered pane. `OrbBrowser` renders what this returns; it does not decide
 * anything.
 *
 * ## The rule the wording follows
 *
 * Say what is known, name the gap where nothing is. In particular:
 *
 * - A `reason` is never paraphrased or embellished. The host produced it with
 *   `describeUpstreamError`, which discloses an HTTP status code and never the
 *   upstream response body, and it is the whole of what is known.
 * - An empty registry on a CircleCI Server installation is the *ordinary*
 *   state, not a fault (#256: a Server registry is private to the installation
 *   and seeded one orb at a time by an admin), so it must not be reported as
 *   though something went wrong.
 * - Server orb operations additionally need an admin token generated *after*
 *   the account became an admin. A token that predates the grant yields an
 *   empty registry rather than a 401 — indistinguishable, from here, from a
 *   registry that is genuinely empty. That is named as a possibility to check,
 *   never asserted as the cause, because nothing this host can see would
 *   establish it.
 * - When the host reports no state at all (an older host, or a fixture written
 *   before #257), the notice says the reason is unknown. An acknowledged gap
 *   beats an invented cause.
 */
import type { OrbSearchStatus } from '~/lib/rpc/client';

/**
 * A notice about the cache. `tone` picks the presentation: `'info'` for states
 * that are nobody's fault and may resolve on their own, `'warning'` for a list
 * that is being shown despite being known-not-current, `'error'` for a failure.
 */
export interface OrbCacheNotice {
  tone: 'info' | 'warning' | 'error';
  headline: string;
  /** One or more sentences. Rendered as separate paragraphs, in order. */
  details: string[];
}

/**
 * Renders a duration as the coarsest unit that still says something useful.
 * Deliberately approximate ("about 3 days ago"): the point is to convey how
 * out-of-date a listing is, and a precise-looking figure would imply a
 * precision the refresh window does not have.
 */
export function describeAge(
  fetchedAt: string,
  now: number = Date.now(),
): string {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return 'at an unknown time';

  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60)
    return `about ${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `about ${days} day${days === 1 ? '' : 's'} ago`;
}

/** The refresh window as a phrase, falling back to naming it as unreported rather than guessing a number. */
function describeWindow(hours: number | undefined): string {
  if (hours === undefined || hours <= 0) return 'this host’s refresh window';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The sentences an empty registry warrants, which differ by installation
 * because the same observation means different things on the two. Split out
 * because this is the case with the most to say and the least room to guess.
 */
function emptyRegistryDetails(status: OrbSearchStatus): string[] {
  if (status.selfHosted) {
    return [
      'This host is configured against a CircleCI Server installation, whose orb registry is private to that installation and is filled one orb at a time by an admin. An empty registry is its ordinary starting state, not a failure.',
      'One thing worth checking if you expected orbs here: orb operations on Server need an API token generated after your account became an admin. A token issued before that reports an empty registry rather than being rejected, so this host cannot tell that apart from a registry that really is empty.',
    ];
  }
  return [
    'The registry answered and reported no orbs. Nothing failed, so this is not a fetch error — but it is unexpected for circleci.com, and this host has no further information about why.',
  ];
}

/**
 * Classifies `status` into the notice to show, or `null` when the cache has
 * nothing to add — i.e. it holds a current listing, and any empty list on
 * screen is therefore about the query or the filter rather than about the
 * cache. Returning `null` is what keeps this from talking over #151's
 * filter-scope messages.
 *
 * `status` being absent is itself a state: the host reported nothing about the
 * cache, so the only true thing to say is that the reason is unknown.
 */
export function describeOrbCacheNotice(
  status: OrbSearchStatus | null,
  now: number = Date.now(),
): OrbCacheNotice | null {
  if (!status) {
    return {
      tone: 'info',
      headline: 'No orbs are cached.',
      details: [
        'This host did not report anything about its orb registry cache, so whether the registry is empty or could not be reached is not known from here.',
      ],
    };
  }

  const reason = status.reason?.trim() ? status.reason.trim() : null;
  // Capitalised for use as a standalone sentence: describeUpstreamError
  // produces a lower-case clause meant to be embedded ("the CircleCI API
  // rejected this token (HTTP 401)").
  const reasonSentence = reason
    ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`
    : null;

  switch (status.state) {
    case 'ready':
      return null;

    case 'fetching':
      return {
        tone: 'info',
        headline: 'The orb registry is still being fetched.',
        details: [
          'No orbs are searchable yet. This runs in the background when the editor starts — search again in a moment.',
          ...(reasonSentence
            ? [
                `An earlier attempt failed: ${reasonSentence} The fetch still running may yet succeed.`,
              ]
            : []),
        ],
      };

    case 'failed':
      return {
        tone: 'error',
        headline: 'The orb registry could not be fetched.',
        details: [
          reasonSentence ?? 'This host did not report a reason.',
          'Nothing was successfully listed, so this is not a report that there are no orbs — it is a report that we do not know what orbs there are.',
        ],
      };

    case 'empty':
      return {
        tone: 'info',
        headline: 'This orb registry has no orbs in it.',
        details: emptyRegistryDetails(status),
      };

    case 'stale': {
      const age = status.fetchedAt ? describeAge(status.fetchedAt, now) : null;
      const details: string[] = [];
      if (reasonSentence) {
        details.push(`The most recent refresh failed: ${reasonSentence}`);
      }
      details.push(
        age
          ? `These ${status.count} orb${status.count === 1 ? '' : 's'} were fetched ${age}, past the ${describeWindow(status.refreshWindowHours)} refresh window. They are a real registry listing, just not a current one — a newly published orb or version may be missing.`
          : `These ${status.count} orb${status.count === 1 ? '' : 's'} are a real registry listing, but this host could not confirm when they were fetched, so treat them as possibly out of date.`,
      );
      return {
        tone: 'warning',
        headline: 'Showing a cached orb list that is not current.',
        details,
      };
    }

    case 'never-fetched':
      return {
        tone: 'info',
        headline: 'The orb registry has not been fetched.',
        details: [
          'No orbs are cached and nothing is currently fetching them, so there is nothing to search yet. This host recorded no failure, so it is not known whether a fetch was attempted.',
        ],
      };

    default:
      // No state at all, or one this build does not recognise. Say only what
      // the counts establish, and name the rest as unknown.
      if (status.count > 0) return null;
      return {
        tone: 'info',
        headline: 'No orbs are cached.',
        details: [
          'This host did not report why, so whether the registry is empty or could not be reached is not known from here.',
        ],
      };
  }
}
