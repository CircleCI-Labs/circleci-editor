import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetOrbDescriptionPrefetchForTests, useOrbStore } from './orbStore';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RESET_STATE = {
  query: '',
  results: [],
  status: null,
  searchState: 'idle' as const,
  reason: null,
  selectedOrb: null,
  loadingOrb: false,
  error: null,
  parsedOrbs: {},
  orbVersionsCache: {},
};

describe('orbStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useOrbStore.setState(RESET_STATE);
    resetOrbDescriptionPrefetchForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('debounces search: rapid calls only fire one request, ~250ms after the last one', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { available: true, status: null, results: [] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    useOrbStore.getState().search('n');
    await vi.advanceTimersByTimeAsync(100);
    useOrbStore.getState().search('no');
    await vi.advanceTimersByTimeAsync(100);
    useOrbStore.getState().search('node');
    await vi.advanceTimersByTimeAsync(260);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('q=node'),
      expect.anything(),
    );
    expect(useOrbStore.getState().query).toBe('node');
  });

  it('discards a stale response that resolves after a newer search has already fired', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      if (!resolveFirst) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        jsonResponse(200, {
          available: true,
          status: null,
          results: [
            {
              name: 'circleci/second',
              private: false,
              certified: false,
              latestVersion: '1.0.0',
              versions: ['1.0.0'],
              matchedOn: 'name',
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    useOrbStore.getState().search('first');
    await vi.advanceTimersByTimeAsync(260); // first request fires and is left pending

    useOrbStore.getState().search('second');
    await vi.advanceTimersByTimeAsync(260); // second request fires and resolves

    // Now let the first (stale) request resolve.
    resolveFirst?.(
      jsonResponse(200, {
        available: true,
        status: null,
        results: [
          {
            name: 'circleci/first',
            private: false,
            certified: false,
            latestVersion: '1.0.0',
            versions: ['1.0.0'],
            matchedOn: 'name',
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(useOrbStore.getState().results.map((r) => r.name)).toEqual([
      'circleci/second',
    ]);
  });

  it('an empty query still searches, so the panel can browse certified orbs', async () => {
    // The host answers an empty query with the certified orbs. Short-circuiting
    // it client-side would leave the browser showing nothing on first open.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        status: { ready: true, complete: false, count: 79, warming: true },
        results: [
          {
            name: 'circleci/node',
            private: false,
            certified: true,
            latestVersion: '7.2.1',
            versions: ['7.2.1'],
            matchedOn: 'default',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    useOrbStore.getState().search('');
    await vi.advanceTimersByTimeAsync(260);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    expect(useOrbStore.getState().searchState).toBe('ready');
    expect(useOrbStore.getState().results.map((r) => r.name)).toEqual([
      'circleci/node',
    ]);
  });

  // Issue #285: the manual "check now" refresh, and the client-side half of
  // its rate-limit requirement (the host's own orbs.Cache.Refresh no-ops
  // too, but this store must not even issue the request when it already
  // knows a crawl is running).
  describe('refresh (issue #285)', () => {
    it('re-runs the current query/filter with refresh=1, immediately (not debounced)', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: { ready: true, complete: true, count: 1, warming: false },
          results: [],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.setState({ query: 'node', filter: 'certified' });
      useOrbStore.getState().refresh();
      // No advanceTimersByTimeAsync: a refresh click is a discrete action,
      // not a keystroke, so it must not wait out SEARCH_DEBOUNCE_MS.
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain('q=node');
      expect(url).toContain('filter=certified');
      expect(url).toContain('refresh=1');
    });

    it('is a no-op while the cache is already warming', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.setState({
        status: {
          ready: true,
          complete: false,
          count: 1,
          warming: true,
          certifiedCount: 0,
          privateCount: 0,
        },
      });
      useOrbStore.getState().refresh();
      await Promise.resolve();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an ordinary debounced search never sends refresh=1', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(200, { available: true, status: null, results: [] }),
        );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().search('node');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).not.toContain('refresh');
    });
  });

  // Issue #89: the version `<select>` reads `orbVersionsCache`, not
  // `results` directly, precisely so it survives the user typing a
  // different query while an orb's detail is still open.
  describe('orbVersionsCache (issue #89)', () => {
    it('is populated from a search response, keyed by orb name', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: null,
          results: [
            {
              name: 'circleci/node',
              private: false,
              certified: true,
              latestVersion: '5.2.0',
              versions: ['5.2.0', '5.1.0', '5.0.0'],
              matchedOn: 'exact-full-name',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().search('node');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();

      expect(useOrbStore.getState().orbVersionsCache['circleci/node']).toEqual({
        versions: ['5.2.0', '5.1.0', '5.0.0'],
        latestVersion: '5.2.0',
      });
    });

    it('keeps an already-cached orb entry once a later search no longer carries it', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = String(input);
        const q = new URLSearchParams(url.split('?')[1]).get('q');
        const results =
          q === 'node'
            ? [
                {
                  name: 'circleci/node',
                  private: false,
                  certified: true,
                  latestVersion: '5.2.0',
                  versions: ['5.2.0', '5.1.0'],
                  matchedOn: 'exact-full-name',
                },
              ]
            : [
                {
                  name: 'circleci/slack',
                  private: false,
                  certified: true,
                  latestVersion: '4.12.0',
                  versions: ['4.12.0'],
                  matchedOn: 'exact-full-name',
                },
              ];
        return Promise.resolve(
          jsonResponse(200, { available: true, status: null, results }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().search('node');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();

      // A second, unrelated search whose results don't include
      // "circleci/node" at all -- exactly the scenario where the old
      // "derive the version list from `results`" approach would have gone
      // back to showing just one version for an orb whose detail is still
      // open.
      useOrbStore.getState().search('slack');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();

      expect(useOrbStore.getState().results.map((r) => r.name)).toEqual([
        'circleci/slack',
      ]);
      expect(useOrbStore.getState().orbVersionsCache['circleci/node']).toEqual({
        versions: ['5.2.0', '5.1.0'],
        latestVersion: '5.2.0',
      });
    });

    it('does not cache a reserved orb name with no published versions', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          status: null,
          results: [
            {
              name: 'someone/reserved',
              private: false,
              certified: false,
              latestVersion: '',
              versions: [],
              matchedOn: 'exact-full-name',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().search('reserved');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();

      expect(
        useOrbStore.getState().orbVersionsCache['someone/reserved'],
      ).toBeUndefined();
    });

    // The host resolves /api/orbs/source via a live, single-name lookup
    // that (per that endpoint's own doc comment) the real CircleCI API
    // answers with an orb's *complete* version history -- unlike
    // /api/orbs/search, which ranks against a crawled cache that often
    // only has each package's newest version embedded. selectOrb/loadOrb
    // must apply this authoritative list even when it's richer than
    // whatever a prior search already cached.
    it("selectOrb upgrades a reduced search-derived entry with the source response's fuller version list", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = String(input);
        if (url.includes('/api/orbs/source')) {
          return Promise.resolve(
            jsonResponse(200, {
              available: true,
              name: 'circleci/node',
              version: '5.2.0',
              source: 'jobs:\n  test:\n    steps: []\n',
              versions: ['5.2.0', '5.1.0', '5.0.0'],
              latestVersion: '5.2.0',
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            available: true,
            status: null,
            results: [
              {
                name: 'circleci/node',
                private: false,
                certified: true,
                latestVersion: '5.2.0',
                versions: ['5.2.0'], // reduced, as the crawled cache often is
                matchedOn: 'exact-full-name',
              },
            ],
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().search('node');
      await vi.advanceTimersByTimeAsync(260);
      await Promise.resolve();
      expect(useOrbStore.getState().orbVersionsCache['circleci/node']).toEqual({
        versions: ['5.2.0'],
        latestVersion: '5.2.0',
      });

      await useOrbStore.getState().selectOrb('circleci/node', '5.2.0');

      expect(useOrbStore.getState().orbVersionsCache['circleci/node']).toEqual({
        versions: ['5.2.0', '5.1.0', '5.0.0'],
        latestVersion: '5.2.0',
      });
    });

    it('loadOrb also populates orbVersionsCache from the source response', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'jobs: {}\n',
          versions: ['5.2.0', '5.1.0'],
          latestVersion: '5.2.0',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await useOrbStore.getState().loadOrb('circleci/node', '5.2.0');

      expect(useOrbStore.getState().orbVersionsCache['circleci/node']).toEqual({
        versions: ['5.2.0', '5.1.0'],
        latestVersion: '5.2.0',
      });
    });
  });

  it('available:false enters "unavailable" and surfaces the reason, never as zero results', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: false,
        source: 'unavailable',
        reason: 'no CircleCI API token available; orb search requires a token',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    useOrbStore.getState().search('node');
    await vi.advanceTimersByTimeAsync(260);
    await Promise.resolve();
    await Promise.resolve();

    expect(useOrbStore.getState().searchState).toBe('unavailable');
    expect(useOrbStore.getState().reason).toContain('token');
  });

  it('a fetch error enters "error"', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    useOrbStore.getState().search('node');
    await vi.advanceTimersByTimeAsync(260);
    await Promise.resolve();
    await Promise.resolve();

    expect(useOrbStore.getState().searchState).toBe('error');
    expect(useOrbStore.getState().error).toContain('network down');
  });

  it('selectOrb fetches, parses, and caches; a second identical select does not refetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        name: 'circleci/node',
        version: '5.2.0',
        source: 'description: Node.js orb\njobs:\n  test:\n    steps: []\n',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await useOrbStore.getState().selectOrb('circleci/node', '5.2.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      useOrbStore.getState().selectedOrb?.parsed.jobs.map((j) => j.name),
    ).toEqual(['test']);

    await useOrbStore.getState().selectOrb('circleci/node', '5.2.0');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit, no second request
  });

  it('selectOrb surfaces a fetch error via `error`', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);

    await useOrbStore.getState().selectOrb('circleci/broken');

    expect(useOrbStore.getState().loadingOrb).toBe(false);
    expect(useOrbStore.getState().error).toContain('boom');
  });

  it('selectOrb reports available:false as an error, not a crash', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: false,
        source: 'unavailable',
        reason: 'no token',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await useOrbStore.getState().selectOrb('circleci/node');

    expect(useOrbStore.getState().selectedOrb).toBeNull();
    expect(useOrbStore.getState().error).toContain('no token');
  });

  describe('loadOrb (issue #37)', () => {
    it('fetches, parses, and caches without touching selectedOrb/loadingOrb/error', () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'jobs:\n  test:\n    steps: []\n',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      return useOrbStore
        .getState()
        .loadOrb('circleci/node', '5.2.0')
        .then((parsed) => {
          expect(parsed.jobs.map((j) => j.name)).toEqual(['test']);
          expect(useOrbStore.getState().selectedOrb).toBeNull();
          expect(useOrbStore.getState().loadingOrb).toBe(false);
          expect(useOrbStore.getState().error).toBeNull();
        });
    });

    it('a second call with the same name/version hits the cache -- no second fetch', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'jobs: {}\n',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await useOrbStore.getState().loadOrb('circleci/node', '5.2.0');
      await useOrbStore.getState().loadOrb('circleci/node', '5.2.0');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares its cache with selectOrb -- selecting an orb already loaded via loadOrb does not refetch', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'jobs: {}\n',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await useOrbStore.getState().loadOrb('circleci/node', '5.2.0');
      await useOrbStore.getState().selectOrb('circleci/node', '5.2.0');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Regression check: selectOrb's cache-hit path used to rebuild `name`
      // from the parsed orb's bare `orbName` (e.g. "node", dropping the
      // "circleci/" namespace -- see parseOrbRef), which this exact
      // loadOrb-then-selectOrb cache-hit sequence triggers. It must report
      // the full name that was actually asked for.
      expect(useOrbStore.getState().selectedOrb?.name).toBe('circleci/node');
    });

    it('throws (rather than mutating shared error state) when the host is unavailable', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: false,
          source: 'unavailable',
          reason: 'no token',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        useOrbStore.getState().loadOrb('circleci/node'),
      ).rejects.toThrow(/no token/);
      expect(useOrbStore.getState().error).toBeNull();
    });
  });

  describe('prefetchDescription (issue #50)', () => {
    it('fetches and caches a description under the same key selectOrb/loadOrb use', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'description: Node.js orb\njobs: {}\n',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().prefetchDescription('circleci/node', '5.2.0');
      await vi.waitFor(() => {
        expect(
          useOrbStore.getState().parsedOrbs['circleci/node@5.2.0']?.description,
        ).toBe('Node.js orb');
      });
    });

    it('is a no-op (no second fetch) once the description is already cached', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          available: true,
          name: 'circleci/node',
          version: '5.2.0',
          source: 'description: Node.js orb\njobs: {}\n',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().prefetchDescription('circleci/node', '5.2.0');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      useOrbStore.getState().prefetchDescription('circleci/node', '5.2.0');
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never surfaces a failure via the shared `error` field -- it is a background enhancement, not a user action', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      useOrbStore.getState().prefetchDescription('circleci/broken', '1.0.0');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      expect(useOrbStore.getState().error).toBeNull();
      expect(
        useOrbStore.getState().parsedOrbs['circleci/broken@1.0.0'],
      ).toBeUndefined();
    });

    it('caps concurrency: a 5th prefetch does not fetch until one of the first 4 in-flight ones settles', async () => {
      const resolvers: Array<(response: Response) => void> = [];
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 5; i++) {
        useOrbStore.getState().prefetchDescription(`circleci/orb${i}`, '1.0.0');
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(4); // MAX_CONCURRENT_DESCRIPTION_FETCHES

      resolvers[0]?.(
        jsonResponse(200, {
          available: true,
          name: 'circleci/orb0',
          version: '1.0.0',
          source: 'jobs: {}\n',
        }),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    });
  });
});
