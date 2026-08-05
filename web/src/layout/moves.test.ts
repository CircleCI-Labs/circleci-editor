import { describe, expect, it } from 'vitest';

import { PRESETS } from './presets';
import { pane, split, type LayoutNode, type PaneId } from './types';
import { collectPaneIds, moveToEdge, swapLeaves } from './moves';

const ALL_PANES: readonly PaneId[] = ['yaml', 'ai', 'dag', 'docs', 'palette'];

describe('swapLeaves', () => {
  it('exchanges two panes without touching any split id, direction, or ratio', () => {
    const root = split('outer', 'row', 0.3, [
      pane('yaml'),
      split('inner', 'column', 0.6, [pane('ai'), pane('dag')]),
    ]);

    const swapped = swapLeaves(root, 'yaml', 'dag') as typeof root;
    expect(swapped.id).toBe('outer');
    expect(swapped.ratio).toBe(0.3);
    expect(swapped.children[0]).toEqual(pane('dag'));
    const inner = swapped.children[1] as typeof root;
    expect(inner.id).toBe('inner');
    expect(inner.ratio).toBe(0.6);
    expect(inner.children[1]).toEqual(pane('yaml'));
    expect(inner.children[0]).toEqual(pane('ai')); // untouched
  });

  it('is a no-op shape-wise when neither pane is present', () => {
    const root = split('outer', 'row', 0.3, [pane('yaml'), pane('ai')]);
    const swapped = swapLeaves(root, 'dag', 'docs');
    expect(swapped).toEqual(root);
  });

  it('preserves every real preset root exactly (same 5 panes, no duplicates) after a swap', () => {
    for (const preset of PRESETS) {
      const swapped = swapLeaves(preset.root, 'yaml', 'palette');
      expect(collectPaneIds(swapped).slice().sort()).toEqual(
        [...ALL_PANES].sort(),
      );
    }
  });
});

describe('moveToEdge', () => {
  it('wraps the whole tree with the moved pane on the requested edge', () => {
    const root = split('outer', 'row', 0.3, [pane('yaml'), pane('ai')]);
    const { root: result, newSplitId } = moveToEdge(root, 'ai', 'left');

    expect(result.type).toBe('split');
    const asSplit = result as Extract<LayoutNode, { type: 'split' }>;
    expect(asSplit.id).toBe(newSplitId);
    expect(asSplit.direction).toBe('row');
    expect(asSplit.children[0]).toEqual(pane('ai'));
    // The survivor is whatever remained after removing `ai` -- here just
    // `yaml`, since removing `ai` from a two-leaf split collapses it away.
    expect(asSplit.children[1]).toEqual(pane('yaml'));
  });

  it('uses a column split for top/bottom and a row split for left/right', () => {
    const root = split('outer', 'row', 0.3, [pane('yaml'), pane('ai')]);
    expect(moveToEdge(root, 'ai', 'top').root).toMatchObject({
      direction: 'column',
    });
    expect(moveToEdge(root, 'ai', 'bottom').root).toMatchObject({
      direction: 'column',
    });
    expect(moveToEdge(root, 'ai', 'left').root).toMatchObject({
      direction: 'row',
    });
    expect(moveToEdge(root, 'ai', 'right').root).toMatchObject({
      direction: 'row',
    });
  });

  it('puts the moved pane first for left/top, second for right/bottom', () => {
    const root = split('outer', 'row', 0.3, [pane('yaml'), pane('ai')]);
    expect(moveToEdge(root, 'ai', 'left').root).toMatchObject({
      children: [pane('ai'), pane('yaml')],
    });
    expect(moveToEdge(root, 'ai', 'right').root).toMatchObject({
      children: [pane('yaml'), pane('ai')],
    });
    expect(moveToEdge(root, 'ai', 'top').root).toMatchObject({
      children: [pane('ai'), pane('yaml')],
    });
    expect(moveToEdge(root, 'ai', 'bottom').root).toMatchObject({
      children: [pane('yaml'), pane('ai')],
    });
  });

  it("collapses away the pane's old parent split rather than leaving a dead single-child wrapper", () => {
    // dag sits inside a nested split, like the real `DAG_WITH_PALETTE` shape.
    const root = split('outer', 'row', 0.3, [
      pane('yaml'),
      split('dag-palette', 'row', 0.72, [pane('dag'), pane('palette')]),
    ]);

    const { root: result } = moveToEdge(root, 'dag', 'right');
    const asSplit = result as Extract<LayoutNode, { type: 'split' }>;
    // The new top-level split's "rest" side must be `outer` with `dag`
    // removed -- i.e. yaml alongside bare `palette`, not a split still
    // carrying a now-pointless single child.
    expect(asSplit.children[0]).toMatchObject({
      id: 'outer',
      children: [pane('yaml'), pane('palette')],
    });
    expect(asSplit.children[1]).toEqual(pane('dag'));
  });

  it("preserves every other split's id, direction and ratio untouched by the move", () => {
    const root = split('outer', 'row', 0.3, [
      pane('yaml'),
      split('inner', 'column', 0.64, [
        pane('ai'),
        split('dag-palette', 'row', 0.72, [pane('dag'), pane('palette')]),
      ]),
    ]);

    const { root: result } = moveToEdge(root, 'docs', 'bottom');
    // `docs` isn't even in this tree -- moveToEdge should still wrap
    // cleanly (a pane not yet present just gets added at the edge; the
    // rest of the tree, including every id/ratio, survives verbatim).
    const asSplit = result as Extract<LayoutNode, { type: 'split' }>;
    expect(asSplit.children[0]).toEqual(root);
  });

  it('never accumulates depth from repeatedly moving the same pane between edges', () => {
    let root: LayoutNode = split('outer', 'row', 0.3, [
      pane('yaml'),
      split('inner', 'column', 0.64, [
        pane('ai'),
        split('dag-palette', 'row', 0.72, [
          pane('dag'),
          split('dag-docs', 'row', 0.8, [pane('palette'), pane('docs')]),
        ]),
      ]),
    ]);

    function depth(node: LayoutNode): number {
      return node.type === 'pane'
        ? 0
        : 1 + Math.max(depth(node.children[0]), depth(node.children[1]));
    }

    const depths: number[] = [];
    for (const edge of ['left', 'top', 'right', 'bottom', 'left'] as const) {
      const result = moveToEdge(root, 'palette', edge);
      root = result.root;
      depths.push(depth(root));
      // Still every pane, exactly once, after each move.
      expect(collectPaneIds(root).slice().sort()).toEqual(
        [...ALL_PANES].sort(),
      );
    }
    // Bouncing the *same* pane between edges five times must not grow
    // without bound -- each move un-nests the previous wrapper before
    // adding a new one.
    expect(Math.max(...depths)).toBeLessThanOrEqual(
      Math.max(...depths.slice(0, 1)) + 1,
    );
    expect(new Set(depths).size).toBeLessThanOrEqual(2);
  });

  it('adds at most one level of depth per move across different panes', () => {
    let root: LayoutNode = PRESETS[0]!.root;
    const before = (function depth(node: LayoutNode): number {
      return node.type === 'pane'
        ? 0
        : 1 + Math.max(depth(node.children[0]), depth(node.children[1]));
    })(root);

    const result = moveToEdge(root, 'palette', 'left');
    root = result.root;
    const after = (function depth(node: LayoutNode): number {
      return node.type === 'pane'
        ? 0
        : 1 + Math.max(depth(node.children[0]), depth(node.children[1]));
    })(root);
    // The new top-level wrap always adds one level; removing `palette` from
    // wherever it used to sit can simultaneously collapse a level elsewhere
    // in the tree, so the net change is "at most +1," not always exactly
    // +1 -- this asserts the bound the depth-accumulation test above relies
    // on, not a specific number.
    expect(after).toBeLessThanOrEqual(before + 1);
  });
});

describe('collectPaneIds', () => {
  it('walks a tree depth-first, left to right', () => {
    const root = split('outer', 'row', 0.5, [
      pane('yaml'),
      split('inner', 'row', 0.5, [pane('ai'), pane('dag')]),
    ]);
    expect(collectPaneIds(root)).toEqual(['yaml', 'ai', 'dag']);
  });
});
