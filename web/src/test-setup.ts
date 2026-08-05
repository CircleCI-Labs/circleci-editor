import '@testing-library/jest-dom/vitest';

// jsdom (this project's Vitest environment) implements no EventSource at
// all. Most tests never touch it directly, but since <App> now mounts
// `HostGoneOverlay` (issue #110), which opens one on mount via
// `useHostLiveness`, *every* test that renders <App/> needs some
// EventSource global to exist -- otherwise `new EventSource(...)` throws a
// bare ReferenceError before any test-specific assertion even runs. This
// no-op stand-in never calls onopen/onerror, so those tests simply see an
// always-alive host, which is what they want (they're not testing
// liveness). Tests that *do* care about liveness behavior (see
// src/host/hostLiveness.test.ts and HostGoneOverlay.test.tsx) install
// their own fake via `vi.stubGlobal('EventSource', ...)`, which shadows
// this default for the duration of that test and is restored afterward by
// `vi.unstubAllGlobals()`.
if (typeof globalThis.EventSource === 'undefined') {
  class NoopEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
  }
  // @ts-expect-error -- a minimal stand-in for jsdom's missing EventSource, not a full implementation of it.
  globalThis.EventSource = NoopEventSource;
}
