/**
 * The orb browser: search CircleCI's orb registry, pick a version, and
 * either drag one of its jobs/commands/executors onto the DAG (see
 * `useOrbInsertion`) or use this panel's own "Add" affordance, which
 * performs the exact same insertion without needing a mouse -- see each
 * element row below.
 *
 * Search results are rendered in the exact order the host API returns them
 * in (`useOrbStore.search` / `results`). The host ranks certified orbs
 * first and orders the rest by match quality server-side; re-sorting here
 * (e.g. alphabetically) would silently undo that ranking, so this
 * component must never call `.sort()` on `results`. The one exception is
 * `groupByNamespace`, used only for the empty-query default browse list --
 * see its own doc comment for why grouping that particular list can never
 * reorder it.
 *
 * Issue #50 (logos, descriptions, badges, structure): the v3 orb registry
 * API has no logo/icon field at all (confirmed empirically -- see the PR
 * description and `~/lib/orbs/avatar`'s doc comment), so `OrbAvatar` is a
 * generated monogram, never a fetched image. It also has no per-orb
 * description in its bulk listing, only in each version's full YAML
 * source, so a row's description (see `ResultRow`) is filled in lazily via
 * `useOrbStore.prefetchDescription` once that source has been fetched, not
 * available up front the way `name`/`certified`/`private` are.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
// Issue #183: these two `<details>` summaries carried the same "uppercase meta
// label" type as the app's inert group headings; they take the shared
// disclosure treatment for the same reason the palette's do.
import { disclosureSummaryClassName } from '~/design/controlAffordance';
import { DOCS_LINKS, orbDocsUrl } from '~/lib/docs/docsLinks';
import { setOrbDragPayload } from '~/lib/orbs/dragPayload';
import { renderOrbDescription } from '~/lib/orbs/orbDescription';
import type { OrbElement, OrbParameter } from '~/lib/orbs/types';
import type { OrbSearchFilter, OrbSearchResult } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import { useOrbStore } from '~/state/orbStore';

import { OrbAvatar } from './OrbAvatar';
import { describeOrbCacheNotice, type OrbCacheNotice } from './orbCacheNotice';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

// Bounds how many of the currently rendered results get their description
// eagerly prefetched (see `useDescriptionPrefetch`). Search returns up to 50
// results (`DEFAULT_SEARCH_LIMIT` in `orbStore.ts`); prefetching all of them
// on every keystroke would multiply outbound `/api/orbs/source` requests
// far past what the user can even see without scrolling. This is roughly
// the panel's own visible row count -- more than that and the marginal
// value of "loaded before you scroll to it" drops off fast.
const DESCRIPTION_PREFETCH_LIMIT = 12;

/** Splits "<namespace>/<name>" for display; falls back to the whole string
 * as the name (no namespace) if there's no "/" -- defensive, since every
 * real orb reference has one, but this must never throw on a malformed
 * name. */
function splitOrbRef(fullName: string): { namespace: string; name: string } {
  const slash = fullName.indexOf('/');
  if (slash < 0) return { namespace: '', name: fullName };
  return {
    namespace: fullName.slice(0, slash),
    name: fullName.slice(slash + 1),
  };
}

/**
 * Groups results by namespace *without reordering them* -- it only merges
 * already-adjacent same-namespace runs into one bucket. Used solely for the
 * empty-query default browse list, whose results the host already returns
 * alphabetically by "<namespace>/<name>" (see `orbs.defaultResults`), which
 * means same-namespace entries are already contiguous: string comparison
 * compares the namespace segment first, so grouping adjacent runs here can
 * never move anything out of the order the host chose. This must never be
 * applied to query-driven results, which are ranked by match quality, not
 * alphabetically -- grouping those would visually misrepresent that
 * ranking even though the underlying array itself is never sorted.
 */
function groupByNamespace(
  results: OrbSearchResult[],
): { namespace: string; items: OrbSearchResult[] }[] {
  const groups: { namespace: string; items: OrbSearchResult[] }[] = [];
  for (const result of results) {
    const { namespace } = splitOrbRef(result.name);
    const last = groups[groups.length - 1];
    if (last && last.namespace === namespace) {
      last.items.push(result);
    } else {
      groups.push({ namespace, items: [result] });
    }
  }
  return groups;
}

export interface OrbBrowserProps {
  /** Names of jobs actually defined under `jobs:` -- the only valid targets for a command/executor "Add". */
  localJobNames: string[];
  /** The workflow an "Add" on an orb job lands in; `undefined` disables that action. */
  activeWorkflowName: string | undefined;
  onAddJob: (orbRef: string, element: OrbElement) => void;
  onAddCommand: (orbRef: string, element: OrbElement, jobName: string) => void;
  onAddExecutor: (orbRef: string, element: OrbElement, jobName: string) => void;
  /**
   * Issue #71: the palette's Executors section explicitly includes
   * orb-provided executors as a way to *create* a job (not just assign to
   * one that already exists, which `onAddExecutor` above already covers).
   * Opens `ConfigureJobDialog` the same way a built-in/local executor card
   * does. Optional so a caller that doesn't fold this browser into the
   * palette (there is none today, but nothing here should require it)
   * doesn't need a stub.
   */
  onCreateJobFromExecutor?: (orbRef: string, element: OrbElement) => void;
}

// Only Certified, Private, and Unlisted are rendered here, not a "Partner"
// badge: the v3 orb/packages API (bulk list, and the single-orb
// filter[name] lookup) has no partner/tier field of any kind, only
// is_private/is_listed plus certified (learned separately, see
// orbs.Cache.warmCertified) -- so there is nothing to badge a "partner" orb
// with short of inventing a hardcoded namespace list, which would drift out
// of date and misrepresent orbs this app has never actually verified.
function ResultBadges({ result }: { result: OrbSearchResult }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {result.certified ? <Badge tone="success">Certified</Badge> : null}
      {result.private ? <Badge tone="warning">Private</Badge> : null}
      {!result.listed ? (
        <span title="Resolved by exact name -- not shown when browsing the public registry">
          <Badge tone="neutral">Unlisted</Badge>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The registry-style filters (issue #151), and what each one is actually
 * backed by.
 *
 * There is no "Partner" filter, and that is a finding rather than an omission.
 * The orb registry's own control is a single dropdown with three options --
 * All, "Certified & Partner" (one combined entry), Popular -- and it is not
 * served by the CircleCI API at all: the developer hub queries an Algolia
 * index whose documents carry `is_certified`/`is_partner`, with the combined
 * option compiling to the literal Algolia filter `is_certified:true OR
 * is_partner:true`. Nothing about partner status reaches any API this host can
 * call; `internal/orbs.Filter` records exactly what was probed to establish
 * that, including that every partner-shaped filter parameter the v3 registry
 * accepts is silently *ignored* rather than rejected. The only ways left to
 * offer the filter would be a hardcoded namespace list or scraping the dev
 * hub's index, and either would label orbs this app has never verified -- the
 * same reason `ResultBadges` above renders no Partner badge.
 *
 * "Community"/"Public" is likewise absent, for the narrower reason that this
 * app cannot tell a community orb from a partner one: the honest complement of
 * Certified here is "everything else", which is what All already shows.
 */
const ORB_FILTERS: {
  value: OrbSearchFilter;
  label: string;
  /** Names the scope inside a sentence, e.g. "3 certified orbs". */
  noun: string;
  /** The control's own explanation of what backs it -- shown on hover/focus. */
  title: string;
}[] = [
  {
    value: 'all',
    label: 'All',
    noun: 'orb',
    title: 'Every orb this host has crawled, public and private',
  },
  {
    value: 'certified',
    label: 'Certified',
    noun: 'certified orb',
    title:
      "Orbs CircleCI certifies -- the registry's filter[certified], the one certification signal the v3 API exposes",
  },
  {
    value: 'private',
    label: 'Private',
    noun: 'private orb',
    title:
      "Orbs private to your organization's namespaces, as reported by each orb's own is_private -- only ones this host's API token can see, and none at all with no token configured",
  },
];

function filterNoun(filter: OrbSearchFilter): string {
  return ORB_FILTERS.find((f) => f.value === filter)?.noun ?? 'orb';
}

/**
 * The filter control: one compact row of native radios styled as chips.
 *
 * Native `<input type="radio">` rather than a hand-rolled toggle group, for
 * the keyboard behaviour that comes with it for free -- Tab reaches the group,
 * arrow keys move between options and select as they go, which is exactly what
 * a segmented filter should do and is fiddly to reimplement correctly. The
 * inputs are visually hidden (`sr-only`) with the chip rendered as their
 * `peer`, so focus and checked state both style the visible chip while the
 * accessible control stays a real radio group.
 *
 * A single-select group, not three independent toggles: every option maps 1:1
 * onto one scope the host can actually answer (see `ORB_FILTERS`), and a
 * single choice is also what the registry itself offers. It costs one ~18px
 * row and no scroll region of its own -- the results region below keeps its
 * `flex-1` height and, per #88, remains the palette column's content
 * rather than a nested scroller.
 */
function OrbFilterBar() {
  const filter = useOrbStore((state) => state.filter);
  const setFilter = useOrbStore((state) => state.setFilter);
  const groupName = useId();

  return (
    // `role="radiogroup"` on a plain div rather than a `<fieldset>`/`<legend>`:
    // a fieldset carries the implicit `group` role, which this pane already
    // uses to mean "a namespace/element section" (see `groupByNamespace` and
    // `ElementSection`, and the test asserting a queried result list has no
    // groups). The radios themselves are what provide arrow-key navigation,
    // and they do that by sharing a `name`, not by their container's element
    // type -- so nothing is lost.
    <div
      role="radiogroup"
      aria-label="Filter orbs by type"
      className="mb-2 flex shrink-0 flex-wrap items-center gap-1"
    >
      {ORB_FILTERS.map((option) => (
        <label
          key={option.value}
          title={option.title}
          className="cursor-pointer"
        >
          <input
            type="radio"
            name={groupName}
            value={option.value}
            checked={filter === option.value}
            onChange={() => setFilter(option.value)}
            className="peer sr-only"
          />
          <span
            className={`block rounded-full border px-2 py-0.5 text-2xs peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-cc-accent ${
              filter === option.value
                ? 'border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)] text-cc-text'
                : 'border-cc-border-interactive text-cc-text-muted hover:border-cc-accent hover:text-cc-text'
            }`}
          >
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * The one line under the filters: how much the active filter is showing, how
 * much it is hiding, and whether the registry crawl is still running.
 *
 * The hidden-count half is issue #151's "the result count should make it
 * obvious when a filter is why something isn't showing up". A filter that
 * quietly shortens a list is indistinguishable, from the user's side, from an
 * orb that does not exist -- so the count says so and offers the way out in
 * the same breath. It occupies the slot the warm-up notice already used, so a
 * filtered search costs no height an unfiltered one didn't.
 */
function SearchStatusLine() {
  const status = useOrbStore((state) => state.status);
  const match = useOrbStore((state) => state.match);
  const setFilter = useOrbStore((state) => state.setFilter);

  const filtering = match !== null && match.filter !== 'all';
  const hidden = match
    ? Math.max(0, match.matchedUnfiltered - match.matched)
    : 0;
  const warming = Boolean(status?.warming);

  if (!filtering && !warming) return null;

  return (
    <p className="mb-2 text-2xs text-cc-text-faint">
      {filtering && match ? (
        <>
          <span className="text-cc-text-muted">
            {match.matched} {filterNoun(match.filter)}
            {match.matched === 1 ? '' : 's'}
          </span>
          {hidden > 0 ? (
            <>
              {' · '}
              {hidden} hidden by this filter{' '}
              <button
                type="button"
                onClick={() => setFilter('all')}
                className="underline decoration-dotted hover:text-cc-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cc-accent"
              >
                Show all
              </button>
            </>
          ) : null}
          {warming ? ' · ' : null}
        </>
      ) : null}
      {warming ? (
        <>
          Searching {status?.count ?? 0} orb{status?.count === 1 ? '' : 's'} so
          far -- the registry is still loading in the background, so results may
          improve if you search again shortly.
        </>
      ) : null}
    </p>
  );
}

/**
 * One cache-level notice (see `describeOrbCacheNotice`), rendered as a block so
 * its several sentences read as prose rather than as one run-on line.
 *
 * No `overflow-*` of its own, per #88: this pane's results list is
 * already the scroll region, and a notice that scrolled independently of it
 * would be a second one.
 */
function OrbCacheNoticeBox({ notice }: { notice: OrbCacheNotice }) {
  const toneClassName =
    notice.tone === 'error'
      ? 'border-cc-danger/40'
      : notice.tone === 'warning'
        ? 'border-cc-warning/50'
        : 'border-cc-border-strong';
  return (
    <div
      role="status"
      data-testid="orb-cache-notice"
      className={`mb-2 rounded-md border bg-cc-panel-raised p-3 text-xs text-cc-text-muted ${toneClassName}`}
    >
      <p className="font-medium text-cc-text">{notice.headline}</p>
      {notice.details.map((detail) => (
        <p key={detail} className="mt-1">
          {detail}
        </p>
      ))}
    </div>
  );
}

/**
 * The cache notice for the case where there *are* results: a listing this host
 * knows is not current is still worth showing, but must be labelled as such
 * rather than presented as the registry's present state (issue #257).
 *
 * Returns nothing when the cache holds a current listing, and nothing when the
 * list is empty -- an empty list's explanation belongs in `NoResultsMessage`,
 * where it replaces the query-level copy instead of sitting above it.
 */
function OrbCacheBanner() {
  const status = useOrbStore((state) => state.status);
  const notice = describeOrbCacheNotice(status);
  if (!notice || (status?.count ?? 0) === 0) return null;
  return <OrbCacheNoticeBox notice={notice} />;
}

/**
 * What to say when a search returned nothing -- which, with filters in play,
 * has three materially different causes that must not be collapsed into one
 * "no orbs matched".
 *
 * The private-orb case is the one that would otherwise lie. An empty private
 * list means "nothing private turned up in what this host's API token was
 * shown while crawling the registry" -- it is *not* the claim "your
 * organizations have no private orbs", and presenting it as the latter would
 * be a wrong answer to a question the user actually asked. So a zero-size
 * private scope says which of the two it is (and, while the crawl is still
 * running, that it is not even settled yet).
 *
 * Issue #160: orb search itself no longer needs a token (the public registry
 * answers unauthenticated), so a no-token host reaches this component just
 * like any other -- it is not diverted to a separate `unavailable` branch
 * the way it used to be. What a missing token still changes is specifically
 * this filter: with none configured, this host cannot see *any* private
 * namespace, which is a stronger and more certain statement than "your token
 * didn't turn any up", and the wording below says which of the two applies.
 */
function NoResultsMessage() {
  const query = useOrbStore((state) => state.query);
  const status = useOrbStore((state) => state.status);
  const match = useOrbStore((state) => state.match);
  const setFilter = useOrbStore((state) => state.setFilter);
  const hasToken = useAppStore((state) => state.meta?.hasToken ?? false);

  const filter = match?.filter ?? 'all';
  const hidden = match
    ? Math.max(0, match.matchedUnfiltered - match.matched)
    : 0;

  // The cache-level explanation outranks every query- and filter-level one
  // below, and does not merely precede it (issue #257). With nothing cached,
  // "no private orbs were found for this host's token" and "no orbs matched
  // your query" are not just less useful — they are *false*, since no search
  // was performed against any registry listing at all. So this branch replaces
  // them rather than sitting above them.
  const cacheNotice = describeOrbCacheNotice(status);
  if (cacheNotice && (status?.count ?? 0) === 0) {
    return <OrbCacheNoticeBox notice={cacheNotice} />;
  }

  const showAll =
    hidden > 0 ? (
      <>
        {' '}
        {hidden} orb{hidden === 1 ? '' : 's'} outside this filter match --{' '}
        <button
          type="button"
          onClick={() => setFilter('all')}
          className="underline decoration-dotted hover:text-cc-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cc-accent"
        >
          show all orbs
        </button>
        .
      </>
    ) : null;

  // Nothing is in the filter's scope at all, which is a statement about the
  // crawl rather than about this query.
  if (filter !== 'all' && match?.scopeSize === 0) {
    return (
      <div className="rounded-md border border-cc-border-strong bg-cc-panel-raised p-3 text-xs text-cc-text-muted">
        {filter === 'private' ? (
          <>
            <p className="mb-1 font-medium text-cc-text">
              {hasToken
                ? "No private orbs found for this host's API token."
                : 'No private orbs can be shown: this host has no CircleCI API token.'}
            </p>
            <p>
              {!hasToken
                ? 'Private orbs appear here only when this host has a CircleCI API token that can see the organization namespace that owns them. With none configured, this is not a report that your organizations have no private orbs -- it is a report that this host cannot look.'
                : status?.warming
                  ? 'The registry is still being crawled, so this is not settled yet -- try again shortly.'
                  : 'Private orbs appear here only when the CircleCI API token this host is using can see the organization namespace that owns them. This is not the same as your organizations having none.'}
            </p>
          </>
        ) : (
          <>
            <p className="mb-1 font-medium text-cc-text">
              No certified orbs are cached yet.
            </p>
            <p>
              {status?.warming
                ? 'The registry is still being crawled -- try again shortly.'
                : 'The certified-orb list could not be fetched, so this filter has nothing to show. Searching all orbs still works.'}
            </p>
          </>
        )}
        {showAll ? <p className="mt-1">{showAll}</p> : null}
      </div>
    );
  }

  if (filter !== 'all') {
    return (
      <p className="text-xs text-cc-text-muted">
        {query
          ? `No ${filterNoun(filter)} matched “${query}”.`
          : `No ${filterNoun(filter)} to show.`}
        {showAll}
      </p>
    );
  }

  return (
    <p className="text-xs text-cc-text-muted">
      No orbs matched &quot;{query}&quot;.
    </p>
  );
}

/**
 * Prefetches (see `useOrbStore.prefetchDescription`) the description for up
 * to `DESCRIPTION_PREFETCH_LIMIT` of `results`, so most rows the user can
 * actually see without scrolling gain a description line rather than only
 * showing one after the orb is selected. Re-runs whenever `results`
 * changes; `prefetchDescription` itself is a no-op for anything
 * already cached/queued, so calling it every render is safe and never
 * duplicates a request.
 */
function useDescriptionPrefetch(results: OrbSearchResult[]): void {
  const prefetchDescription = useOrbStore((state) => state.prefetchDescription);
  useEffect(() => {
    for (const result of results.slice(0, DESCRIPTION_PREFETCH_LIMIT)) {
      if (!result.latestVersion) continue; // A reserved name with nothing published; no source to fetch.
      prefetchDescription(result.name, result.latestVersion);
    }
  }, [results, prefetchDescription]);
}

/** One result row: avatar, namespace/name (namespace dimmed so the part
 * that varies row-to-row within one namespace's cluster reads first),
 * badges, version, and -- once `prefetchDescription` resolves it -- a
 * truncated description line. */
function ResultRow({
  result,
  isSelected,
  onSelect,
}: {
  result: OrbSearchResult;
  isSelected: boolean;
  onSelect: (result: OrbSearchResult) => void;
}) {
  const { namespace, name } = splitOrbRef(result.name);
  // Mirrors the cache key `prefetchDescription`/`loadOrb` store this under
  // (see orbStore.ts): the version *as requested* -- here always
  // `latestVersion`, since that's what this row asked for -- not
  // whatever the host resolved "latest" to.
  const cacheKey = `${result.name}@${result.latestVersion || 'latest'}`;
  const description = useOrbStore(
    (state) => state.parsedOrbs[cacheKey]?.description,
  );

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(result)}
        aria-pressed={isSelected}
        className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs text-cc-text ${
          isSelected
            ? 'border-cc-accent bg-[color-mix(in_srgb,var(--color-cc-accent)_14%,transparent)]'
            : 'border-cc-border-interactive bg-cc-panel-raised hover:border-cc-accent'
        }`}
      >
        <OrbAvatar name={result.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {/*
              `aria-label` here is load-bearing, not decorative: without it,
              the accessible-name algorithm both `getByRole` and real screen
              readers use inserts a space between this span's two DOM
              children (the dimmed "<namespace>/" span and the plain "name"
              text) when flattening them, turning "circleci/node" into
              "circleci/ node" -- silently breaking any name-based lookup
              (including this file's own `getByRole('button', { name:
              /circleci\/node/ })` assertions). Setting `aria-label`
              short-circuits that flattening with the exact string this
              visually-split markup represents.
            */}
            <span
              className="min-w-0 flex-1 truncate font-mono"
              aria-label={result.name}
            >
              {namespace ? (
                <span className="text-cc-text-faint">{namespace}/</span>
              ) : null}
              {name}
            </span>
            <ResultBadges result={result} />
            <span className="shrink-0 text-2xs text-cc-text-faint">
              {result.latestVersion || 'unreleased'}
            </span>
          </span>
          {description ? (
            <span
              className="mt-0.5 block truncate text-2xs text-cc-text-muted"
              title={description}
            >
              {description}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function ResultsList({
  onSelect,
  selectedName,
}: {
  onSelect: (result: OrbSearchResult) => void;
  /** The currently selected result's name, if any -- drives the visible-selection styling and `aria-pressed`. */
  selectedName: string | null;
  /** Registers (or, called with `null`, unregisters) the DOM node for one result's row, so the parent can scroll the selected one into view. */
}) {
  const query = useOrbStore((state) => state.query);
  const filter = useOrbStore((state) => state.filter);
  const searchState = useOrbStore((state) => state.searchState);
  const results = useOrbStore((state) => state.results);
  const reason = useOrbStore((state) => state.reason);
  const error = useOrbStore((state) => state.error);
  const search = useOrbStore((state) => state.search);

  useDescriptionPrefetch(results);

  if (searchState === 'idle') {
    return (
      <p className="text-xs text-cc-text-muted">
        Search for an orb by name, e.g. "node" or "circleci/slack".
      </p>
    );
  }
  if (searchState === 'searching') {
    return (
      <div className="flex items-center gap-2 text-xs text-cc-text-muted">
        <Spinner size={14} label="Searching" /> Searching orbs&hellip;
      </div>
    );
  }
  if (searchState === 'unavailable') {
    // Issue #160: orb search itself no longer needs a token -- the public
    // registry answers unauthenticated, so `available: false` should not
    // occur for that reason any more, and this branch keeps only the host's
    // own `reason` rather than assuming what it must be. It is kept rather
    // than removed: `available` is still part of the wire contract (see
    // orbsSearchResponse's doc comment), and a client rendering a status
    // it never expects to receive is safer than one with no branch for it
    // at all.
    return (
      <div className="rounded-md border border-cc-border-strong bg-cc-panel-raised p-3 text-xs text-cc-text-muted">
        <p className="mb-1 font-medium text-cc-text">
          Orb search is unavailable.
        </p>
        <p>
          {reason ??
            'This host reported that the orb registry cannot be searched right now.'}
        </p>
        {filter === 'private' ? (
          <p className="mt-1">
            That includes your private orbs: this host cannot tell whether your
            organizations have any, so this is not a report that you have none.
          </p>
        ) : null}
      </div>
    );
  }
  if (searchState === 'error') {
    return (
      <div className="rounded-md border border-cc-danger/40 bg-cc-panel-raised p-3 text-xs text-cc-danger">
        <p className="mb-2">{error ?? 'Orb search failed.'}</p>
        <Button variant="secondary" size="sm" onClick={() => search(query)}>
          Retry
        </Button>
      </div>
    );
  }
  if (results.length === 0) {
    return <NoResultsMessage />;
  }

  // An empty query is the "browse" state -- the host answers it with the
  // certified set alphabetically (see orbs.defaultResults), which groups
  // naturally by namespace (see groupByNamespace's doc comment). Sectioning
  // it by namespace turns that into something closer to a directory than a
  // flat wall of names -- issue #50's "structure the results" ask -- with
  // zero risk of misrepresenting a ranking, since there is no match-quality
  // ranking to misrepresent for an unqueried browse list. A non-empty query
  // is never grouped this way: those results *are* ranked by match quality
  // (see orbs.Search), and grouping by namespace would reorder how that
  // ranking reads even though the underlying array itself is never sorted.
  if (query === '') {
    return (
      <>
        <OrbCacheBanner />
        <SearchStatusLine />
        {groupByNamespace(results).map((group) => (
          <details key={group.namespace || '—'} className="mb-2" open>
            <summary className={disclosureSummaryClassName}>
              {group.namespace || '—'} ({group.items.length})
            </summary>
            <ul className="mt-1.5 space-y-1.5">
              {group.items.map((result) => (
                <ResultRow
                  key={result.name}
                  result={result}
                  isSelected={result.name === selectedName}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </details>
        ))}
      </>
    );
  }

  return (
    <>
      <OrbCacheBanner />
      <SearchStatusLine />
      <ul className="space-y-1">
        {results.map((result) => (
          <ResultRow
            key={result.name}
            result={result}
            isSelected={result.name === selectedName}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

/** Exported for reuse by the palette's Steps section (issue #71), which needs the identical "pick one of this config's jobs, then Add" control for a step card as `ElementRow` already uses for an orb command/executor. */
export function JobPicker({
  jobNames,
  onAdd,
}: {
  jobNames: string[];
  onAdd: (jobName: string) => void;
}) {
  const [jobName, setJobName] = useState(jobNames[0] ?? '');
  const selectId = useId();
  useEffect(() => {
    if (!jobNames.includes(jobName)) setJobName(jobNames[0] ?? '');
  }, [jobNames, jobName]);

  if (jobNames.length === 0) {
    return (
      <span
        className="text-2xs text-cc-text-faint"
        title="Add a job to this config first"
      >
        No jobs to add to
      </span>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <label className="sr-only" htmlFor={selectId}>
        Job to add to
      </label>
      <select
        id={selectId}
        value={jobName}
        onChange={(event) => setJobName(event.target.value)}
        className="rounded-md border border-cc-border-interactive bg-cc-panel px-1.5 py-1 text-2xs text-cc-text outline-none focus-visible:border-cc-accent"
      >
        {jobNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="sm" onClick={() => onAdd(jobName)}>
        Add
      </Button>
    </div>
  );
}

/**
 * One parameter's full detail row -- name, type, required-vs-optional,
 * default, enum choices, and its own description -- issue #89's "give each
 * element its parameters, types and defaults in a readable form, and make
 * it obvious which are required" for a single row. Rendered directly (not
 * behind a further click) inside `ElementRow`: the whole point of #89 was
 * that the previous "N params (M required)" count line made a user go
 * hunt for what those params actually were, and the master/detail layout
 * already gave this pane the column's full height specifically so content
 * like this has somewhere to be.
 */
function ParameterRow({ param }: { param: OrbParameter }) {
  return (
    <li className="border-t border-cc-border-strong/60 py-1 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-2xs text-cc-text">{param.name}</span>
        <span className="text-2xs text-cc-text-faint">{param.type}</span>
        {param.required ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <span className="text-2xs text-cc-text-faint">optional</span>
        )}
        {param.default !== undefined ? (
          <span className="text-2xs text-cc-text-faint">
            default:{' '}
            <code className="rounded bg-cc-panel px-1 py-0.5 font-mono">
              {String(param.default)}
            </code>
          </span>
        ) : null}
      </div>
      {param.type === 'enum' &&
      param.enumValues &&
      param.enumValues.length > 0 ? (
        <p className="mt-0.5 text-2xs text-cc-text-faint">
          one of: {param.enumValues.join(', ')}
        </p>
      ) : null}
      {param.description ? (
        <p className="mt-0.5 text-2xs text-cc-text-muted">
          {param.description}
        </p>
      ) : null}
    </li>
  );
}

/** The full parameter list for one job/command/executor (or, via `OrbDetail`, the orb itself) -- renders nothing for an element with no parameters. */
function ParameterList({ parameters }: { parameters: OrbParameter[] }) {
  if (parameters.length === 0) return null;
  return (
    <ul className="mt-1.5 rounded-md border border-cc-border-strong/60 bg-cc-panel px-2 py-0.5">
      {parameters.map((param) => (
        <ParameterRow key={param.name} param={param} />
      ))}
    </ul>
  );
}

function ElementRow({
  orbRef,
  element,
  localJobNames,
  activeWorkflowName,
  onAddJob,
  onAddCommand,
  onAddExecutor,
  onCreateJobFromExecutor,
}: OrbBrowserProps & { orbRef: string; element: OrbElement }) {
  const paramCount = element.parameters.length;
  const requiredCount = element.parameters.filter((p) => p.required).length;

  return (
    <li
      draggable
      onDragStart={(event) =>
        setOrbDragPayload(event.dataTransfer, orbRef, element)
      }
      className="rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5"
      title="Drag onto the graph, or use Add"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-cc-text">
          {element.name}
        </span>
        <span className="shrink-0 text-2xs text-cc-text-faint">
          {paramCount} param{paramCount === 1 ? '' : 's'}
          {requiredCount > 0 ? ` (${requiredCount} required)` : ''}
        </span>
      </div>
      {element.description ? (
        <p
          className="mt-0.5 truncate text-2xs text-cc-text-muted"
          title={element.description}
        >
          {element.description}
        </p>
      ) : null}
      <ParameterList parameters={element.parameters} />
      <div className="mt-1.5">
        {element.kind === 'job' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!activeWorkflowName}
            title={!activeWorkflowName ? 'Add a workflow first' : undefined}
            onClick={() => onAddJob(orbRef, element)}
          >
            Add to workflow
          </Button>
        ) : element.kind === 'command' ? (
          <JobPicker
            jobNames={localJobNames}
            onAdd={(jobName) => onAddCommand(orbRef, element, jobName)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {/* Issue #71: an orb executor is also a way to *create* a job
                (see `onCreateJobFromExecutor`'s own doc comment), offered
                alongside -- not instead of -- assigning it to a job that
                already exists. */}
            {onCreateJobFromExecutor ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onCreateJobFromExecutor(orbRef, element)}
              >
                New job
              </Button>
            ) : null}
            <JobPicker
              jobNames={localJobNames}
              onAdd={(jobName) => onAddExecutor(orbRef, element, jobName)}
            />
          </div>
        )}
      </div>
    </li>
  );
}

function ElementSection({
  title,
  elements,
  orbRef,
  ...rest
}: OrbBrowserProps & {
  title: string;
  elements: OrbElement[];
  orbRef: string;
}) {
  if (elements.length === 0) return null;
  return (
    <details className="mb-2" open>
      <summary className={disclosureSummaryClassName}>
        {title} ({elements.length})
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {elements.map((element) => (
          <ElementRow
            key={element.name}
            orbRef={orbRef}
            element={element}
            {...rest}
          />
        ))}
      </ul>
    </details>
  );
}

/** The pinned detail region's own header: title/version/close, shown across every state (loading/error/loaded) so "close" is always reachable. */
function DetailHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <OrbAvatar name={title} size={18} />
        <h4
          className="min-w-0 truncate font-mono text-xs font-semibold text-cc-text"
          title={title}
        >
          {title}
        </h4>
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {children}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to results"
          onClick={onClose}
        >
          &larr; Back
        </Button>
      </div>
    </div>
  );
}

/**
 * The version `<select>` plus its "which one is latest, and is this it"
 * affordance -- issue #89: "obviously we want to push people to the latest
 * version... but people should be able to look at the orb in a bit more
 * detail and select what version they want." Always rendered (never gated
 * on having more than one known version, unlike the control this replaces)
 * so version is a first-class, always-visible control rather than
 * something that only appears once the search response happened to carry
 * more than one entry.
 *
 * `value` is deliberately a prop, not read off the store directly: while a
 * version switch is in flight, `selectedOrb.version` is still the
 * *previous* version (the fetch for the new one hasn't resolved yet), so
 * `OrbDetail` passes whichever version the user most recently asked for --
 * see its own `pendingVersion` state -- and this control just renders
 * whatever it's given.
 */
function VersionControl({
  versions,
  value,
  latestVersion,
  disabled,
  onChange,
}: {
  /** Newest-first; may be just `[value]` if nothing richer is known yet (see `orbVersionsCache`). */
  versions: string[];
  value: string | undefined;
  /** Empty string/undefined when not yet resolved. */
  latestVersion: string | undefined;
  disabled: boolean;
  onChange: (version: string) => void;
}) {
  const selectId = useId();
  // Defensive: `value` should always be one of `versions` in practice, but
  // a `<select>` with a `value` not among its `<option>`s silently shows
  // nothing selected rather than erroring -- folding it in here means the
  // control never goes visibly blank even if `orbVersionsCache` and the
  // resolved version briefly disagree (e.g. right after a host that
  // resolves "latest" to something not in a stale cached list).
  const options =
    value && !versions.includes(value) ? [value, ...versions] : versions;
  const isLatest = Boolean(latestVersion) && value === latestVersion;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label className="sr-only" htmlFor={selectId}>
        Orb version
      </label>
      <select
        id={selectId}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-cc-border-interactive bg-cc-panel px-1.5 py-1 text-2xs text-cc-text outline-none focus-visible:border-cc-accent disabled:opacity-60"
      >
        {options.map((v) => (
          <option key={v} value={v}>
            {v}
            {latestVersion && v === latestVersion ? ' (latest)' : ''}
          </option>
        ))}
      </select>
      {isLatest ? (
        <Badge tone="success">Latest</Badge>
      ) : latestVersion ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={`Switch to the latest published version (${latestVersion})`}
          onClick={() => onChange(latestVersion)}
        >
          Use latest
        </Button>
      ) : null}
    </div>
  );
}

function OrbDetail(
  props: OrbBrowserProps & { selectedName: string; onClose: () => void },
) {
  const { selectedName, onClose } = props;
  const selectedOrb = useOrbStore((state) => state.selectedOrb);
  const loadingOrb = useOrbStore((state) => state.loadingOrb);
  const error = useOrbStore((state) => state.error);
  const selectOrb = useOrbStore((state) => state.selectOrb);
  const versionInfo = useOrbStore(
    (state) => state.orbVersionsCache[selectedName],
  );

  // The version the user most recently asked for -- see `VersionControl`'s
  // doc comment for why the select shows this rather than
  // `selectedOrb?.version` while a switch is in flight. `undefined` means
  // "nothing requested yet this selection", i.e. show whatever's resolved.
  // Never needs resetting on its own: `OrbBrowser` only ever mounts a fresh
  // `OrbDetail` instance per selection (master and detail alternate rather
  // than one persisting across a different orb), so this
  // local state can't outlive the selection it was set during.
  const [pendingVersion, setPendingVersion] = useState<string | undefined>(
    undefined,
  );

  const resolvedVersion =
    selectedOrb?.name === selectedName ? selectedOrb.version : undefined;
  const displayVersion = pendingVersion ?? resolvedVersion;
  const versions =
    versionInfo?.versions && versionInfo.versions.length > 0
      ? versionInfo.versions
      : displayVersion
        ? [displayVersion]
        : [];

  const handleVersionChange = useCallback(
    (v: string) => {
      setPendingVersion(v);
      void selectOrb(selectedName, v).finally(() => {
        setPendingVersion((current) => (current === v ? undefined : current));
      });
    },
    [selectOrb, selectedName],
  );

  const versionControl = (
    <VersionControl
      versions={versions}
      value={displayVersion}
      latestVersion={versionInfo?.latestVersion}
      disabled={loadingOrb}
      onChange={handleVersionChange}
    />
  );

  if (loadingOrb) {
    return (
      <div>
        <DetailHeader title={selectedName} onClose={onClose}>
          {versionControl}
        </DetailHeader>
        <div className="flex items-center gap-2 text-xs text-cc-text-muted">
          <Spinner size={14} label="Loading orb" /> Loading orb source&hellip;
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <DetailHeader title={selectedName} onClose={onClose}>
          {versionControl}
        </DetailHeader>
        <div className="rounded-md border border-cc-danger/40 bg-cc-panel-raised p-3 text-xs text-cc-danger">
          <p className="mb-2">{error}</p>
          {selectedOrb ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void selectOrb(selectedOrb.name, selectedOrb.version)
              }
            >
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!selectedOrb) return null;

  const { name, version, parsed } = selectedOrb;
  const orbRef = `${name}@${version}`;
  const registryUrl = orbDocsUrl(
    parsed.namespace ?? splitOrbRef(name).namespace,
    parsed.orbName ?? splitOrbRef(name).name,
  );

  return (
    <div>
      <DetailHeader title={name} onClose={onClose}>
        {versionControl}
      </DetailHeader>

      {parsed.description ? (
        <div className="mb-2 text-xs text-cc-text-muted">
          {renderOrbDescription(parsed.description)}
        </div>
      ) : null}

      {parsed.homeUrl || parsed.sourceUrl || registryUrl ? (
        <p className="mb-3 flex flex-wrap gap-3 text-2xs">
          {parsed.homeUrl ? (
            <a
              href={parsed.homeUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cc-accent hover:underline"
            >
              Home
            </a>
          ) : null}
          {parsed.sourceUrl ? (
            <a
              href={parsed.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-cc-accent hover:underline"
            >
              Source
            </a>
          ) : null}
          {registryUrl ? (
            <DocsLink
              label={`${name} on the CircleCI orb registry`}
              url={registryUrl}
            >
              Registry
            </DocsLink>
          ) : null}
        </p>
      ) : null}

      {parsed.parameters.length > 0 ? (
        <div className="mb-3">
          <h5 className="text-2xs font-semibold uppercase tracking-wide text-cc-text-muted">
            Orb parameters
          </h5>
          <ParameterList parameters={parsed.parameters} />
        </div>
      ) : null}

      <ElementSection
        title="Jobs"
        elements={parsed.jobs}
        orbRef={orbRef}
        {...props}
      />
      <ElementSection
        title="Commands"
        elements={parsed.commands}
        orbRef={orbRef}
        {...props}
      />
      <ElementSection
        title="Executors"
        elements={parsed.executors}
        orbRef={orbRef}
        {...props}
      />

      {parsed.jobs.length === 0 &&
      parsed.commands.length === 0 &&
      parsed.executors.length === 0 ? (
        <p className="text-xs text-cc-text-muted">
          This orb has no jobs, commands, or executors to add.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The full orb-browser panel: search box, results list, and the selected
 * result's detail view.
 *
 * Fix for issue #29: selecting a result used to render its detail *below*
 * the full results list, so seeing it meant scrolling past every result --
 * for a list of dozens of certified orbs, that read as "nothing happened."
 * Instead, once something is selected the results list gets its own bounded,
 * independently-scrolling region and the detail is pinned right below it
 * (never below an arbitrarily long list), the selected row is visibly
 * marked and scrolled into view, and a "Back" affordance in the detail
 * header clears the selection to give the list its full height back. The
 * search field stays reachable throughout, and results are never re-sorted
 * -- see the module doc comment above.
 */
export function OrbBrowser(props: OrbBrowserProps) {
  const query = useOrbStore((state) => state.query);
  const search = useOrbStore((state) => state.search);
  const selectOrb = useOrbStore((state) => state.selectOrb);
  const clearSelection = useOrbStore((state) => state.clearSelection);
  const searchInputId = useId();
  const searchState = useOrbStore((state) => state.searchState);
  const refresh = useOrbStore((state) => state.refresh);
  const warming = useOrbStore((state) => Boolean(state.status?.warming));

  // The name of the result the user last clicked, tracked locally (not
  // read off `useOrbStore.selectedOrb`) so the detail region -- and the
  // selected row's own styling -- can appear the instant it's clicked, even
  // before `selectOrb`'s fetch resolves (`selectedOrb` itself stays `null`
  // until then).
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // The selected row used to be scrolled into view inside the capped list
  // that sat above the detail. Master and detail now alternate rather than
  // stack (see the render below), so while something is selected there is no
  // list rendered and therefore no row to scroll to -- the effect and its ref
  // map were a guaranteed no-op and are gone rather than left describing a
  // layout that no longer exists.

  // Populate the panel on first open. The host answers an empty query with
  // the certified orbs, so the user lands on a browsable list of the orbs
  // they are most likely to want rather than an empty panel.
  useEffect(() => {
    if (searchState === 'idle') search('');
    // Only ever fires for the initial idle state; later searches are driven
    // by the input, and re-running this on every state change would fight
    // the user's own query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (result: OrbSearchResult) => {
    setSelectedName(result.name);
    clearSelection();
    void selectOrb(result.name, result.latestVersion || undefined);
  };

  const handleClose = useCallback(() => {
    setSelectedName(null);
    clearSelection();
  }, [clearSelection]);

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="mb-2 flex shrink-0 items-center gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-cc-text-muted">
          Orbs
        </h3>
        {/* Issue #78/#79: orbs are "the gateway" reusable config leads to --
            a link to the registry (browse what already exists) sits right
            next to one on what an orb even is, at the one spot every orb
            interaction in this app starts from. */}
        <DocsLink
          label={DOCS_LINKS.orbs.intro.label}
          url={DOCS_LINKS.orbs.intro.url}
        />
        <DocsLink
          label={DOCS_LINKS.orbs.registry.label}
          url={DOCS_LINKS.orbs.registry.url}
        >
          Registry
        </DocsLink>
        {/*
          Issue #285: the manual "check now" re-crawl the owner asked for by
          name, styled and placed like the palette's own Contexts refresh
          (`PaletteContextSection`) so the two read as the same affordance.
          `ml-auto` pins it to the row's far end, matching that button's own
          right-aligned placement in its header. Disabled (not hidden) while
          a crawl -- this one's or the automatic warm-up's -- is already
          running: the crawl can take minutes, and a disabled control that
          says so beats one that looks clickable but would just no-op.
        */}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={refresh}
          disabled={warming}
          title={
            warming
              ? 'Re-crawling the orb registry — this can take a few minutes for the full ~6,400-orb registry'
              : 'Re-crawl the orb registry now, instead of waiting for the next automatic check'
          }
        >
          {warming ? (
            <span className="flex items-center gap-1.5">
              <Spinner size={12} label="Refreshing" />
              Refreshing…
            </span>
          ) : (
            'Refresh'
          )}
        </Button>
      </div>

      <label htmlFor={searchInputId} className="sr-only">
        Search orbs
      </label>
      <div className="mb-2 flex shrink-0 items-center gap-1.5">
        <input
          id={searchInputId}
          type="search"
          value={query}
          onChange={(event) => search(event.target.value)}
          placeholder="Search orbs&hellip;"
          className={inputClassName}
        />
        {query ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Clear search"
            onClick={() => search('')}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/* Issue #151. Deliberately outside the master/detail switch below, so
          the chosen scope stays visible (and changeable) while an orb's detail
          is open, and `shrink-0` so it never eats into the results region's
          own height. */}
      <OrbFilterBar />

      {/*
        Master and detail are *alternating* views, not stacked ones.

        They used to be stacked: on selection the list shrank to a capped,
        independently-scrolling 12rem strip and the detail scrolled below it.
        That satisfied the requirement it was built for (issue #29 -- reach the
        detail without scrolling past every result) but it put two scroll
        regions inside the palette column, which itself scrolls, inside a pane
        that scrolls. Measured four in this pane at once, and the reported
        symptom was exactly that: "there's 5 different scroll bars there and it
        just doesn't really work that nicely... it's hard to understand what's
        going on."

        Drilling down instead means only the palette column ever scrolls, and
        it also fixes the second half of that report -- an orb's jobs,
        commands and executors were "kind of hard to just read it all" in a
        12rem-capped strip, and now get the column's full height. This is the
        ordinary answer for master/detail on a surface too narrow to hold both,
        and the "reachable without scrolling" requirement is satisfied more
        strongly than before: the detail replaces the list rather than sitting
        under it.

        `handleClose` is unchanged, so Escape and the detail's own close
        control already return here -- `DetailHeader` renders its own
        "Back to results" button, so no new affordance was needed.
      */}
      {selectedName ? (
        <div data-testid="orb-detail-region" className="min-h-0 flex-1">
          <OrbDetail
            {...props}
            selectedName={selectedName}
            onClose={handleClose}
          />
        </div>
      ) : (
        <div data-testid="orb-results-list" className="min-h-0 flex-1">
          <ResultsList onSelect={handleSelect} selectedName={selectedName} />
        </div>
      )}
    </div>
  );
}
