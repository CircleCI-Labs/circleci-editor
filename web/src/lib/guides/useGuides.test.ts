import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuidesResponse } from './types';
import { __resetGuidesCacheForTests, useGuides } from './useGuides';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_RESPONSE: GuidesResponse = {
  available: true,
  guides: [],
  provenance: {
    repo: 'circleci/circleci-docs',
    commit: 'aaaa',
    committedAt: '2026-07-01T00:00:00Z',
    fetchedAt: '2026-07-01T00:00:00Z',
    source: 'vendored',
    refreshing: false,
  },
  links: [],
};

describe('useGuides (issue #285)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetGuidesCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves the initial fetch into `response`', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, BASE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGuides());
    expect(result.current.response).toBeUndefined();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.response?.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('refresh');
  });

  it('refresh() sends refresh=1 and immediately reflects a Refreshing response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, BASE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...BASE_RESPONSE,
          provenance: { ...BASE_RESPONSE.provenance, refreshing: true },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGuides());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('refresh=1');
    expect(result.current.response?.provenance.refreshing).toBe(true);
  });

  it('refresh() is a no-op while a check is already reported in flight', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        ...BASE_RESPONSE,
        provenance: { ...BASE_RESPONSE.provenance, refreshing: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGuides());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterLoad = fetchMock.mock.calls.length;

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // No timers were advanced, so the polling effect's own interval (which
    // is allowed to ask again while Refreshing is true) has not fired
    // either -- this checks specifically that calling refresh() itself adds
    // no request while one is already reported in flight.
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  it('polls until Refreshing clears, then stops', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, BASE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...BASE_RESPONSE,
          provenance: { ...BASE_RESPONSE.provenance, refreshing: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...BASE_RESPONSE,
          provenance: { ...BASE_RESPONSE.provenance, refreshing: true },
        }),
      )
      .mockResolvedValue(
        jsonResponse(200, {
          ...BASE_RESPONSE,
          provenance: {
            ...BASE_RESPONSE.provenance,
            refreshing: false,
            fetchedAt: '2026-07-30T00:00:00Z',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGuides());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.response?.provenance.refreshing).toBe(true);

    // Two poll ticks: still refreshing, then cleared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.response?.provenance.refreshing).toBe(false);
    expect(result.current.response?.provenance.fetchedAt).toBe(
      '2026-07-30T00:00:00Z',
    );

    const callsAtClear = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAtClear); // polling stopped once Refreshing cleared.
  });

  it('a rejected refresh fetch degrades to an explanatory response rather than staying stuck refreshing', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, BASE_RESPONSE))
      .mockRejectedValueOnce(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGuides());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.response?.available).toBe(false);
    expect(result.current.response?.provenance.refreshing).toBe(false);
  });
});
