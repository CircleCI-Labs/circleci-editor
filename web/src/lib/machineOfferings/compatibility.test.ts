import { describe, expect, it } from 'vitest';

import {
  familiesForResourceClass,
  isDeprecatedMachineImage,
} from './compatibility';
import type { MachineOfferingsState } from './useMachineOfferings';

function state(
  overrides: Partial<MachineOfferingsState> = {},
): MachineOfferingsState {
  return {
    available: true,
    linux: {},
    windows: {},
    macos: {},
    deprecated: {},
    live: false,
    stale: false,
    ...overrides,
  };
}

describe('familiesForResourceClass', () => {
  it('returns the offered families for a Linux resource class', () => {
    const result = familiesForResourceClass(
      state({
        linux: {
          large: [
            'ubuntu-2204:current',
            'ubuntu-2404:current',
            'ubuntu-2404:edge',
          ],
        },
      }),
      'large',
    );
    expect(result).toEqual(new Set(['ubuntu-2204', 'ubuntu-2404']));
  });

  it('falls back to the windows map when the class is not in linux', () => {
    const result = familiesForResourceClass(
      state({
        windows: { 'windows.large': ['windows-server-2025-gui:current'] },
      }),
      'windows.large',
    );
    expect(result).toEqual(new Set(['windows-server-2025-gui']));
  });

  it('returns undefined when the catalog is unavailable', () => {
    expect(
      familiesForResourceClass(state({ available: false }), 'large'),
    ).toBeUndefined();
  });

  it('returns undefined when no resource class is given', () => {
    expect(
      familiesForResourceClass(state({ linux: { large: ['x:current'] } }), ''),
    ).toBeUndefined();
  });

  it('returns undefined -- not an empty set -- for a class the catalog does not cover', () => {
    // The specific, documented gap issue #305 verified: "small" is a real
    // Docker resource class this endpoint never lists at all (see
    // internal/offerings' TestOfferingsIsNotASupersetOfAsciiDocResourceClasses).
    // A caller must show its unfiltered list here, not an empty picker.
    const result = familiesForResourceClass(
      state({ linux: { large: ['ubuntu-2204:current'] } }),
      'small',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when state itself is undefined (still loading)', () => {
    expect(familiesForResourceClass(undefined, 'large')).toBeUndefined();
  });
});

describe('isDeprecatedMachineImage', () => {
  it('reports true for an image in the linux deprecated list', () => {
    expect(
      isDeprecatedMachineImage(
        state({ deprecated: { linux: ['ubuntu-1604:current'] } }),
        'ubuntu-1604:current',
      ),
    ).toBe(true);
  });

  it('reports true for an image in the windows deprecated list', () => {
    expect(
      isDeprecatedMachineImage(
        state({ deprecated: { windows: ['windows-server-2019:previous'] } }),
        'windows-server-2019:previous',
      ),
    ).toBe(true);
  });

  it('never checks macos -- the Xcode field is a separate control', () => {
    expect(
      isDeprecatedMachineImage(
        state({ deprecated: { macos: ['xcode:26.0.1'] } }),
        'xcode:26.0.1',
      ),
    ).toBe(false);
  });

  it('reports false for an image not in any deprecated list', () => {
    expect(
      isDeprecatedMachineImage(
        state({ deprecated: { linux: ['ubuntu-1604:current'] } }),
        'ubuntu-2404:current',
      ),
    ).toBe(false);
  });

  it('reports false rather than "unknown" when the catalog is unavailable', () => {
    expect(
      isDeprecatedMachineImage(
        state({ available: false }),
        'ubuntu-2404:current',
      ),
    ).toBe(false);
  });
});
