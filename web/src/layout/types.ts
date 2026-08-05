/**
 * Shared types for the configurable pane layout (issue #30). The three
 * panes are laid out by a small binary-split tree instead of bespoke JSX
 * per arrangement: every preset in `./presets` is *data* describing which
 * two regions sit inside each split, in which direction, and (by default)
 * how big each one is. `LayoutRoot` walks that tree once, generically, so
 * a new preset never needs a new rendering code path.
 */

/** The five panes this app has today (issue #83 added `docs`; issue #88
 * added `palette`). Adding a sixth is a type error everywhere until every
 * preset accounts for it -- deliberately, since a preset that silently
 * omitted a pane would make it unreachable.
 *
 * `palette` (issue #88): the object palette used to be a fixed 320px column
 * `DagPane` rendered inline, permanently stacked next to its own resizable
 * inspector -- together the narrowest useful region on screen became the
 * workflow graph itself, in the one preset whose entire purpose is the
 * graph. Promoting it to a real pane hands its sizing to this same
 * splitter/collapse machinery every other pane already gets (resizable,
 * keyboard-accessible, collapses to a strip that reclaims its space
 * exactly, persists per preset) instead of a fixed width with a single
 * on/off toggle. `DagPane` still owns every bit of the palette's actual
 * behaviour -- see `panes/dag/palette/palettePortalTarget.ts`'s doc comment
 * for how its content still reaches this pane's slot. */
export type PaneId = 'yaml' | 'ai' | 'dag' | 'docs' | 'palette';

export const PANE_IDS: readonly PaneId[] = [
  'yaml',
  'ai',
  'dag',
  'docs',
  'palette',
];

/** Human-readable labels for a pane's collapsed strip / expand button and
 * for the (rare) case its own heading isn't available as a fallback.
 * `docs` -- 'Reference', not 'Docs': it's the vendored config JSON Schema
 * rendered browsable (see `panes/docs/DocsPane`), not prose documentation,
 * and the label should not promise more than that. */
export const PANE_LABELS: Record<PaneId, string> = {
  yaml: 'Config',
  ai: 'AI Assistant',
  dag: 'Workflow Graph',
  docs: 'Reference',
  palette: 'Palette',
};

export type SplitDirection = 'row' | 'column';

/** A leaf: one pane occupies this region. */
export interface PaneNode {
  type: 'pane';
  pane: PaneId;
}

/**
 * An internal node: splits its region into two children along `direction`
 * ('row' = side-by-side, 'column' = stacked). `id` is the persistence key
 * for this split's user-adjusted ratio (see `state/layoutStore.ts`) and
 * must be unique *within* the preset that owns it -- two different presets
 * may reuse the same id without colliding, since ratios are stored keyed
 * by `(presetId, splitId)`.
 *
 * `ratio` is this node's *default* share of the first child (0..1); the
 * store overrides it once the user has dragged the corresponding
 * splitter, so this field is only ever read as a fallback.
 */
export interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  children: readonly [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

export function pane(pane: PaneId): PaneNode {
  return { type: 'pane', pane };
}

export function split(
  id: string,
  direction: SplitDirection,
  ratio: number,
  children: readonly [LayoutNode, LayoutNode],
): SplitNode {
  return { type: 'split', id, direction, ratio, children };
}

/** Walks a tree collecting every split's id -> default ratio, so the store
 * can seed persisted state for a preset it has never seen sizes for yet. */
export function collectDefaultRatios(
  node: LayoutNode,
  out: Record<string, number> = {},
): Record<string, number> {
  if (node.type === 'split') {
    out[node.id] = node.ratio;
    collectDefaultRatios(node.children[0], out);
    collectDefaultRatios(node.children[1], out);
  }
  return out;
}

/**
 * True if `node` is a pane in `collapsed`, or a split whose *both* children
 * are (recursively) fully collapsed. Used by `LayoutRoot` to decide whether
 * a region gets a fixed strip size or a flexible, ratio-driven share of
 * space -- see that module's doc comment for why this needs to be
 * recursive rather than just checking the immediate child.
 */
export function isFullyCollapsed(
  node: LayoutNode,
  collapsed: ReadonlySet<PaneId>,
): boolean {
  if (node.type === 'pane') return collapsed.has(node.pane);
  return (
    isFullyCollapsed(node.children[0], collapsed) &&
    isFullyCollapsed(node.children[1], collapsed)
  );
}
