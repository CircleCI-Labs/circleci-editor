import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';

import {
  _resetOrbSearchCacheForTests,
  fetchOrbSearch,
  getCachedOrbSearch,
} from './orbSearch';

vi.mock('~/lib/rpc/client', () => ({ searchOrbs: vi.fn<() => void>() }));

const NODE_RESULT: rpcClient.OrbSearchResult = {
  name: 'circleci/node',
  private: false,
  certified: true,
  listed: true,
  latestVersion: '5.2.0',
  versions: ['5.2.0', '5.1.0'],
  matchedOn: 'exact-name',
};

describe('orbSearch', () => {
  beforeEach(() => {
    _resetOrbSearchCacheForTests();
    vi.mocked(rpcClient.searchOrbs).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getCachedOrbSearch returns undefined before anything has been fetched', () => {
    expect(getCachedOrbSearch('node')).toBeUndefined();
  });

  it('fetchOrbSearch resolves a successful search and caches it for getCachedOrbSearch', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [NODE_RESULT],
    });

    const result = await fetchOrbSearch('node');

    expect(result).toEqual({ results: [NODE_RESULT], available: true });
    expect(getCachedOrbSearch('node')).toEqual(result);
    expect(rpcClient.searchOrbs).toHaveBeenCalledWith('node', 20);
  });

  it("preserves the host's result order exactly -- never re-sorts", async () => {
    const b = { ...NODE_RESULT, name: 'circleci/b' };
    const a = { ...NODE_RESULT, name: 'circleci/a' };
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [b, a], // deliberately not alphabetical -- the host decided this order
    });

    const result = await fetchOrbSearch('x');
    expect(result.results.map((r) => r.name)).toEqual([
      'circleci/b',
      'circleci/a',
    ]);
  });

  it('resolves to unavailable (never rejects) when the host reports available: false (no token)', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: false,
      reason: 'no CircleCI API token available; orb search requires a token',
    });

    const result = await fetchOrbSearch('node');
    expect(result).toEqual({
      results: [],
      available: false,
      reason: 'no CircleCI API token available; orb search requires a token',
    });
  });

  it('resolves to unavailable (never rejects) when the underlying request throws', async () => {
    vi.mocked(rpcClient.searchOrbs).mockRejectedValue(
      new Error('network error'),
    );

    const result = await fetchOrbSearch('node');
    expect(result).toEqual({ results: [], available: false });
  });

  it('de-duplicates concurrent calls for the same query into a single request', async () => {
    let resolveFetch!: (value: rpcClient.OrbSearchResponse) => void;
    vi.mocked(rpcClient.searchOrbs).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = fetchOrbSearch('node');
    const second = fetchOrbSearch('node');

    resolveFetch({ available: true, results: [NODE_RESULT] });

    await expect(first).resolves.toEqual(await second);
    expect(rpcClient.searchOrbs).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh browser-side cache hit without a second request', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [NODE_RESULT],
    });

    await fetchOrbSearch('node');
    await fetchOrbSearch('node');

    expect(rpcClient.searchOrbs).toHaveBeenCalledTimes(1);
  });

  it('treats queries differing only in case as the same cache entry', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [NODE_RESULT],
    });

    await fetchOrbSearch('Node');
    await fetchOrbSearch('node');

    expect(rpcClient.searchOrbs).toHaveBeenCalledTimes(1);
  });

  it('tracks each query independently', async () => {
    vi.mocked(rpcClient.searchOrbs).mockImplementation((query) =>
      Promise.resolve({
        available: true,
        results: [{ ...NODE_RESULT, name: `circleci/${query}` }],
      }),
    );

    const node = await fetchOrbSearch('node');
    const slack = await fetchOrbSearch('slack');

    expect(node.results[0]?.name).toBe('circleci/node');
    expect(slack.results[0]?.name).toBe('circleci/slack');
    expect(getCachedOrbSearch('node')?.results[0]?.name).toBe('circleci/node');
    expect(getCachedOrbSearch('slack')?.results[0]?.name).toBe(
      'circleci/slack',
    );
  });

  it('caches an unavailable (no-token) result too, so re-typing on a tokenless host does not re-fire a request for the exact same query', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({ available: false });

    await fetchOrbSearch('node');
    await fetchOrbSearch('node');

    expect(rpcClient.searchOrbs).toHaveBeenCalledTimes(1);
  });
});
