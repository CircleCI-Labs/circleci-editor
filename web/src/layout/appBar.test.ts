import { describe, expect, it } from 'vitest';

import {
  APP_BAR_COMPACT_PX,
  APP_BAR_FULL_PX,
  APP_BAR_FURNITURE_PX,
  APP_BAR_TIERS,
  availableDemotions,
  baseAppBarTier,
  resolveAppBarTier,
  type AppBarTier,
} from './appBar';

/** The four widths issue #154 named, plus a sweep step fine enough to catch a
 * tier boundary landing badly. */
const SWEEP = [
  1024, 1100, 1152, 1200, 1280, 1366, 1400, 1440, 1500, 1600, 1680, 1800, 1920,
];

/** Richness, i.e. position up the ladder. `APP_BAR_TIERS` is tersest-first. */
function richness(tier: AppBarTier): number {
  return APP_BAR_TIERS.indexOf(tier);
}

describe('baseAppBarTier', () => {
  it('starts at the form that fits everywhere before the bar has been measured', () => {
    // An over-wide first render is the one that overflows and then visibly
    // reflows, so an unmeasured bar guesses down, not up.
    expect(baseAppBarTier(0)).toBe('tight');
    expect(baseAppBarTier(-1)).toBe('tight');
  });

  it('steps up at its two thresholds and nowhere else', () => {
    expect(baseAppBarTier(APP_BAR_COMPACT_PX - 1)).toBe('tight');
    expect(baseAppBarTier(APP_BAR_COMPACT_PX)).toBe('compact');
    expect(baseAppBarTier(APP_BAR_FULL_PX - 1)).toBe('compact');
    expect(baseAppBarTier(APP_BAR_FULL_PX)).toBe('full');
  });

  it('is monotonic in width', () => {
    let previous = -1;
    for (const width of SWEEP) {
      const current = richness(baseAppBarTier(width));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe('resolveAppBarTier (issue #166)', () => {
  it('is the base tier with no demotions', () => {
    for (const width of SWEEP) {
      expect(resolveAppBarTier(width, 0)).toBe(baseAppBarTier(width));
    }
  });

  it('steps one tier down the ladder per demotion', () => {
    expect(resolveAppBarTier(1920, 0)).toBe('full');
    expect(resolveAppBarTier(1920, 1)).toBe('compact');
    expect(resolveAppBarTier(1920, 2)).toBe('tight');
  });

  /** The optimistic thresholds sit just above each tier's measured furniture
   * cost, so a bar barely wide enough for `full`'s furniture starts there and
   * relies entirely on demotion to come back down. Pinned because it is the
   * case where the starting guess is *most* likely to be wrong. */
  it('starts at `full` as soon as the width clears `full`s own furniture', () => {
    expect(baseAppBarTier(APP_BAR_FULL_PX)).toBe('full');
    expect(resolveAppBarTier(APP_BAR_FULL_PX, 2)).toBe('tight');
  });

  it('clamps at the tersest tier rather than running off the end', () => {
    expect(resolveAppBarTier(1920, 3)).toBe('tight');
    expect(resolveAppBarTier(1920, 99)).toBe('tight');
    expect(resolveAppBarTier(1024, 1)).toBe('tight');
    expect(resolveAppBarTier(1024, -1)).toBe('tight');
  });

  /** Every threshold has to clear the furniture it is a threshold for,
   * otherwise a tier could be entered that cannot physically fit even with the
   * switcher absent -- which no amount of demotion would rescue, because
   * demotion only helps the switcher. */
  it('each threshold clears its own tier’s measured furniture cost', () => {
    expect(APP_BAR_COMPACT_PX).toBeGreaterThan(APP_BAR_FURNITURE_PX.compact);
    expect(APP_BAR_FULL_PX).toBeGreaterThan(APP_BAR_FURNITURE_PX.full);
    expect(APP_BAR_COMPACT_PX).toBeLessThan(APP_BAR_FULL_PX);
  });

  it('never resolves richer than the width alone would allow', () => {
    // Demotion is the only adjustment and it only ever goes down, so no amount
    // of switcher pressure can talk the bar into a tier its width doesn't
    // support.
    for (const width of SWEEP) {
      for (const demotions of [0, 1, 2, 5]) {
        expect(
          richness(resolveAppBarTier(width, demotions)),
        ).toBeLessThanOrEqual(richness(baseAppBarTier(width)));
      }
    }
  });
});

describe('availableDemotions', () => {
  it('is how many steps the width leaves before the tersest tier', () => {
    expect(availableDemotions(APP_BAR_COMPACT_PX - 1)).toBe(0); // already `tight`
    expect(availableDemotions(APP_BAR_COMPACT_PX)).toBe(1); // compact -> tight
    expect(availableDemotions(APP_BAR_FULL_PX)).toBe(2); // full -> compact -> tight
  });

  /**
   * The termination guarantee behind `useAppBarTier`'s probe: a demotion
   * strictly reduces richness, and the walk is bounded by this number -- so the
   * probe takes at most `availableDemotions(width)` steps before it must
   * settle. Combined with "only a width change resets the probe", that is why
   * the ladder cannot oscillate.
   */
  it('bounds a demotion walk, and each step is strictly terser until the floor', () => {
    for (const width of SWEEP) {
      const steps = availableDemotions(width);
      for (let step = 0; step < steps; step++) {
        expect(richness(resolveAppBarTier(width, step + 1))).toBeLessThan(
          richness(resolveAppBarTier(width, step)),
        );
      }
      expect(resolveAppBarTier(width, steps)).toBe('tight');
    }
  });
});
