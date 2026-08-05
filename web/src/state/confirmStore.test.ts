import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIRM_SCHEMA_VERSION,
  CONFIRM_STORAGE_KEY,
  buildDefaultConfirmPrefs,
  readPersistedConfirmPrefs,
  useConfirmStore,
  writePersistedConfirmPrefs,
} from './confirmStore';

beforeEach(() => {
  window.localStorage.clear();
  useConfirmStore.setState({ suppressed: [] });
});

describe('readPersistedConfirmPrefs', () => {
  it('defaults to asking about everything on a first run', () => {
    expect(readPersistedConfirmPrefs()).toEqual(buildDefaultConfirmPrefs());
    expect(buildDefaultConfirmPrefs().suppressed).toEqual([]);
  });

  it('round-trips a written value', () => {
    writePersistedConfirmPrefs({
      schemaVersion: CONFIRM_SCHEMA_VERSION,
      suppressed: ['renameJob'],
    });
    expect(readPersistedConfirmPrefs().suppressed).toEqual(['renameJob']);
  });

  it('falls back to asking on unparseable JSON', () => {
    window.localStorage.setItem(CONFIRM_STORAGE_KEY, '{not json');
    expect(readPersistedConfirmPrefs().suppressed).toEqual([]);
  });

  it('falls back to asking on a schema-version mismatch', () => {
    window.localStorage.setItem(
      CONFIRM_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: CONFIRM_SCHEMA_VERSION + 1,
        suppressed: ['renameJob'],
      }),
    );
    // "Ask" is always the safe direction for a value we can't interpret: one
    // extra prompt, never a silently-suppressed one.
    expect(readPersistedConfirmPrefs().suppressed).toEqual([]);
  });

  it('falls back to asking on an unrecognised kind rather than keeping the rest', () => {
    window.localStorage.setItem(
      CONFIRM_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: CONFIRM_SCHEMA_VERSION,
        suppressed: ['renameJob', 'somethingFromTheFuture'],
      }),
    );
    expect(readPersistedConfirmPrefs().suppressed).toEqual([]);
  });

  it('never throws when localStorage itself does', () => {
    const spy = vi
      .spyOn(window.localStorage, 'getItem')
      .mockImplementation(() => {
        throw new Error('private browsing');
      });
    expect(readPersistedConfirmPrefs().suppressed).toEqual([]);
    spy.mockRestore();
  });
});

describe('writePersistedConfirmPrefs', () => {
  it('swallows a storage failure so the session-local choice still holds', () => {
    const spy = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });
    expect(() =>
      writePersistedConfirmPrefs({
        schemaVersion: CONFIRM_SCHEMA_VERSION,
        suppressed: ['renameJob'],
      }),
    ).not.toThrow();
    spy.mockRestore();
  });
});

describe('useConfirmStore', () => {
  it('suppress/isSuppressed/unsuppress round-trip, and persist', () => {
    const { suppress, isSuppressed, unsuppress } = useConfirmStore.getState();

    expect(isSuppressed('renameJob')).toBe(false);
    suppress('renameJob');
    expect(useConfirmStore.getState().isSuppressed('renameJob')).toBe(true);
    expect(readPersistedConfirmPrefs().suppressed).toEqual(['renameJob']);

    unsuppress('renameJob');
    expect(useConfirmStore.getState().isSuppressed('renameJob')).toBe(false);
    expect(readPersistedConfirmPrefs().suppressed).toEqual([]);
  });

  it('suppress is idempotent and does not duplicate the entry', () => {
    useConfirmStore.getState().suppress('renameJob');
    useConfirmStore.getState().suppress('renameJob');
    expect(useConfirmStore.getState().suppressed).toEqual(['renameJob']);
  });

  it('unsuppressing something that was never suppressed is a no-op', () => {
    const before = useConfirmStore.getState().suppressed;
    useConfirmStore.getState().unsuppress('renameJob');
    expect(useConfirmStore.getState().suppressed).toBe(before);
  });
});
