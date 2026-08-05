/**
 * Client-side state for the host's background-warmed Usage Export summary
 * (issue #307): what powers the palette's resource-class right-sizing
 * suggestions.
 *
 * Deliberately thin compared to `orbStore.ts`. There is no query to
 * debounce and no per-row prefetching -- `GET /api/usage` (see
 * `~/lib/rpc/client`) already answers with everything this app needs in one
 * response, because the host's cache does all the real work (warming in the
 * background from the moment it starts, delta-fetching, pruning) before
 * this store ever asks. `ensureFetched` exists so the first consumer that
 * needs this data (currently `RecommendationsSection`) triggers exactly one
 * fetch per session rather than every consumer fetching independently; it
 * is emphatically not what makes the underlying data fresh -- that is the
 * host's job, not this store's.
 *
 * `windowDays` is the one piece of state that *is* a user preference, and it
 * is persisted here, in `localStorage`, the same versioned-JSON convention
 * `themeStore.ts` uses -- not on the host, which has no other per-user
 * settings storage and would otherwise have to invent one just for this.
 */
import { create } from 'zustand';

import { getUsage } from '~/lib/rpc/client';
import type { UsageJobSummary, UsageStatus } from '~/lib/rpc/client';

/** The only window sizes the host accepts -- see `usage.ValidWindowDays` (internal/usage/cache.go), kept in sync deliberately rather than derived from a shared schema this small a value doesn't warrant. */
export const USAGE_WINDOW_OPTIONS = [7, 14, 30] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_OPTIONS)[number];
const DEFAULT_WINDOW_DAYS: UsageWindowDays = 7;

export const USAGE_WINDOW_SCHEMA_VERSION = 1;
export const USAGE_WINDOW_STORAGE_KEY = 'vce.usageWindowDays';

function isUsageWindowDays(value: unknown): value is UsageWindowDays {
  return (USAGE_WINDOW_OPTIONS as readonly number[]).includes(value as number);
}

interface PersistedUsageWindow {
  schemaVersion: number;
  windowDays: UsageWindowDays;
}

function isPersistedUsageWindow(value: unknown): value is PersistedUsageWindow {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === USAGE_WINDOW_SCHEMA_VERSION &&
    isUsageWindowDays(candidate.windowDays)
  );
}

/**
 * Reads the persisted window preference, falling back to
 * `DEFAULT_WINDOW_DAYS` for a first run, unparseable JSON, a schema-version
 * mismatch, an unrecognised value, or an environment where `localStorage`
 * throws (private browsing, a non-browser test environment). Never throws
 * -- mirrors `readPersistedThemePreference`'s own guarantee.
 */
export function readPersistedUsageWindowDays(): UsageWindowDays {
  try {
    const raw = window.localStorage.getItem(USAGE_WINDOW_STORAGE_KEY);
    if (raw === null) return DEFAULT_WINDOW_DAYS;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedUsageWindow(parsed)
      ? parsed.windowDays
      : DEFAULT_WINDOW_DAYS;
  } catch {
    return DEFAULT_WINDOW_DAYS;
  }
}

export function writePersistedUsageWindowDays(
  windowDays: UsageWindowDays,
): void {
  try {
    window.localStorage.setItem(
      USAGE_WINDOW_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: USAGE_WINDOW_SCHEMA_VERSION,
        windowDays,
      }),
    );
  } catch {
    // The choice still applies for the rest of this session even if it can't persist.
  }
}

/**
 * - `'idle'`: no fetch has been made yet this session.
 * - `'loading'`: a fetch (initial, refresh, or a window change) is in flight.
 * - `'ready'`: the host answered `available: true`. `status`/`jobs` carry
 *   its own honest state -- `'ready'` here only means "a response arrived",
 *   not that the underlying cache itself is warm; check `status.state` for
 *   that.
 * - `'unavailable'`: the host reported `available: false` (no token, or no
 *   resolvable organization) -- distinct from `'ready'` with empty `jobs`,
 *   which means the cache tried and found nothing.
 * - `'error'`: the request itself failed (network/transport/non-2xx).
 */
export type UsageFetchState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error';

interface UsageState {
  fetchState: UsageFetchState;
  status: UsageStatus | null;
  jobs: UsageJobSummary[];
  /** Set alongside `'unavailable'` or `'error'`; null otherwise. */
  reason: string | null;
  windowDays: UsageWindowDays;

  /** Fetches once per session (a no-op if a fetch already ran or is running) -- see this module's own doc comment for why. */
  ensureFetched: () => void;
  /** The manual "check now" affordance issue #285 established for every other cache. A no-op while `status?.warming` is already true, same guard `orbStore.refresh` uses. */
  refresh: () => void;
  /** Persists the new window and re-fetches with it -- a no-op if `days` is already the current window. */
  setWindowDays: (days: UsageWindowDays) => void;
}

export const useUsageStore = create<UsageState>((set, get) => {
  const fetch = (opts?: { refresh?: boolean; windowDays?: number }): void => {
    set({ fetchState: 'loading' });
    getUsage(opts)
      .then((response) => {
        if (!response.available) {
          set({
            fetchState: 'unavailable',
            reason: response.reason ?? null,
            status: null,
            jobs: [],
          });
          return;
        }
        set({
          fetchState: 'ready',
          status: response.status ?? null,
          jobs: response.jobs ?? [],
          reason: null,
        });
      })
      .catch((err: unknown) => {
        set({
          fetchState: 'error',
          reason:
            err instanceof Error ? err.message : 'Fetching usage data failed.',
          jobs: [],
        });
      });
  };

  return {
    fetchState: 'idle',
    status: null,
    jobs: [],
    reason: null,
    windowDays: readPersistedUsageWindowDays(),

    ensureFetched: () => {
      if (get().fetchState !== 'idle') return;
      fetch({ windowDays: get().windowDays });
    },

    refresh: () => {
      if (get().status?.warming) return;
      fetch({ refresh: true, windowDays: get().windowDays });
    },

    setWindowDays: (days: UsageWindowDays) => {
      if (days === get().windowDays) return;
      writePersistedUsageWindowDays(days);
      set({ windowDays: days });
      fetch({ windowDays: days });
    },
  };
});
