import { describe, expect, it } from 'vitest';

import {
  isDraggingPaletteContext,
  readPaletteContextDragPayload,
  setPaletteContextDragPayload,
} from './paletteContexts';

/**
 * A minimal `DataTransfer` stand-in: jsdom provides no usable implementation,
 * and the payload helpers only ever touch `setData`/`getData`/`types`/
 * `effectAllowed`. Mirrors `dragPayload.test.ts`'s own fake.
 */
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: 'none',
  } as unknown as DataTransfer;
}

describe('palette context drag payload', () => {
  it('round-trips a context name', () => {
    const dt = fakeDataTransfer();
    setPaletteContextDragPayload(dt, 'deploy-prod');

    expect(isDraggingPaletteContext(dt)).toBe(true);
    expect(readPaletteContextDragPayload(dt)).toEqual({
      contextName: 'deploy-prod',
    });
  });

  it('sets a human-readable text/plain fallback and a copy effect', () => {
    const dt = fakeDataTransfer();
    setPaletteContextDragPayload(dt, 'deploy-prod');

    expect(dt.getData('text/plain')).toBe('deploy-prod');
    expect(dt.effectAllowed).toBe('copy');
  });

  // The per-kind MIME type is what lets a drop target answer "would I accept
  // this?" during `dragover`, when `getData()` is unreadable -- so an unrelated
  // drag must not be mistaken for a context.
  it('does not claim an unrelated drag', () => {
    const dt = fakeDataTransfer();
    dt.setData('application/x-vce-palette-step', '{"stepKey":"checkout"}');

    expect(isDraggingPaletteContext(dt)).toBe(false);
    expect(readPaletteContextDragPayload(dt)).toBeUndefined();
  });

  it('returns undefined for malformed or empty payloads', () => {
    const withGarbage = fakeDataTransfer();
    withGarbage.setData('application/x-vce-palette-context', 'not json');
    expect(readPaletteContextDragPayload(withGarbage)).toBeUndefined();

    const withWrongShape = fakeDataTransfer();
    withWrongShape.setData('application/x-vce-palette-context', '{"nope":1}');
    expect(readPaletteContextDragPayload(withWrongShape)).toBeUndefined();

    const withEmptyName = fakeDataTransfer();
    withEmptyName.setData(
      'application/x-vce-palette-context',
      '{"contextName":""}',
    );
    expect(readPaletteContextDragPayload(withEmptyName)).toBeUndefined();
  });
});
