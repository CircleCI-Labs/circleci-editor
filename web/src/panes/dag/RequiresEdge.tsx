import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';
import { memo } from 'react';

/**
 * Issue #70: "I do see the success/failed status. I think that's helpful,
 * but maybe more if you hover over that specific dependency" -- a status
 * condition on `requires` (`- job: [success, failed]`) used to render as an
 * always-on React Flow edge `label` (a permanent `<text>` sitting on the
 * canvas), which is exactly what made a workflow with a handful of
 * conditioned edges read as noisy. This renders no on-canvas text at all;
 * only a small persistent dot (so the *existence* of a condition stays
 * visible without hovering anything) plus the actual statuses as a tooltip
 * that appears on hover/focus.
 *
 * A real DOM element via `<EdgeLabelRenderer>`, not an SVG `<text>`,
 * specifically so it can be `tabIndex`-focusable -- an SVG text node has no
 * equivalent, and "hover/focus" was the explicit ask, not "hover only".
 *
 * Two thin wrappers below (`SmoothStepRequiresEdge`, `BezierRequiresEdge`)
 * select the path util matching whichever routing `flowEdges` (`DagPane.tsx`)
 * already chose per `LARGE_GRAPH_THRESHOLD` -- registered under React
 * Flow's own `'smoothstep'`/`'default'` `edgeTypes` keys (see `EDGE_TYPES`
 * in `DagPane.tsx`), so `edge.type` itself is untouched and every existing
 * test/behaviour keyed on it (routing choice, the large-graph perf
 * fallback) still applies exactly as before; only what renders *inside*
 * that edge type changes.
 *
 * Issue #289: the same `<EdgeLabelRenderer>` also carries the unlink
 * affordance -- a small delete button that appears once this edge is
 * hovered or selected (`canRemove`, computed in `DagPane.tsx`'s
 * `flowEdges`), the on-canvas counterpart to dragging a new edge into
 * existence (#29/#32). Offset a few px to the side of the status dot's own
 * anchor point rather than sharing it exactly -- both can be present on the
 * same status-conditioned edge at once, and stacking two independently
 * meaningful controls exactly on top of each other would make one of them
 * unclickable.
 */
export interface RequiresEdgeData extends Record<string, unknown> {
  /** The `requires:` status conditions this edge represents (e.g.
   * `['success', 'failed']`), or `undefined`/empty for a plain dependency
   * with nothing extra to show. */
  statuses?: string[];
  /** Whether to show the hover/selected delete affordance -- hovered or
   * (controlled, see `DagPane.tsx`'s `selectedEdgeId`) selected. */
  canRemove?: boolean;
  /** Removes this edge's `requires:` dependency. Absent only in tests that
   * construct edge data by hand; `DagPane.tsx` always supplies it. */
  onRemove?: () => void;
}

function RequiresEdgeBase({
  id,
  path,
  labelX,
  labelY,
  style,
  markerEnd,
  statuses,
  canRemove,
  onRemove,
}: {
  id: string;
  path: string;
  labelX: number;
  labelY: number;
  style?: React.CSSProperties;
  markerEnd?: string;
  statuses: string[] | undefined;
  canRemove: boolean;
  onRemove: (() => void) | undefined;
}) {
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {statuses && statuses.length > 0 ? (
        <EdgeLabelRenderer>
          <div
            className="vce-dag-edge-condition nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            tabIndex={0}
            role="note"
            aria-label={`This dependency only runs on: ${statuses.join(', ')}`}
          >
            <span className="vce-dag-edge-condition__dot" aria-hidden="true" />
            <span className="vce-dag-edge-condition__tooltip" role="tooltip">
              {statuses.join(' / ')}
            </span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {canRemove && onRemove ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="vce-dag-edge-delete-affordance nodrag nopan"
            style={{
              // A third `translate` shifts this off the status dot's own
              // anchor point (see this file's own doc comment) rather than
              // sharing it exactly -- both can be present on the same edge.
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) translate(14px, -14px)`,
            }}
            title="Remove this dependency"
            aria-label="Remove this dependency"
            onClick={(event) => {
              // This button lives on the canvas, not inside the edge's own
              // clickable path -- but React Flow still treats a click
              // anywhere inside `EdgeLabelRenderer`'s portal as landing on
              // the pane, and `onPaneClick` would otherwise fire right after
              // this and immediately clear the selection this click has
              // nothing to do with.
              event.stopPropagation();
              onRemove();
            }}
          >
            &times;
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function SmoothStepRequiresEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <RequiresEdgeBase
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      style={style}
      markerEnd={markerEnd}
      statuses={(data as RequiresEdgeData | undefined)?.statuses}
      canRemove={(data as RequiresEdgeData | undefined)?.canRemove ?? false}
      onRemove={(data as RequiresEdgeData | undefined)?.onRemove}
    />
  );
}

/** Registered under React Flow's own `'smoothstep'` `edgeTypes` key -- see this file's own doc comment. */
export const SmoothStepRequiresEdge = memo(SmoothStepRequiresEdgeImpl);

function BezierRequiresEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <RequiresEdgeBase
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      style={style}
      markerEnd={markerEnd}
      statuses={(data as RequiresEdgeData | undefined)?.statuses}
      canRemove={(data as RequiresEdgeData | undefined)?.canRemove ?? false}
      onRemove={(data as RequiresEdgeData | undefined)?.onRemove}
    />
  );
}

/** Registered under React Flow's own `'default'` (bezier) `edgeTypes` key --
 * the large-graph (`LARGE_GRAPH_THRESHOLD`) fallback routing. */
export const BezierRequiresEdge = memo(BezierRequiresEdgeImpl);
