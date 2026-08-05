import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_STRIP_PX,
  MIN_PANE_PX,
  SPLITTER_TRACK_PX,
  clampRatio,
  clampRatioToMinimums,
  extentAxis,
  minPaneExtent,
  renderRatio,
} from './constants';
import { DEFAULT_PRESET_ID, PRESETS } from './presets';
import { pane, split, type PaneId } from './types';

const NONE = new Set<PaneId>();

describe('minPaneExtent (issue #154)', () => {
  it('is a pane its own minimum along the axis being measured', () => {
    expect(minPaneExtent(pane('dag'), 'width', NONE)).toBe(
      MIN_PANE_PX.dag.width,
    );
    expect(minPaneExtent(pane('dag'), 'height', NONE)).toBe(
      MIN_PANE_PX.dag.height,
    );
  });

  it('is only the collapsed strip for a collapsed pane -- collapsing is how space is genuinely recovered', () => {
    expect(minPaneExtent(pane('dag'), 'width', new Set<PaneId>(['dag']))).toBe(
      COLLAPSED_STRIP_PX,
    );
  });

  it('sums its children plus the splitter along the split’s own axis', () => {
    const row = split('r', 'row', 0.5, [pane('dag'), pane('palette')]);
    expect(minPaneExtent(row, 'width', NONE)).toBe(
      MIN_PANE_PX.dag.width + MIN_PANE_PX.palette.width + SPLITTER_TRACK_PX,
    );
  });

  it('takes only the larger child across the split’s cross axis -- side-by-side panes share vertical space, they don’t divide it', () => {
    const row = split('r', 'row', 0.5, [pane('dag'), pane('palette')]);
    expect(minPaneExtent(row, 'height', NONE)).toBe(
      Math.max(MIN_PANE_PX.dag.height, MIN_PANE_PX.palette.height),
    );
  });

  it('drops the splitter from the sum when one side is collapsed, matching when LayoutRoot actually renders one', () => {
    const row = split('r', 'row', 0.5, [pane('dag'), pane('palette')]);
    expect(minPaneExtent(row, 'width', new Set<PaneId>(['palette']))).toBe(
      MIN_PANE_PX.dag.width + COLLAPSED_STRIP_PX,
    );
  });

  it('recurses through nested splits', () => {
    // (yaml | (dag | palette)) as a row: every minimum plus two splitters.
    const tree = split('outer', 'row', 0.4, [
      pane('yaml'),
      split('inner', 'row', 0.7, [pane('dag'), pane('palette')]),
    ]);
    expect(minPaneExtent(tree, 'width', NONE)).toBe(
      MIN_PANE_PX.yaml.width +
        MIN_PANE_PX.dag.width +
        MIN_PANE_PX.palette.width +
        SPLITTER_TRACK_PX * 2,
    );
  });

  /**
   * The property that keeps the minimums honest rather than aspirational: the
   * *default* preset must fit its own minimums at the narrowest width issue
   * #154 named, so a first run on a small monitor never lands in
   * `clampRatioToMinimums`' proportional-degradation fallback -- that is the
   * answer for a window genuinely too small, not something a default should
   * hit.
   *
   * 1024 less the app's own chrome: `main`'s `p-3` on both sides (24px). The
   * vertical case uses 720 (a common laptop height) less the 48px app bar and
   * the same 24px of padding.
   */
  it('the default preset fits its own minimums at 1024x720', () => {
    const preset = PRESETS.find(
      (candidate) => candidate.id === DEFAULT_PRESET_ID,
    )!;
    const collapsed = new Set<PaneId>(preset.defaultCollapsed);
    expect(minPaneExtent(preset.root, 'width', collapsed)).toBeLessThanOrEqual(
      1024 - 24,
    );
    expect(minPaneExtent(preset.root, 'height', collapsed)).toBeLessThanOrEqual(
      720 - 48 - 24,
    );
  });

  it.each(PRESETS.map((preset) => preset.id))(
    'the "%s" preset fits its own minimums at 1440x720',
    (presetId) => {
      const preset = PRESETS.find((candidate) => candidate.id === presetId)!;
      const collapsed = new Set<PaneId>(preset.defaultCollapsed);
      expect(
        minPaneExtent(preset.root, 'width', collapsed),
      ).toBeLessThanOrEqual(1440 - 24);
      expect(
        minPaneExtent(preset.root, 'height', collapsed),
      ).toBeLessThanOrEqual(720 - 48 - 24);
    },
  );

  /**
   * Honest accounting, asserted rather than left implicit: `three-column` puts
   * four panes side by side (plus the reference's collapsed strip), which needs
   * 1248px before any of them is above its floor -- so at 1024 it genuinely
   * cannot satisfy them and falls to proportional shares. That is a real
   * limitation of asking for four columns on a small monitor, not a bug in the
   * minimums, and the way out is the one that always worked: collapse a pane,
   * which really does recover its width (see `minPaneExtent`'s collapsed case).
   */
  it('three-column cannot satisfy four panes at 1024px, and collapsing one is what recovers the room', () => {
    const preset = PRESETS.find(
      (candidate) => candidate.id === 'three-column',
    )!;
    const asShipped = new Set<PaneId>(preset.defaultCollapsed);
    expect(minPaneExtent(preset.root, 'width', asShipped)).toBeGreaterThan(
      1000,
    );

    const withAiCollapsed = new Set<PaneId>([...asShipped, 'ai']);
    expect(
      minPaneExtent(preset.root, 'width', withAiCollapsed),
    ).toBeLessThanOrEqual(1000);
  });
});

describe('clampRatioToMinimums (issue #154)', () => {
  it('leaves a ratio alone when both sides already clear their minimums', () => {
    expect(clampRatioToMinimums(0.5, 1000, 200, 200)).toBe(0.5);
  });

  it('clamps a ratio that would put the second side under its minimum', () => {
    // 0.9 of 1000 leaves 100 for a side that needs 300.
    expect(clampRatioToMinimums(0.9, 1000, 200, 300)).toBeCloseTo(0.7, 10);
  });

  it('clamps a ratio that would put the first side under its minimum', () => {
    expect(clampRatioToMinimums(0.05, 1000, 300, 200)).toBeCloseTo(0.3, 10);
  });

  it('degrades to proportional shares when the container cannot satisfy both, rather than crushing the second side', () => {
    // 360 (graph) + 200 (palette) needs 560; in 400px neither can have its
    // floor. Honouring the first side's would leave the second 40px.
    const ratio = clampRatioToMinimums(0.72, 400, 360, 200);
    expect(ratio).toBeCloseTo(360 / 560, 10);
    // Both sides end up equally far below their floors, and the graph -- which
    // asked for more -- still gets more.
    expect(ratio * 400).toBeGreaterThan((1 - ratio) * 400);
    expect((ratio * 400) / 360).toBeCloseTo(((1 - ratio) * 400) / 200, 10);
  });
});

describe('renderRatio (issue #154)', () => {
  it('returns the stored ratio untouched when the container has not been measured', () => {
    // jsdom, and the first render before any layout effect: no evidence the
    // persisted ratio doesn't fit, so render it as stored.
    expect(renderRatio(0.72, 0, 360, 200)).toBe(0.72);
    expect(renderRatio(0.72, Number.NaN, 360, 200)).toBe(0.72);
  });

  it('clamps once measured', () => {
    // The reported case: `graph-focus`'s 0.72 dag/palette default at the width
    // the dag/palette row gets on a 1024px window rendered the palette at
    // 171px, under its 200px floor.
    expect(renderRatio(0.72, 605, 360, 200)).toBeCloseTo(1 - 200 / 605, 10);
    expect(renderRatio(0.72, 605, 360, 200) * 605).toBeCloseTo(405, 6);
  });
});

describe('clampRatio (user gestures)', () => {
  it('falls back to a size-independent clamp when unmeasured, so a keyboard resize still moves', () => {
    // Deliberately different from `renderRatio`: returning the input unchanged
    // here would make Home/End and the arrow keys silently do nothing in a
    // test environment with no layout.
    expect(clampRatio(0, 0)).toBe(0.05);
    expect(clampRatio(1, 0)).toBe(0.95);
    expect(clampRatio(0.5, 0)).toBe(0.5);
  });

  it('defaults to MIN_REGION_PX when a caller passes no per-pane minimums', () => {
    expect(clampRatio(0.99, 1000)).toBeCloseTo(0.8, 10);
  });

  it('honours per-pane minimums when given them', () => {
    expect(clampRatio(0.99, 1000, 300, 360)).toBeCloseTo(0.64, 10);
  });
});

describe('extentAxis', () => {
  it('maps a row split to width and a column split to height', () => {
    expect(extentAxis('row')).toBe('width');
    expect(extentAxis('column')).toBe('height');
  });
});
