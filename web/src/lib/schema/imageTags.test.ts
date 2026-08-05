import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';

import {
  _resetCimgTagsCacheForTests,
  fetchCimgTags,
  getCachedCimgTags,
  refreshCimgTags,
} from './imageTags';

vi.mock('~/lib/rpc/client', () => ({ getDockerTags: vi.fn<() => void>() }));

describe('imageTags', () => {
  beforeEach(() => {
    _resetCimgTagsCacheForTests();
    vi.mocked(rpcClient.getDockerTags).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getCachedCimgTags returns undefined before anything has been fetched', () => {
    expect(getCachedCimgTags('node')).toBeUndefined();
  });

  it('fetchCimgTags resolves a live result and caches it for getCachedCimgTags', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0', '20.10.0'],
      allTags: ['20.11.2', '20.11.0', '20.11.0-browsers', '20.10.0'],
      fetchedAt: '2026-07-20T12:00:00Z',
      live: true,
    });

    const result = await fetchCimgTags('node');

    expect(result).toEqual({
      tags: ['20.11.0', '20.10.0'],
      allTags: ['20.11.2', '20.11.0', '20.11.0-browsers', '20.10.0'],
      source: 'live',
      fetchedAt: '2026-07-20T12:00:00Z',
    });
    expect(getCachedCimgTags('node')).toEqual(result);
    expect(rpcClient.getDockerTags).toHaveBeenCalledWith('node');
  });

  it('reports source "cache" when the host served a cache hit rather than a live fetch', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      fetchedAt: '2026-07-20T12:00:00Z',
      live: false,
    });

    const result = await fetchCimgTags('node');
    expect(result.source).toBe('cache');
  });

  it('resolves to "unavailable" (never rejects) when the host reports available:false', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: false,
      reason: 'could not reach Docker Hub',
    });

    const result = await fetchCimgTags('node');
    expect(result).toEqual({ tags: [], allTags: [], source: 'unavailable' });
  });

  it('resolves to "unavailable" (never rejects) when the underlying request throws', async () => {
    vi.mocked(rpcClient.getDockerTags).mockRejectedValue(
      new Error('network error'),
    );

    const result = await fetchCimgTags('node');
    expect(result).toEqual({ tags: [], allTags: [], source: 'unavailable' });
  });

  it('de-duplicates concurrent calls for the same image into a single request', async () => {
    let resolveFetch!: (value: rpcClient.DockerTagsResponse) => void;
    vi.mocked(rpcClient.getDockerTags).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = fetchCimgTags('node');
    const second = fetchCimgTags('node');

    resolveFetch({ available: true, tags: ['20.11.0'], live: true });

    await expect(first).resolves.toEqual(await second);
    expect(rpcClient.getDockerTags).toHaveBeenCalledTimes(1);
  });

  // Issue #285: the manual "check now" affordance.
  describe('refreshCimgTags', () => {
    it('sends refresh:true and updates the cache getCachedCimgTags serves', async () => {
      vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
        available: true,
        tags: ['20.12.0', '20.11.0'],
        fetchedAt: '2026-07-30T00:00:00Z',
        live: true,
      });

      const result = await refreshCimgTags('node');

      expect(rpcClient.getDockerTags).toHaveBeenCalledWith('node', true);
      expect(result.tags).toEqual(['20.12.0', '20.11.0']);
      expect(getCachedCimgTags('node')).toEqual(result);
    });

    it('bypasses a fresh browser-side cache entry rather than serving it', async () => {
      vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
        available: true,
        tags: ['20.11.0'],
        live: true,
      });
      await fetchCimgTags('node'); // populates the browser cache
      vi.mocked(rpcClient.getDockerTags).mockClear();

      vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
        available: true,
        tags: ['20.12.0'],
        live: true,
      });
      const result = await refreshCimgTags('node');

      expect(rpcClient.getDockerTags).toHaveBeenCalledTimes(1);
      expect(result.tags).toEqual(['20.12.0']);
    });

    it('never rejects, resolving to "unavailable" on failure', async () => {
      vi.mocked(rpcClient.getDockerTags).mockRejectedValue(
        new Error('network unreachable'),
      );
      await expect(refreshCimgTags('node')).resolves.toEqual({
        tags: [],
        allTags: [],
        source: 'unavailable',
      });
    });

    it('a concurrent ordinary fetchCimgTags call for the same image shares the refresh, not a second request', async () => {
      let resolveFetch!: (value: rpcClient.DockerTagsResponse) => void;
      vi.mocked(rpcClient.getDockerTags).mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const refreshing = refreshCimgTags('node');
      const ordinary = fetchCimgTags('node');

      resolveFetch({ available: true, tags: ['20.12.0'], live: true });

      await expect(refreshing).resolves.toEqual(await ordinary);
      expect(rpcClient.getDockerTags).toHaveBeenCalledTimes(1);
    });
  });

  it('serves a fresh browser-side cache hit without a second request', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      live: true,
    });

    await fetchCimgTags('node');
    await fetchCimgTags('node');

    expect(rpcClient.getDockerTags).toHaveBeenCalledTimes(1);
  });

  it('tracks each image independently', async () => {
    vi.mocked(rpcClient.getDockerTags).mockImplementation((name) =>
      Promise.resolve({ available: true, tags: [`${name}-tag`], live: true }),
    );

    const node = await fetchCimgTags('node');
    const python = await fetchCimgTags('python');

    expect(node.tags).toEqual(['node-tag']);
    expect(python.tags).toEqual(['python-tag']);
    expect(getCachedCimgTags('node')?.tags).toEqual(['node-tag']);
    expect(getCachedCimgTags('python')?.tags).toEqual(['python-tag']);
  });

  it('propagates a truncated fetch rather than silently dropping the flag (issue #243)', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      allTags: ['20.11.0'],
      truncated: true,
      truncatedReason: 'Docker Hub rate-limited this request (HTTP 429)',
      live: true,
    });

    const result = await fetchCimgTags('node');
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe(
      'Docker Hub rate-limited this request (HTTP 429)',
    );
  });

  it('does not report truncated for an ordinary, complete fetch', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      live: true,
    });

    const result = await fetchCimgTags('node');
    expect(result.truncated).toBeFalsy();
  });

  it('fills allTags from the ranked list when the host omits it', async () => {
    // A tag list the host cached before it served `allTags` -- see
    // `CimgTagsState.allTags`. Rather than bumping the disk cache's schema version
    // and discarding every user's warm cache to add one field, an entry without it
    // serves the ranked list for both, so the combobox is briefly shorter instead
    // of empty and no caller has to tell "this repo published nothing" apart from
    // "this entry predates the feature".
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['1.21.0'],
      fetchedAt: '2026-07-20T12:00:00Z',
      live: false,
    });

    const result = await fetchCimgTags('go');
    expect(result.allTags).toEqual(['1.21.0']);
  });
});
