import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INSPECTOR_SECTIONS_SCHEMA_VERSION,
  INSPECTOR_SECTIONS_STORAGE_KEY,
  readPersistedSectionChoices,
  useInspectorSectionStore,
  writePersistedSectionChoices,
} from './inspectorSectionStore';

/**
 * Mirrors `layoutStore.test.ts`'s own coverage of the shared versioned-JSON
 * pattern, case for case: nothing saved, unparseable JSON, a wrong schema
 * version, a wrong-shaped payload, and a `localStorage` that throws. The
 * point of repeating the list rather than trusting the copied implementation
 * is that the *fallback* is the whole contract here -- a corrupt value must
 * degrade to "no explicit choices", which hands every section back to the
 * content rule, rather than pinning sections shut or throwing during render.
 */
describe('inspectorSectionStore persistence (issue #219)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useInspectorSectionStore.setState({ open: {} });
  });

  it('starts with no explicit choices at all, so the content rule decides everything', () => {
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('round-trips a written choice', () => {
    writePersistedSectionChoices({ 'post-steps': true, filters: false });
    expect(readPersistedSectionChoices()).toEqual({
      'post-steps': true,
      filters: false,
    });
  });

  it('writes the schema version alongside the choices', () => {
    writePersistedSectionChoices({ steps: false });
    const raw = window.localStorage.getItem(INSPECTOR_SECTIONS_STORAGE_KEY);
    expect(JSON.parse(raw ?? '{}')).toEqual({
      schemaVersion: INSPECTOR_SECTIONS_SCHEMA_VERSION,
      open: { steps: false },
    });
  });

  it('falls back to no choices for unparseable JSON', () => {
    window.localStorage.setItem(INSPECTOR_SECTIONS_STORAGE_KEY, '{not json');
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('falls back to no choices for a different schema version', () => {
    window.localStorage.setItem(
      INSPECTOR_SECTIONS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INSPECTOR_SECTIONS_SCHEMA_VERSION + 1,
        open: { steps: false },
      }),
    );
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('falls back to no choices when a value is not a boolean', () => {
    window.localStorage.setItem(
      INSPECTOR_SECTIONS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INSPECTOR_SECTIONS_SCHEMA_VERSION,
        open: { steps: 'closed' },
      }),
    );
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('falls back to no choices when `open` is an array rather than a record', () => {
    window.localStorage.setItem(
      INSPECTOR_SECTIONS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INSPECTOR_SECTIONS_SCHEMA_VERSION,
        open: ['steps'],
      }),
    );
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('survives a localStorage that throws, in both directions', () => {
    const getItem = vi
      .spyOn(window.localStorage, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    expect(readPersistedSectionChoices()).toEqual({});
    expect(() => writePersistedSectionChoices({ steps: false })).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('setSectionOpen records one section without disturbing the others', () => {
    useInspectorSectionStore.getState().setSectionOpen('post-steps', true);
    useInspectorSectionStore.getState().setSectionOpen('filters', false);
    expect(useInspectorSectionStore.getState().open).toEqual({
      'post-steps': true,
      filters: false,
    });
    // ...and persisted, not only held in memory.
    expect(readPersistedSectionChoices()).toEqual({
      'post-steps': true,
      filters: false,
    });
  });

  it('resetSectionChoices hands every section back to the content rule', () => {
    useInspectorSectionStore.getState().setSectionOpen('steps', false);
    useInspectorSectionStore.getState().resetSectionChoices();
    expect(useInspectorSectionStore.getState().open).toEqual({});
    expect(readPersistedSectionChoices()).toEqual({});
  });

  it('keeps a choice for a section id it does not recognise, rather than dropping it', () => {
    // Ids are plain strings on purpose (see the module comment): a value
    // written by a newer or older build describes a section this build may not
    // render, and silently discarding it would lose the user's choice the
    // moment they switched versions.
    writePersistedSectionChoices({ 'some-future-section': false });
    expect(readPersistedSectionChoices()).toEqual({
      'some-future-section': false,
    });
  });
});
