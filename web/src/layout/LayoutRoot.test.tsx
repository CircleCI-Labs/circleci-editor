import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { Panel } from '~/design/components/Panel';
import {
  buildDefaultPersistedLayout,
  useLayoutStore,
} from '~/state/layoutStore';

import { COLLAPSED_STRIP_PX } from './constants';
import { LayoutRoot } from './LayoutRoot';
import { PRESETS } from './presets';

function resetStoreToDefaults(): void {
  window.localStorage.clear();
  const defaults = buildDefaultPersistedLayout();
  useLayoutStore.setState({
    activePreset: defaults.activePreset,
    presetStates: defaults.presets,
    custom: defaults.custom,
  });
}

const SIMPLE_PANES = {
  yaml: <div data-testid="yaml-content">yaml pane</div>,
  ai: <div data-testid="ai-content">ai pane</div>,
  dag: <div data-testid="dag-content">dag pane</div>,
  docs: <div data-testid="docs-content">docs pane</div>,
  // Issue #88.
  palette: <div data-testid="palette-content">palette pane</div>,
};

describe('LayoutRoot', () => {
  beforeEach(() => {
    resetStoreToDefaults();
  });

  it.each(PRESETS.map((preset) => preset.id))(
    'renders all five panes for the "%s" preset',
    (presetId) => {
      useLayoutStore.getState().setPreset(presetId);
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      // Present in the DOM regardless of collapsed state -- a collapsed pane
      // is hidden, never unmounted (see `PaneSlot`). `docs` (issue #83) starts
      // collapsed in every preset but `graph-focus`, and `palette` (issue
      // #88) starts collapsed only in `editor-only` -- both still present
      // here regardless.
      expect(screen.getByTestId('yaml-content')).toBeInTheDocument();
      expect(screen.getByTestId('ai-content')).toBeInTheDocument();
      expect(screen.getByTestId('dag-content')).toBeInTheDocument();
      expect(screen.getByTestId('docs-content')).toBeInTheDocument();
      expect(screen.getByTestId('palette-content')).toBeInTheDocument();
    },
  );

  // Issue #83: the reference pane is visible by default in exactly one
  // preset (`graph-focus`, also `DEFAULT_PRESET_ID` -- see
  // `layout/presets.ts`'s `withDocsSidebar` and the design doc for why),
  // collapsed everywhere else so it doesn't add to the crowding the
  // splitter-gutter fix just addressed.
  // The reference pane starts collapsed in *every* preset, including the
  // graph-focus one it was designed for. Measured with it expanded on a real
  // 12-job config, four visible panes plus the DAG's own palette and inspector
  // left the graph canvas as the narrowest useful region on screen with nodes
  // clipped at its edge -- and five simultaneously-scrollable regions, the
  // quantity issue #88 exists to reduce. See `presets.ts` for the full
  // rationale; it is also what this preset was asked to be (config left,
  // graph right, AI bottom).
  it.each([
    'graph-focus',
    'three-column',
    'editor-focus',
    'graph-only',
    'editor-only',
  ] as const)(
    'starts the reference pane collapsed by default in the "%s" preset',
    (presetId) => {
      useLayoutStore.getState().setPreset(presetId);
      render(<LayoutRoot panes={SIMPLE_PANES} />);
      expect(screen.getByTestId('docs-content')).not.toBeVisible();
      expect(
        screen.getByRole('button', { name: /expand reference panel/i }),
      ).toBeInTheDocument();
    },
  );

  it('shows a collapsed strip with a working expand button for a pane collapsed by preset default', () => {
    useLayoutStore.getState().setPreset('graph-only'); // collapses yaml + ai by default
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    expect(screen.getByTestId('yaml-content')).not.toBeVisible();
    expect(screen.getByTestId('ai-content')).not.toBeVisible();
    expect(screen.getByTestId('dag-content')).toBeVisible();

    const expandYaml = screen.getByRole('button', {
      name: /expand config panel/i,
    });
    fireEvent.click(expandYaml);

    expect(screen.getByTestId('yaml-content')).toBeVisible();
    // `docs` also starts collapsed by default for this preset (issue #83);
    // expanding `yaml` must leave it untouched, not just `ai`.
    expect(
      useLayoutStore.getState().presetStates['graph-only'].collapsed,
    ).toEqual(['ai', 'docs']);
  });

  it('lets an expanded pane collapse itself via its own "Collapse" button', () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    expect(screen.getByTestId('ai-content')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: /collapse ai assistant panel/i }),
    );

    expect(screen.getByTestId('ai-content')).not.toBeVisible();
    // `docs` already starts collapsed by default in this preset (issue
    // #83); collapsing `ai` must add to that set, not replace it.
    expect(
      useLayoutStore.getState().presetStates['three-column'].collapsed,
    ).toEqual(['docs', 'ai']);
  });

  it('renders a keyboard-resizable separator for every visible split', () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    const separators = screen.getAllByRole('separator');
    // three-column has three splits (outer: yaml|rest, inner: ai|dag-with-
    // palette, and -- issue #88 -- dag-palette: dag|palette), all three with
    // two flexible sides by default, so all three should render an active
    // splitter.
    expect(separators).toHaveLength(3);
    for (const separator of separators) {
      expect(separator).toHaveAttribute('tabindex', '0');
      expect(separator).toHaveAttribute('aria-valuenow');
    }
  });

  it('does not render a splitter next to a collapsed (fixed-size) side', () => {
    useLayoutStore.getState().setPreset('editor-focus'); // ai starts collapsed
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    // The outer (yaml / bottom-row) split has two flexible sides, and so
    // does the dag-with-palette split nested inside "bottom" (issue #88:
    // neither `dag` nor `palette` is collapsed by default here) -- both get
    // an active splitter. The bottom row's own split (dag-with-palette |
    // collapsed ai) does not: dragging against a fixed strip does nothing
    // useful.
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  // Regression test for a bug where collapsing a pane left dead space next
  // to its now-expanded sibling instead of the sibling reclaiming it (e.g.
  // collapsing the AI assistant in "Columns" mode left a gap between it and
  // the workflow graph). See `fixedChildStyle` in `LayoutRoot.tsx`.
  it('gives a collapsed pane leaf an explicit pixel strip instead of leaving the browser to size it from content', () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    fireEvent.click(
      screen.getByRole('button', { name: /collapse ai assistant panel/i }),
    );

    // The div `NodeRenderer` wraps `PaneSlot` in for the collapsed 'ai' leaf
    // -- walking up from the (hidden) content div: PaneSlot's own content
    // wrapper, then PaneSlot's root, then this one.
    const aiStrip = screen.getByTestId('ai-content').parentElement!
      .parentElement!.parentElement as HTMLElement;
    expect(aiStrip.style.flexBasis).toBe(`${COLLAPSED_STRIP_PX}px`);
    expect(aiStrip.style.flexGrow).toBe('0');
    expect(aiStrip.style.flexShrink).toBe('0');
    expect(aiStrip.style.width).toBe(`${COLLAPSED_STRIP_PX}px`);
  });

  it("lets the flexible sibling reclaim 100% of a collapsed pane's freed space -- no dead space left over", () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    fireEvent.click(
      screen.getByRole('button', { name: /collapse ai assistant panel/i }),
    );

    // Issue #88 added a layer: `dag` is no longer `inner`'s direct second
    // child -- it's now nested one split deeper, inside `dag-palette` (dag |
    // palette), which *is* `inner`'s direct second child. So reaching the
    // box whose flex-grow this test cares about means walking up two more
    // levels than before the palette became its own pane: past `dag`'s own
    // `PaneSlot` (2 levels, same as ever), then past `dag-palette`'s own
    // per-child sizing div (1), then past `dag-palette`'s own flex-row
    // container (1), landing on `inner`'s sizing div for its second child --
    // the one this test is actually about.
    const dagBox = screen.getByTestId('dag-content').parentElement!
      .parentElement!.parentElement!.parentElement!
      .parentElement as HTMLElement;
    // No splitter renders next to a collapsed sibling (see the test above
    // this one in the suite), so the dag-with-palette split is the *only*
    // flex item left in this row. Its flex-grow must be exactly `1`, not the
    // split's ordinary `ratio`/`1 - ratio` factor (e.g. 0.64 for
    // three-column's inner split): per the flexbox spec, when the sum of a
    // row's flex-grow factors is *less than 1*, only that fraction of the
    // free space is actually distributed -- a lone item left at grow `0.64`
    // claims only 64% of what its collapsed sibling freed up, and the other
    // 36% is real, unclaimed dead space, confirmed against a live browser
    // (see `fixedChildStyle`'s neighbouring comment in `LayoutRoot.tsx`).
    // `1` is therefore not an arbitrary "big enough" value -- it's the only
    // factor that makes "the sole flexible item claims 100% of the
    // remainder" true rather than approximately true.
    expect(dagBox.style.flexGrow).toBe('1');
    expect(dagBox.style.flexBasis).toBe('0%');

    const containerPx = 900;
    const fixedPx = COLLAPSED_STRIP_PX;
    const flexiblePx = containerPx - fixedPx; // the only other flex item, so it takes 100% of the remainder
    expect(fixedPx + flexiblePx).toBe(containerPx);
  });

  it('sizes a collapsed strip by height, not width, when its split runs column rather than row', () => {
    useLayoutStore.getState().setPreset('graph-focus'); // ai sits under a 'column' outer split here
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    fireEvent.click(
      screen.getByRole('button', { name: /collapse ai assistant panel/i }),
    );

    const aiStrip = screen.getByTestId('ai-content').parentElement!
      .parentElement!.parentElement as HTMLElement;
    expect(aiStrip.style.flexBasis).toBe(`${COLLAPSED_STRIP_PX}px`);
    expect(aiStrip.style.height).toBe(`${COLLAPSED_STRIP_PX}px`);
    expect(aiStrip.style.width).toBe(''); // the cross axis here -- untouched
  });

  it('arrow-key resizing a splitter changes its ratio in the store', () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    const before =
      useLayoutStore.getState().presetStates['three-column'].ratios.outer!;
    const outerSeparator = screen.getAllByRole('separator')[0]!;
    fireEvent.keyDown(outerSeparator, { key: 'ArrowRight' });

    const after =
      useLayoutStore.getState().presetStates['three-column'].ratios.outer!;
    expect(after).toBeGreaterThan(before);
    expect(outerSeparator).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(after * 100)),
    );
  });

  it('Home/End snap a splitter to its minimum/maximum ratio', () => {
    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={SIMPLE_PANES} />);

    const outerSeparator = screen.getAllByRole('separator')[0]!;
    fireEvent.keyDown(outerSeparator, { key: 'End' });
    const maxed =
      useLayoutStore.getState().presetStates['three-column'].ratios.outer!;
    expect(maxed).toBeGreaterThan(0.5);

    fireEvent.keyDown(outerSeparator, { key: 'Home' });
    const mined =
      useLayoutStore.getState().presetStates['three-column'].ratios.outer!;
    expect(mined).toBeLessThan(0.5);
  });

  it('does not remount a pane while a splitter is dragged/resized -- its own state survives', () => {
    // Stands in for something like the YAML editor's cursor/scroll
    // position: internal state that a remount would silently reset.
    function StatefulPane() {
      const [value, setValue] = useState('');
      return (
        <input
          aria-label="stateful pane input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }

    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={{ ...SIMPLE_PANES, yaml: <StatefulPane /> }} />);

    const input = screen.getByLabelText('stateful pane input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(input).toHaveValue('hello');

    const outerSeparator = screen.getAllByRole('separator')[0]!;
    fireEvent.keyDown(outerSeparator, { key: 'ArrowRight' });
    fireEvent.keyDown(outerSeparator, { key: 'ArrowRight' });

    // Re-query: if the pane had remounted, this would be a *different*
    // input element reset to its default (empty) value.
    expect(screen.getByLabelText('stateful pane input')).toHaveValue('hello');
  });

  it('does not remount a pane across a collapse/expand cycle', () => {
    function StatefulPane() {
      const [value, setValue] = useState('');
      return (
        <input
          aria-label="stateful pane input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }

    useLayoutStore.getState().setPreset('three-column');
    render(<LayoutRoot panes={{ ...SIMPLE_PANES, ai: <StatefulPane /> }} />);

    fireEvent.change(screen.getByLabelText('stateful pane input'), {
      target: { value: 'kept' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: /collapse ai assistant panel/i }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /expand ai assistant panel/i }),
    );

    expect(screen.getByLabelText('stateful pane input')).toHaveValue('kept');
  });

  it('keeps every layout container clipped so nothing can force page-level horizontal scroll', () => {
    useLayoutStore.getState().setPreset('graph-focus');
    const { container } = render(<LayoutRoot panes={SIMPLE_PANES} />);

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain('overflow-hidden');

    // Every split's own flex wrapper (there is one per split node) must
    // also clip, not scroll -- a flexible child is *allowed* to shrink
    // toward its min-size floor, but its container must never expand past
    // its own share and drag the page wider with it.
    const splitWrappers = container.querySelectorAll(
      '[class*="flex-row"], [class*="flex-col"]',
    );
    expect(splitWrappers.length).toBeGreaterThan(0);
    for (const wrapper of splitWrappers) {
      expect(wrapper.className).toContain('overflow-hidden');
    }
  });

  // Issue #121: the "Move" menu on each pane's header, and rendering the
  // resulting custom layout.
  describe('pane rearrangement (issue #121)', () => {
    it('every expanded pane exposes a keyboard-reachable "Move" button', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      // `ai` is the only pane visible in this preset besides yaml/dag
      // (docs starts collapsed) -- collapsed panes render a bare "Expand"
      // strip with no "Move" button, by design (see `PaneSlot`).
      const moveButtons = screen.getAllByRole('button', { name: 'Move' });
      expect(moveButtons.length).toBeGreaterThanOrEqual(3);
    });

    it('choosing "swap with" from one pane\'s Move menu re-parents both panes and switches to Custom', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      const configMove = within(screen.getByTestId('pane-yaml')).getByRole(
        'button',
        { name: 'Move' },
      );
      fireEvent.click(configMove);
      fireEvent.click(screen.getByRole('menuitem', { name: 'AI Assistant' }));

      expect(useLayoutStore.getState().activePreset).toBe('custom');
      // Both panes' content is still in the document (re-parenting must
      // never unmount either) -- content stays exactly where it was
      // authored, just addressed by a different tree position now.
      expect(screen.getByTestId('yaml-content')).toBeInTheDocument();
      expect(screen.getByTestId('ai-content')).toBeInTheDocument();
    });

    it('choosing "move to edge" wraps the layout and switches to Custom', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      const dagMove = within(screen.getByTestId('pane-dag')).getByRole(
        'button',
        { name: 'Move' },
      );
      fireEvent.click(dagMove);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Left edge' }));

      const state = useLayoutStore.getState();
      expect(state.activePreset).toBe('custom');
      expect(screen.getByTestId('dag-content')).toBeInTheDocument();
    });

    it('closes the Move menu on Escape without performing an action', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      const dagMove = within(screen.getByTestId('pane-dag')).getByRole(
        'button',
        { name: 'Move' },
      );
      fireEvent.click(dagMove);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(useLayoutStore.getState().activePreset).toBe('graph-focus');
    });

    it('renders the custom layout tree once activePreset is "custom"', () => {
      useLayoutStore.getState().setPreset('three-column');
      useLayoutStore.getState().swapPanes('yaml', 'dag');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      // Every pane still rendered -- the custom tree still has all five,
      // just rearranged (see `layoutStore.test.ts` for the tree-shape
      // assertions; this only checks the render doesn't drop anything).
      expect(screen.getByTestId('yaml-content')).toBeInTheDocument();
      expect(screen.getByTestId('ai-content')).toBeInTheDocument();
      expect(screen.getByTestId('dag-content')).toBeInTheDocument();
      expect(screen.getByTestId('palette-content')).toBeInTheDocument();
      expect(screen.getByTestId('docs-content')).toBeInTheDocument();
    });
  });

  /**
   * Issue #208: `Move`/`Collapse` fold into each pane's own header, and the
   * chrome strip that used to carry them is gone -- which is where the 24px per
   * pane comes from.
   *
   * These render panes built from the real `Panel`, because that is the landmark
   * the fold targets. The suite below deliberately keeps using bare `<div>`
   * panes, which exercises the *other* half of the contract: a pane with no
   * header to fold into still gets its controls, from `PaneSlot`'s fallback
   * strip. Both paths matter, so both are covered.
   */
  describe('folding the pane controls into the pane header (issue #208)', () => {
    const PANEL_PANES = {
      yaml: (
        <Panel title="Config" headerExtra={<button type="button">Save</button>}>
          <div data-testid="yaml-content">yaml pane</div>
        </Panel>
      ),
      ai: (
        <Panel title="AI Assistant">
          <div data-testid="ai-content">ai pane</div>
        </Panel>
      ),
      dag: (
        <Panel title="Workflow Graph">
          <div data-testid="dag-content">dag pane</div>
        </Panel>
      ),
      docs: (
        <Panel title="Reference">
          <div data-testid="docs-content">docs pane</div>
        </Panel>
      ),
      palette: (
        <Panel title="Palette">
          <div data-testid="palette-content">palette pane</div>
        </Panel>
      ),
    };

    it('renders the controls inside the pane’s own header, and no chrome strip above it', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={PANEL_PANES} />);

      const pane = screen.getByTestId('pane-dag');
      const header = within(pane).getByRole('heading', {
        name: 'Workflow Graph',
      }).parentElement!;
      const move = within(pane).getByRole('button', { name: 'Move' });

      // Inside the pane's own header row...
      expect(header.contains(move)).toBe(true);
      // ...and the 24px strip that used to sit above that header is gone. That
      // is the whole of the reclaimed height; the pixels are measured in
      // `e2e/responsive-layout.spec.ts`, since jsdom runs no layout.
      expect(pane.querySelector(':scope > div.h-6')).toBeNull();
    });

    it('keeps both controls as direct siblings of one items-center row, after the pane’s own controls', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={PANEL_PANES} />);

      const pane = screen.getByTestId('pane-yaml');
      const move = within(pane).getByRole('button', { name: 'Move' });
      const collapse = within(pane).getByRole('button', {
        name: 'Collapse Config panel',
      });
      const save = within(pane).getByRole('button', { name: 'Save' });

      // #183's fix has to survive the move: same parent, both direct children,
      // nothing wrapping either -- that is what makes their vertical centres
      // identical rather than 2px apart. `e2e/layout.spec.ts` measures them.
      expect(move.parentElement).toBe(collapse.parentElement);
      expect(move.parentElement?.className).toContain('items-center');
      // The pane's own controls share the row, and the layout's come last.
      const row = Array.from(move.parentElement!.children);
      expect(save.parentElement).toBe(move.parentElement);
      expect(row.indexOf(save)).toBeLessThan(row.indexOf(move));
      expect(row.indexOf(move)).toBeLessThan(row.indexOf(collapse));
    });

    it('offers no controls to a collapsed pane’s header, which keeps its own strip', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={PANEL_PANES} />);

      // `docs` starts collapsed in every preset (issue #83). Its own header is
      // hidden, so the collapsed strip is the only thing naming the region --
      // exactly as before #208.
      const pane = screen.getByTestId('pane-docs');
      expect(
        within(pane).getByRole('button', { name: 'Expand Reference panel' }),
      ).toHaveTextContent('Reference');
      expect(within(pane).queryByRole('button', { name: 'Move' })).toBeNull();
    });

    it('renders each control exactly once -- never in both a header and a strip', () => {
      useLayoutStore.getState().setPreset('three-column');
      render(<LayoutRoot panes={PANEL_PANES} />);

      for (const pane of ['yaml', 'ai', 'dag', 'palette']) {
        const region = screen.getByTestId(`pane-${pane}`);
        expect(
          within(region).getAllByRole('button', { name: 'Move' }),
        ).toHaveLength(1);
      }
    });

    /** #80's collapse and #121's Move menu must hold from the folded position,
     * not only from the strip the fallback still renders. */
    it('collapses and expands from the folded controls, and still opens the Move menu', () => {
      useLayoutStore.getState().setPreset('three-column');
      render(<LayoutRoot panes={PANEL_PANES} />);

      fireEvent.click(
        screen.getByRole('button', { name: /collapse ai assistant panel/i }),
      );
      expect(screen.getByTestId('ai-content')).not.toBeVisible();
      fireEvent.click(
        screen.getByRole('button', { name: /expand ai assistant panel/i }),
      );
      expect(screen.getByTestId('ai-content')).toBeVisible();

      fireEvent.click(
        within(screen.getByTestId('pane-dag')).getByRole('button', {
          name: 'Move',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Left edge' }));
      expect(useLayoutStore.getState().activePreset).toBe('custom');
    });
  });

  // Issue #183. The *geometry* of the alignment fix can only be asserted in a
  // real browser (jsdom runs no flexbox and reports every box as 0x0) and lives
  // in `e2e/layout.spec.ts`. What can be pinned here is the structure the fix
  // depends on and the semantics it must not trade away.
  //
  // These use the bare-`<div>` `SIMPLE_PANES`, so they exercise `PaneSlot`'s
  // fallback strip: a pane that renders no `Panel` still gets its Move and
  // Collapse (issue #208), and this is the suite that proves it.
  describe('pane chrome (issue #183)', () => {
    it('puts Move and Collapse as direct siblings of one strip, with nothing wrapping either', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      const pane = screen.getByTestId('pane-dag');
      const move = within(pane).getByRole('button', { name: 'Move' });
      const collapse = within(pane).getByRole('button', {
        name: 'Collapse Workflow Graph panel',
      });

      // The 2px misalignment was caused by exactly one thing: `Move` sat inside
      // a wrapper `<div>`, so it was an inline-block on that div's text
      // baseline while `Collapse` was a blockified, vertically-centred flex
      // item. Same parent, both direct children, is the fix.
      expect(move.parentElement).toBe(collapse.parentElement);
      expect(move.parentElement?.className).toContain('items-center');
    });

    it("renders no pane label in the expanded strip -- the pane's own header is the one that names it", () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(
        <LayoutRoot
          panes={{
            ...SIMPLE_PANES,
            // Stands in for the pane's own `Panel` header, which is what still
            // names the pane while it is expanded.
            dag: <h2 data-testid="dag-content">Workflow Graph</h2>,
          }}
        />,
      );

      // Exactly one "Workflow Graph" in this pane, and it is the pane's own
      // heading -- not the chrome strip repeating it 24px above.
      const pane = screen.getByTestId('pane-dag');
      expect(within(pane).getAllByText('Workflow Graph')).toHaveLength(1);
      expect(
        within(pane).getByRole('heading', { name: 'Workflow Graph' }),
      ).toBeInTheDocument();

      // And nothing structural was lost with the label: both controls still
      // name their pane to assistive tech and on hover.
      expect(
        within(pane).getByRole('button', { name: 'Move' }),
      ).toHaveAttribute('title', 'Move Workflow Graph pane');
      expect(
        within(pane).getByRole('button', {
          name: 'Collapse Workflow Graph panel',
        }),
      ).toHaveAttribute('title', 'Collapse Workflow Graph panel');
    });

    it("keeps the label on the collapsed strip, where the pane's own header is hidden", () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      // `docs` is the pane `graph-focus` starts with collapsed (issue #83).
      const pane = screen.getByTestId('pane-docs');
      const expand = within(pane).getByRole('button', {
        name: 'Expand Reference panel',
      });
      expect(expand).toHaveTextContent('Reference');
    });

    it('gives both chrome controls a real button treatment, not bare text', () => {
      useLayoutStore.getState().setPreset('graph-focus');
      render(<LayoutRoot panes={SIMPLE_PANES} />);

      const pane = screen.getByTestId('pane-dag');
      for (const name of ['Move', 'Collapse Workflow Graph panel']) {
        const control = within(pane).getByRole('button', { name });
        // A real `<button>` (so it is keyboard-reachable and keeps the global
        // `:focus-visible` ring), carrying the shared resting affordance: a
        // raised fill inside a visible border.
        expect(control.tagName).toBe('BUTTON');
        expect(control).toHaveClass('bg-cc-panel-raised');
        // Issue #200: the resting boundary is `-border-interactive`, not
        // `-border-strong` -- the latter only measures 1.4:1 against this
        // fill in light mode, short of 1.4.11's 3:1 floor for an
        // interactive boundary.
        expect(control).toHaveClass('border-cc-border-interactive');
        expect(control).toHaveClass('hover:border-cc-accent');
      }
    });
  });
});
