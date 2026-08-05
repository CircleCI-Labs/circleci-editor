import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_URL,
  startHostLivenessWatch,
  useHostLiveness,
} from './hostLiveness';

/**
 * jsdom (this project's Vitest environment) has no `EventSource`
 * implementation at all, so every test here supplies its own fake and
 * drives it directly -- there is no real network stack underneath to
 * simulate a dropped connection with. `instances` lets a test reach the
 * fake `EventSource` the code under test constructed, the same role a
 * mocked `fetch`'s call args would play elsewhere in this codebase.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startHostLivenessWatch', () => {
  it('connects to the heartbeat endpoint', () => {
    startHostLivenessWatch(() => {});

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(HEARTBEAT_URL);
  });

  it('reports alive when the connection opens', () => {
    const onChange = vi.fn<(alive: boolean) => void>();
    startHostLivenessWatch(onChange);

    FakeEventSource.instances[0]?.onopen?.();

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reports not-alive the instant the connection errors', () => {
    const onChange = vi.fn<(alive: boolean) => void>();
    startHostLivenessWatch(onChange);

    FakeEventSource.instances[0]?.onerror?.();

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('self-heals: an error followed by a successful reconnect reports alive again', () => {
    const onChange = vi.fn<(alive: boolean) => void>();
    startHostLivenessWatch(onChange);
    const source = FakeEventSource.instances[0];

    source?.onerror?.();
    source?.onopen?.(); // EventSource's own automatic-reconnect succeeding

    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });

  it('stop() closes the underlying connection', () => {
    const handle = startHostLivenessWatch(() => {});
    handle.stop();

    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});

describe('useHostLiveness', () => {
  it('starts optimistic (true) before any event has arrived', () => {
    const { result } = renderHook(() => useHostLiveness());
    expect(result.current).toBe(true);
  });

  it('flips to false on error and back to true once reconnected', () => {
    const { result } = renderHook(() => useHostLiveness());
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onerror?.();
    });
    expect(result.current).toBe(false);

    act(() => {
      source?.onopen?.();
    });
    expect(result.current).toBe(true);
  });

  it('closes its EventSource on unmount', () => {
    const { unmount } = renderHook(() => useHostLiveness());
    const source = FakeEventSource.instances[0];

    unmount();

    expect(source?.closed).toBe(true);
  });
});
