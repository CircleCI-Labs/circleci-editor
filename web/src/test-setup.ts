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

// jsdom implements no ResizeObserver either, and Radix's floating-element
// primitives construct one as soon as a popup actually opens. Components that
// merely *render* a tooltip trigger are unaffected, which is why this went
// unnoticed: the existing tooltip tests assert the trigger and stop there.
// Asserting what a tooltip *says* -- which is the whole point of the hover in
// `InfoHint` (issue #71) -- means opening one, and that throws
// "ResizeObserver is not defined" before any assertion runs.
//
// A no-op stand-in is the right shape rather than a shim that measures things:
// jsdom has no layout, so every measurement would be zero regardless, and no
// test here asserts tooltip *placement* -- only its content. Same reasoning as
// the EventSource stub above.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    NoopResizeObserver as unknown as typeof globalThis.ResizeObserver;
}
