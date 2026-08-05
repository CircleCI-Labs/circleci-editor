/**
 * Issue #88: a tiny module-level store holding the DOM node the object
 * palette's content should portal into. `PalettePane` (the layout pane the
 * palette now lives in -- see `layout/types.ts`'s `PaneId` doc comment) sets
 * it on mount to a plain `<div>` it owns; `DagPane` reads it and, when it's
 * non-null, renders the real `<Palette>` (with every insertion callback it
 * already builds via `useOrbInsertion`/`usePaletteInsertion`) into that node
 * via `createPortal` instead of into its own tree.
 *
 * A plain zustand store, not React context: `DagPane` and `PalettePane` are
 * siblings in the layout tree -- both are entries in the `panes` map
 * `App.tsx` hands to `LayoutRoot`, with no shared ancestor below `App`
 * itself to host a context provider without threading one through
 * `LayoutRoot`'s own generic pane-rendering code, which is deliberately
 * preset-shape-agnostic (see that module's doc comment) and has no reason to
 * know about this.
 *
 * Why a portal at all, rather than lifting `useOrbInsertion`/
 * `usePaletteInsertion` and their two dialogs (`ParamsDialog`,
 * `ConfigureJobDialog`) up to `App.tsx` so both `DagPane` and a
 * `PalettePane` could receive them as props: that lift would also have to
 * carry `activeWorkflow` (today derived inline in `DagPane` from
 * `selectedWorkflow` + the parsed doc) and the `autoFocusNameNodeId` state a
 * freshly-created node's name field needs, none of which anything outside
 * `DagPane` currently touches. A portal keeps every one of those exactly
 * where it already lives and only moves *where the resulting JSX paints*,
 * which is a much smaller, lower-risk change for what is fundamentally a
 * layout fix, not a data-flow one.
 *
 * `null` (the initial value, and whenever `PalettePane` unmounts) is the
 * signal `DagPane` uses to fall back to rendering the palette inline itself,
 * exactly as it did before this issue -- see `DagPane`'s own comment on that
 * fallback, which is what keeps every existing `DagPane`-only test (each of
 * which renders it with no surrounding `App`/`LayoutRoot`, so this store is
 * never given a target) working unchanged.
 */
import { create } from 'zustand';

interface PalettePortalState {
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}

export const usePalettePortalTarget = create<PalettePortalState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
