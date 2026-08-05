/**
 * Orb-browser state: the search box's query/results/cache-warmth, and the
 * currently selected orb's parsed elements. Deliberately a separate store
 * from `appStore` -- none of this is config state, it never goes through
 * `mutate()`, and keeping it apart means `appStore` doesn't grow a second,
 * unrelated responsibility. Every actual edit to the config still flows
 * through `appStore.mutate()`, driven by the drag-and-drop / "Add" affordances
 * in `panes/orbs` and `panes/dag`, not by anything here.
 */
import { create } from 'zustand';

import { parseOrbSource } from '~/lib/orbs/parseOrb';
import type { ParsedOrb } from '~/lib/orbs/types';
import { getOrbSource, searchOrbs } from '~/lib/rpc/client';
import type {
  OrbSearchFilter,
  OrbSearchMatch,
  OrbSearchResult,
  OrbSearchStatus,
  OrbSourceResponse,
} from '~/lib/rpc/client';

/**
 * The search box's state machine.
 *
 * - `idle`: no query typed yet (or the query was cleared).
 * - `searching`: a debounced `GET /api/orbs/search` is in flight.
 * - `ready`: the API responded with (possibly empty) results.
 * - `unavailable`: the host reported that it cannot search at all right now.
 *   Distinct from `ready` with zero results, since "there is no way to
 *   search orbs right now" and "nothing matched" need different messaging
 *   (see `OrbBrowser`). Issue #160: this used to be the state a missing
 *   `CIRCLE_TOKEN` produced, because the host refused every search without
 *   one -- it no longer does, since the public orb registry answers
 *   unauthenticated. A token now only changes whether the *private* scope
 *   has anything to find, which `OrbBrowser`'s Private-filter messaging
 *   handles on its own, without going through this state.
 * - `error`: the request itself failed (network/transport/non-2xx).
 */
export type OrbSearchState =
  | 'idle'
  | 'searching'
  | 'ready'
  | 'unavailable'
  | 'error';

/** The orb currently shown in the browser's detail view, already parsed. */
export interface SelectedOrb {
  name: string;
  version: string;
  parsed: ParsedOrb;
}

/**
 * One orb's full version list, as needed to render a version picker (issue
 * #89: "select what version they want") independent of whatever the
 * *current* search happens to carry. `versions` is newest-first, mirroring
 * `OrbSearchResult.versions`; `latestVersion` names which of them the host
 * would resolve a version-less request to, so the UI can badge/recommend
 * it even after the user has picked an older one.
 */
export interface OrbVersionInfo {
  versions: string[];
  latestVersion: string;
}

const SEARCH_DEBOUNCE_MS = 250;
/** Matches the host's own default (`GET /api/orbs/search` clamps to 100 anyway). */
const DEFAULT_SEARCH_LIMIT = 50;

interface OrbState {
  query: string;
  /**
   * Which slice of the registry searches are scoped to (issue #151).
   *
   * Lives here rather than in `OrbBrowser`'s local state for the requirement
   * that "filters must survive a query change": `search` reads it, and typing
   * a new query never writes it, so the two are independent by construction.
   * It also survives drilling into an orb's detail and coming back, and any
   * remount of the panel (e.g. collapsing the palette's Orbs section).
   */
  filter: OrbSearchFilter;
  results: OrbSearchResult[];
  status: OrbSearchStatus | null;
  /**
   * What the last search matched, within and without the active filter --
   * `null` before the first response, or whenever the host answered
   * `available: false` (nothing was searched, so there is nothing to count).
   * See `OrbSearchMatch`; the UI turns this into the sentence that keeps an
   * active filter from being an invisible reason for a short list.
   */
  match: OrbSearchMatch | null;
  searchState: OrbSearchState;
  reason: string | null;
  selectedOrb: SelectedOrb | null;
  loadingOrb: boolean;
  error: string | null;
  /**
   * Parsed orbs cached in-memory, keyed by `"<name>@<version-as-requested>"`
   * (see `selectOrb`'s doc comment for why "as requested" rather than
   * always the resolved version). Exposed as state -- not a private module
   * variable -- because drop targets elsewhere in the app (a job node, the
   * inspector's steps list) need to look up an already-selected orb's
   * elements without re-fetching.
   */
  parsedOrbs: Record<string, ParsedOrb>;
  /**
   * Each orb's full version list, keyed by its canonical
   * `"<namespace>/<name>"` (no `@version` -- unlike `parsedOrbs`, there is
   * exactly one entry per orb regardless of which version is selected).
   *
   * Populated two ways: opportunistically from every `search()` response
   * (each `OrbSearchResult` carries its own `versions`/`latestVersion` for
   * free), and authoritatively from every `selectOrb`/`loadOrb`
   * fetch-success (their `OrbSourceResponse` also carries
   * `versions`/`latestVersion`, resolved via a live single-name lookup --
   * see that response's own doc comment for why it, unlike a search
   * response, is guaranteed to carry an orb's *complete* version history,
   * not just whichever one the host's crawled cache happened to have
   * embedded). The latter always wins on conflict (it's applied second,
   * and `withOrbVersionInfo` overwrites): search results are a same-tick
   * head start for the common case of opening the detail of a row that's
   * still on screen, not the source of truth.
   *
   * Either way, entries are only ever added, never dropped once a search
   * moves on -- so an orb's version list survives the user typing a
   * *different* query while its detail is still open. `OrbBrowser`'s
   * version `<select>` reads this directly rather than deriving the list
   * from `results` live, which is exactly the fragility issue #89 called
   * out: "the list comes from whatever the search response happened to
   * carry."
   */
  orbVersionsCache: Record<string, OrbVersionInfo>;
  /**
   * Debounced (~250ms) orb search. Discards a response that arrives after a
   * newer call has already been made, via a request sequence counter, so a
   * slow response for a stale query can never overwrite fresher results.
   *
   * An empty query is still sent: the host answers it with the certified
   * orbs, which is the useful default for browsing. Showing those beats an
   * empty panel when someone opens the browser without a search in mind.
   */
  search: (query: string) => void;
  /**
   * Switches which slice of the registry is searched, re-running the current
   * query immediately (not debounced -- this is a discrete click/keypress on a
   * filter control, not a keystroke, so there is nothing to coalesce and a
   * 250ms lag would read as the control not responding). The query itself is
   * left untouched: changing the filter must never clear what the user typed,
   * and changing the query must never reset the filter.
   */
  setFilter: (filter: OrbSearchFilter) => void;
  /**
   * Triggers the host's manual "check now" re-crawl of the orb registry
   * (issue #285), then re-runs the current query/filter against whatever the
   * host answers immediately -- a full re-crawl can take minutes, so this
   * request itself returns fast; `status.warming` is how the UI observes the
   * crawl actually finishing, exactly as it already does for the automatic
   * warm-on-launch crawl.
   *
   * A no-op while `status.warming` is already true, so a double-click (or
   * this and the automatic warm-up overlapping) costs no extra request --
   * the host's own orbs.Cache.Refresh no-ops too, but skipping the request
   * here avoids paying even that round trip.
   */
  refresh: () => void;
  /**
   * Fetches and parses one orb version's source, then caches the parsed
   * result so re-selecting the same orb (a very likely action while
   * dragging its elements around) is instant. `version` omitted means "the
   * orb's latest", resolved by the host.
   */
  selectOrb: (name: string, version?: string) => Promise<void>;
  clearSelection: () => void;
  /**
   * Fetches (with the same `parsedOrbs` cache `selectOrb` uses/populates)
   * and parses one orb version's source, *without* touching
   * `selectedOrb`/`loadingOrb`/`error` -- for a consumer that needs an
   * orb's schema (e.g. the inspector's orb-job parameter editor, issue #37)
   * without hijacking whatever the orb browser panel currently has
   * selected or displaying that consumer's own loading/error state through
   * this store's shared fields. `version` omitted means "the orb's latest".
   * Throws (rather than returning `undefined`) on any failure -- an
   * unavailable host, a network error, ... -- so a caller manages its own
   * loading/error UI the ordinary way (try/catch), instead of this store
   * inventing a second error channel alongside `error`.
   */
  loadOrb: (name: string, version?: string) => Promise<ParsedOrb>;
  /**
   * Best-effort background fetch of one orb's description, for showing it
   * in the results *list* rather than only after selecting an orb (issue
   * #50). The v3 registry's bulk package listing has no description field
   * at all -- the only way to learn one is to fetch and parse the orb's
   * full YAML source, the same as `selectOrb`/`loadOrb` already do -- so
   * this is really just `loadOrb` with two differences suited to a
   * background row-list prefetch rather than a user-driven selection:
   * it never surfaces an error (a failed description is just a row with no
   * second line, not a failure worth showing the user), and it runs
   * through `descriptionQueue` below so rendering, say, 50 search results
   * doesn't fire 50 simultaneous orb-source requests. A no-op if the
   * description is already cached (via `parsedOrbs`) or already
   * queued/in-flight.
   */
  prefetchDescription: (name: string, version?: string) => void;
}

// Debounce timer and request sequence counter live outside zustand state,
// same rationale as `appStore`'s `validateTimer`/`validateSeq`: neither
// should itself trigger a re-render, and both must survive across store
// updates untouched by anything React does.
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

function clearSearchTimer(): void {
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }
}

/**
 * Folds an `OrbSourceResponse`'s `versions`/`latestVersion` (issue #89's
 * version picker -- see that response's own doc comment on why it, not
 * `searchOrbs`, is the *authoritative* source for an orb's full version
 * list) into `cache`, keyed by the orb's resolved name. Shared by
 * `selectOrb` and `loadOrb`'s fetch-success paths: both resolve the same
 * response shape and both want the version list it carries applied the
 * same way. A response with no versions (shouldn't happen once
 * `available` is true, but this must never throw on a malformed one)
 * leaves whatever `cache` already had for this name untouched rather than
 * clobbering it with nothing -- e.g. a live `/api/orbs/source` hiccup on a
 * *second* fetch must not erase what a first, successful one already
 * established.
 */
function withOrbVersionInfo(
  cache: Record<string, OrbVersionInfo>,
  name: string,
  response: OrbSourceResponse,
): Record<string, OrbVersionInfo> {
  if (!response.versions || response.versions.length === 0) return cache;
  return {
    ...cache,
    [name]: {
      versions: response.versions,
      latestVersion: response.latestVersion ?? '',
    },
  };
}

// Bounds how many description-only orb-source fetches (see
// `prefetchDescription`) run at once. `OrbBrowser` requests one per visible
// result, and doing that with no cap would turn every settled search into a
// burst of up to a few dozen simultaneous `/api/orbs/source` requests. This
// caps *concurrency*, not the number of rows that eventually get a
// description -- every row's request still runs eventually, just queued
// behind whichever four are already in flight.
const MAX_CONCURRENT_DESCRIPTION_FETCHES = 4;
let activeDescriptionFetches = 0;
const descriptionQueue: Array<() => void> = [];
// Keys (the same "<name>@<version-as-requested>" shape `loadOrb` caches
// under) already requested this session -- whether that request is still
// queued, currently in flight, or already finished (successfully or not) --
// so re-rendering the same row (e.g. every keystroke of a query it still
// matches) never re-enqueues it. `parsedOrbs` alone only covers "already
// resolved successfully"; this also covers "queued/in flight", and
// deliberately never retries a failure within the same session, on the
// assumption that a transient orb-source fetch failure is likely to repeat
// (e.g. the host lost its token) rather than being worth hammering again on
// every subsequent search.
const descriptionRequested = new Set<string>();

function runNextDescriptionFetch(): void {
  if (activeDescriptionFetches >= MAX_CONCURRENT_DESCRIPTION_FETCHES) return;
  const next = descriptionQueue.shift();
  if (!next) return;
  activeDescriptionFetches++;
  next();
}

/**
 * Test-only: clears the description-prefetch queue/dedupe state above.
 * That state deliberately lives outside zustand (so a queued fetch keeps
 * draining even across unrelated store updates) and therefore survives
 * `useOrbStore.setState(...)` between tests -- without this, a test that
 * reuses the same orb name/version another test already prefetched (e.g.
 * "circleci/node@5.2.0", which recurs throughout OrbBrowser.test.tsx) would
 * see `prefetchDescription` silently no-op, having inherited an unrelated
 * earlier test's "already requested" entry instead of actually issuing its
 * own fetch.
 */
export function resetOrbDescriptionPrefetchForTests(): void {
  descriptionQueue.length = 0;
  descriptionRequested.clear();
  activeDescriptionFetches = 0;
}

export const useOrbStore = create<OrbState>((set, get) => {
  /**
   * Issues one search request and folds its response into the store, guarding
   * against a stale response via `searchSeq` (a slow answer for an
   * already-superseded query/filter must never overwrite fresher results).
   *
   * Shared by `search` (which debounces it, since it runs per keystroke) and
   * `setFilter` (which runs it immediately) so both paths handle a response
   * identically -- the alternative, two copies of this fold, is exactly how
   * one of them would eventually forget to reset `match`.
   */
  const runSearch = (
    query: string,
    filter: OrbSearchFilter,
    refresh = false,
  ): void => {
    const seq = ++searchSeq;
    set({ searchState: 'searching', error: null });

    searchOrbs(query, DEFAULT_SEARCH_LIMIT, filter, refresh)
      .then((response) => {
        if (seq !== searchSeq) return; // superseded by a newer search
        if (!response.available) {
          set({
            searchState: 'unavailable',
            reason: response.reason ?? null,
            results: [],
            status: null,
            // Nothing was searched, so there is nothing to count. Leaving a
            // previous search's counts in place would let the UI explain an
            // empty list with numbers from a request that never happened.
            match: null,
          });
          return;
        }
        set((state) => {
          const results = response.results ?? [];
          // Free enrichment of `orbVersionsCache`: every result this
          // search returned already carries its own full version list,
          // so there's no reason to make `ensureOrbVersions` re-fetch it
          // later just because the *current* search has moved on by
          // then. Skipped for a reserved name with nothing published
          // (`versions` empty) -- caching an empty list would be
          // indistinguishable from "not yet looked up".
          let versionsCache = state.orbVersionsCache;
          for (const result of results) {
            if (result.versions.length === 0) continue;
            if (versionsCache === state.orbVersionsCache) {
              versionsCache = { ...state.orbVersionsCache };
            }
            versionsCache[result.name] = {
              versions: result.versions,
              latestVersion: result.latestVersion,
            };
          }
          return {
            searchState: 'ready',
            // Rendered in this order by `OrbBrowser` -- see
            // `OrbSearchResponse`'s doc comment for why it must not be
            // re-sorted client-side.
            results,
            status: response.status ?? null,
            match: response.match ?? null,
            reason: null,
            orbVersionsCache: versionsCache,
          };
        });
      })
      .catch((err: unknown) => {
        if (seq !== searchSeq) return;
        set({
          searchState: 'error',
          error: err instanceof Error ? err.message : 'Orb search failed.',
          results: [],
          match: null,
        });
      });
  };

  return {
    query: '',
    filter: 'all',
    results: [],
    status: null,
    match: null,
    searchState: 'idle',
    reason: null,
    selectedOrb: null,
    loadingOrb: false,
    error: null,
    parsedOrbs: {},
    orbVersionsCache: {},

    search: (query: string) => {
      set({ query });
      clearSearchTimer();
      searchTimer = setTimeout(() => {
        runSearch(query, get().filter);
      }, SEARCH_DEBOUNCE_MS);
    },

    setFilter: (filter: OrbSearchFilter) => {
      set({ filter });
      // A pending keystroke's debounced search would otherwise land *after*
      // this one with the same (already-current) filter -- harmless, but it
      // would issue a redundant request and briefly flip `searchState` back
      // to 'searching' for no reason.
      clearSearchTimer();
      runSearch(get().query, filter);
    },

    refresh: () => {
      if (get().status?.warming) return;
      clearSearchTimer();
      runSearch(get().query, get().filter, true);
    },

    selectOrb: async (name: string, version?: string) => {
      // Cached under the version *as requested*: a caller that always omits
      // `version` (i.e. always wants "latest") gets a cache hit on repeat
      // selection without needing to already know what "latest" resolved to.
      // A caller that pins an explicit version gets a cache hit for that
      // exact pin. The two never collide because the key includes the literal
      // string "latest" only when no version was given.
      const cacheKey = `${name}@${version ?? 'latest'}`;
      const cached = get().parsedOrbs[cacheKey];
      if (cached) {
        // `name` here -- the parameter this function was called with -- is
        // already the full "<namespace>/<name>" the caller asked for, and is
        // used as-is rather than reconstructed from the cached `ParsedOrb`.
        // `cached.orbName` (bare, without its namespace -- see
        // `parseOrbRef`) is *not* an equivalent substitute: using it here
        // used to silently truncate "circleci/node" down to "node" on every
        // cache-hit selection, which only went unnoticed because nothing
        // previously populated this cache ahead of a first `selectOrb` call
        // for a given orb. `prefetchDescription` now does exactly that (see
        // its doc comment), which is what surfaced this.
        set({
          selectedOrb: {
            name,
            version: cached.version ?? version ?? '',
            parsed: cached,
          },
          loadingOrb: false,
          error: null,
        });
        return;
      }

      set({ loadingOrb: true, error: null });
      try {
        const response = await getOrbSource(name, version);
        if (!response.available) {
          set({
            loadingOrb: false,
            error:
              response.reason ??
              // Issue #160: orb source fetching no longer needs a token either
              // (GET /api/v3/orb/versions/{id}/source answers unauthenticated,
              // verified live), so this generic fallback -- used only when the
              // host's own `reason` is somehow absent -- no longer names a
              // token as the presumed cause.
              'This host reported that the orb source could not be fetched.',
          });
          return;
        }
        const resolvedName = response.name ?? name;
        const resolvedVersion = response.version ?? version ?? '';
        const parsed = parseOrbSource(
          response.source,
          `${resolvedName}@${resolvedVersion}`,
        );
        const exactKey = `${resolvedName}@${resolvedVersion}`;

        set((state) => ({
          selectedOrb: { name: resolvedName, version: resolvedVersion, parsed },
          parsedOrbs: {
            ...state.parsedOrbs,
            [cacheKey]: parsed,
            [exactKey]: parsed,
          },
          orbVersionsCache: withOrbVersionInfo(
            state.orbVersionsCache,
            resolvedName,
            response,
          ),
          loadingOrb: false,
          error: null,
        }));
      } catch (err) {
        set({
          loadingOrb: false,
          error:
            err instanceof Error ? err.message : 'Failed to load orb source.',
        });
      }
    },

    clearSelection: () => set({ selectedOrb: null, error: null }),

    loadOrb: async (name: string, version?: string) => {
      const cacheKey = `${name}@${version ?? 'latest'}`;
      const cached = get().parsedOrbs[cacheKey];
      if (cached) return cached;

      const response = await getOrbSource(name, version);
      if (!response.available) {
        throw new Error(
          response.reason ??
            // Issue #160: orb source fetching no longer needs a token either
            // (GET /api/v3/orb/versions/{id}/source answers unauthenticated,
            // verified live), so this generic fallback -- used only when the
            // host's own `reason` is somehow absent -- no longer names a
            // token as the presumed cause.
            'This host reported that the orb source could not be fetched.',
        );
      }
      const resolvedName = response.name ?? name;
      const resolvedVersion = response.version ?? version ?? '';
      const parsed = parseOrbSource(
        response.source,
        `${resolvedName}@${resolvedVersion}`,
      );
      const exactKey = `${resolvedName}@${resolvedVersion}`;

      set((state) => ({
        parsedOrbs: {
          ...state.parsedOrbs,
          [cacheKey]: parsed,
          [exactKey]: parsed,
        },
        orbVersionsCache: withOrbVersionInfo(
          state.orbVersionsCache,
          resolvedName,
          response,
        ),
      }));
      return parsed;
    },

    prefetchDescription: (name: string, version?: string) => {
      const cacheKey = `${name}@${version ?? 'latest'}`;
      if (get().parsedOrbs[cacheKey]) return; // Already resolved.
      if (descriptionRequested.has(cacheKey)) return; // Already queued or in flight.
      descriptionRequested.add(cacheKey);

      descriptionQueue.push(() => {
        get()
          .loadOrb(name, version)
          // Deliberately swallowed: unlike `selectOrb`, this is a background
          // enhancement to a row the user hasn't asked to see the detail of
          // yet. A failed fetch just means that row's description line stays
          // absent -- never a user-facing error.
          .catch(() => {})
          .finally(() => {
            activeDescriptionFetches--;
            runNextDescriptionFetch();
          });
      });
      runNextDescriptionFetch();
    },
  };
});
