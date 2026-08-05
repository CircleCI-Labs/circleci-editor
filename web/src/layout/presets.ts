/**
 * Preset pane arrangements (issue #30). Each preset is *data* -- a
 * `LayoutNode` tree plus which panes start collapsed -- rendered by the
 * same generic `LayoutRoot` walk. Adding a sixth preset means adding an
 * entry here, not a new component.
 *
 * `three-column`, `graph-only` and `editor-only` deliberately share one
 * tree object: "graph only" / "editor only" are not a different shape, just
 * the three-column shape with the other two panes collapsed to strips. That
 * also means dragging the yaml/ai or ai/dag splitter while, say, "editor
 * only" is active adjusts the *same* persisted ratios `three-column` would
 * restore to once panes are expanded again -- which is the intended
 * behaviour (it really is the same layout, just with two regions pinched
 * shut), not an accidental coupling.
 */
import { pane, split, type LayoutNode, type PaneId } from './types';

export type PresetId =
  | 'three-column'
  | 'graph-focus'
  | 'editor-focus'
  | 'graph-only'
  | 'editor-only';

export interface LayoutPreset {
  id: PresetId;
  label: string;
  description: string;
  root: LayoutNode;
  /** Panes collapsed the *first* time this preset is selected. Once the
   * user has toggled a pane themselves, their choice is what's persisted
   * (see `state/layoutStore.ts`) -- this only seeds the initial default. */
  defaultCollapsed: readonly PaneId[];
}

/**
 * Issue #88: every preset's `dag` leaf is this split instead of a bare
 * `pane('dag')` -- the object palette sits beside the graph as a real,
 * resizable, independently-collapsible sibling pane rather than a fixed
 * 320px column `DagPane` used to render inline next to its own resizable
 * inspector. `0.72` favours the graph, matching the canvas's rough share
 * under the old fixed-320px arrangement on a typical window, but it's now a
 * *default* a user can actually drag away from -- the old column had no
 * splitter at all, only an on/off toggle. `DagPane` still owns every bit of
 * the palette's actual behaviour (drag payloads, insertion hooks, dialogs);
 * see `panes/dag/palette/palettePortalTarget.ts` for how its rendered
 * content still reaches this split's second leaf.
 */
const DAG_WITH_PALETTE: LayoutNode = split('dag-palette', 'row', 0.72, [
  pane('dag'),
  pane('palette'),
]);

// Shared by three-column / graph-only / editor-only -- see module doc
// comment above. Left-to-right: config, AI assistant, workflow graph,
// matching the app's historical fixed 3-column grid.
const THREE_COLUMN_ROOT: LayoutNode = split('outer', 'row', 0.3, [
  pane('yaml'),
  split('inner', 'row', 0.36, [pane('ai'), DAG_WITH_PALETTE]),
]);

const GRAPH_FOCUS_ROOT: LayoutNode = split('outer', 'column', 0.72, [
  split('top', 'row', 0.35, [pane('yaml'), DAG_WITH_PALETTE]),
  pane('ai'),
]);

const EDITOR_FOCUS_ROOT: LayoutNode = split('outer', 'column', 0.4, [
  pane('yaml'),
  split('bottom', 'column', 0.85, [DAG_WITH_PALETTE, pane('ai')]),
]);

/**
 * Wraps a preset's existing root as the first (larger) side of one new
 * `row` split, with the schema-derived reference pane (issue #83,
 * `panes/docs/DocsPane`) as a sidebar on the second. Every preset uses this
 * -- not a bespoke fourth-pane placement per preset -- for the same reason
 * `three-column`/`graph-only`/`editor-only` already share one tree object
 * (see this module's doc comment): the reference reads as a tall narrow
 * sidebar regardless of whatever `row`/`column` shape the rest of a given
 * preset happens to use internally, so wrapping is the one placement that
 * never has to know that shape. `id` must still be unique *within* the
 * preset that owns it, same rule as any other split -- `'with-docs'` never
 * collides with an inner id since none of the five presets' own trees use
 * that name.
 */
function withDocsSidebar(root: LayoutNode): LayoutNode {
  return split('with-docs', 'row', 0.8, [root, pane('docs')]);
}

export const PRESETS: readonly LayoutPreset[] = [
  {
    id: 'three-column',
    label: 'Columns',
    description: 'Config, AI assistant and workflow graph side by side.',
    root: withDocsSidebar(THREE_COLUMN_ROOT),
    // Already three visible panes; see `withDocsSidebar`'s and
    // `DEFAULT_PRESET_ID`'s neighbouring comments for why the reference
    // starts collapsed everywhere except `graph-focus`.
    defaultCollapsed: ['docs'],
  },
  {
    id: 'graph-focus',
    label: 'Graph focus',
    description:
      'Config and graph on top, AI assistant across the bottom, config reference on the side.',
    root: withDocsSidebar(GRAPH_FOCUS_ROOT),
    // The reference starts collapsed here too, despite this being the pane
    // it was designed for.
    //
    // Measured on the running app with the reference expanded on a real
    // 12-job config: four visible panes plus the DAG's own palette and
    // inspector left the graph canvas as the *narrowest* useful region on
    // screen, with node boxes clipped at its left edge -- and the graph is
    // this preset's whole point. There were five simultaneously-scrollable
    // regions, which is the exact quantity issue #88 exists to bring down.
    // (#88 has since promoted the palette to its own pane -- see
    // `DAG_WITH_PALETTE` -- so that specific combination no longer applies,
    // but the reference stays collapsed by default regardless: a fourth
    // pane opening itself on first run is the thing being avoided, not just
    // the number five.)
    //
    // It is also what the owner asked this preset to be, in as many words:
    // config left, graph right, AI across the bottom. A fourth pane opening
    // itself on first run quietly overrides that. The reference is one click
    // away from every preset instead, which costs a user who wants it almost
    // nothing and costs a user who doesn't a great deal less.
    defaultCollapsed: ['docs'],
  },
  {
    id: 'editor-focus',
    label: 'Editor focus',
    description: 'Config across the top, graph below.',
    root: withDocsSidebar(EDITOR_FOCUS_ROOT),
    // The AI pane is functional (issue #92) but still starts tucked out of
    // the way here: this preset exists to give the editor and the graph the
    // vertical space, and an assistant nobody has asked a question of yet
    // shouldn't eat a slice of it. One click on the "Expand" strip when it's
    // wanted.
    // The reference joins it collapsed for the same "don't dilute a
    // deliberately narrow preset" reason -- see `withDocsSidebar`'s comment.
    defaultCollapsed: ['ai', 'docs'],
  },
  {
    id: 'graph-only',
    label: 'Graph only',
    description: 'Workflow graph maximised; config and AI assistant collapsed.',
    root: withDocsSidebar(THREE_COLUMN_ROOT),
    // Palette stays open here (not in this list) -- this preset's whole
    // point is building out the graph, and the palette is the primary way
    // to do that.
    defaultCollapsed: ['yaml', 'ai', 'docs'],
  },
  {
    id: 'editor-only',
    label: 'Editor only',
    description: 'Config maximised; AI assistant and graph collapsed.',
    root: withDocsSidebar(THREE_COLUMN_ROOT),
    // Issue #88: the palette collapses along with `dag` here -- there's
    // nothing to drag it onto while the graph itself is hidden, so leaving
    // it expanded would just be a second collapsed-for-no-reason pane to
    // click past.
    defaultCollapsed: ['ai', 'dag', 'palette', 'docs'],
  },
];

// 'graph-focus', not 'three-column': a first-run user's most immediate need
// is seeing the workflow graph next to the config that produces it, with
// the (currently backend-less, see `editor-focus`'s own comment) AI
// assistant given a share of space but not fighting the other two for
// horizontal room. Changing this alone would be invisible to anyone who
// already has a persisted choice, including the old default -- see
// `LAYOUT_SCHEMA_VERSION` in `state/layoutStore.ts`, bumped alongside this.
export const DEFAULT_PRESET_ID: PresetId = 'graph-focus';

export function getPreset(id: string): LayoutPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function isPresetId(value: string): value is PresetId {
  return PRESETS.some((preset) => preset.id === value);
}
