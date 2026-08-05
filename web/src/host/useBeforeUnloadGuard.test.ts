import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAppStore } from '~/state/appStore';

import { useBeforeUnloadGuard } from './useBeforeUnloadGuard';

/** Fires a real `beforeunload` event and returns whether something asked the browser to confirm -- via either half of the "both required by some browser" contract the hook itself documents. */
function dispatchBeforeUnload(): {
  defaultPrevented: boolean;
  returnValue: unknown;
} {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return {
    defaultPrevented: event.defaultPrevented,
    returnValue: (event as BeforeUnloadEvent).returnValue,
  };
}

/** A `docCache` entry: only `isDirty` matters here, so the rest is filled in as an empty document. */
function cachedDoc(isDirty: boolean) {
  return {
    doc: null,
    text: '',
    savedText: '',
    parseError: null,
    isDirty,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    validation: { state: 'idle' as const, errors: [] },
    editError: null,
    selectedWorkflow: null,
    selectedNodeId: null,
    workflowSelected: false,
  };
}

describe('useBeforeUnloadGuard', () => {
  beforeEach(() => {
    useAppStore.setState({
      isDirty: false,
      configPath: '/repo/.circleci/config.yml',
      docCache: {},
    });
  });

  it('does not intercept beforeunload when there are no unsaved changes', () => {
    renderHook(() => useBeforeUnloadGuard());

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(false);
  });

  it('intercepts beforeunload while isDirty is true', () => {
    useAppStore.setState({ isDirty: true });
    renderHook(() => useBeforeUnloadGuard());

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(true);
  });

  it('stops intercepting once the store becomes clean again (e.g. after a save)', () => {
    useAppStore.setState({ isDirty: true });
    const { rerender } = renderHook(() => useBeforeUnloadGuard());

    act(() => {
      useAppStore.setState({ isDirty: false });
    });
    rerender();

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(false);
  });

  it('removes its listener on unmount', () => {
    useAppStore.setState({ isDirty: true });
    const { unmount } = renderHook(() => useBeforeUnloadGuard());
    unmount();

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(false);
  });

  // Issue #177: switching files does not discard the file you left (the
  // per-file document cache keeps its unsaved text), so closing the window
  // is the moment those edits are actually lost -- and the open file being
  // clean says nothing about them.
  it('intercepts beforeunload when a different, non-open file has unsaved changes', () => {
    useAppStore.setState({
      isDirty: false,
      configPath: '/repo/.circleci/config.yml',
      docCache: { '/repo/.circleci/continue-config.yml': cachedDoc(true) },
    });
    renderHook(() => useBeforeUnloadGuard());

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(true);
  });

  it('does not intercept when every cached file is clean', () => {
    useAppStore.setState({
      isDirty: false,
      configPath: '/repo/.circleci/config.yml',
      docCache: { '/repo/.circleci/continue-config.yml': cachedDoc(false) },
    });
    renderHook(() => useBeforeUnloadGuard());

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(false);
  });

  // The spurious-prompt trap the issue warns about, and the reason
  // `hasUnsavedChanges` skips the active path: `switchFile` leaves a cache
  // entry in place for the file it switches *to*, so that entry can still
  // say "dirty" about edits which have since been saved. The live top-level
  // `isDirty` is the only current answer for the open file.
  it('does not intercept on a saved open file whose stale cache entry still says dirty', () => {
    useAppStore.setState({
      isDirty: false,
      configPath: '/repo/.circleci/config.yml',
      docCache: { '/repo/.circleci/config.yml': cachedDoc(true) },
    });
    renderHook(() => useBeforeUnloadGuard());

    const { defaultPrevented } = dispatchBeforeUnload();
    expect(defaultPrevented).toBe(false);
  });

  it('starts intercepting when another file becomes dirty while mounted', () => {
    const { rerender } = renderHook(() => useBeforeUnloadGuard());
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    act(() => {
      useAppStore.setState({
        docCache: { '/repo/.circleci/continue-config.yml': cachedDoc(true) },
      });
    });
    rerender();

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });
});
