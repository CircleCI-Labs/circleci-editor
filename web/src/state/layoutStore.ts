/**
 * Persisted layout state for the configurable pane layout (issue #30): the
 * active preset, plus each preset's own splitter ratios and collapsed
 * panes. Deliberately a separate store from `appStore` -- this is UI
 * chrome, never touches the config document, and switching presets or
 * dragging a splitter should never be mistaken for an edit that needs
 * undo/redo or a dirty-state indicator.
 *
 * Persistence is hand-rolled (matching the pattern `DagPane`'s
 * `InspectorDivider` already used for its own width) rather than a
 * zustand `persist` middleware, so the exact fallback behaviour for a
 * corrupt or schema-mismatched value is explicit and easy to unit test
 * without needing to drive the store through React.
 */
import { create } from 'zustand';

import {
  DEFAULT_PRESET_ID,
  PRESETS,
  getPreset,
  isPresetId,
  type PresetId,
} from '~/layout/presets';
import {
  collectPaneIds,
  moveToEdge,
  swapLeaves,
  type PaneEdge,
} from '~/layout/moves';
import {
  PANE_IDS,
  collectDefaultRatios,
  type LayoutNode,
  type PaneId,
} from '~/layout/types';

// Bumping `LAYOUT_SCHEMA_VERSION` is how a future incompatible layout
// change (a renamed split id, a restructured preset) discards old saved
// state instead of trying to interpret it -- see `isPersistedLayout`
// below, which rejects *any* value whose `schemaVersion` doesn't match
// exactly. Both constants are exported for tests only, so they can seed/
// inspect the exact key and version this module reads and writes without
// hard-coding either a second time (and risking the two silently drifting
// apart if one changes).
//
// 2, not 1: changing `DEFAULT_PRESET_ID` (three-column -> graph-focus) is
// itself exactly this kind of incompatible change from a *returning* user's
// point of view -- without a version bump, anyone who had already run the
// app would have a v1 value with `activePreset: 'three-column'` sitting in
// `localStorage` that `readPersistedLayout` would happily accept as still
// valid, silently masking the new default forever. Bumping the version
// makes that stale value fail `isPersistedLayout` and fall back to
// `buildDefaultPersistedLayout()`, which is the only place the new default
// actually takes effect.
//
// 3, not 2: issue #83 added a fourth pane (`docs`, the schema-derived
// reference) with a deliberate per-preset default -- expanded only in
// `graph-focus`, collapsed everywhere else (see `layout/presets.ts`'s
// `withDocsSidebar`). `mergeWithDefaults` only backfills missing *ratio*
// keys, never `collapsed` membership -- deliberately, so an update never
// silently re-collapses a pane a user chose to expand. That means a
// pre-#83 `collapsed` array, which has nothing to say about a pane it
// predates, would leave `docs` rendering *expanded* in every preset a
// returning user had touched, regardless of the new defaults above -- the
// opposite of what those defaults intend. Bumping discards that stale
// value so `buildDefaultPersistedLayout()` seeds `docs`'s collapse state
// correctly for every preset, exactly as the version-2 bump did for
// `DEFAULT_PRESET_ID`.
//
// 4, not 3: issue #88 promoted the object palette from a fixed column
// `DagPane` rendered inline to its own pane (`DAG_WITH_PALETTE` in
// `layout/presets.ts`), with a deliberate per-preset default (collapsed
// only in `editor-only`, where the graph itself starts collapsed too).
// Same failure mode as the version-3 bump if this weren't bumped again: a
// pre-#88 `collapsed` array has nothing to say about `palette`, so
// `mergeWithDefaults`'s "only backfill missing ratio keys, never collapsed
// membership" rule would leave it rendered *expanded* in `editor-only` for
// any returning user, contradicting that preset's own point.
//
// 5, not 4: issue #121 adds a sixth `activePreset` value, `'custom'`, and a
// new top-level `custom` field carrying a user-built `LayoutNode` tree. A
// pre-#121 persisted value has no `custom` key at all and its
// `activePreset` is one of the five real `PresetId`s -- structurally that
// would actually still pass the new `isPersistedLayout` shape check
// (`custom: null` is a valid absence), so this bump isn't strictly needed
// for *that* value to keep working. It matters for a narrower, real case:
// a value saved by a build *between* when `'custom'` was introduced and
// when this comment/id landed, or any hand-edited/corrupted value with
// `activePreset: 'custom'` but a missing or malformed `custom` payload,
// which would otherwise render nothing (`LayoutRoot` has no tree to walk)
// with no obvious way back short of clearing localStorage -- exactly the
// broken-tree case this module's own doc comment says to bump for.
export const LAYOUT_SCHEMA_VERSION = 5;
export const LAYOUT_STORAGE_KEY = 'vce.layout';
const SCHEMA_VERSION = LAYOUT_SCHEMA_VERSION;
const STORAGE_KEY = LAYOUT_STORAGE_KEY;

export interface PersistedPresetState {
  /** Split id -> the first child's share (0..1). Missing entries fall back
   * to that split's default `ratio` from `./presets`. */
  ratios: Record<string, number>;
  collapsed: PaneId[];
}

/**
 * A user-built arrangement (issue #121), kept entirely separate from the
 * five named presets' own `PersistedPresetState` entries rather than
 * overwriting one of them -- the hard requirement that a hand-built layout
 * "coexist with the five named presets." `root` is the actual tree
 * (`layout/moves.ts`'s `swapLeaves`/`moveToEdge` are the only things that
 * ever produce a new one); `ratios`/`collapsed` mean exactly what they do
 * for a named preset's `PersistedPresetState`, just keyed against this tree
 * instead of a static one from `./presets`.
 */
export interface CustomLayoutState {
  root: LayoutNode;
  ratios: Record<string, number>;
  collapsed: PaneId[];
  /** Which named preset this arrangement started from -- the "reset to
   * preset" way back (a hard requirement) returns here, not always to
   * `DEFAULT_PRESET_ID`, so undoing a rearrangement someone made while on
   * e.g. `editor-focus` doesn't also silently switch them to a different
   * preset entirely. */
  basePreset: PresetId;
}

/** `activePreset` can now name either one of the five static presets or
 * `'custom'` -- the ad hoc arrangement in `custom` below. Kept as a
 * distinct type from `PresetId` (rather than folding `'custom'` into that
 * union) because `PresetId` is also used everywhere a *static* preset
 * lookup (`getPreset`, `PRESETS.find`) is expected to succeed; `'custom'`
 * has no entry in `PRESETS` and never should. */
export type ActiveLayout = PresetId | 'custom';

export interface PersistedLayout {
  schemaVersion: number;
  activePreset: ActiveLayout;
  presets: Record<PresetId, PersistedPresetState>;
  custom: CustomLayoutState | null;
}

function buildDefaultPresetState(presetId: PresetId): PersistedPresetState {
  const preset = PRESETS.find((candidate) => candidate.id === presetId);
  // Unreachable outside a test that hand-constructs a bogus id -- PresetId
  // is a closed union and every member has an entry in PRESETS.
  if (!preset) return { ratios: {}, collapsed: [] };
  return {
    ratios: collectDefaultRatios(preset.root),
    collapsed: [...preset.defaultCollapsed],
  };
}

export function buildDefaultPersistedLayout(): PersistedLayout {
  const presets = {} as Record<PresetId, PersistedPresetState>;
  for (const preset of PRESETS) {
    presets[preset.id] = buildDefaultPresetState(preset.id);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    activePreset: DEFAULT_PRESET_ID,
    presets,
    // No custom arrangement exists until a user actually moves a pane (see
    // `swapPanes`/`movePaneToEdge` below) -- `null`, not an empty tree, so
    // `PresetSwitcher`'s "Custom" pill has a plain, unambiguous "does one
    // exist at all" check.
    custom: null,
  };
}

function isRecordOfFiniteNumbers(
  value: unknown,
): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
}

function isPaneIdArray(value: unknown): value is PaneId[] {
  return (
    Array.isArray(value) &&
    value.every((entry) =>
      (PANE_IDS as readonly string[]).includes(entry as string),
    )
  );
}

function isPersistedPresetState(value: unknown): value is PersistedPresetState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isRecordOfFiniteNumbers(candidate.ratios) &&
    isPaneIdArray(candidate.collapsed)
  );
}

/** Recursively validates a `LayoutNode` -- both shape (every field the
 * right type) and, for a `split`, that its `children` tuple has exactly
 * two valid entries. Doesn't check that the *set* of panes across the
 * whole tree is exactly the five this app has; that's `isCompleteLayoutTree`
 * below, kept separate since a bad node shape and a node set that's merely
 * incomplete are different failures worth being able to reason about (and
 * test) independently. */
function isLayoutNode(value: unknown): value is LayoutNode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'pane') {
    return (
      typeof candidate.pane === 'string' &&
      (PANE_IDS as readonly string[]).includes(candidate.pane)
    );
  }
  if (candidate.type === 'split') {
    return (
      typeof candidate.id === 'string' &&
      (candidate.direction === 'row' || candidate.direction === 'column') &&
      typeof candidate.ratio === 'number' &&
      Number.isFinite(candidate.ratio) &&
      Array.isArray(candidate.children) &&
      candidate.children.length === 2 &&
      isLayoutNode(candidate.children[0]) &&
      isLayoutNode(candidate.children[1])
    );
  }
  return false;
}

/** A valid `LayoutNode` (per `isLayoutNode`) is still a broken tree to
 * render if it doesn't contain every one of this app's panes exactly
 * once -- a duplicate would make one pane's content ambiguous about where
 * it lives, and a missing one would make that pane unreachable entirely,
 * the same failure mode `PaneId`'s own doc comment (`layout/types.ts`)
 * calls out for a preset silently omitting a pane. */
function isCompleteLayoutTree(node: LayoutNode): boolean {
  const ids = collectPaneIds(node).slice().sort();
  const expected = (PANE_IDS as readonly string[]).slice().sort();
  return (
    ids.length === expected.length && ids.every((id, i) => id === expected[i])
  );
}

function isCustomLayoutState(value: unknown): value is CustomLayoutState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isLayoutNode(candidate.root) &&
    isCompleteLayoutTree(candidate.root) &&
    isRecordOfFiniteNumbers(candidate.ratios) &&
    isPaneIdArray(candidate.collapsed) &&
    typeof candidate.basePreset === 'string' &&
    isPresetId(candidate.basePreset)
  );
}

/**
 * The full shape check for a value read out of `localStorage`. Rejects
 * outright (rather than trying to salvage part of it) on: not an object,
 * the wrong `schemaVersion`, an unrecognised `activePreset`, any `presets`
 * entry that doesn't match `PersistedPresetState`'s shape, an invalid
 * `custom` payload, or `activePreset: 'custom'` with no (or a broken)
 * `custom` payload to actually render -- that last case is exactly the
 * "old persisted value would produce a broken tree" scenario the schema
 * version exists to catch. A `false` here always means "fall back to
 * `buildDefaultPersistedLayout()`" -- see `readPersistedLayout`.
 */
function isPersistedLayout(value: unknown): value is PersistedLayout {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== SCHEMA_VERSION) return false;
  if (
    typeof candidate.activePreset !== 'string' ||
    (!isPresetId(candidate.activePreset) && candidate.activePreset !== 'custom')
  )
    return false;
  if (
    typeof candidate.presets !== 'object' ||
    candidate.presets === null ||
    Array.isArray(candidate.presets)
  ) {
    return false;
  }
  if (!Object.values(candidate.presets).every(isPersistedPresetState)) {
    return false;
  }
  if (candidate.custom !== null && !isCustomLayoutState(candidate.custom)) {
    return false;
  }
  if (candidate.activePreset === 'custom' && candidate.custom === null) {
    return false;
  }
  return true;
}

/**
 * Fills in any preset the persisted value is missing entirely, and any
 * ratio key within an existing preset entry that isn't there yet, from the
 * fresh defaults. This is *not* the schema-version escape hatch above --
 * it's forward-compatibility within the same version, e.g. a split gaining
 * an id it didn't have when the user last saved. Values already present in
 * `parsed` always win.
 */
function mergeWithDefaults(parsed: PersistedLayout): PersistedLayout {
  const defaults = buildDefaultPersistedLayout();
  const presets = { ...defaults.presets };
  for (const preset of PRESETS) {
    const parsedPreset = parsed.presets[preset.id];
    if (!parsedPreset) continue;
    presets[preset.id] = {
      ratios: { ...defaults.presets[preset.id].ratios, ...parsedPreset.ratios },
      collapsed: parsedPreset.collapsed,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    activePreset: parsed.activePreset,
    presets,
    // `custom`'s tree is entirely the user's own, not derived from any
    // static default -- nothing to merge in from `defaults` the way a
    // named preset's missing ratio key gets backfilled above, so it passes
    // through `isPersistedLayout`-validated as-is (already `null` if the
    // user never built one).
    custom: parsed.custom,
  };
}

/**
 * Reads and validates the persisted layout, falling back to
 * `buildDefaultPersistedLayout()` for a first run, unparseable JSON, a
 * value that fails `isPersistedLayout` (including a schema-version
 * mismatch), or an environment where `localStorage` itself throws (private
 * browsing, disabled storage, a non-browser test environment). Never
 * throws.
 */
export function readPersistedLayout(): PersistedLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return buildDefaultPersistedLayout();
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedLayout(parsed)) return buildDefaultPersistedLayout();
    return mergeWithDefaults(parsed);
  } catch {
    return buildDefaultPersistedLayout();
  }
}

export function writePersistedLayout(state: PersistedLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Layout changes still work for the rest of this session even if they
    // can't persist across a reload.
  }
}

/** Small helper so every action below writes the exact same four-field
 * shape rather than re-listing `schemaVersion`/`presets` at each call
 * site -- the four preceding actions already did that by hand; adding
 * `custom` on top of them made the duplication worth naming. */
function persist(
  activePreset: ActiveLayout,
  presets: Record<PresetId, PersistedPresetState>,
  custom: CustomLayoutState | null,
): void {
  writePersistedLayout({
    schemaVersion: SCHEMA_VERSION,
    activePreset,
    presets,
    custom,
  });
}

interface LayoutState {
  activePreset: ActiveLayout;
  presetStates: Record<PresetId, PersistedPresetState>;
  /** The user's own rearranged layout (issue #121), or `null` if they've
   * never moved a pane. Independent of `activePreset`: it can hold a value
   * while a *named* preset is active (the user built one, then clicked
   * back to a preset -- `PresetSwitcher`'s "Custom" pill stays available
   * to return to it), and `activePreset` can only ever be `'custom'` while
   * this is non-`null` (`isPersistedLayout` rejects the other combination
   * on read; every action below preserves it by construction). */
  custom: CustomLayoutState | null;
  setPreset: (id: PresetId) => void;
  /** Sets one split's ratio *within the currently active layout* -- this
   * is what `Splitter` calls while dragging or on an arrow-key press.
   * "Active layout" means whichever of the five presets or `custom` is
   * current; see `activeLayoutState`. */
  setSplitRatio: (splitId: string, ratio: number) => void;
  /** Flips one pane between collapsed/expanded within the active layout.
   * Used for both directions: a "Collapse" button on an expanded pane and
   * an "Expand <pane>" strip on a collapsed one call the same action. */
  toggleCollapsed: (pane: PaneId) => void;
  /**
   * Exchanges two panes' positions (the "swap with…" entry in each pane's
   * "Move" menu -- see `PaneSlot`). Always transitions `activePreset` to
   * `'custom'`: even a same-shape rearrangement of a named preset is, from
   * that preset's own point of view, no longer what it describes, and the
   * whole point of #121 is that this doesn't overwrite the preset itself.
   * The very first move of a session snapshots whichever preset was active
   * (its ratios, its collapsed set, and `basePreset`) as `custom`'s
   * starting point; every move after that mutates `custom` in place.
   */
  swapPanes: (a: PaneId, b: PaneId) => void;
  /** Moves a pane to occupy a whole edge of the layout (the "move to
   * left/right/top/bottom" entries in the same menu) -- see
   * `layout/moves.ts`'s `moveToEdge`. Same `'custom'`-transition rule as
   * `swapPanes`. */
  movePaneToEdge: (pane: PaneId, edge: PaneEdge) => void;
  /** Switches back to a custom layout that already exists but isn't
   * currently active (the user built one, then clicked a named preset in
   * `PresetSwitcher`) -- a no-op if `custom` is `null`, since there is then
   * nothing to switch to. Distinct from `setPreset`, which only ever
   * accepts a real `PresetId`. */
  activateCustom: () => void;
  /** The "way back" hard requirement: discards the custom arrangement
   * entirely and returns to whichever preset it started from
   * (`custom.basePreset`), falling back to `DEFAULT_PRESET_ID` if there
   * was somehow no custom layout to reset (unreachable via the UI, which
   * only ever shows this action once `custom` exists). The abandoned
   * preset's own state was never touched by any move, so this is exactly
   * "switch back to that preset," not a restore from a snapshot. */
  resetCustomLayout: () => void;
}

/** Resolves the currently *active* ratios/collapsed-set, regardless of
 * whether that's one of the five named presets or the user's own `custom`
 * arrangement -- every reader that used to index `presetStates` straight
 * off `activePreset` (this store's own actions, `LayoutRoot`, `DagPane`'s
 * palette-open check) needs this now that `activePreset` can be `'custom'`,
 * a key `presetStates` never has. */
export function activeLayoutState(state: LayoutState): PersistedPresetState {
  if (state.activePreset === 'custom') {
    return state.custom ?? { ratios: {}, collapsed: [] };
  }
  return state.presetStates[state.activePreset];
}

/** Resolves the currently active *tree* -- a static preset's `root` from
 * `./presets`, or the user's own `custom.root`. `null` only if
 * `activePreset` is `'custom'` with no `custom` set, which the store's own
 * invariants (and `isPersistedLayout` on read) never allow to happen; typed
 * as nullable anyway so a caller like `LayoutRoot` can fail soft rather
 * than assert. */
export function activeLayoutRoot(state: LayoutState): LayoutNode | null {
  if (state.activePreset === 'custom') {
    return state.custom?.root ?? null;
  }
  return getPreset(state.activePreset)?.root ?? null;
}

export const useLayoutStore = create<LayoutState>((set) => {
  const initial = readPersistedLayout();

  return {
    activePreset: initial.activePreset,
    presetStates: initial.presets,
    custom: initial.custom,

    setPreset: (id) =>
      set((state) => {
        persist(id, state.presetStates, state.custom);
        return { activePreset: id };
      }),

    setSplitRatio: (splitId, ratio) =>
      set((state) => {
        if (state.activePreset === 'custom' && state.custom) {
          const custom: CustomLayoutState = {
            ...state.custom,
            ratios: { ...state.custom.ratios, [splitId]: ratio },
          };
          persist('custom', state.presetStates, custom);
          return { custom };
        }
        const presetId = state.activePreset as PresetId;
        const current = state.presetStates[presetId];
        const presetStates: Record<PresetId, PersistedPresetState> = {
          ...state.presetStates,
          [presetId]: {
            ...current,
            ratios: { ...current.ratios, [splitId]: ratio },
          },
        };
        persist(presetId, presetStates, state.custom);
        return { presetStates };
      }),

    toggleCollapsed: (pane) =>
      set((state) => {
        if (state.activePreset === 'custom' && state.custom) {
          const collapsed = state.custom.collapsed.includes(pane)
            ? state.custom.collapsed.filter((candidate) => candidate !== pane)
            : [...state.custom.collapsed, pane];
          const custom: CustomLayoutState = { ...state.custom, collapsed };
          persist('custom', state.presetStates, custom);
          return { custom };
        }
        const presetId = state.activePreset as PresetId;
        const current = state.presetStates[presetId];
        const collapsed = current.collapsed.includes(pane)
          ? current.collapsed.filter((candidate) => candidate !== pane)
          : [...current.collapsed, pane];
        const presetStates: Record<PresetId, PersistedPresetState> = {
          ...state.presetStates,
          [presetId]: { ...current, collapsed },
        };
        persist(presetId, presetStates, state.custom);
        return { presetStates };
      }),

    swapPanes: (a, b) =>
      set((state) => {
        const root = activeLayoutRoot(state);
        if (!root) return {};
        const { ratios, collapsed } = activeLayoutState(state);
        const basePreset =
          state.activePreset === 'custom' && state.custom
            ? state.custom.basePreset
            : (state.activePreset as PresetId);
        const custom: CustomLayoutState = {
          root: swapLeaves(root, a, b),
          ratios,
          collapsed,
          basePreset,
        };
        persist('custom', state.presetStates, custom);
        return { activePreset: 'custom', custom };
      }),

    movePaneToEdge: (pane, edge) =>
      set((state) => {
        const root = activeLayoutRoot(state);
        if (!root) return {};
        const { ratios, collapsed } = activeLayoutState(state);
        const basePreset =
          state.activePreset === 'custom' && state.custom
            ? state.custom.basePreset
            : (state.activePreset as PresetId);
        const { root: newRoot } = moveToEdge(root, pane, edge);
        // The one new split `moveToEdge` adds has no entry in `ratios` yet
        // -- deliberately left that way rather than added here. `LayoutRoot`
        // already falls back to a `SplitNode`'s own `ratio` field when the
        // store has no override for its id (`ratios[node.id] ?? node.ratio`,
        // the same fallback every preset's *first* render relies on), so
        // the new split renders at `moveToEdge`'s chosen default without
        // this action needing to duplicate that value here. Every other
        // split's ratio is untouched, satisfying "preserve untouched
        // splits' ratios" for free.
        const custom: CustomLayoutState = {
          root: newRoot,
          ratios,
          collapsed,
          basePreset,
        };
        persist('custom', state.presetStates, custom);
        return { activePreset: 'custom', custom };
      }),

    activateCustom: () =>
      set((state) => {
        if (!state.custom) return {};
        persist('custom', state.presetStates, state.custom);
        return { activePreset: 'custom' };
      }),

    resetCustomLayout: () =>
      set((state) => {
        const fallback = state.custom?.basePreset ?? DEFAULT_PRESET_ID;
        persist(fallback, state.presetStates, null);
        return { activePreset: fallback, custom: null };
      }),
  };
});
