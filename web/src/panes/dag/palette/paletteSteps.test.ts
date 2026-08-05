import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';
import { addStep } from '~/lib/mutations/configMutations';

import {
  defaultStepValue,
  isDraggingPaletteStep,
  PALETTE_STEPS,
  readPaletteStepDragPayload,
  setPaletteStepDragPayload,
} from './paletteSteps';

function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    get types() {
      return Array.from(store.keys());
    },
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

describe('PALETTE_STEPS', () => {
  it('starts with checkout and run -- the two nearly every job uses', () => {
    expect(PALETTE_STEPS[0]?.key).toBe('checkout');
    expect(PALETTE_STEPS[1]?.key).toBe('run');
  });

  it('has no duplicate keys', () => {
    const keys = PALETTE_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every card produces a value that, once inserted, is a legal single-key step (or a recognized bare string)', () => {
    for (const step of PALETTE_STEPS) {
      const { doc, error } = parseConfig(
        'jobs:\n  build:\n    docker: []\n    steps: []\n',
      );
      if (!doc) throw new Error(`fixture failed to parse: ${error}`);
      addStep(doc, 'build', defaultStepValue(step.key));
      const value: unknown = (
        doc.toJS() as { jobs: { build: { steps: unknown[] } } }
      ).jobs.build.steps[0];
      // Normalize both legal shapes -- a bare string, or a single-key map --
      // down to "the key(s) this step is addressable by" so there's exactly
      // one unconditional assertion, rather than an `expect` per branch.
      const keys =
        typeof value === 'string'
          ? [value]
          : Object.keys(value as Record<string, unknown>);
      expect(keys).toEqual([step.key]);
    }
  });
});

describe('defaultStepValue', () => {
  it('throws for a step key with no default builder', () => {
    expect(() => defaultStepValue('not-a-real-step')).toThrow(
      /no default value/i,
    );
  });
});

describe('palette step drag payload', () => {
  it('round-trips', () => {
    const dt = fakeDataTransfer();
    setPaletteStepDragPayload(dt, 'save_cache');
    expect(isDraggingPaletteStep(dt)).toBe(true);
    expect(readPaletteStepDragPayload(dt)).toEqual({ stepKey: 'save_cache' });
  });

  it('is not dragging when nothing was written', () => {
    const dt = fakeDataTransfer();
    expect(isDraggingPaletteStep(dt)).toBe(false);
    expect(readPaletteStepDragPayload(dt)).toBeUndefined();
  });
});
