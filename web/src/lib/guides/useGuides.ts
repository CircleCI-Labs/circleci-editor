/**
 * Shared, session-cached accessor for the parsed CircleCI guides (issue #104),
 * modelled on `~/lib/schema/useCircleciSchema` for the same reason: the pane
 * that reads it can remount (a preset switch, a pane move), and re-fetching a
 * ~500 KB payload on every remount would be wasteful and would flash the pane
 * blank each time.
 *
 * The state machine has exactly three states and no fourth:
 *
 *  - `undefined` — the one fetch is in flight. The only moment a spinner is
 *    correct.
 *  - a response with `available: true` — content, plus provenance.
 *  - a response with `available: false` and a `reason` — an *explanatory* pane
 *    with links out to the live docs.
 *
 * A rejected fetch (the host gone, a transport error) resolves to the third
 * state rather than staying pending, so there is no path to a spinner that
 * never resolves. That is the project-wide "degrade honestly" invariant, and it
 * is enforced here rather than in the component so no future caller can miss
 * it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getGuides } from '~/lib/rpc/client';

import type { GuidesResponse } from './types';

/**
 * What the pane falls back to when even the request failed. Deliberately built
 * from the same `links` shape the host sends, so the pane has exactly one
 * rendering path for "no content, here's where to read it" whether the host
 * answered or not.
 *
 * The URLs are the canonical post-redirect ones from `~/lib/docs/docsLinks`,
 * so this fallback is covered by that module's live link check rather
 * than being a second, unverified table.
 */
function unreachableHostResponse(reason: string): GuidesResponse {
  return {
    available: false,
    reason,
    provenance: {
      repo: 'circleci/circleci-docs',
      commit: '',
      committedAt: '',
      fetchedAt: '',
      source: 'vendored',
      refreshing: false,
    },
    links: [
      {
        id: 'configuration-reference',
        label: 'Configuration reference',
        url: 'https://circleci.com/docs/reference/configuration-reference/',
      },
      {
        id: 'reusing-config',
        label: 'Reusable config',
        url: 'https://circleci.com/docs/reference/reusing-config/',
      },
      {
        id: 'dynamic-config',
        label: 'Dynamic config',
        url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
      },
    ],
  };
}

let cached: Promise<GuidesResponse> | null = null;

function loadGuides(): Promise<GuidesResponse> {
  cached ??= getGuides().catch(() =>
    unreachableHostResponse(
      "This app's own local server didn't return the built-in documentation guides.",
    ),
  );
  return cached;
}

/**
 * Test-only escape hatch: clears the module cache so the next `useGuides()`
 * call fetches again instead of replaying whatever the first test in a file
 * happened to get back. Mirrors
 * `__resetCircleciSchemaCacheForTests`.
 */
export function __resetGuidesCacheForTests(): void {
  cached = null;
}

// How long a manual refresh (see UseGuides.refresh below) is polled for
// before this hook stops asking, and how often. Mirrors the docs-MCP OAuth
// poll in `panes/ai/McpSettings.tsx` for the same reason: the outcome is
// decided on the host's own background goroutine, so the only way to learn
// it landed is to ask again. Two minutes comfortably covers a real refresh
// (a handful of small GitHub raw-content requests -- see
// `internal/guides/cache.go`'s refreshTimeout, which bounds the host side at
// ten minutes for a much larger worst case than this pane's three guides
// will ever hit); polling stops the moment `refreshing` clears, whether that
// took two seconds or the full two minutes.
const GUIDES_REFRESH_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const GUIDES_REFRESH_POLL_INTERVAL_MS = 2000;

export interface UseGuides {
  /** `undefined` while the at-most-once initial fetch is in flight; the response after. */
  response: GuidesResponse | undefined;
  /**
   * Triggers the host's manual "check now" refresh (issue #285) and polls
   * until it finishes. A no-op while one is already in flight (per this
   * hook's own last-known `provenance.refreshing`) -- the host's own
   * `guides.Cache.Refresh` no-ops too, but skipping the request here avoids
   * even that round trip, the same rate-limit courtesy `useOrbStore.refresh`
   * extends to the orb registry crawl.
   */
  refresh: () => void;
}

/** See `UseGuides`. */
export function useGuides(): UseGuides {
  const [response, setResponse] = useState<GuidesResponse | undefined>(
    undefined,
  );
  // Read inside the poll loop below without retriggering its effect on every
  // response -- only `refreshing`'s eventual transition to `false` should
  // stop it, not every fetch this hook makes.
  const responseRef = useRef(response);
  responseRef.current = response;

  useEffect(() => {
    let cancelled = false;
    loadGuides().then((resolved) => {
      if (!cancelled) setResponse(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    if (responseRef.current?.provenance?.refreshing) return;

    const next = getGuides(true).catch(() =>
      unreachableHostResponse(
        "This app's own local server didn't return the built-in documentation guides.",
      ),
    );
    cached = next;
    void next.then((resolved) => setResponse(resolved));
  }, []);

  // While the last-known state says a refresh is in flight, poll for its
  // outcome -- content or Error changing, Refreshing clearing -- exactly as
  // the automatic background refresh's own eventual landing is only ever
  // observed by asking again, never pushed.
  useEffect(() => {
    if (!response?.provenance?.refreshing) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > GUIDES_REFRESH_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }
      const next = getGuides().catch(() =>
        unreachableHostResponse(
          "This app's own local server didn't return the built-in documentation guides.",
        ),
      );
      cached = next;
      void next.then((resolved) => setResponse(resolved));
    }, GUIDES_REFRESH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [response?.provenance?.refreshing]);

  return { response, refresh };
}
