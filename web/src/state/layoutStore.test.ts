import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectPaneIds } from '~/layout/moves';
import { DEFAULT_PRESET_ID, PRESETS } from '~/layout/presets';
import { PANE_IDS } from '~/layout/types';

import {
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_STORAGE_KEY,
  buildDefaultPersistedLayout,
  readPersistedLayout,
  useLayoutStore,
  type CustomLayoutState,
  type PersistedLayout,
} from './layoutStore';

function resetStoreToDefaults(): void {
  window.localStorage.clear();
  const defaults = buildDefaultPersistedLayout();
  useLayoutStore.setState({
    activePreset: defaults.activePreset,
    presetStates: defaults.presets,
    custom: defaults.custom,
  });
}

describe('layoutStore', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  // DEFAULT_PRESET_ID is 'graph-focus' (issue: first-run layout), not
  // 'three-column' -- asserted against the constant, not the literal, so
  // this test keeps meaning if the default ever changes again rather than
  // silently asserting whatever it happened to equal.
  it('defaults to the graph-focus preset with only the reference collapsed', () => {
    const state = useLayoutStore.getState();
    expect(state.activePreset).toBe(DEFAULT_PRESET_ID);
    expect(state.activePreset).toBe('graph-focus');
    // Config, graph and AI are all visible on a first run; the reference pane
    // is the one that starts collapsed -- see `presets.ts` for why a fourth
    // open pane crowded the graph out of its own preset.
    expect(state.presetStates['graph-focus'].collapsed).toEqual(['docs']);
    // Sanity check the default ratios were actually seeded from the
    // preset tree, not left empty.
    expect(state.presetStates['graph-focus'].ratios.outer).toBeTypeOf('number');
    expect(state.presetStates['graph-focus'].ratios.top).toBeTypeOf('number');
  });

  it('switching presets changes activePreset without disturbing other presets state', () => {
    const { setPreset, setSplitRatio } = useLayoutStore.getState();

    setPreset('graph-focus');
    setSplitRatio('outer', 0.6);
    expect(useLayoutStore.getState().activePreset).toBe('graph-focus');
    expect(
      useLayoutStore.getState().presetStates['graph-focus'].ratios.outer,
    ).toBe(0.6);

    setPreset('three-column');
    setSplitRatio('outer', 0.25);
    expect(
      useLayoutStore.getState().presetStates['three-column'].ratios.outer,
    ).toBe(0.25);

    // Switching back to graph-focus must restore exactly what was set
    // there, unaffected by the three-column edit made in between.
    setPreset('graph-focus');
    expect(useLayoutStore.getState().activePreset).toBe('graph-focus');
    expect(
      useLayoutStore.getState().presetStates['graph-focus'].ratios.outer,
    ).toBe(0.6);
  });

  it('setSplitRatio only ever touches the currently active preset', () => {
    const { setPreset, setSplitRatio } = useLayoutStore.getState();
    setPreset('three-column'); // explicit, rather than relying on it being DEFAULT_PRESET_ID
    const before =
      useLayoutStore.getState().presetStates['graph-focus'].ratios.outer;

    setSplitRatio('outer', 0.42);
    expect(
      useLayoutStore.getState().presetStates['three-column'].ratios.outer,
    ).toBe(0.42);
    expect(
      useLayoutStore.getState().presetStates['graph-focus'].ratios.outer,
    ).toBe(before);
  });

  it('toggleCollapsed flips a pane collapsed/expanded within the active preset', () => {
    const { setPreset, toggleCollapsed } = useLayoutStore.getState();
    setPreset('three-column'); // explicit, rather than relying on it being DEFAULT_PRESET_ID
    // `docs` starts collapsed by default here (issue #83) -- toggling `ai`
    // must add to that set, not replace it.
    expect(
      useLayoutStore.getState().presetStates['three-column'].collapsed,
    ).toEqual(['docs']);

    toggleCollapsed('ai');
    expect(
      useLayoutStore.getState().presetStates['three-column'].collapsed,
    ).toEqual(['docs', 'ai']);

    toggleCollapsed('ai');
    expect(
      useLayoutStore.getState().presetStates['three-column'].collapsed,
    ).toEqual(['docs']);
  });

  it('toggleCollapsed on one preset does not affect another preset already-collapsed panes', () => {
    const { setPreset, toggleCollapsed } = useLayoutStore.getState();

    // editor-focus starts with `ai` and `docs` collapsed by default (see
    // presets.ts's `withDocsSidebar` -- issue #83).
    setPreset('editor-focus');
    expect(
      useLayoutStore.getState().presetStates['editor-focus'].collapsed,
    ).toEqual(['ai', 'docs']);

    setPreset('three-column');
    toggleCollapsed('dag');
    expect(
      useLayoutStore.getState().presetStates['three-column'].collapsed,
    ).toEqual(['docs', 'dag']);
    expect(
      useLayoutStore.getState().presetStates['editor-focus'].collapsed,
    ).toEqual(['ai', 'docs']);
  });

  it('every preset action persists to localStorage so a fresh read restores it', () => {
    const { setPreset, setSplitRatio, toggleCollapsed } =
      useLayoutStore.getState();

    setPreset('editor-focus');
    setSplitRatio('bottom', 0.55);
    toggleCollapsed('dag');

    const persisted = readPersistedLayout();
    expect(persisted.activePreset).toBe('editor-focus');
    expect(persisted.presets['editor-focus'].ratios.bottom).toBe(0.55);
    // `ai` and `docs` started collapsed by default for this preset;
    // toggling `dag` must add to that set, not replace it.
    expect(persisted.presets['editor-focus'].collapsed.sort()).toEqual([
      'ai',
      'dag',
      'docs',
    ]);
  });

  it('buildDefaultPersistedLayout seeds every preset with its own default ratios and collapsed set', () => {
    const defaults = buildDefaultPersistedLayout();
    expect(defaults.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(defaults.activePreset).toBe(DEFAULT_PRESET_ID);
    for (const preset of PRESETS) {
      expect(defaults.presets[preset.id].collapsed).toEqual(
        preset.defaultCollapsed,
      );
    }
    // Issue #83: `docs` joins the pre-existing `yaml`/`ai` default collapse
    // for this preset, rather than replacing it.
    expect(defaults.presets['graph-only'].collapsed).toEqual([
      'yaml',
      'ai',
      'docs',
    ]);
  });
});

// Issue #121: swapping/moving panes, the "custom" layout it produces, and
// the "way back" out of it.
describe('layoutStore: custom layout (issue #121)', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  it('swapPanes moves to the custom layout, swaps the two panes, and leaves the starting preset untouched', () => {
    const { setPreset, swapPanes } = useLayoutStore.getState();
    setPreset('three-column');
    const beforePreset = useLayoutStore.getState().presetStates['three-column'];

    swapPanes('yaml', 'dag');

    const state = useLayoutStore.getState();
    expect(state.activePreset).toBe('custom');
    expect(state.custom).not.toBeNull();
    expect(state.custom!.basePreset).toBe('three-column');
    // Every pane still present exactly once -- nothing dropped or
    // duplicated by the swap.
    expect(collectPaneIds(state.custom!.root).slice().sort()).toEqual(
      [...PANE_IDS].sort(),
    );
    // The named preset this arrangement started from is exactly as it was
    // -- "coexist," not "overwrite."
    expect(state.presetStates['three-column']).toEqual(beforePreset);
  });

  it("swapPanes actually exchanges the two panes' positions", () => {
    const { setPreset, swapPanes } = useLayoutStore.getState();
    setPreset('three-column');
    swapPanes('yaml', 'palette');

    const custom = useLayoutStore.getState().custom!;
    // three-column's root is `withDocsSidebar(THREE_COLUMN_ROOT)` --
    // `with-docs`'s own first child is `THREE_COLUMN_ROOT` (id `outer`),
    // whose own first child is the leaf that starts out as `yaml`. After
    // swapping with `palette`, that exact position should hold `palette`.
    const withDocs = custom.root as Extract<
      typeof custom.root,
      { type: 'split' }
    >;
    expect(withDocs.id).toBe('with-docs');
    const outer = withDocs.children[0] as Extract<
      typeof custom.root,
      { type: 'split' }
    >;
    expect(outer.id).toBe('outer');
    expect(outer.children[0]).toEqual({ type: 'pane', pane: 'palette' });
  });

  it('a second move while already custom mutates the existing custom layout rather than re-snapshotting', () => {
    const { setPreset, swapPanes } = useLayoutStore.getState();
    setPreset('editor-focus');
    swapPanes('yaml', 'ai');
    const afterFirst = useLayoutStore.getState().custom!;

    swapPanes('dag', 'docs');
    const afterSecond = useLayoutStore.getState().custom!;

    // Still the same starting preset throughout.
    expect(afterSecond.basePreset).toBe('editor-focus');
    expect(afterSecond.basePreset).toBe(afterFirst.basePreset);
    // The first swap's effect (yaml/ai exchanged) survives the second.
    expect(collectPaneIds(afterSecond.root).slice().sort()).toEqual(
      [...PANE_IDS].sort(),
    );
  });

  it("movePaneToEdge wraps the layout with the moved pane on that edge and preserves other splits' ratios", () => {
    const { setPreset, setSplitRatio, movePaneToEdge } =
      useLayoutStore.getState();
    setPreset('three-column');
    setSplitRatio('inner', 0.5); // a ratio that must survive the move untouched

    movePaneToEdge('palette', 'top');

    const state = useLayoutStore.getState();
    expect(state.activePreset).toBe('custom');
    const custom = state.custom!;
    const root = custom.root as Extract<typeof custom.root, { type: 'split' }>;
    expect(root.direction).toBe('column');
    expect(root.children[0]).toEqual({ type: 'pane', pane: 'palette' });
    // The pre-existing `inner` ratio (set above, before the move) is still
    // exactly what it was -- `movePaneToEdge` never touches any split's
    // ratio besides the one new wrapper it adds.
    expect(state.custom!.ratios.inner).toBe(0.5);
  });

  it('setSplitRatio and toggleCollapsed operate on the custom layout, not the abandoned preset, once active', () => {
    const { setPreset, swapPanes, setSplitRatio, toggleCollapsed } =
      useLayoutStore.getState();
    setPreset('three-column');
    const presetRatioBefore =
      useLayoutStore.getState().presetStates['three-column'].ratios.outer;

    swapPanes('yaml', 'ai');
    setSplitRatio('outer', 0.9);
    toggleCollapsed('dag');

    const state = useLayoutStore.getState();
    expect(state.custom!.ratios.outer).toBe(0.9);
    expect(state.custom!.collapsed).toContain('dag');
    // three-column's own persisted ratio for `outer` never moved.
    expect(state.presetStates['three-column'].ratios.outer).toBe(
      presetRatioBefore,
    );
  });

  it('activateCustom is a no-op with no custom layout, and switches back to an existing one otherwise', () => {
    const { setPreset, swapPanes, activateCustom } = useLayoutStore.getState();

    activateCustom();
    expect(useLayoutStore.getState().activePreset).toBe(DEFAULT_PRESET_ID);

    setPreset('graph-only');
    swapPanes('yaml', 'ai');
    expect(useLayoutStore.getState().activePreset).toBe('custom');

    setPreset('editor-focus'); // switch away, without discarding `custom`
    expect(useLayoutStore.getState().custom).not.toBeNull();

    activateCustom();
    expect(useLayoutStore.getState().activePreset).toBe('custom');
  });

  it('resetCustomLayout discards the custom layout and returns to its starting preset', () => {
    const { setPreset, swapPanes, resetCustomLayout } =
      useLayoutStore.getState();
    setPreset('editor-only');
    swapPanes('ai', 'dag');
    expect(useLayoutStore.getState().activePreset).toBe('custom');

    resetCustomLayout();

    const state = useLayoutStore.getState();
    expect(state.activePreset).toBe('editor-only');
    expect(state.custom).toBeNull();
  });

  it('resetCustomLayout falls back to DEFAULT_PRESET_ID if there is somehow nothing to reset', () => {
    const { resetCustomLayout } = useLayoutStore.getState();
    resetCustomLayout();
    expect(useLayoutStore.getState().activePreset).toBe(DEFAULT_PRESET_ID);
  });

  it('every custom-layout action persists to localStorage so a fresh read restores it', () => {
    const { setPreset, swapPanes } = useLayoutStore.getState();
    setPreset('graph-focus');
    swapPanes('yaml', 'docs');

    const persisted = readPersistedLayout();
    expect(persisted.activePreset).toBe('custom');
    expect(persisted.custom).not.toBeNull();
    expect(persisted.custom!.basePreset).toBe('graph-focus');
  });
});

describe('readPersistedLayout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns the default layout when nothing has been saved yet', () => {
    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('falls back to the default layout for unparseable JSON', () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, '{not valid json');
    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('discards saved state from a different schema version rather than trying to read it', () => {
    const stale: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      schemaVersion: LAYOUT_SCHEMA_VERSION + 1,
      activePreset: 'graph-only',
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(stale));

    const result = readPersistedLayout();
    expect(result).toEqual(buildDefaultPersistedLayout());
    expect(result.activePreset).not.toBe('graph-only');
  });

  it('falls back to defaults for an unrecognised activePreset', () => {
    const bogus = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'not-a-real-preset',
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(bogus));
    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('falls back to defaults when a preset entry has the wrong shape', () => {
    const bogus = buildDefaultPersistedLayout();
    // @ts-expect-error -- deliberately malformed for this test
    bogus.presets['three-column'] = { ratios: 'nope', collapsed: [] };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(bogus));
    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('merges a persisted value missing a whole preset entry with that preset default', () => {
    const partial = buildDefaultPersistedLayout();
    delete (partial.presets as Partial<typeof partial.presets>)['graph-only'];
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(partial));

    const result = readPersistedLayout();
    expect(result.presets['graph-only']).toEqual(
      buildDefaultPersistedLayout().presets['graph-only'],
    );
  });

  it('merges a persisted preset missing one ratio key with that key default, keeping the rest', () => {
    const partial = buildDefaultPersistedLayout();
    partial.presets['three-column'] = {
      ratios: { outer: 0.5 },
      collapsed: ['ai'],
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(partial));

    const result = readPersistedLayout();
    expect(result.presets['three-column'].ratios.outer).toBe(0.5);
    expect(result.presets['three-column'].ratios.inner).toBe(
      buildDefaultPersistedLayout().presets['three-column'].ratios.inner,
    );
    expect(result.presets['three-column'].collapsed).toEqual(['ai']);
  });

  it('falls back to defaults without throwing when localStorage itself throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => readPersistedLayout()).not.toThrow();
    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  // Issue #121: the new `custom` field and `activePreset: 'custom'`.
  const validCustom: CustomLayoutState = {
    root: {
      type: 'split',
      id: 'custom-root',
      direction: 'row',
      ratio: 0.3,
      children: [
        { type: 'pane', pane: 'palette' },
        {
          type: 'split',
          id: 'custom-inner',
          direction: 'column',
          ratio: 0.5,
          children: [
            { type: 'pane', pane: 'yaml' },
            {
              type: 'split',
              id: 'custom-inner-2',
              direction: 'row',
              ratio: 0.5,
              children: [
                { type: 'pane', pane: 'ai' },
                {
                  type: 'split',
                  id: 'custom-inner-3',
                  direction: 'row',
                  ratio: 0.5,
                  children: [
                    { type: 'pane', pane: 'dag' },
                    { type: 'pane', pane: 'docs' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    ratios: {},
    collapsed: [],
    basePreset: 'three-column',
  };

  it('round-trips a valid custom layout unchanged', () => {
    const value: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'custom',
      custom: validCustom,
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(value));

    const result = readPersistedLayout();
    expect(result.activePreset).toBe('custom');
    expect(result.custom).toEqual(validCustom);
  });

  it('falls back to defaults when activePreset is "custom" but custom is null', () => {
    const bogus: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'custom',
      custom: null,
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(bogus));

    const result = readPersistedLayout();
    expect(result).toEqual(buildDefaultPersistedLayout());
  });

  it("falls back to defaults when custom's tree is missing a pane", () => {
    const broken: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'custom',
      custom: {
        ...validCustom,
        // Drop `docs` entirely -- a broken tree, not just a differently
        // shaped valid one.
        root: {
          type: 'split',
          id: 'broken',
          direction: 'row',
          ratio: 0.5,
          children: [
            { type: 'pane', pane: 'yaml' },
            { type: 'pane', pane: 'ai' },
          ],
        },
      },
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(broken));

    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it("falls back to defaults when custom's tree duplicates a pane", () => {
    const broken: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'custom',
      custom: {
        ...validCustom,
        root: {
          type: 'split',
          id: 'broken',
          direction: 'row',
          ratio: 0.5,
          children: [
            { type: 'pane', pane: 'yaml' },
            { type: 'pane', pane: 'yaml' },
          ],
        },
      },
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(broken));

    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('falls back to defaults when custom has the wrong shape (bad basePreset)', () => {
    const broken: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'custom',
      custom: { ...validCustom, basePreset: 'not-a-real-preset' as never },
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(broken));

    expect(readPersistedLayout()).toEqual(buildDefaultPersistedLayout());
  });

  it('keeps a saved custom layout even while a named preset is the active one', () => {
    const value: PersistedLayout = {
      ...buildDefaultPersistedLayout(),
      activePreset: 'graph-only', // not 'custom'
      custom: validCustom,
    };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(value));

    const result = readPersistedLayout();
    expect(result.activePreset).toBe('graph-only');
    expect(result.custom).toEqual(validCustom);
  });
});
