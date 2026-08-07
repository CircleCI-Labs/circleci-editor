import {
  Background,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Document } from 'yaml';

import { Button } from '~/design/components/Button';
import { Panel } from '~/design/components/Panel';
import {
  buildWorkflowGraph,
  listWorkflows,
  type GraphEdge,
  type GraphProblem,
} from '~/lib/graph/buildGraph';
import {
  layoutGraph,
  type LayoutDirection,
  type PositionedNode,
} from '~/lib/graph/layout';
import {
  addRequire,
  addWorkflow,
  deleteJob,
  removeRequire,
  removeWorkflowJobEntry,
} from '~/lib/mutations/configMutations';
import { describeDeleteImpact } from '~/lib/mutations/jobReferences';
import { isDraggingOrbKind, readOrbDragPayload } from '~/lib/orbs/dragPayload';
import { buildDiagnostics } from '~/lib/validation/build';
import {
  describeSource,
  diagnosticHeadline,
  diagnosticWorkflow,
  matchesNode,
  type Diagnostic,
} from '~/lib/validation/diagnostics';
import { usePolicyDiagnostics } from '~/lib/validation/usePolicyDiagnostics';
import { getJobNames } from '~/lib/yaml/documentUtils';
import { activeLayoutState, useLayoutStore } from '~/state/layoutStore';
import { useAppStore } from '~/state/appStore';
import {
  getStoredPosition,
  useNodePositionStore,
} from '~/state/nodePositionStore';
import { useProjectContextStore } from '~/state/projectContextStore';
import { useThemeStore } from '~/state/themeStore';
import { EditErrorBanner, Inspector } from '~/panes/inspector/Inspector';
import { ParamsDialog } from '~/panes/orbs/ParamsDialog';

import { ContextRestrictionNotice } from './ContextRestrictionNotice';
import { DeleteNodeConfirm } from './DeleteNodeConfirm';
import {
  getAncestorChain,
  isEditableTarget,
  wouldCreateCycle,
} from './dagUtils';
import { CanvasControls } from './CanvasControls';
import { JobNode, type JobNodeData } from './JobNode';
import { ConfigureJobDialog } from './palette/ConfigureJobDialog';
import { Palette } from './palette/Palette';
import { usePalettePortalTarget } from './palette/palettePortalTarget';
import {
  isDraggingPaletteContext,
  readPaletteContextDragPayload,
} from './palette/paletteContexts';
import {
  isDraggingPaletteExecutor,
  readPaletteExecutorDragPayload,
} from './palette/paletteExecutors';
import {
  isDraggingPaletteStep,
  readPaletteStepDragPayload,
} from './palette/paletteSteps';
import { BezierRequiresEdge, SmoothStepRequiresEdge } from './RequiresEdge';
import { useOrbInsertion } from './useOrbInsertion';
import { usePaletteInsertion } from './usePaletteInsertion';

// Registered once at module scope: React Flow warns (and can lose node
// identity) if `nodeTypes` is a fresh object on every render.
const NODE_TYPES: NodeTypes = { job: JobNode };

// Issue #70: overrides what renders *inside* React Flow's own 'smoothstep'/
// 'default' (bezier) edge types -- not a third custom type -- so `edge.type`
// itself keeps meaning exactly what it did before (the routing choice
// `flowEdges` makes per `LARGE_GRAPH_THRESHOLD`) and every test/behaviour
// keyed on that value is unaffected. See `RequiresEdge.tsx`'s own doc
// comment for why this exists: moving a `requires` status condition off an
// always-on label and onto a hover/focus tooltip.
const EDGE_TYPES: EdgeTypes = {
  smoothstep: SmoothStepRequiresEdge,
  default: BezierRequiresEdge,
};

// Typing pauses the layout recompute briefly so ELK doesn't re-run on
// every keystroke while the user is still editing YAML.
const LAYOUT_DEBOUNCE_MS = 150;

// Fraction of the viewport left as breathing room around the graph when
// fitting it into view (see `FitViewOnStructureChange`).
const FIT_VIEW_PADDING = 0.2;

// How far out the canvas may zoom, overriding React Flow's own default of
// 0.5 -- a large workflow (dozens of jobs) can be many thousands of pixels
// wide, and the default limit prevents the user from ever zooming out far
// enough to see the whole shape of it.
const MIN_ZOOM = 0.02;

// Bounds applied to the automatic fit only, which are deliberately tighter
// than MIN_ZOOM. Fitting every node at any cost renders a long pipeline too
// small to read; below this floor it is better to show the graph legibly and
// let the user pan. The ceiling stops a two-node graph being blown up.
//
// Issue #90: re-derived, not left at the pre-existing 0.45, once the label
// itself changed -- "a bigger label changes what readable means" was the
// audit's own framing. The floor's whole job is to bound the *rendered*
// text size (`labelFontPx * zoom`) at the worst case; `JobNode`'s primary
// label moved from `text-xs` (12px) to `text-sm` (14px) alongside the
// 220x56 -> 256x44 node resize (`layout.ts`'s `NODE_WIDTH`/`NODE_HEIGHT`),
// so the same 0.45 floor that used to bottom out at 12 * 0.45 = 5.4px now
// bottoms out at 14 * 0.45 = 6.3px -- already more legible for free. That
// headroom is exactly what a lower floor spends: 0.4 gives 14 * 0.4 = 5.6px,
// matching (very slightly bettering) the old floor's own legibility rather
// than leaving it an accident of the font bump, while letting a long
// pipeline's fit zoom out a bit further -- which matters more now that
// every node is also 16% wider (256 vs 220), so a long horizontal pipeline
// needs more room per layer than it did before this issue. Verified against
// both the flakey-todo-list fixture and a synthetic 32-job workflow (issue
// #90's own verification step): node labels stayed readable at this floor
// in both, and the 32-job graph's fit shows visibly more of the pipeline at
// 0.4 than it did pinned to 0.45.
const FIT_VIEW_MIN_ZOOM = 0.4;
const FIT_VIEW_MAX_ZOOM = 1;

// Bundled once at module scope so `CanvasControls`'s `handleFitView` callback
// isn't invalidated on every render by a fresh object identity.
const CONTROL_FIT_VIEW_OPTIONS = {
  padding: FIT_VIEW_PADDING,
  minZoom: FIT_VIEW_MIN_ZOOM,
  maxZoom: FIT_VIEW_MAX_ZOOM,
};

// Issue #54: the node/edge count above which production itself backs off
// its own DAG polish for performance -- it falls back from `smoothstep` to
// React Flow's plain `default` (bezier) edge routing above 100 nodes, and
// skips animating the select/hover opacity transition above the same
// count. Mirrored here for both: `smoothstep`'s orthogonal-ish routing and
// a `transition: opacity` on dozens of simultaneously-restyled nodes/edges
// are the kind of per-frame cost that scales with graph size, so a config
// with hundreds of jobs should degrade the same way production's does
// rather than stutter.
const LARGE_GRAPH_THRESHOLD = 100;

// A layout splitter drag emits a continuous stream of resize callbacks, and
// each fit writes a new viewport transform, so they are collapsed into one
// fit once the drag settles. See `FitViewOnContainerResize`.
const RESIZE_FIT_DEBOUNCE_MS = 120;

// Issue #70: React Flow's own `<MiniMap>` default is a fixed 200x150 box
// (4:3) regardless of the graph's own shape. A typical LR workflow is much
// wider than tall, so a fixed 4:3 box left most of its height empty --
// `computeMinimapSize` instead sizes the box to roughly match the graph's
// own aspect ratio, which is what actually makes better use of the space
// instead of centering a thin sliver inside a mostly-empty rectangle.
// `MINIMAP_TARGET_AREA` keeps the box's total on-screen footprint roughly
// constant across aspect ratios (a very wide *or* very tall graph gets a
// long, thin box, not a huge one) close to the original 200x150 = 30000px^2
// default's own footprint. The width/height floors and ceilings bound how
// extreme that gets for a graph that's almost entirely one dimension (a
// single long linear pipeline, or a single column of independent jobs).
const MINIMAP_TARGET_AREA = 27000;
const MINIMAP_MIN_WIDTH = 140;
const MINIMAP_MAX_WIDTH = 280;
const MINIMAP_MIN_HEIGHT = 90;
const MINIMAP_MAX_HEIGHT = 200;

// Issue #30 (the smaller half): the inspector column used to be a fixed
// 280px. These bound the draggable/keyboard-resizable divider between it
// and the canvas -- narrow enough to still show the "Steps"/"Requires"
// headings, wide enough that a long orb command name (issue #28) isn't
// forced to truncate immediately.
//
// 220 is measured to be too narrow, and is kept anyway. Sweeping the divider
// across its full range on the running app and counting elements whose text
// actually overflows its box:
//
//   |                       | at 220px | at 280px (default) | first width with 0 |
//   |-----------------------|----------|--------------------|--------------------|
//   | before the type fix   |     4    |          1         |        300px       |
//   | after                 |   **3**  |        **0**       |      **268px**     |
//
// So the 280px default is vindicated by measurement rather than inherited, and
// 220px leaves three elements truncating -- below what this pane's content
// needs. Raising the floor was not taken because it takes width from the
// canvas, which is already below what *it* needs, and is the worse victim of
// the two. Recorded here rather than left in a tracker so the number is not
// re-derived by whoever next wonders whether it is arbitrary.
const INSPECTOR_MIN_WIDTH = 220;
const INSPECTOR_MAX_WIDTH = 560;
const INSPECTOR_DEFAULT_WIDTH = 280;
const INSPECTOR_KEYBOARD_STEP = 16;
const INSPECTOR_WIDTH_STORAGE_KEY = 'vce.inspectorWidth';

function clampInspectorWidth(width: number): number {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, width));
}

/**
 * Reads the persisted inspector width from `localStorage`, falling back to
 * the historical 280px default for a first run, a corrupt value, or an
 * environment where `localStorage` throws (private browsing, disabled
 * storage, or a non-browser test environment).
 */
function readStoredInspectorWidth(): number {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed)
      ? clampInspectorWidth(parsed)
      : INSPECTOR_DEFAULT_WIDTH;
  } catch {
    return INSPECTOR_DEFAULT_WIDTH;
  }
}

function writeStoredInspectorWidth(width: number): void {
  try {
    window.localStorage.setItem(
      INSPECTOR_WIDTH_STORAGE_KEY,
      String(Math.round(width)),
    );
  } catch {
    // Resizing still works for the rest of this session even if it can't persist.
  }
}

/**
 * The draggable/keyboard-resizable divider between the canvas and the
 * inspector column (issue #30). A native `pointermove`/`pointerup` pair on
 * `window` (not React props on this element) drives the drag so it keeps
 * tracking the pointer even once it leaves the thin handle itself.
 */
function InspectorDivider({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  // `window`-level `pointermove`/`pointerup` listeners drive the drag (so it
  // keeps tracking the pointer even once it leaves this thin handle), which
  // means their identity must stay stable across renders for
  // `removeEventListener` to actually find them -- so the two handlers
  // below are created exactly once (via `useRef`'s lazy-init argument) and
  // read the *latest* `width`/`onResize` through these refs rather than by
  // closing over the render's own values.
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const dragOrigin = useRef<{ pointerX: number; width: number } | null>(null);

  const handlePointerMoveRef = useRef((event: PointerEvent) => {
    const drag = dragOrigin.current;
    if (!drag) return;
    // The inspector sits to the *right* of the divider, so dragging the
    // handle left (a decreasing clientX) must widen it, not narrow it.
    const delta = drag.pointerX - event.clientX;
    onResizeRef.current(clampInspectorWidth(drag.width + delta));
  });
  const handlePointerUpRef = useRef(() => {
    dragOrigin.current = null;
    window.removeEventListener('pointermove', handlePointerMoveRef.current);
    window.removeEventListener('pointerup', handlePointerUpRef.current);
  });

  const startDragging = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      dragOrigin.current = { pointerX: event.clientX, width: widthRef.current };
      window.addEventListener('pointermove', handlePointerMoveRef.current);
      window.addEventListener('pointerup', handlePointerUpRef.current);
    },
    [],
  );

  // Defensive cleanup only -- if this component unmounts mid-drag (e.g. the
  // selection is cleared while the pointer is still down), the listeners
  // above must not outlive it. Captured into locals rather than read off
  // the refs inside the cleanup itself: both refs are set once (via
  // `useRef`'s lazy-init argument) and never reassigned, so this is just
  // satisfying the lint rule that would otherwise apply to a ref whose
  // `.current` *does* change.
  useEffect(() => {
    const handlePointerMove = handlePointerMoveRef.current;
    const handlePointerUp = handlePointerUpRef.current;
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onResize(clampInspectorWidth(width + INSPECTOR_KEYBOARD_STEP));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onResize(clampInspectorWidth(width - INSPECTOR_KEYBOARD_STEP));
      } else if (event.key === 'Home') {
        event.preventDefault();
        onResize(INSPECTOR_MIN_WIDTH);
      } else if (event.key === 'End') {
        event.preventDefault();
        onResize(INSPECTOR_MAX_WIDTH);
      }
    },
    [onResize, width],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector panel"
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={startDragging}
      onKeyDown={handleKeyDown}
      className="w-1.5 shrink-0 cursor-col-resize touch-none bg-cc-border transition-colors hover:bg-cc-accent focus-visible:bg-cc-accent"
    />
  );
}

interface RenderedGraph {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  problems: GraphProblem[];
}

function problemsSignature(problems: GraphProblem[]): string {
  return problems
    .map((p) => `${p.severity}:${p.nodeId ?? ''}:${p.message}`)
    .join('|');
}

/**
 * Issue #70: "the minimap is now somewhat working, but doesn't necessarily
 * show and render the minimap as nice" -- one concrete reason is that
 * `<MiniMap>`'s own default box is a fixed 200x150 (4:3), independent of
 * the graph it's showing. A wide LR workflow's minimap then wastes most of
 * its height on empty space around a thin horizontal sliver, which is
 * exactly what reads as "not rendering nice" rather than "broken" -- #47
 * already fixed the rects being invisible; this is the next layer up.
 *
 * Sizes the box to the graph's own aspect ratio instead, holding the total
 * on-screen area roughly constant (`MINIMAP_TARGET_AREA`, chosen to match
 * the default 200x150 box's own ~30000px^2 footprint) so a wide graph gets
 * a wide, short box and a tall graph gets a narrow, tall one, both making
 * comparable use of the space the default box already used. Framework-free
 * (no React) so it's trivial to unit test against real ELK output shapes
 * without mounting `DagPane`.
 */
export function computeMinimapSize(nodes: PositionedNode[]): {
  width: number;
  height: number;
} {
  if (nodes.length === 0)
    return { width: MINIMAP_MIN_WIDTH, height: MINIMAP_MIN_HEIGHT };

  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  // Floors of 1 rather than 0: a single node (or a column of nodes at
  // exactly the same x) has zero graph width/height, which would otherwise
  // make `aspect` either `NaN` (0/0) or `Infinity`.
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const aspect = graphWidth / graphHeight;

  const width = Math.min(
    MINIMAP_MAX_WIDTH,
    Math.max(MINIMAP_MIN_WIDTH, Math.sqrt(MINIMAP_TARGET_AREA * aspect)),
  );
  const height = Math.min(
    MINIMAP_MAX_HEIGHT,
    Math.max(MINIMAP_MIN_HEIGHT, MINIMAP_TARGET_AREA / width),
  );
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Builds the workflow graph and lays it out, debounced against `doc`
 * churn and guarded against out-of-order resolution: if `doc`/workflow/
 * direction change again before a scheduled layout starts, the effect
 * cleanup cancels the pending timer outright; if they change again while
 * ELK is already running, `cancelled` makes the eventual resolution a
 * no-op instead of overwriting a newer result with a stale one.
 *
 * `layoutNonce` carries no data of its own -- bumping it (see the
 * "Re-layout" button in `DagPane`) is purely a way to force this effect to
 * re-run and re-derive fresh ELK positions even when nothing about the
 * graph's structure changed, which is the only way to snap a node that the
 * user dragged back onto the computed layout.
 */
function useRenderedGraph(
  doc: Document | null,
  workflowName: string | undefined,
  direction: LayoutDirection,
  layoutNonce: number,
): RenderedGraph | null {
  const [rendered, setRendered] = useState<RenderedGraph | null>(null);

  useEffect(() => {
    if (!doc || !workflowName) {
      setRendered(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const graph = buildWorkflowGraph(doc, workflowName);
      void layoutGraph(graph, { direction }).then((laidOut) => {
        if (cancelled) return;
        setRendered({
          nodes: laidOut.nodes,
          edges: laidOut.edges,
          problems: graph.problems,
        });
      });
    }, LAYOUT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutNonce is intentionally not "used" inside the effect; bumping it is the point.
  }, [doc, workflowName, direction, layoutNonce]);

  return rendered;
}

/** One workflow's at-a-glance summary for `WorkflowTabs`: how many jobs it
 * runs and whether it has any structural problems (an unknown `requires`,
 * a dependency cycle -- the same `GraphProblem`s the active workflow's own
 * `ProblemsBanner` surfaces), so switching is an informed choice rather
 * than a guess at what's behind each name. */
interface WorkflowSummary {
  name: string;
  jobCount: number;
  hasErrors: boolean;
}

/**
 * Issue #49: CircleCI's own pipeline page always shows every workflow as a
 * tab, even a pipeline with just one -- that's deliberate, since hiding the
 * switcher until a *second* workflow exists is exactly what made
 * multi-workflow support read as a hidden feature rather than a first-class
 * one. This mirrors that: always visible whenever `summaries` is non-empty
 * (never gated on `summaries.length > 1`, unlike the `<select>` this
 * replaces), with a validity dot and job count on every tab.
 */
function WorkflowTabs({
  summaries,
  active,
  onSelect,
}: {
  summaries: WorkflowSummary[];
  active: string | undefined;
  onSelect: (name: string) => void;
}) {
  if (summaries.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Workflows"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-cc-border bg-cc-bg px-3 py-2"
    >
      {summaries.map((summary) => {
        const isActive = summary.name === active;
        const jobLabel =
          summary.jobCount === 1 ? '1 job' : `${summary.jobCount} jobs`;
        return (
          <button
            key={summary.name}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(summary.name)}
            title={
              summary.hasErrors
                ? `${summary.name}: has problems`
                : `${summary.name}: ${jobLabel}`
            }
            className={`flex min-w-0 shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? 'border-cc-accent bg-cc-panel-raised text-cc-text'
                : 'border-transparent text-cc-text-muted hover:border-cc-border-interactive hover:bg-cc-panel-raised hover:text-cc-text'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${summary.hasErrors ? 'bg-cc-danger' : 'bg-cc-success'}`}
            />
            <span className="min-w-0 max-w-[16rem] truncate">
              {summary.name}
            </span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-2xs tabular-nums ${
                isActive
                  ? 'bg-cc-bg text-cc-text-muted'
                  : 'bg-cc-panel text-cc-text-faint'
              }`}
            >
              {summary.jobCount}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The graph's own problem banner, now carrying two kinds of entry (issue
 * #148):
 *
 *  - `problems` -- what `buildWorkflowGraph` worked out about *this*
 *    workflow's structure, offline: an unknown `requires:`, a cycle, an entry
 *    naming a job with no definition.
 *  - `diagnostics` -- what validation said, attributed to this workflow.
 *    Labelled with its source (`describeSource`) so a CircleCI compile error
 *    and this app's own offline check are never mistaken for one another, and
 *    each rendered as a *button* that selects the node it names -- which is
 *    what makes error navigation keyboard-reachable rather than a matter of
 *    finding the red-ringed box with a mouse.
 *
 * Rendered only when there is something to say; a workflow that is fine gets
 * no banner at all.
 */
function ProblemsBanner({
  problems,
  diagnostics,
  onDismiss,
  onFocusDiagnostic,
}: {
  problems: GraphProblem[];
  diagnostics: Diagnostic[];
  onDismiss: () => void;
  /** Selects the first node a diagnostic names, or does nothing when it names none. */
  onFocusDiagnostic: (diagnostic: Diagnostic) => void;
}) {
  if (problems.length === 0 && diagnostics.length === 0) return null;
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const compileErrors = diagnostics.filter((d) => d.severity === 'error');

  return (
    <div className="absolute inset-x-2 top-2 z-10 max-h-32 overflow-y-auto rounded-md border border-cc-border-strong bg-cc-panel/95 p-2 text-xs shadow-lg backdrop-blur-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-cc-text">
          {[
            errors.length + compileErrors.length > 0
              ? `${errors.length + compileErrors.length} error(s)`
              : '',
            warnings.length > 0 ? `${warnings.length} warning(s)` : '',
          ]
            .filter(Boolean)
            .join(', ')}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss graph problems"
          className="rounded px-1.5 py-0.5 text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text"
        >
          Dismiss
        </button>
      </div>
      <ul className="space-y-0.5">
        {diagnostics.map((diagnostic) => (
          <li key={diagnostic.id}>
            <button
              type="button"
              onClick={() => onFocusDiagnostic(diagnostic)}
              title="Select the job this error names"
              className={`w-full rounded px-1 text-left hover:bg-cc-panel-raised ${
                diagnostic.severity === 'error'
                  ? 'text-cc-danger'
                  : 'text-cc-warning'
              }`}
            >
              <span className="mr-1 text-2xs uppercase tracking-wide opacity-70">
                {describeSource(diagnostic.source)}:
              </span>
              {/* The rule name is part of the message for a policy
                  violation -- see `diagnosticHeadline`. */}
              {diagnosticHeadline(diagnostic)}
            </button>
          </li>
        ))}
        {problems.map((problem, index) => (
          <li
            key={`${problem.nodeId ?? ''}-${index}`}
            className={
              problem.severity === 'error'
                ? 'text-cc-danger'
                : 'text-cc-warning'
            }
          >
            {problem.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Imperatively re-fits the viewport to the graph whenever `fitKey` changes,
 * as long as there is at least one node to fit.
 *
 * `<ReactFlow fitView>` alone only fits once, at mount -- but this pane's
 * nodes arrive asynchronously from the debounced ELK layout (see
 * `useRenderedGraph`), so at mount there is nothing yet to fit, and the
 * graph renders wherever the viewport happened to default to (often with
 * most or all nodes off-screen for anything but a tiny workflow). Must be
 * rendered as a descendant of `<ReactFlowProvider>` (it is, as a child of
 * `<ReactFlow>` below) since `useReactFlow` requires that context.
 *
 * `fitKey` is constructed by the caller to change only on a structural
 * change (workflow switch, direction toggle, explicit re-layout, or the
 * graph's own set of nodes/edges) and not on unrelated node-data edits, so
 * this never fights a user who has deliberately panned or zoomed.
 */
function FitViewOnStructureChange({
  fitKey,
  hasNodes,
}: {
  fitKey: string;
  hasNodes: boolean;
}) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!hasNodes) return;
    // Called synchronously from the effect (not deferred to a
    // requestAnimationFrame/timeout): React Flow only actually performs a
    // *queued* fitView the next time it processes a node dimension change
    // (see its `updateNodeInternals` store action), which for freshly
    // mounted nodes is driven by React Flow's own per-node ResizeObserver.
    // That observer's first callback fires shortly after this effect runs,
    // but only if it has something to report -- so nodes must NOT be given
    // explicit top-level `width`/`height` (only a CSS `style` size; see
    // `flowNodes` below), otherwise React Flow considers them already
    // measured and the queued fit is never consumed.
    // Cap how far fitView may zoom out. Allowing it to shrink without limit
    // technically fits every node on screen, but a long pipeline in a narrow
    // pane ends up too small to read, which is worse than needing to pan.
    // Below this floor the user scrolls and zooms instead.
    void fitView({
      padding: FIT_VIEW_PADDING,
      duration: 0,
      minZoom: FIT_VIEW_MIN_ZOOM,
      maxZoom: FIT_VIEW_MAX_ZOOM,
    });
  }, [fitKey, hasNodes, fitView]);

  return null;
}

/**
 * Re-fits the graph when the canvas element itself changes size.
 *
 * `FitViewOnStructureChange` only reacts to the graph changing, so resizing
 * the pane -- dragging a layout splitter, collapsing a neighbour, resizing the
 * window -- left the viewport exactly where it was, with the graph small and
 * off-centre in a pane that had just got much wider. Verified by comparing the
 * viewport transform across a splitter drag: byte-identical before and after.
 *
 * Debounced, because a drag emits a continuous stream of resizes and each fit
 * writes a new viewport transform.
 */
function FitViewOnContainerResize({
  containerRef,
  hasNodes,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  hasNodes: boolean;
}) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !hasNodes) return;
    if (typeof ResizeObserver === 'undefined') return; // jsdom, older browsers

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void fitView({
          padding: FIT_VIEW_PADDING,
          duration: 0,
          minZoom: FIT_VIEW_MIN_ZOOM,
          maxZoom: FIT_VIEW_MAX_ZOOM,
        });
      }, RESIZE_FIT_DEBOUNCE_MS);
    });
    observer.observe(element);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
    };
  }, [containerRef, hasNodes, fitView]);

  return null;
}

/**
 * Renders the workflow DAG derived from the store's `doc`, and lets the
 * user edit it by dragging: connecting/disconnecting `requires` edges,
 * adding/removing/renaming jobs (via the inspector drawer), and deleting
 * nodes. Every edit still goes through `mutate()`, so `doc` (and therefore
 * the rendered graph) is always the single source of truth -- nothing here
 * keeps its own shadow copy of the workflow.
 */
export function DagPane() {
  // Issue #52: React Flow has its own light/dark rendering (controls,
  // minimap, the canvas dot-grid background) independent of this app's own
  // CSS tokens -- `colorMode` is the one prop that switches it, so it has
  // to track the same resolved theme everything else does rather than the
  // hardcoded `'dark'` this app shipped with before light mode existed.
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const doc = useAppStore((state) => state.doc);
  const configPath = useAppStore((state) => state.configPath);
  const parseError = useAppStore((state) => state.parseError);
  const text = useAppStore((state) => state.text);
  const validation = useAppStore((state) => state.validation);
  const selectedWorkflow = useAppStore((state) => state.selectedWorkflow);
  const setSelectedWorkflow = useAppStore((state) => state.setSelectedWorkflow);
  const dagDirection = useAppStore((state) => state.dagDirection);
  const setDagDirection = useAppStore((state) => state.setDagDirection);
  const selectedNodeId = useAppStore((state) => state.selectedNodeId);
  const selectNode = useAppStore((state) => state.selectNode);
  // Issue #288: whether the *workflow itself* (rather than a job in it) is
  // what the inspector column should show -- see `selectWorkflowEntity`'s
  // own doc comment for the two gestures that set it (`handlePaneClick`
  // below, and `WorkflowTabs`' own already-active-tab click).
  const workflowSelected = useAppStore((state) => state.workflowSelected);
  const selectWorkflowEntity = useAppStore(
    (state) => state.selectWorkflowEntity,
  );
  const mutate = useAppStore((state) => state.mutate);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const canUndo = useAppStore((state) => state.canUndo);
  const canRedo = useAppStore((state) => state.canRedo);
  // Issue #135: the open file may be one the host classified as *not* a
  // CircleCI config, revealed and opened deliberately from the switcher's
  // "other YAML files" affordance. An empty canvas would be a mystery in
  // that case, so the host's own reason is what this pane says instead.
  const files = useAppStore((state) => state.files);

  const workflows = useMemo(() => (doc ? listWorkflows(doc) : []), [doc]);
  const activeWorkflow =
    selectedWorkflow && workflows.includes(selectedWorkflow)
      ? selectedWorkflow
      : workflows[0];

  // Issue #49: a synchronous (no ELK, no debounce) rebuild of *every*
  // workflow, not just the active one -- `WorkflowTabs` needs each
  // workflow's job count and problem state up front, at all times, not just
  // whichever one happens to be selected. Same rationale as `liveGraph`
  // below for using the un-debounced builder: this feeds a switcher the
  // user is about to click, not a canvas layout, so it must reflect the
  // *current* doc, not a stale one from before the last keystroke.
  // Issue #148: the same derivation the YAML pane's strip renders, so the two
  // panes can never disagree about what is wrong with the config. Pure, and
  // computed from state already loaded -- no request of its own.
  const diagnosticsResult = useMemo(
    () => buildDiagnostics({ doc, text, parseError, validation }),
    [doc, text, parseError, validation],
  );

  /**
   * Issue #215: config-policy violations, marked on the graph by exactly the
   * same `matchesNode` machinery compile errors use -- a violation naming a
   * job locates and highlights the same way, or names nothing and highlights
   * nothing.
   *
   * Merged into one list *for node marking only*. The two verdicts stay
   * separate where verdicts are rendered (the YAML pane's two strips): this
   * list answers "which boxes on this canvas does something say a word
   * about", which is the same question for both sources, and every entry
   * still carries its own `source` so the banner names which authority
   * spoke.
   */
  const policyDiagnostics = usePolicyDiagnostics();
  const allDiagnostics = useMemo(
    () => [...diagnosticsResult.diagnostics, ...policyDiagnostics],
    [diagnosticsResult, policyDiagnostics],
  );

  /**
   * Which of `diagnostics` belong on `name`'s tab and in its banner.
   *
   * Two independent ways in, deliberately -- getting this wrong is how a job
   * that no longer compiles renders as a perfectly healthy box:
   *
   *  - the error *named* the workflow (`diagnosticWorkflow`): a broken
   *    `requires:`, an `Error calling workflow: 'main'` context line;
   *  - the error named a *job* and this workflow runs it (`matchesNode`
   *    against the workflow's own nodes). A schema violation under
   *    `jobs.build` carries no workflow at all -- CircleCI has no reason to
   *    mention one -- but every workflow that runs `build` is affected by it.
   *
   * A diagnostic that satisfies neither (a bad orb *version*, a top-level
   * schema violation) belongs to no workflow, and correctly puts an error dot
   * on no tab: the YAML pane's strip is where those are surfaced.
   */
  function selectWorkflowDiagnostics(
    diagnostics: Diagnostic[],
    name: string,
    nodes: { id: string; jobName: string; orbRef?: string }[],
  ): Diagnostic[] {
    return diagnostics.filter(
      (diagnostic) =>
        diagnosticWorkflow(diagnostic) === name ||
        nodes.some((node) => matchesNode(diagnostic, name, node)),
    );
  }

  const workflowSummaries = useMemo<WorkflowSummary[]>(() => {
    if (!doc) return [];
    return workflows.map((name) => {
      const graph = buildWorkflowGraph(doc, name);
      return {
        name,
        jobCount: graph.nodes.length,
        hasErrors:
          graph.problems.some((problem) => problem.severity === 'error') ||
          // A workflow that compiles no more is a workflow with problems,
          // even when nothing structural is wrong with it locally -- which is
          // exactly the case for an undefined executor or a misspelled step.
          selectWorkflowDiagnostics(allDiagnostics, name, graph.nodes).some(
            (diagnostic) => diagnostic.severity === 'error',
          ),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selectWorkflowDiagnostics` is a pure module-level-style helper defined in this component's body; it has no captured state and re-creating it every render is not a reason to recompute this memo.
  }, [doc, workflows, allDiagnostics]);

  const [layoutNonce, setLayoutNonce] = useState(0);
  const rendered = useRenderedGraph(
    doc,
    activeWorkflow,
    dagDirection,
    layoutNonce,
  );
  // Issue #70: manual drag positions, persisted outside `doc` (config has no
  // coordinate fields -- see `nodePositionStore`'s own doc comment) and
  // keyed by (config path, workflow name, node id) so a dragged node keeps
  // its spot across a structure change, a save, and a reload, which is
  // exactly what ELK's own position -- recomputed fresh into `rendered.nodes`
  // on every relevant `doc` change -- cannot do on its own.
  const manualPositions = useNodePositionStore((state) => state.positions);
  const setManualPosition = useNodePositionStore((state) => state.setPosition);
  const clearWorkflowPositions = useNodePositionStore(
    (state) => state.clearWorkflowPositions,
  );
  // Issue #85: React Flow reports each in-progress pointer position via its
  // own `onNodeDrag` (see `handleNodeDrag` below), continuously while the
  // pointer moves -- but `flowNodes` is a *fully controlled* array, and
  // every render this pane does for any other reason (a hover, a selection,
  // an edit elsewhere) was handing React Flow a freshly recomputed
  // manual-or-ELK position back for the node already mid-drag, stomping the
  // in-flight one before it ever painted. Measured on the running app: the
  // node's `transform` stayed at `translate(12px, 240px)` for the entire
  // drag (`dragging: true`) and only jumped once, on `mouseup`. Keyed by id
  // (not just "the one node currently dragging") and looked up the same way
  // `manualPositions` already is -- see `flowNodes`'s own comment -- so it
  // survives whatever unrelated re-render happens mid-drag. Cleared by
  // `handleNodeDragStop` the moment the same position lands in
  // `manualPositions`, at which point the normal lookup already covers it.
  const [liveDragPositions, setLiveDragPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  // Defensive only: nothing lets a user switch workflows while a mouse
  // button is held down over this canvas, so `onNodeDragStop` should always
  // be the one to clear its own entry -- but a drag interrupted some other
  // way (e.g. the pointer released outside the window) must not leave a
  // stale entry that would silently keep overriding that node's position
  // forever after. Mirrors `keyboardConnectFromId`'s own per-workflow reset
  // below.
  useEffect(() => {
    setLiveDragPositions({});
  }, [activeWorkflow]);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(
    null,
  );
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState<string | null>(
    null,
  );
  const [autoFocusNameNodeId, setAutoFocusNameNodeId] = useState<string | null>(
    null,
  );
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Issue #88: the palette's open/closed state is the same `useLayoutStore`
  // collapse state every other pane uses -- previously a second, parallel
  // `localStorage` flag (`vce.paletteOpen`) that had no relationship to the
  // layout system at all.
  //
  // Issue #183 removed this header's own "Palette" button, which was the other
  // reader of this value; what's left is only the *inline fallback* below,
  // which renders when no `PalettePane` is mounted to portal into (i.e. in
  // every `DagPane`-only unit test). In the real app `PaneSlot` owns the
  // palette pane's visibility via a `hidden` attribute and this value is not
  // consulted at all.
  //
  // Issue #121: goes through `activeLayoutState` rather than indexing
  // `presetStates` directly by `activePreset`, since that can now be
  // `'custom'` -- a key `presetStates` never has (the user's own
  // arrangement lives in a separate `custom` slot; see
  // `state/layoutStore.ts`). Indexing directly would silently read
  // `undefined` and report the palette as always open while a custom
  // layout is active, regardless of its real collapsed state.
  const paletteCollapsed = useLayoutStore((state) =>
    activeLayoutState(state).collapsed.includes('palette'),
  );
  const paletteOpen = !paletteCollapsed;
  // Issue #88: the DOM node `PalettePane` (the layout pane the palette now
  // lives in) registers, if one is mounted -- see `palettePortalTarget.ts`'s
  // own doc comment. `null` in every `DagPane`-only test, none of which
  // render the surrounding `App`/`LayoutRoot` tree, which is exactly what
  // makes the inline fallback below still exercised by all of them.
  const paletteTarget = usePalettePortalTarget((state) => state.target);
  // Issue #30: the inspector column's width, draggable/keyboard-resizable
  // via `InspectorDivider` and persisted across reloads. Lazily initialized
  // from `localStorage` so the very first render already has the user's
  // last width instead of flashing the 280px default first.
  const [inspectorWidth, setInspectorWidth] = useState<number>(
    readStoredInspectorWidth,
  );
  const handleResizeInspector = useCallback((width: number) => {
    setInspectorWidth(width);
    writeStoredInspectorWidth(width);
  }, []);
  const editError = useAppStore((state) => state.editError);
  const clearEditError = useAppStore((state) => state.clearEditError);
  // Issue #251: read here only to decide whether the notice's overlay slot
  // exists at all. An always-mounted `pointer-events-auto` strip across the top
  // of the canvas would swallow clicks on the graph underneath it.
  const restrictionNotice = useProjectContextStore(
    (state) => state.restrictionNotice,
  );
  // Highlights the canvas background while an orb job is dragged over it --
  // `null` means nothing relevant is being dragged; see `handleCanvasDragOver`.
  const [canvasDragState, setCanvasDragState] = useState<
    'valid' | 'invalid' | null
  >(null);
  // Issue #54: drives "hovering a node highlights the edges connected to
  // it". Node and edge elements are separate React Flow layers (siblings,
  // not ancestor/descendant), so a plain CSS `:hover` on the node can never
  // reach an edge -- this has to be tracked in JS and fed back down as a
  // className. Deliberately only active while nothing is selected (see
  // `flowEdges` below): once a node is selected the ancestor-chain
  // highlight is already the stronger, "locked-in" answer to the same
  // question, and layering a second highlight semantic on top of it read as
  // noisy rather than helpful.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Issue #289: the canvas's own notion of "this edge is the one about to be
  // deleted" -- deliberately *not* left to React Flow's internal selection
  // bookkeeping, for the same reason `selectedNodeId` (below) already isn't:
  // `flowEdges` is a fresh array recomputed from `rendered` on every
  // structural change, and an internal-only selection flag would be silently
  // dropped the next time that happens. Controlling it here, and feeding it
  // back into each edge's own `selected` field in `flowEdges`, is what makes
  // both the click-to-select visual (`.react-flow__edge.selected`, already
  // styled in `styles.css`) and keyboard Delete (`onEdgesDelete`, which React
  // Flow fires for whatever it currently believes is selected) reliable
  // regardless of what else re-renders this pane in between.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Mouse-only, transient: which edge to show the hover delete affordance on
  // (`RequiresEdge.tsx`'s `canRemove`). Separate from `selectedEdgeId` so the
  // affordance also appears on a plain hover, before any click -- the same
  // "discoverable before you commit to it" shape `hoveredNodeId` already
  // gives edge highlighting, just for a different edge-level feature.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  // Issue #70: "it's really hard to hit that little circle to link" -- a
  // mouse drag is still the primary path (see `styles.css` for the larger
  // hit area), but connecting must not be *mouse-only*. This is the anchor
  // of a from-the-keyboard connection: the id of the node whose handle was
  // most recently activated (Enter/Space) with nothing else pending. See
  // `handleHandleActivate` for the rest of the two-step state machine, and
  // `JobNodeData.onActivateHandle` for why this can't just be React Flow's
  // own `connectOnClick` -- that leaves a pending click-connection alive in
  // React Flow's *internal* store with no way for this component to cancel
  // or even inspect it, so an abandoned first click can silently hijack an
  // unrelated later click as its second step.
  const [keyboardConnectFromId, setKeyboardConnectFromId] = useState<
    string | null
  >(null);

  // Never carry a pending keyboard connection across a workflow switch --
  // the anchor node id may not even exist in the newly-selected workflow,
  // and even if it happens to (same id, different workflow), completing it
  // there would silently connect two nodes the user never actually saw
  // side by side.
  useEffect(() => {
    setKeyboardConnectFromId(null);
  }, [activeWorkflow]);

  const handleHandleActivate = useCallback(
    (nodeId: string) => {
      if (keyboardConnectFromId === null) {
        setKeyboardConnectFromId(nodeId);
        return;
      }
      if (keyboardConnectFromId === nodeId) {
        // Activating the anchor's own handle again is the documented way to
        // cancel (see the status hint rendered below) rather than leaving
        // the only way out be Escape or picking some other node.
        setKeyboardConnectFromId(null);
        return;
      }
      if (activeWorkflow) {
        // Reuses the exact same mutation `handleConnect` (mouse drag) calls
        // below -- `addRequire` already refuses a self-loop or a cycle and
        // reports why via `editError` (see `mutate`'s own catch), so this
        // gets identical validation and error messaging for free rather
        // than duplicating `isValidConnection`'s logic here and risking the
        // two drifting apart.
        mutate((d) =>
          addRequire(d, activeWorkflow, nodeId, keyboardConnectFromId),
        );
      }
      setKeyboardConnectFromId(null);
    },
    [activeWorkflow, keyboardConnectFromId, mutate],
  );

  const localJobNames = useMemo(() => (doc ? getJobNames(doc) : []), [doc]);

  /**
   * The active workflow's job-entry ids -- what a dragged context attaches to
   * (issue #105). Entry ids, not job names: `context:` is a key of the
   * workflow entry, so the same job aliased twice can carry different
   * contexts, and an orb-provided job is a valid target despite having no
   * local `jobs:` definition. Approval entries are excluded -- nothing runs,
   * so a context has nothing to supply.
   *
   * Computed from `doc` rather than read off the laid-out `nodes` above,
   * because that state is debounced behind ELK and would briefly disagree
   * with the document after an edit.
   */
  const workflowEntryIds = useMemo(() => {
    if (!doc || !activeWorkflow) return [];
    return buildWorkflowGraph(doc, activeWorkflow)
      .nodes.filter((node) => node.kind !== 'approval')
      .map((node) => node.id);
  }, [doc, activeWorkflow]);
  const insertion = useOrbInsertion(activeWorkflow);
  const paletteInsertion = usePaletteInsertion(
    activeWorkflow,
    setAutoFocusNameNodeId,
  );

  // A synchronous (no ELK, no debounce) rebuild of the same graph, used for
  // everything that needs the *current* structure immediately: cycle
  // checks while dragging a connection, and the inspector drawer's view of
  // the selected node. `rendered` above is intentionally debounced (so ELK
  // doesn't re-run on every keystroke) and therefore briefly stale right
  // after an edit -- fine for node *positions*, not for validation logic.
  const liveGraph = useMemo(
    () =>
      doc && activeWorkflow ? buildWorkflowGraph(doc, activeWorkflow) : null,
    [doc, activeWorkflow],
  );

  const selectedNode = useMemo(
    () => liveGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [liveGraph, selectedNodeId],
  );
  const pendingDeleteNode = useMemo(
    () =>
      liveGraph?.nodes.find((node) => node.id === pendingDeleteNodeId) ?? null,
    [liveGraph, pendingDeleteNodeId],
  );
  /**
   * Issue #12: enumerated once, from the *live* document (not the debounced
   * `rendered` graph), when the confirm popover is about to be shown -- so the
   * list of sites it names is exactly what the delete about to run will touch.
   * `null` unless there is actually a job definition to delete.
   */
  const pendingDeleteImpact = useMemo(() => {
    if (!doc || !pendingDeleteNode) return null;
    if (pendingDeleteNode.kind !== 'job' || !pendingDeleteNode.isDefined) {
      return null;
    }
    return describeDeleteImpact(doc, pendingDeleteNode.jobName);
  }, [doc, pendingDeleteNode]);

  const problems = rendered?.problems ?? [];
  /**
   * The validation errors belonging to the workflow currently on screen --
   * see `selectWorkflowDiagnostics`. Resolved against `rendered.nodes` (the
   * graph actually drawn) rather than a freshly-built one, so the banner and
   * the node marks can never disagree about which nodes exist.
   */
  const activeDiagnostics = useMemo(
    () =>
      activeWorkflow && rendered
        ? selectWorkflowDiagnostics(
            allDiagnostics,
            activeWorkflow,
            rendered.nodes,
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see `workflowSummaries` on why `selectWorkflowDiagnostics` is not a dependency.
    [activeWorkflow, rendered, allDiagnostics],
  );
  // Dismissal is keyed off *what* is wrong, so a newly-broken config re-opens
  // the banner rather than staying hidden behind a dismissal of a different
  // problem -- see `problemsSignature`, which now spans both kinds of entry.
  const currentSignature = `${problemsSignature(problems)}#${activeDiagnostics
    .map((diagnostic) => `${diagnostic.source}:${diagnostic.title}`)
    .join('|')}`;
  const showProblems =
    (problems.length > 0 || activeDiagnostics.length > 0) &&
    dismissedSignature !== currentSignature;

  /**
   * Issue #148: which nodes each validation error implicates, resolved from
   * the errors' *structured* targets (see `matchesNode`) against the graph
   * currently on screen. `Map<nodeId, messages>` so `flowNodes` can hand each
   * node exactly the messages that name it, and nothing else.
   */
  const diagnosticsByNode = useMemo(() => {
    const byNode = new Map<string, string[]>();
    if (!rendered || !activeWorkflow) return byNode;
    for (const diagnostic of activeDiagnostics) {
      for (const node of rendered.nodes) {
        if (!matchesNode(diagnostic, activeWorkflow, node)) continue;
        // `diagnosticHeadline`, not `title`: for a policy violation the rule
        // name is half the message ("which control fired" and "what it
        // wants" are different questions), and a node's hover text is one of
        // the two places that answers both.
        const headline = diagnosticHeadline(diagnostic);
        const existing = byNode.get(node.id);
        if (existing) existing.push(headline);
        else byNode.set(node.id, [headline]);
      }
    }
    return byNode;
  }, [rendered, activeWorkflow, activeDiagnostics]);

  const handleRequestDelete = useCallback((nodeId: string) => {
    setPendingDeleteNodeId(nodeId);
  }, []);

  /**
   * Selects the first node a banner entry names, so clicking (or tabbing to
   * and pressing Enter on) an error takes the user to the job it is about.
   * A diagnostic that names no node on this canvas selects nothing rather
   * than clearing the current selection for no reason.
   */
  const handleFocusDiagnostic = useCallback(
    (diagnostic: Diagnostic) => {
      if (!rendered || !activeWorkflow) return;
      const hit = rendered.nodes.find(
        (node) =>
          matchesNode(diagnostic, activeWorkflow, node) &&
          node.isMissing !== true,
      );
      if (hit) selectNode(hit.id);
    },
    [rendered, activeWorkflow, selectNode],
  );

  // Issue #54: "what does this job actually depend on?" -- the set of node
  // ids to leave at full opacity while everything else dims, computed from
  // the same edges `flowEdges` renders (not `liveGraph`, which can be a
  // render ahead of `rendered` -- see `useRenderedGraph`'s own comment on
  // why positions and structure are deliberately decoupled). `null` (rather
  // than an empty set) when nothing is selected, so `flowNodes`/`flowEdges`
  // below have an unambiguous "no dimming at all" case to check instead of
  // treating an empty selection the same as a selected node with no
  // ancestors.
  const ancestorChain = useMemo(() => {
    if (!selectedNodeId || !rendered) return null;
    if (!rendered.nodes.some((node) => node.id === selectedNodeId)) return null;
    return getAncestorChain(rendered.edges, selectedNodeId);
  }, [rendered, selectedNodeId]);

  // See `LARGE_GRAPH_THRESHOLD`'s own comment: only animate the dim/undim
  // and hover-highlight transitions below this size.
  const isLargeGraph = (rendered?.nodes.length ?? 0) > LARGE_GRAPH_THRESHOLD;

  const handleNodeMouseEnter = useCallback((_event: unknown, node: Node) => {
    setHoveredNodeId(node.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

  // Issue #289: the one place a `requires:` edge is actually removed from
  // the document -- both the hover/selected canvas affordance below and
  // React Flow's own `onEdgesDelete` (fired for Backspace/Delete with an
  // edge selected) end up here, so there is exactly one code path to reason
  // about for "does this leave `requires: []` behind" (it doesn't --
  // `removeRequire` already collapses an emptied list to no `requires:` key
  // at all, and back to a bare string entry if that was its only option;
  // see `configMutations.ts`) and exactly one for "is this undoable as one
  // step" (yes -- `mutate` always pushes one history entry per call).
  //
  // Refuses rather than mangles, on #85's principle: `removeRequire` throws
  // if `activeWorkflow`'s own entry for `edge.target` cannot be found at
  // all, and is a safe no-op (not a guess) for any edge whose endpoints
  // don't actually correspond to a live `requires:` entry -- there is
  // nothing here that could half-apply.
  const removeEdgeDependency = useCallback(
    (edge: { source: string; target: string }) => {
      if (!activeWorkflow) return;
      mutate((d) => removeRequire(d, activeWorkflow, edge.target, edge.source));
    },
    [activeWorkflow, mutate],
  );

  // Issue #289: click-to-select an edge, mirroring `handleNodeClick` below --
  // deselects any selected node (only one kind of thing reads as "selected"
  // on this canvas at a time) and cancels a pending keyboard connection,
  // same as every other click handler on this canvas already does.
  const handleEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      setSelectedEdgeId(edge.id);
      setAutoFocusNameNodeId(null);
      selectNode(null);
      setKeyboardConnectFromId(null);
    },
    [selectNode],
  );

  const handleEdgeMouseEnter = useCallback((_event: unknown, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const handleEdgeMouseLeave = useCallback(() => {
    setHoveredEdgeId(null);
  }, []);

  const flowNodes: Node<JobNodeData>[] = useMemo(() => {
    if (!rendered || !activeWorkflow) return [];
    return rendered.nodes.map((node) => {
      const dimmed = ancestorChain !== null && !ancestorChain.has(node.id);
      // Issue #70: a manually-dragged position (see `onNodeDragStop` below)
      // always wins over ELK's own `node.x`/`node.y` for a node that has
      // one. This is looked up by id from `manualPositions`, not from
      // `rendered.nodes` itself, which is the fix for the exact staleness
      // this used to have: `rendered.nodes` gets a fresh array (and each
      // node a fresh object) from ELK every time the graph's structure
      // changes, but a node's *id* survives that change, and the position
      // store is keyed by id, not by array identity. A node ELK has never
      // seen dragged (new, or never moved) has no entry here and simply
      // falls through to ELK's own placement.
      // Issue #85: a live in-progress drag position (see `liveDragPositions`'s
      // own comment above) wins over even a manually-persisted one -- this
      // node is *currently being dragged from* whatever manual/ELK position
      // it already had, so re-asserting that old position here for the rest
      // of this drag is exactly the bug being fixed.
      const live = liveDragPositions[node.id];
      const manual = getStoredPosition(
        manualPositions,
        configPath,
        activeWorkflow,
        node.id,
      );
      const position = live ?? manual ?? { x: node.x, y: node.y };
      // Issue #12: a `missing` placeholder has no line in the config -- it
      // stands for a `requires:` target nothing provides. Every affordance
      // that would edit "this node" is therefore withheld: there is no entry
      // to delete, nothing to drop a step or executor onto, and no id a new
      // `requires:` could legally name. The fix is always to edit the
      // `requires:` pointing at it, or to add the entry it's asking for.
      const isMissing = node.isMissing === true;
      return {
        id: node.id,
        type: 'job',
        position,
        data: {
          node,
          direction: dagDirection,
          onRequestDelete: isMissing ? undefined : handleRequestDelete,
          onDropElement: isMissing ? undefined : insertion.dropOnJobNode,
          onDropStep: isMissing
            ? undefined
            : paletteInsertion.dropStepOnJobNode,
          onDropExecutorRefused: isMissing
            ? undefined
            : paletteInsertion.refuseExecutorOnJobNode,
          // Withheld for a `missing` placeholder for the same reason as every
          // other edit affordance above (issue #12): it has no workflow entry,
          // so there is no `context:` for one to be added to.
          onDropContext: isMissing
            ? undefined
            : paletteInsertion.dropContextOnJobNode,
          onActivateHandle: isMissing ? undefined : handleHandleActivate,
          isKeyboardConnectSource: node.id === keyboardConnectFromId,
          // Issue #148: absent (not an empty array) for every node in a config
          // that validates, so a healthy graph carries no error state at all.
          diagnostics: diagnosticsByNode.get(node.id),
        },
        // Draggable so a manual position can be set at all -- see
        // `onNodeDragStop`, which is what actually persists it. Unlike this
        // pane's old behaviour, the moved position now survives a structure
        // change or a reload; only an explicit "Re-layout" (see
        // `handleRelayout`) discards it and hands the node back to ELK.
        // Still draggable when missing -- moving a placeholder out of the way
        // is harmless and sometimes useful -- but never `connectable` (a new
        // `requires:` naming an id that doesn't exist would just be a second
        // broken reference) and never `selectable` (the inspector has no entry
        // to inspect; see `flowNodes`' `isMissing` comment above).
        draggable: true,
        connectable: !isMissing,
        selectable: !isMissing,
        selected: !isMissing && node.id === selectedNodeId,
        // `vce-dag-node--dimmed` lands on React Flow's own node wrapper (not
        // inside `JobNode`'s own markup), so opacity applies to the whole
        // node -- box, handles, delete affordance -- with one rule; see
        // `.vce-dag-node--dimmed` in styles.css. The transition class is
        // withheld above `LARGE_GRAPH_THRESHOLD` so a big graph's dim/undim
        // is instant rather than animating dozens of nodes at once.
        className: dimmed
          ? `vce-dag-node--dimmed${isLargeGraph ? '' : ' vce-dag-fade'}`
          : undefined,
        style: { width: node.width, height: node.height },
        // Deliberately `initialWidth`/`initialHeight`, not the top-level
        // `width`/`height` fields, and not *only* the CSS size above:
        //   - `width`/`height` make these controlled dimensions, which React
        //     Flow treats as pre-measured, suppressing the dimension-change
        //     notification that applies a queued `fitView()`.
        //   - a CSS size alone is invisible to `<MiniMap>`, whose
        //     `NodeComponentWrapper` reads `node.internals.userNode` -- this
        //     object -- and returns `null` unless `measured?.width ?? width ??
        //     initialWidth` is defined. React Flow only writes `measured` onto
        //     its *internal* node, so for a controlled `nodes` array that field
        //     is never set here and every minimap rect was skipped.
        //   - `initialWidth`/`initialHeight` are a hint: they satisfy that
        //     check while leaving the ResizeObserver free to report the real
        //     measurement, so the minimap and fitView both work.
        // Exact, not a guess -- ELK laid out with the same numbers.
        initialWidth: node.width,
        initialHeight: node.height,
      };
    });
  }, [
    rendered,
    activeWorkflow,
    configPath,
    manualPositions,
    liveDragPositions,
    dagDirection,
    handleRequestDelete,
    insertion.dropOnJobNode,
    paletteInsertion.dropStepOnJobNode,
    paletteInsertion.refuseExecutorOnJobNode,
    paletteInsertion.dropContextOnJobNode,
    handleHandleActivate,
    keyboardConnectFromId,
    selectedNodeId,
    ancestorChain,
    isLargeGraph,
    diagnosticsByNode,
  ]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!rendered) return [];
    // Production falls back from `smoothstep` to plain `default` (bezier)
    // routing above its own 100-node threshold -- smoothstep's routing has
    // to reason about the nodes' extents to route around them, which gets
    // more expensive as the graph grows. See `LARGE_GRAPH_THRESHOLD`.
    const edgeType = isLargeGraph ? 'default' : 'smoothstep';
    return rendered.edges.map((edge) => {
      // Highlighted when it's on the selected node's ancestor chain, or
      // (with nothing selected) when it touches the currently-hovered node
      // -- see `hoveredNodeId`'s own comment for why hover can't reach
      // edges via CSS alone. Dimmed when a chain is active and this edge
      // falls outside it.
      const onChain =
        ancestorChain !== null &&
        ancestorChain.has(edge.source) &&
        ancestorChain.has(edge.target);
      const hovered =
        ancestorChain === null &&
        hoveredNodeId !== null &&
        (edge.source === hoveredNodeId || edge.target === hoveredNodeId);
      const dimmed = ancestorChain !== null && !onChain;
      const classNames = [
        onChain || hovered ? 'vce-dag-edge--highlighted' : '',
        dimmed ? 'vce-dag-edge--dimmed' : '',
        dimmed && !isLargeGraph ? 'vce-dag-fade' : '',
        // Issue #12: a `requires:` pointing at an id nothing provides. Drawn,
        // not hidden -- see `buildGraph`'s doc comment on why the breakage is
        // the feature.
        edge.dangling ? 'vce-dag-edge--dangling' : '',
      ].filter(Boolean);

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // Production's own routing (issue #54): React Flow has no `type` set
        // for us today, which falls back to its default bezier -- curvy
        // where production's is stepped. `style.strokeWidth` matches
        // production's `1` (down from our previous 1.5px, set in
        // styles.css); stroke colour stays CSS-driven (`.react-flow__edge-path`
        // and the `--highlighted`/`--dimmed` classes above) rather than
        // inline, so it keeps working with whatever `--color-cc-*` tokens
        // issue #52 lands.
        type: edgeType,
        style: { strokeWidth: 1 },
        // A workflow graph is directed, and CircleCI's own workflow graph draws
        // arrowheads. Without them these read as undirected lines, so which job
        // depends on which is ambiguous. The marker inherits our edge stroke
        // colour because React Flow renders it with `context-stroke`.
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
        // Issue #289: a fully controlled `selected` field, same reasoning as
        // `flowNodes`' own `selected: node.id === selectedNodeId` just above
        // -- React Flow's *internal* click-tracked selection would otherwise
        // be silently overwritten the next time this array is recomputed
        // (e.g. on an unrelated hover), which is exactly the kind of "worked
        // once, then quietly stopped" bug a controlled field avoids.
        selected: edge.id === selectedEdgeId,
        // Issue #70: a status-conditioned dependency (`- job: [success,
        // failed]`) no longer renders as an always-on label -- `data`
        // (read by `RequiresEdge.tsx`, registered as this edge type's
        // renderer below) draws a small persistent dot plus a hover/focus
        // tooltip with the actual statuses instead.
        //
        // Issue #289: `canRemove`/`onRemove` are the unlink half of the same
        // idea -- a hover *or* selected edge grows a small delete affordance
        // (`RequiresEdge.tsx`), the on-canvas counterpart to dragging a new
        // edge into existence (#29/#32). `onRemove` closes over this edge's
        // own endpoints rather than over `edge.id`, so it keeps working even
        // though `removeRequire` is keyed by (target, source), not edge id.
        data: {
          statuses: edge.statuses,
          canRemove: edge.id === hoveredEdgeId || edge.id === selectedEdgeId,
          onRemove: () =>
            removeEdgeDependency({ source: edge.source, target: edge.target }),
        },
        className: classNames.length > 0 ? classNames.join(' ') : undefined,
      };
    });
  }, [
    rendered,
    ancestorChain,
    hoveredNodeId,
    hoveredEdgeId,
    selectedEdgeId,
    isLargeGraph,
    removeEdgeDependency,
  ]);

  // Issue #70: see `computeMinimapSize`'s own doc comment. Recomputed only
  // when the set of nodes' ids/dimensions could plausibly have changed
  // (`rendered`, which is itself debounced against `doc` churn -- see
  // `useRenderedGraph`), not on every unrelated re-render.
  const minimapSize = useMemo(
    () => computeMinimapSize(rendered?.nodes ?? []),
    [rendered],
  );

  // Changes only on a structural change to the rendered graph (which node
  // and edge ids exist -- not node positions or unrelated job data), or
  // when the workflow, layout direction, or an explicit "Re-layout" click
  // changes the graph independently of its structure. Feeds
  // `FitViewOnStructureChange` below, so the viewport re-fits exactly when
  // the user would expect it to and never mid-edit while they're
  // panning/zooming.
  const fitKey = useMemo(() => {
    if (!rendered) return 'empty';
    const nodeIds = rendered.nodes
      .map((node) => node.id)
      .slice()
      .sort();
    const edgeKeys = rendered.edges
      .map((edge) => `${edge.source}>${edge.target}`)
      .slice()
      .sort();
    return [
      activeWorkflow ?? '',
      dagDirection,
      layoutNonce,
      nodeIds.join(','),
      edgeKeys.join(','),
    ].join('|');
  }, [rendered, activeWorkflow, dagDirection, layoutNonce]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!activeWorkflow || !connection.source || !connection.target) return;
      mutate((d) =>
        addRequire(d, activeWorkflow, connection.target, connection.source),
      );
    },
    [activeWorkflow, mutate],
  );

  // Rejects the drop *before* it happens -- a self-loop, or a connection
  // that would close a cycle in `requires` -- so React Flow can grey the
  // connection line out while the user is still dragging instead of us
  // attempting the edit and surfacing an error toast after the fact.
  const isValidConnection = useCallback(
    (edgeOrConnection: Edge | Connection): boolean => {
      const { source, target } = edgeOrConnection;
      if (!source || !target) return false;
      if (source === target) return false;
      if (!liveGraph) return true;
      return !wouldCreateCycle(liveGraph.edges, source, target);
    },
    [liveGraph],
  );

  // Issue #289: React Flow's own keyboard-delete entry point -- fired for
  // Backspace/Delete with one or more edges selected (its default
  // `deleteKeyCode`, unchanged here). The canvas already has this
  // mechanism, and already uses the identical one for nodes
  // (`onNodesDelete={handleNodesDelete}` below): this is that same, already
  // proven "selection model" the issue asks to check for before adding a
  // parallel one, extended to cover edges too, now that `flowEdges` makes
  // edge selection a controlled (and therefore reliable) property instead of
  // an internal-only one.
  const handleEdgesDelete = useCallback(
    (edges: Edge[]) => {
      // Defense in depth: React Flow's own delete-key handling already
      // ignores keypresses while a text input is focused, but this callback
      // can also be reached from other future entry points, so it checks
      // for itself rather than trusting the caller.
      if (isEditableTarget(document.activeElement)) return;
      for (const edge of edges) removeEdgeDependency(edge);
    },
    [removeEdgeDependency],
  );

  // Deleting a *node* is never a one-step keyboard action: it always opens
  // the "remove from workflow / delete job" popover (see `DeleteNodeConfirm`)
  // instead of actually removing anything here, because those two intents
  // are meaningfully different (see that component's own doc comment).
  const handleNodesDelete = useCallback((nodes: Node[]) => {
    if (isEditableTarget(document.activeElement)) return;
    const first = nodes[0];
    if (!first) return;
    setPendingDeleteNodeId(first.id);
  }, []);

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      setAutoFocusNameNodeId(null);
      selectNode(node.id);
      setSelectedEdgeId(null);
    },
    [selectNode],
  );

  // Issue #288: "clicking the canvas background... puts the workflow in the
  // inspector the way selecting a job does" -- the owner's own placement
  // decision, and the natural-gesture half of it. This used to clear the
  // selection down to nothing (`selectNode(null)`); it now selects the
  // workflow instead, which is a strict superset of what a click on empty
  // canvas already meant (dismiss whatever was selected) plus the new
  // capability, not a second, competing behavior.
  const handlePaneClick = useCallback(() => {
    setAutoFocusNameNodeId(null);
    selectWorkflowEntity();
    setKeyboardConnectFromId(null);
    setSelectedEdgeId(null);
  }, [selectWorkflowEntity]);

  /**
   * `WorkflowTabs`' own click handler -- issue #288's "reasonable second
   * entry point" for selecting the workflow itself, alongside
   * `handlePaneClick`.
   *
   * Switching to a *different* workflow is untouched: it only changes
   * `activeWorkflow`, exactly as it always has, and does not itself select
   * anything -- switching workflows while a job is selected must not
   * surprise-clear that selection (the risk this issue calls out by name),
   * and it does not, because nothing here touches `selectedNodeId` or
   * `workflowSelected` on that path.
   *
   * Clicking the tab that is *already* active is a deliberate second
   * gesture with nothing else to do (re-selecting the same workflow is a
   * no-op for `setSelectedWorkflow`), so it's repurposed as "select the
   * workflow for editing" -- the same action `handlePaneClick` performs,
   * just reached from the tab strip instead of the canvas.
   */
  const handleWorkflowTabSelect = useCallback(
    (name: string) => {
      if (name === activeWorkflow) {
        selectWorkflowEntity();
      } else {
        setSelectedWorkflow(name);
      }
    },
    [activeWorkflow, selectWorkflowEntity, setSelectedWorkflow],
  );

  // Issue #85: the live counterpart to `handleNodeDragStop` below -- React
  // Flow calls this on every pointer-move frame of a drag (not throttled
  // here), feeding `liveDragPositions` so `flowNodes` lets this node's
  // in-flight position win over the manual/ELK recompute that would
  // otherwise overwrite it on the next unrelated render. Deliberately never
  // touches `nodePositionStore` itself -- only `onNodeDragStop` commits,
  // same "persist on commit, not on every frame" split `handleNodeDragStop`
  // already used before this fix.
  const handleNodeDrag = useCallback((_event: unknown, node: Node) => {
    setLiveDragPositions((prev) => ({
      ...prev,
      [node.id]: { x: node.position.x, y: node.position.y },
    }));
  }, []);

  // Issue #70: the other half of free positioning -- persists exactly where
  // the user dropped this node, keyed so it survives everything ELK's own
  // layout does not (see `flowNodes`' own comment). Fires once per drag
  // (React Flow's own "stop", not every intermediate frame), which matches
  // every other persisted-on-commit affordance in this pane (the inspector
  // width, the layout splitters) rather than writing to `localStorage` on
  // every pointermove.
  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      // Issue #85: this node's live in-progress position (see
      // `handleNodeDrag`) is now superseded by the manual position this
      // same drag is about to commit below -- clearing it here, rather than
      // leaving it to linger until the next drag starts, is what lets
      // `flowNodes`' normal manual-position lookup take back over
      // immediately (harmless either way once cleared, since both now agree
      // on the same value, but a stale entry serves no purpose).
      setLiveDragPositions((prev) => {
        if (!(node.id in prev)) return prev;
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      if (!activeWorkflow) return;
      setManualPosition(configPath, activeWorkflow, node.id, {
        x: node.position.x,
        y: node.position.y,
      });
    },
    [activeWorkflow, configPath, setManualPosition],
  );

  const closePendingDelete = useCallback(
    () => setPendingDeleteNodeId(null),
    [],
  );

  const handleRemoveFromWorkflow = useCallback(() => {
    if (!pendingDeleteNode || !activeWorkflow) return;
    mutate((d) =>
      removeWorkflowJobEntry(d, activeWorkflow, pendingDeleteNode.id),
    );
    if (selectedNodeId === pendingDeleteNode.id) selectNode(null);
    setPendingDeleteNodeId(null);
  }, [activeWorkflow, mutate, pendingDeleteNode, selectNode, selectedNodeId]);

  const handleDeleteJobEntirely = useCallback(() => {
    if (!pendingDeleteNode) return;
    // One `mutate` call for the whole reconciliation -- the job definition,
    // every workflow entry, every `requires:` mention -- so the five-site
    // cleanup is a single undo step, not five (issue #12). See
    // `appStore.mutate`.
    mutate((d) => deleteJob(d, pendingDeleteNode.jobName));
    if (selectedNodeId === pendingDeleteNode.id) selectNode(null);
    setPendingDeleteNodeId(null);
  }, [mutate, pendingDeleteNode, selectNode, selectedNodeId]);

  const handleAddWorkflow = useCallback(() => {
    mutate((d) => addWorkflow(d, 'build-and-test'));
    setSelectedWorkflow('build-and-test');
  }, [mutate, setSelectedWorkflow]);

  // Issue #70: "Re-layout" is the one explicit, discoverable way to discard
  // manually-dragged positions -- clearing them here (rather than leaving
  // stale entries a future ELK run would never overwrite) is *why* the
  // button exists at all now that a drag otherwise sticks forever. Clears
  // before bumping `layoutNonce`, not after, so the same render that hands
  // control back to ELK also has an empty `manualPositions` for this
  // workflow, instead of momentarily reapplying a position `flowNodes` is
  // about to discard anyway.
  const handleRelayout = useCallback(() => {
    if (activeWorkflow) clearWorkflowPositions(configPath, activeWorkflow);
    setLayoutNonce((n) => n + 1);
  }, [activeWorkflow, clearWorkflowPositions, configPath]);

  // Reacts to an orb *job* drag (needs an existing workflow) or a palette
  // executor drag (issue #71: always valid -- `addJobFromExecutor` creates
  // the workflow too when none exists yet, so dropping an executor works on
  // a config with no `workflows:` block at all) or a palette *step* drag
  // (always invalid here -- a step has nowhere to go on empty canvas; see
  // `handleCanvasDrop`). Commands/executors dropped on a job node are
  // handled by `JobNode` itself, which calls `stopPropagation()` on its own
  // accept, so this never double-handles a drop that already landed on a
  // node.
  // Issue #87: `preventDefault()` on `dragover` is what tells the browser a
  // target *accepts* the drop -- call it unconditionally (as this used to)
  // and the browser shows its "copy" cursor (the green "+") over a target
  // that is about to be refused anyway, and still fires `drop` on release,
  // which is exactly the "looks droppable, then errors" bug: dragging a
  // palette step over empty canvas showed the green "+" the whole way, then
  // released into `refuseStepOnCanvas`'s error banner. Only calling it for
  // a combination that will actually succeed makes the browser itself
  // refuse the drop (its own "not-allowed" cursor, and `drop` never fires
  // here at all) for every other combination -- `dataTransfer.dropEffect`
  // is set explicitly either way so both the real browser cursor and a test
  // reading `dropEffect` directly agree on which is which.
  const handleCanvasDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (isDraggingOrbKind(event.dataTransfer, 'job')) {
        // Valid unless there's no workflow yet to drop the job into --
        // `insertion.dropOnCanvas` -> `insertJob` refuses that case today;
        // this is what makes that refusal unreachable in normal use rather
        // than a pop-up error after the fact.
        const isValid = Boolean(activeWorkflow);
        setCanvasDragState(isValid ? 'valid' : 'invalid');
        event.dataTransfer.dropEffect = isValid ? 'copy' : 'none';
        if (!isValid) return;
        event.preventDefault();
        return;
      }
      if (isDraggingPaletteExecutor(event.dataTransfer)) {
        // Issue #71: always valid -- an executor with no workflow yet still
        // creates one (see `usePaletteInsertion`'s own module doc).
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setCanvasDragState('valid');
        return;
      }
      if (isDraggingPaletteStep(event.dataTransfer)) {
        // A step has nowhere to go on the canvas background -- always
        // refused; `refuseStepOnCanvas` (see `handleCanvasDrop`) is now an
        // unreachable backstop rather than the normal path.
        event.dataTransfer.dropEffect = 'none';
        setCanvasDragState('invalid');
        return;
      }
      if (isDraggingPaletteContext(event.dataTransfer)) {
        // Issue #105: same as a step -- a context attaches to a specific
        // workflow *entry*, so the canvas background is never a target.
        // Refused here (visibly, before release) rather than only at drop
        // time, per issue #87's rule about not showing an accepting cursor
        // for a drop that will be refused.
        event.dataTransfer.dropEffect = 'none';
        setCanvasDragState('invalid');
      }
    },
    [activeWorkflow],
  );

  const handleCanvasDragLeave = useCallback(() => setCanvasDragState(null), []);

  const handleCanvasDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      setCanvasDragState(null);

      const orbJobPayload = readOrbDragPayload(event.dataTransfer, 'job');
      if (orbJobPayload) {
        event.preventDefault();
        insertion.dropOnCanvas(orbJobPayload);
        return;
      }

      const executorPayload = readPaletteExecutorDragPayload(
        event.dataTransfer,
      );
      if (executorPayload) {
        event.preventDefault();
        paletteInsertion.dropOnCanvas(executorPayload);
        return;
      }

      const stepPayload = readPaletteStepDragPayload(event.dataTransfer);
      if (stepPayload) {
        event.preventDefault();
        paletteInsertion.refuseStepOnCanvas();
        return;
      }

      const contextPayload = readPaletteContextDragPayload(event.dataTransfer);
      if (contextPayload) {
        event.preventDefault();
        paletteInsertion.refuseContextOnCanvas();
      }
    },
    [insertion, paletteInsertion],
  );

  // Scoped to this pane's own subtree (via React's event bubbling, not a
  // document-level listener) so it can never fight with the YAML editor's
  // own native undo/redo, which lives in a completely different part of the
  // tree. Still guarded by `isEditableTarget` because the inspector drawer
  // -- rendered inside this same subtree -- has its own text inputs, and
  // Cmd/Ctrl+Z there should undo *typing in that field* (the browser's
  // native input undo), not the whole document.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      // Issue #54, matching production's own Escape handling: clears the
      // ancestor-chain highlight/dim by clearing the selection, the same
      // end state a pane click already reaches via `handlePaneClick`.
      if (event.key === 'Escape') {
        setAutoFocusNameNodeId(null);
        selectNode(null);
        // Issue #70: Escape is also the documented way to back out of a
        // pending keyboard connection without completing it or having to
        // find the anchor handle again to cancel it.
        setKeyboardConnectFromId(null);
        // Issue #289: and to back out of an edge selection, matching every
        // other selection-clearing path here (`handlePaneClick`).
        setSelectedEdgeId(null);
        return;
      }
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    },
    [redo, undo, selectNode],
  );

  const openFile = files.find((file) => file.path === configPath);
  const notAConfigMessage =
    openFile && !openFile.isConfig
      ? `${openFile.relPath} is not a CircleCI config, so there is no workflow graph to show. ${openFile.configReason}`
      : null;

  let emptyMessage: string | null = null;
  if (notAConfigMessage) {
    // Checked before the parse/workflow cases below so a goss file is never
    // told it "has no workflows: block yet", which would read as advice to
    // go and add one.
    emptyMessage = notAConfigMessage;
  } else if (!doc) {
    // `doc` is only ever null here because parsing the loaded (or just
    // edited) text failed -- an empty or missing file still parses to an
    // empty `Document` (see `parseConfig`) -- so say so specifically,
    // rather than the generic "nothing loaded" message, which would read
    // as if the file were untouched when it actually has unparsable YAML
    // in it.
    emptyMessage = parseError
      ? 'Your YAML has a parse error. Fix it in the editor to see the graph.'
      : 'No configuration loaded yet.';
  } else if (workflows.length === 0) {
    emptyMessage = 'This config has no workflows: block yet.';
  } else if (rendered && rendered.nodes.length === 0) {
    emptyMessage = `The "${activeWorkflow}" workflow has no jobs.`;
  }

  return (
    <Panel
      title="Workflow Graph"
      headerExtra={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={undo}
            disabled={!canUndo}
            aria-label="Undo last change"
            title="Undo (Ctrl/Cmd+Z)"
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={redo}
            disabled={!canRedo}
            aria-label="Redo last undone change"
            title="Redo (Ctrl/Cmd+Shift+Z)"
          >
            Redo
          </Button>
          {/* Issue #49: workflow navigation itself is no longer here -- it
              moved out of this button row and into `WorkflowTabs`, rendered
              as its own always-visible strip below the header (see the
              content below), where there's room to show every workflow's
              job count and validity, not just its name in a cramped
              `<select>`. */}
          {doc && workflows.length === 0 ? (
            <Button variant="secondary" size="sm" onClick={handleAddWorkflow}>
              Add workflow
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRelayout}
            disabled={!rendered}
            title="Discards any positions you've dragged nodes to in this workflow and hands every node back to the automatic layout"
          >
            Re-layout
          </Button>
          {/*
            Issue #183: there is deliberately no "Palette" button here any
            more. *"We have the palette button still on the workflow graph
            section."*

            It was left-over furniture from before #88, when the palette
            was a fixed 320px column this pane rendered inline and this button
            was the only thing that could show or hide it. #88 promoted the
            palette to a real layout pane, and this button was rewired to
            `useLayoutStore.toggleCollapsed('palette')` -- i.e. it became a
            second, remote control for the *other* pane's own Collapse/Expand
            strip, duplicating a control that pane already carries (and that
            every other pane carries too). Confirmed by reading both paths
            before removing it: this button called
            `toggleCollapsed('palette')` and so does `PaneSlot`'s own
            Collapse/Expand for that pane -- one store field, which is exactly
            why the two could never disagree, and also why one of them is
            redundant. The palette pane stays reachable exactly the way the
            other four are.

            (Issue #71 is what reduced the old "Add job"/"Orbs" pair to this
            one button; both are sections of the palette itself now, so nothing
            else was ever waiting for a slot here.)
          */}
        </>
      }
      contentClassName="p-0"
    >
      <div className="flex h-full w-full min-w-0 flex-col">
        <WorkflowTabs
          summaries={workflowSummaries}
          active={activeWorkflow}
          onSelect={handleWorkflowTabSelect}
        />
        {/* relative: anchors the floating orb browser drawer below. min-h-0:
            without it this row refuses to shrink below its content's
            natural height, which -- inside the column above -- pushed it
            (and the canvas below it) taller than the panel and off-screen. */}
        <div
          className="relative flex min-h-0 w-full min-w-0 flex-1"
          onKeyDown={handleKeyDown}
        >
          <div
            ref={canvasRef}
            data-testid="dag-canvas"
            className={`relative h-full min-w-0 flex-1${
              canvasDragState ? ` vce-dag-canvas--drop-${canvasDragState}` : ''
            }`}
            onDragOver={handleCanvasDragOver}
            onDragLeave={handleCanvasDragLeave}
            onDrop={handleCanvasDrop}
          >
            {emptyMessage ? (
              <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-cc-text-muted">
                {emptyMessage}
              </div>
            ) : (
              <ReactFlowProvider>
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={NODE_TYPES}
                  edgeTypes={EDGE_TYPES}
                  // React Flow's own default (0.5) is too high to let fitView
                  // zoom out far enough for a large graph (dozens of jobs) in
                  // this pane's narrow width -- without this, fitView silently
                  // clamps to the default and most of the graph stays
                  // off-screen. See `FitViewOnStructureChange`.
                  minZoom={MIN_ZOOM}
                  // Without an explicit `colorMode`, React Flow defaults to
                  // light (the canvas renders `class="react-flow light"`) and
                  // every control, minimap and handle has to be patched dark
                  // in styles.css by hand. Tracking this app's own resolved
                  // theme (issue #52) instead of hardcoding `"dark"` fixes the
                  // parts styles.css never thought to patch, in *either*
                  // theme; the ~12 override rules in styles.css's "React Flow
                  // ships light-theme defaults..." comment stay in place
                  // regardless, since they use this app's own theme-aware
                  // `--color-cc-*` tokens rather than duplicating React Flow's
                  // per-mode palette.
                  colorMode={resolvedTheme}
                  proOptions={{ hideAttribution: true }}
                  nodesDraggable
                  nodesConnectable
                  elementsSelectable
                  // Issue #70: "it's really hard to hit that little circle" --
                  // React Flow's own default (20px) already gives a mouse
                  // drag some tolerance for ending on a handle it didn't land
                  // exactly on, but a 220px-wide node's handle is a small
                  // target next to the whole node body; widening this beyond
                  // the default makes a slightly-off drop still count as
                  // "on" the handle instead of silently doing nothing.
                  connectionRadius={36}
                  onConnect={handleConnect}
                  isValidConnection={isValidConnection}
                  onNodesDelete={handleNodesDelete}
                  onEdgesDelete={handleEdgesDelete}
                  onNodeClick={handleNodeClick}
                  onPaneClick={handlePaneClick}
                  // Issue #289: click-to-select an edge (mirrors
                  // `onNodeClick`), and the hover half of the discoverable
                  // delete affordance -- see `hoveredEdgeId`'s own comment.
                  onEdgeClick={handleEdgeClick}
                  onEdgeMouseEnter={handleEdgeMouseEnter}
                  onEdgeMouseLeave={handleEdgeMouseLeave}
                  // Issue #85: the live in-flight position, sampled every
                  // drag frame -- see `handleNodeDrag`'s own comment.
                  onNodeDrag={handleNodeDrag}
                  // Issue #70: persists the drop position -- see
                  // `handleNodeDragStop`'s own comment on why "stop", not
                  // every intermediate drag frame.
                  onNodeDragStop={handleNodeDragStop}
                  // Issue #54: drives the hover-highlights-connected-edges
                  // affordance -- see `hoveredNodeId`'s own comment on why
                  // this can't just be CSS `:hover`.
                  onNodeMouseEnter={handleNodeMouseEnter}
                  onNodeMouseLeave={handleNodeMouseLeave}
                >
                  {/*
                  `gap`/`color` echo production's dotted background (its own
                  literal is `#9ca3af`); reusing our existing
                  `--color-cc-border-strong` token rather than that hex
                  keeps this app's one dark palette as the only source of
                  truth instead of adding a second, unrelated grey.
                */}
                  <Background gap={16} color="var(--color-cc-border-strong)" />
                  <CanvasControls
                    direction={dagDirection}
                    onDirectionChange={setDagDirection}
                    fitViewOptions={CONTROL_FIT_VIEW_OPTIONS}
                  />
                  <MiniMap
                    pannable
                    zoomable
                    ariaLabel="Workflow graph minimap"
                    // Issue #70: see `computeMinimapSize`'s own doc comment --
                    // sized to this graph's own aspect ratio instead of
                    // `<MiniMap>`'s fixed 200x150 default.
                    style={minimapSize}
                    // Rounded corners on the rects themselves, echoing (not
                    // matching exactly -- these are a few px on a canvas
                    // node vs. a fraction of a px here) `.vce-dag-node`'s own
                    // `border-radius: 8px`, so a minimap rect reads as a
                    // small job card rather than a bare rectangle. `1` is
                    // React Flow's own flow-space units here, same as
                    // `nodeBorderRadius`'s default of 5 -- this pane's own
                    // 220x56 nodes are much larger in flow-space than
                    // whatever example graph that default was tuned against.
                    nodeBorderRadius={4}
                    // Colour comes from a per-kind class rather than the
                    // `nodeColor` prop so the palette stays in styles.css with
                    // every other token (and keeps working when a light theme
                    // lands). React Flow passes the *user* node here, which is
                    // where our `JobNodeData` lives.
                    nodeClassName={(node) => {
                      const data = node.data as JobNodeData | undefined;
                      const graphNode = data?.node;
                      if (!graphNode) return '';
                      // Issue #148: a validation error outranks everything --
                      // it's why the pipeline won't run at all.
                      if ((data?.diagnostics?.length ?? 0) > 0) {
                        return 'vce-minimap-node--diagnostic';
                      }
                      // An undefined job outranks its kind: it's the one state
                      // worth spotting without zooming back in.
                      if (graphNode.kind === 'job' && !graphNode.isDefined) {
                        return 'vce-minimap-node--undefined';
                      }
                      return `vce-minimap-node--${graphNode.kind}`;
                    }}
                  />
                  <FitViewOnStructureChange
                    fitKey={fitKey}
                    hasNodes={flowNodes.length > 0}
                  />
                  <FitViewOnContainerResize
                    containerRef={canvasRef}
                    hasNodes={flowNodes.length > 0}
                  />
                </ReactFlow>
              </ReactFlowProvider>
            )}

            {showProblems ? (
              <ProblemsBanner
                problems={problems}
                diagnostics={activeDiagnostics}
                onDismiss={() => setDismissedSignature(currentSignature)}
                onFocusDiagnostic={handleFocusDiagnostic}
              />
            ) : null}

            {/*
            Issue #70: the discoverability half of keyboard connecting --
            without this, a screen-reader/keyboard user who activates a
            handle has no way to tell the anchor was accepted at all, let
            alone what to do next. `role="status"` (not `alert`) since this
            is routine progress feedback, not an error. `pointer-events-none`
            on the wrapper keeps it from stealing clicks off the canvas
            underneath; the pill itself opts back in so its own Cancel
            button stays clickable.
          */}
            {keyboardConnectFromId ? (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
                <div
                  role="status"
                  className="pointer-events-auto flex items-center gap-2 rounded-full border border-cc-accent bg-cc-panel/95 px-3 py-1.5 text-xs text-cc-text shadow-lg backdrop-blur-sm"
                >
                  <span>
                    Connecting from{' '}
                    <span className="font-mono font-medium">
                      {rendered?.nodes.find(
                        (node) => node.id === keyboardConnectFromId,
                      )?.alias ?? keyboardConnectFromId}
                    </span>{' '}
                    -- press Enter on another job&apos;s connector to finish, or
                    Escape to cancel.
                  </span>
                  <button
                    type="button"
                    onClick={() => setKeyboardConnectFromId(null)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-cc-text-muted hover:bg-cc-panel-raised hover:text-cc-text"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {pendingDeleteNode ? (
              <DeleteNodeConfirm
                node={pendingDeleteNode}
                canDeleteJob={
                  pendingDeleteNode.kind === 'job' &&
                  pendingDeleteNode.isDefined
                }
                deleteImpact={pendingDeleteImpact ?? undefined}
                onRemoveFromWorkflow={handleRemoveFromWorkflow}
                onDeleteJob={handleDeleteJobEntirely}
                onCancel={closePendingDelete}
              />
            ) : null}

            {/*
            Only when there IS a last valid version to fall back to --
            `doc` is null on a parse error with nothing previously parsed
            (e.g. the file already had broken YAML on first load), in which
            case `emptyMessage` above already explains the parse error and
            this "last valid version" framing would be actively wrong.
          */}
            {doc && parseError ? (
              <div
                role="status"
                className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-cc-warning/40 bg-cc-panel/90 px-4 py-2 text-center text-xs text-cc-warning"
              >
                Showing last valid version -- your YAML currently has a parse
                error.
              </div>
            ) : null}
          </div>

          {/*
          Refusals frequently originate on the canvas (an invalid drop, a
          connection that would create a cycle), so this is rendered here
          rather than only in the inspector, which may not be mounted.
        */}
          {editError ? (
            <div className="pointer-events-auto absolute inset-x-3 top-3 z-30">
              <EditErrorBanner message={editError} onDismiss={clearEditError} />
            </div>
          ) : null}

          {/*
          Issue #251: a context that may not work here was *added anyway*, and
          this says so. Stacked below the refusal banner rather than sharing its
          slot because the two can be true at once and mean opposite things --
          one reports an edit that did not happen, this one an edit that did.
        */}
          {restrictionNotice ? (
            <div
              className={`pointer-events-auto absolute inset-x-3 z-30 ${
                editError ? 'top-16' : 'top-3'
              }`}
            >
              <ContextRestrictionNotice />
            </div>
          ) : null}

          {/*
          Only mounted once a job -- or, issue #288, the workflow itself --
          is selected. Reserving this column for a "select a job" placeholder
          cost the canvas 280px permanently, which on a narrow window forced
          the graph to fit at an unreadable zoom. `activeWorkflow` is also
          required for the workflow-selected case: a `workflowSelected` left
          over from a previous file/workflow with no workflow currently
          resolvable (e.g. this file has none at all) would otherwise open an
          inspector with nothing to show.
        */}
          {selectedNode !== null || (workflowSelected && activeWorkflow) ? (
            <>
              <InspectorDivider
                width={inspectorWidth}
                onResize={handleResizeInspector}
              />
              <div
                className="h-full shrink-0 overflow-hidden"
                style={{ width: inspectorWidth }}
              >
                <Inspector
                  key={
                    selectedNode
                      ? selectedNode.id
                      : `workflow:${activeWorkflow}`
                  }
                  doc={doc}
                  workflowName={activeWorkflow}
                  node={selectedNode}
                  workflowSelected={selectedNode === null && workflowSelected}
                  onRequestDelete={handleRequestDelete}
                  autoFocusName={
                    selectedNode
                      ? selectedNode.id === autoFocusNameNodeId
                      : false
                  }
                  onDropOrbCommand={insertion.dropOnSteps}
                  onDropPaletteStep={paletteInsertion.dropStepOnSteps}
                />
              </div>
            </>
          ) : null}

          {/*
          Issue #88: the palette used to be a real flex column rendered
          right here, sitting *after* the inspector inside this same pane --
          up to `inspectorWidth + 320px` (more than the inspector alone ever
          cost) came out of the canvas whenever both were open at once,
          which measured out as the graph canvas becoming the narrowest
          useful region on screen in the one preset whose whole purpose is
          the graph.

          It's now `PalettePane`, a sibling top-level pane the layout
          system's own splitter/collapse machinery sizes -- resizable,
          keyboard-accessible, collapses to a strip that reclaims its space
          exactly, all for free from the same code every other pane already
          gets. `paletteTarget` is that pane's own portal target (see
          `palettePortalTarget.ts`); `<Palette>` itself, and every callback
          it needs, stays built right here since nothing about *why* it's
          rendered changed, only *where its DOM lands*.

          The old "must stay a sibling column, never an overlay, so the
          inspector is never hidden" constraint (issue #75) is now satisfied
          more strongly than before: the palette lives in an entirely
          separate region of the layout tree, so there is no longer even a
          *code path* by which opening it could cover the inspector, overlay
          or not. Likewise, dragging a step onto the inspector's own steps
          list still works exactly as before -- HTML5 drag-and-drop is a
          browser-level `dataTransfer` mechanism (see `paletteSteps.ts`/
          `paletteExecutors.ts`), indifferent to which pane's DOM subtree
          either endpoint happens to live in.

          `paletteTarget` is `null` in every `DagPane`-only test (none of
          which render the surrounding `App`/`LayoutRoot` tree that mounts
          `PalettePane`) -- the inline fallback below is what keeps every
          one of those unchanged, rendering the exact same markup this
          pane used to render permanently, just now gated the same way it
          always was.
        */}
          {(() => {
            const paletteElement = (
              <Palette
                doc={doc}
                mutate={mutate}
                localJobNames={localJobNames}
                activeWorkflowName={activeWorkflow}
                onActivateExecutor={paletteInsertion.openConfigureFor}
                onAddStepToJob={paletteInsertion.addStepToJob}
                onAddCommandToJob={paletteInsertion.addCommandToJob}
                onExtractExecutor={paletteInsertion.extractExecutor}
                onExtractCommand={paletteInsertion.extractCommand}
                onAddOrbJob={insertion.insertJob}
                onAddOrbCommand={insertion.insertCommand}
                onAddOrbExecutor={insertion.insertExecutor}
                workflowEntryIds={workflowEntryIds}
                onAddContextToEntry={paletteInsertion.addContextToJobEntry}
                onCreateJobFromOrbExecutor={(orbRef, element) =>
                  paletteInsertion.openConfigureForOrbExecutor(
                    orbRef,
                    element.name,
                  )
                }
              />
            );

            if (paletteTarget) {
              // Always portalled once a target exists, regardless of
              // `paletteOpen` -- visibility is `PaneSlot`'s job (a `hidden`
              // attribute on an ancestor, never an unmount -- see that
              // component's own doc comment on why: the palette has its own
              // meaningful state, an open accordion section, a search query,
              // a selected orb, that a collapse/expand round trip must not
              // reset any more than collapsing the YAML editor may lose its
              // cursor position).
              return createPortal(
                <div className="h-full w-full" aria-label="Object palette">
                  {paletteElement}
                </div>,
                paletteTarget,
              );
            }

            return paletteOpen ? (
              <div
                className="h-full w-[320px] shrink-0 overflow-hidden border-l border-cc-border bg-cc-panel"
                role="complementary"
                aria-label="Object palette"
              >
                {paletteElement}
              </div>
            ) : null;
          })()}
        </div>
      </div>

      <ParamsDialog
        element={insertion.pendingElement}
        onSubmit={insertion.confirmPending}
        onCancel={insertion.cancelPending}
      />
      <ConfigureJobDialog
        item={paletteInsertion.pendingItem}
        existingJobNames={paletteInsertion.existingJobNames}
        existingExecutorNames={paletteInsertion.existingExecutorNames}
        onSubmit={paletteInsertion.confirmPending}
        onCancel={paletteInsertion.cancelPending}
      />
    </Panel>
  );
}
