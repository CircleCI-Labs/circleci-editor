/**
 * The one source of truth for a `cimg/*` image's *live* version tags,
 * shared by both places issue #77 (and the follow-up user feedback that
 * widened it -- see the PR description) needs them: the `docker: - image:`
 * CodeMirror completion source (`completion.ts`, issue #57) and the image
 * picker in `ConfigureJobDialog`. Deliberately a plain module-level cache
 * rather than two independent fetchers, per that feedback: the picker must
 * never end up with richer tag data than the editor's own autocomplete, or
 * vice versa -- that asymmetry would be its own bug.
 *
 * `images.ts` vendors the `cimg/*` repo list and variant suffixes but
 * deliberately excludes version numbers (see its own provenance comment)
 * because they churn too fast to hand-curate. This module is what fills
 * that gap live: it calls `GET /api/docker-tags` (implemented by
 * `internal/host`/`internal/dockerhub`, which talks to Docker Hub's public
 * API on this module's behalf -- never directly from the browser; see that
 * package's doc comment for why).
 *
 * Every caller must treat "no tags" as a normal, expected state, not an
 * error -- see `CimgTagsState.source`. There is always a working fallback
 * one layer down (`images.ts`'s vendored variant list), which is why
 * neither `fetchCimgTags` nor `getCachedCimgTags` ever throws: a network or
 * host failure resolves to `{ tags: [], source: 'unavailable' }` rather
 * than rejecting, so a caller that forgets to handle the offline case still
 * degrades gracefully instead of surfacing a raw error to the user for a
 * feature that was always meant to be optional.
 */
import { getDockerTags } from '~/lib/rpc/client';

/** One image's live-tag lookup result, as seen by a caller of this module. */
export interface CimgTagsState {
  /** Ranked, newest-first version tags (see `internal/dockerhub.RankVersionTags`). Empty when unavailable, or when the repo genuinely has none. What the picker *recommends*. */
  tags: string[];
  /**
   * Every version-shaped tag the host saw, newest-first -- a superset of `tags`,
   * and what the picker's type-to-filter searches (issue #213).
   *
   * Never shorter than `tags`: when the host answers from a cache entry written
   * before it served this field, `fetchCimgTags` fills it from `tags` rather than
   * leaving it empty, so no caller has to distinguish "this repo published
   * nothing" from "this entry is older than the feature".
   */
  allTags: string[];
  /**
   * Where `tags` came from, so the UI can be honest about freshness rather
   * than implying every list is live: `'live'` means this exact call just
   * fetched from Docker Hub; `'cache'` means the *host's* disk/memory cache
   * answered without a fresh fetch (still real data, just not brand new);
   * `'unavailable'` means neither worked (offline, or Docker Hub
   * unreachable and the host has never cached this image before) -- the
   * caller's own fallback (images.ts's vendored variant list) is what to
   * show instead.
   */
  source: 'live' | 'cache' | 'unavailable';
  /** ISO 8601 fetch time from the host, present iff `source !== 'unavailable'`. */
  fetchedAt?: string;
  /**
   * True iff `tags`/`allTags` are known to be shorter than Docker Hub
   * actually has, because the host's fetch was cut short (rate limiting,
   * most likely) rather than genuinely exhausting what's available -- see
   * `DockerTagsResponse.truncated`. Never true just because the host's own
   * pagination bound was reached with more left on Docker Hub; that is a
   * deliberate limit the tag count already discloses honestly, not a
   * degradation needing its own caveat.
   */
  truncated?: boolean;
  /** Explains `truncated`. Present iff `truncated`. */
  truncatedReason?: string;
}

const UNAVAILABLE: CimgTagsState = {
  tags: [],
  allTags: [],
  source: 'unavailable',
};

/**
 * How long this *browser tab's* copy of a repo's tags is trusted before
 * `fetchCimgTags` asks the host again. Deliberately much shorter than the
 * host's own 12h disk-cache TTL (`internal/dockerhub`'s cacheTTL): the host
 * call is cheap once its own cache is warm (no outbound Docker Hub
 * request), so there's little to gain from a long-lived browser-side
 * cache beyond absorbing the handful of repeat lookups one picker
 * session/typing burst naturally produces.
 */
const BROWSER_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  state: CimgTagsState;
  cachedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CimgTagsState>>();

/**
 * Returns the last resolved lookup for `name` (a bare `cimg/*` image name,
 * e.g. `"node"`), if any is cached in this tab -- without triggering a
 * fetch. Used by the completion source's synchronous fast path (see
 * `completion.ts`): a keystroke that lands on an image already looked up
 * this session can show live tags immediately, with `fetchCimgTags` only
 * needed to populate the cache in the first place or refresh it.
 */
export function getCachedCimgTags(name: string): CimgTagsState | undefined {
  const entry = cache.get(name);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAtMs > BROWSER_CACHE_TTL_MS) return undefined;
  return entry.state;
}

/**
 * Resolves `name`'s live version tags, fetching via the host (see the
 * module doc comment) if not already cached fresh in this tab. Concurrent
 * calls for the same name share one in-flight request rather than each
 * firing their own -- CodeMirror can re-invoke the completion source on
 * every keystroke, and without de-duplication that would mean one outbound
 * request per character typed.
 *
 * Never rejects -- see the module doc comment for why "unavailable" is a
 * resolved state, not a thrown error.
 */
export function fetchCimgTags(name: string): Promise<CimgTagsState> {
  const cached = getCachedCimgTags(name);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(name);
  if (pending) return pending;

  const request = getDockerTags(name)
    .then((response): CimgTagsState => {
      if (!response.available) return UNAVAILABLE;
      const tags = response.tags ?? [];
      return {
        tags,
        // `?? tags` rather than `?? []`: see `CimgTagsState.allTags`.
        allTags: response.allTags ?? tags,
        source: response.live ? 'live' : 'cache',
        fetchedAt: response.fetchedAt,
        truncated: response.truncated,
        truncatedReason: response.truncatedReason,
      };
    })
    .catch(() => UNAVAILABLE)
    .then((state) => {
      cache.set(name, { state, cachedAtMs: Date.now() });
      inFlight.delete(name);
      return state;
    });

  inFlight.set(name, request);
  return request;
}

/**
 * Forces a live Docker Hub fetch for `name`, bypassing this tab's own cache
 * (`BROWSER_CACHE_TTL_MS`) *and* the host's 12h one (`internal/dockerhub`'s
 * `cacheTTL`) via `getDockerTags`'s `refresh` flag -- the manual "check now"
 * affordance issue #285 adds to the image picker, for a tag published since
 * the last fetch.
 *
 * Shares `inFlight` with `fetchCimgTags`: a concurrent ordinary lookup for
 * the same image (e.g. the completion source firing on a keystroke while the
 * picker's Refresh button is also in flight) gets this call's result instead
 * of firing a second request, the same one-request-per-name guarantee
 * `fetchCimgTags` already gives itself. Never rejects, for the same reason
 * `fetchCimgTags` doesn't -- see the module doc comment.
 */
export function refreshCimgTags(name: string): Promise<CimgTagsState> {
  const request = getDockerTags(name, true)
    .then((response): CimgTagsState => {
      if (!response.available) return UNAVAILABLE;
      const tags = response.tags ?? [];
      return {
        tags,
        allTags: response.allTags ?? tags,
        source: response.live ? 'live' : 'cache',
        fetchedAt: response.fetchedAt,
        truncated: response.truncated,
        truncatedReason: response.truncatedReason,
      };
    })
    .catch(() => UNAVAILABLE)
    .then((state) => {
      cache.set(name, { state, cachedAtMs: Date.now() });
      inFlight.delete(name);
      return state;
    });

  inFlight.set(name, request);
  return request;
}

/** Test-only: clears this module's cache/in-flight state so tests don't leak state into each other. Not exported from the package's public surface in spirit (there is no barrel file to gate it from), but every real caller has no reason to call it. */
export function _resetCimgTagsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
