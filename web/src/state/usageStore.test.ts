import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedUsageWindowDays,
  useUsageStore,
  writePersistedUsageWindowDays,
} from './usageStore';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RESET_STATE = {
  fetchState: 'idle' as const,
  status: null,
  jobs: [],
  reason: null,
  windowDays: 7 as const,
};

describe('usageStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUsageStore.setState(RESET_STATE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensureFetched issues exactly one request per session', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { available: true, jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    useUsageStore.getState().ensureFetched();
    useUsageStore.getState().ensureFetched();
    useUsageStore.getState().ensureFetched();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/usage/),
      expect.anything(),
    );
  });

  it('folds a successful, available response into status/jobs', async () => {
    const response = {
      available: true,
      status: { ready: true, warming: false, state: 'ready', windowDays: 7 },
      jobs: [
        {
          jobName: 'build',
          resourceClass: 'large',
          executor: 'docker',
          operatingSystem: 'linux',
          runs: 5,
          avgMedianCpuPct: 20,
          avgMaxCpuPct: 30,
          maxMaxCpuPct: 35,
          avgMedianRamPct: 40,
          avgMaxRamPct: 50,
          maxMaxRamPct: 55,
          computeCredits: 1,
          totalCredits: 1,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, response)),
    );

    useUsageStore.getState().ensureFetched();
    await vi.waitFor(() =>
      expect(useUsageStore.getState().fetchState).toBe('ready'),
    );

    expect(useUsageStore.getState().jobs).toEqual(response.jobs);
    expect(useUsageStore.getState().status?.state).toBe('ready');
  });

  it('reports available: false as unavailable, distinct from an empty jobs list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(200, { available: false, reason: 'no token' }),
        ),
    );

    useUsageStore.getState().ensureFetched();
    await vi.waitFor(() =>
      expect(useUsageStore.getState().fetchState).toBe('unavailable'),
    );

    expect(useUsageStore.getState().reason).toBe('no token');
    expect(useUsageStore.getState().jobs).toEqual([]);
  });

  it('reports a transport failure as error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')),
    );

    useUsageStore.getState().ensureFetched();
    await vi.waitFor(() =>
      expect(useUsageStore.getState().fetchState).toBe('error'),
    );

    expect(useUsageStore.getState().reason).toBe('network down');
  });

  it('refresh is a no-op while a warm cycle is already in progress', async () => {
    useUsageStore.setState({
      status: {
        ready: true,
        warming: true,
        state: 'fetching',
        windowDays: 7,
      },
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    useUsageStore.getState().refresh();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('setWindowDays persists the choice, is a no-op for the same value, and re-fetches on a real change', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { available: true, jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    useUsageStore.getState().setWindowDays(7); // already the default -- no-op.
    expect(fetchMock).not.toHaveBeenCalled();

    useUsageStore.getState().setWindowDays(30);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('window=30'),
      expect.anything(),
    );
    expect(useUsageStore.getState().windowDays).toBe(30);
    expect(readPersistedUsageWindowDays()).toBe(30);
  });

  it('readPersistedUsageWindowDays falls back to 7 for anything unparseable', () => {
    window.localStorage.setItem('vce.usageWindowDays', 'not json');
    expect(readPersistedUsageWindowDays()).toBe(7);

    window.localStorage.setItem(
      'vce.usageWindowDays',
      JSON.stringify({ schemaVersion: 999, windowDays: 30 }),
    );
    expect(readPersistedUsageWindowDays()).toBe(7);
  });

  it('writePersistedUsageWindowDays round-trips through readPersistedUsageWindowDays', () => {
    writePersistedUsageWindowDays(14);
    expect(readPersistedUsageWindowDays()).toBe(14);
  });
});
