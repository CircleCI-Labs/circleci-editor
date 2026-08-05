/**
 * Detects whether the Go host process that served this page is still
 * running (issue #110). The failure this exists to catch: Ctrl-C in the
 * terminal (or the CLI plugin host that spawned it dying some other way)
 * does not close the browser window, and this single-page app holds the
 * entire document in memory -- so the DAG renders, the inspector edits,
 * and the YAML pane accepts typing exactly as before, with only Save
 * actually depending on the host. Left undetected, someone can work for a
 * while in a window that looks perfectly healthy and only discover the
 * tool is dead when Save fails.
 *
 * `GET /api/heartbeat` (see `internal/host/heartbeat.go`) is a
 * Server-Sent Events stream built specifically to make this detectable
 * without a polling loop of our own: `EventSource` keeps one connection
 * open for as long as this module is subscribed, and the browser itself
 * fires `open` the moment a connection succeeds and `error` the instant
 * one breaks, for *any* reason -- the host shutting down gracefully, the
 * process being killed outright, or the network otherwise dropping it.
 * After an `error`, `EventSource` keeps retrying on its own (the host
 * shortens that retry interval to 1s -- see the endpoint's own doc
 * comment) -- a retry that fails re-fires `error` (host still gone); one
 * that succeeds fires `open` again, which is what lets a momentary blip
 * self-heal instead of leaving a false "gone" banner stuck up forever.
 */
import { useEffect, useState } from 'react';

/** The URL `startHostLivenessWatch` subscribes to. Exported only so tests can assert against it without hardcoding the string twice. */
export const HEARTBEAT_URL = '/api/heartbeat';

export interface HostLivenessHandle {
  /** Stops watching and closes the underlying connection. Safe to call more than once. */
  stop: () => void;
}

/**
 * Subscribes to the host's heartbeat stream and calls `onChange(true)` /
 * `onChange(false)` whenever liveness flips. Returns a handle whose `stop`
 * must be called when the caller no longer needs the watch (e.g. on
 * unmount) -- an `EventSource` left open otherwise keeps retrying forever.
 *
 * A plain function (not a hook) on purpose: it has no React dependency at
 * all, so it's trivial to unit-test against a fake `EventSource` and reuse
 * from anywhere, including outside a component.
 */
export function startHostLivenessWatch(
  onChange: (alive: boolean) => void,
): HostLivenessHandle {
  const source = new EventSource(HEARTBEAT_URL);
  source.onopen = () => onChange(true);
  source.onerror = () => onChange(false);
  return {
    stop: () => source.close(),
  };
}

/**
 * React hook wrapping `startHostLivenessWatch`: `true` until the first
 * `error` is observed, matching the optimistic assumption that the host
 * that just served this page is still there -- the SSE connection this
 * hook opens on mount settles that within one round trip, well before a
 * user could plausibly have already lost the underlying process.
 */
export function useHostLiveness(): boolean {
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    const handle = startHostLivenessWatch(setAlive);
    return () => handle.stop();
  }, []);

  return alive;
}
