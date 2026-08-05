import { useReactFlow } from '@xyflow/react';
import { useCallback, type ReactNode } from 'react';

import { Tooltip } from '~/design/components/Tooltip';
import type { LayoutDirection } from '~/lib/graph/layout';

/**
 * The canvas's own control cluster: zoom out, zoom in, fit view, then the
 * layout-direction toggle below a divider.
 *
 * Issue #82. This replaces React Flow's built-in `<Controls>` *and* the
 * separate `LR`/`TB` segmented control that used to sit up in the pane
 * header, because CircleCI's production DAG puts all four in one cluster --
 * verified against the production workflow DAG's own controls
 * (rev dc3fabe), which renders exactly this grouping: a vertical stack of
 * zoom-out / zoom-in / fit-view, a full-width rule, then a single direction
 * button. Its ordering (minus before plus) is production's too, and is kept
 * rather than "corrected" so the muscle memory transfers.
 *
 * Two deliberate divergences from that reference:
 *
 *   - Production's fit is `fitView({ padding: 0.2, duration: 500, minZoom:
 *     0.5, maxZoom: 1.5 })`. We pass our own bounds instead, because its DAG
 *     is a full-screen dialog while ours is one pane of three or four; see
 *     `FIT_VIEW_MIN_ZOOM`'s comment in `DagPane` for why ours goes much
 *     lower.
 *   - Production uses Lucide icon components. This app has no icon
 *     dependency, and pulling one in for five trivial geometric shapes isn't
 *     worth the bundle or the licence surface, so they're inline SVG below.
 */

const CONTROL_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-cc-text-muted transition-colors ' +
  'hover:bg-cc-panel-raised hover:text-cc-text focus-visible:bg-cc-panel-raised focus-visible:text-cc-text ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

function ControlButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={CONTROL_BUTTON_CLASS}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Shared SVG frame: 16px, `currentColor` stroke, so each icon inherits the
 *  button's own hover/focus colour rather than hardcoding one. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * The direction glyph mirrors the graph's *current* orientation while the
 * label describes the state clicking will move to -- production's own
 * comment makes the same distinction ("rows for the left-to-right layout,
 * columns for the top-to-bottom layout"). Three bars laid out as rows read
 * as a left-to-right pipeline; rotated to columns they read as top-to-bottom.
 */
function DirectionGlyph({ direction }: { direction: LayoutDirection }) {
  return (
    <Glyph>
      {direction === 'RIGHT' ? (
        <>
          <line x1="3" y1="5.5" x2="14" y2="5.5" />
          <line x1="3" y1="10" x2="17" y2="10" />
          <line x1="3" y1="14.5" x2="11" y2="14.5" />
        </>
      ) : (
        <>
          <line x1="5.5" y1="3" x2="5.5" y2="14" />
          <line x1="10" y1="3" x2="10" y2="17" />
          <line x1="14.5" y1="3" x2="14.5" y2="11" />
        </>
      )}
    </Glyph>
  );
}

interface CanvasControlsProps {
  direction: LayoutDirection;
  onDirectionChange: (direction: LayoutDirection) => void;
  /** Passed through to `fitView` -- see the divergence note above. */
  fitViewOptions: { padding: number; minZoom: number; maxZoom: number };
}

export function CanvasControls({
  direction,
  onDirectionChange,
  fitViewOptions,
}: CanvasControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  // Animated to match production's own `duration` values: the viewport
  // jumping instantly makes it hard to keep track of where you were,
  // especially when zoomed far out on a long pipeline.
  const handleZoomIn = useCallback(
    () => void zoomIn({ duration: 200 }),
    [zoomIn],
  );
  const handleZoomOut = useCallback(
    () => void zoomOut({ duration: 200 }),
    [zoomOut],
  );
  const handleFitView = useCallback(
    () => void fitView({ ...fitViewOptions, duration: 500 }),
    [fitView, fitViewOptions],
  );

  const isHorizontal = direction === 'RIGHT';
  // Names the destination, not the current state -- "LR"/"TB" (what this
  // replaced) are ELK's axis codes and mean nothing to someone who hasn't
  // read its documentation. Wording taken from production.
  const directionLabel = isHorizontal
    ? 'Switch to vertical layout'
    : 'Switch to horizontal layout';

  return (
    <div
      className="absolute bottom-4 left-4 z-10 flex flex-col items-center gap-0.5 rounded-xl border border-cc-border bg-cc-panel p-1 shadow-lg"
      // `nodrag`/`nopan` stop a click or drag that lands on the cluster from
      // being interpreted by the canvas underneath it as a pan.
      // `react-flow__panel` is deliberately *not* used: this is our own
      // overlay, not one React Flow manages.
    >
      <div className="flex flex-col items-center gap-0.5">
        <ControlButton label="Zoom out" onClick={handleZoomOut}>
          <Glyph>
            <line x1="4" y1="10" x2="16" y2="10" />
          </Glyph>
        </ControlButton>
        <ControlButton label="Zoom in" onClick={handleZoomIn}>
          <Glyph>
            <line x1="4" y1="10" x2="16" y2="10" />
            <line x1="10" y1="4" x2="10" y2="16" />
          </Glyph>
        </ControlButton>
        <ControlButton label="Fit view" onClick={handleFitView}>
          <Glyph>
            <path d="M7.5 3.5H4.5A1 1 0 0 0 3.5 4.5V7.5" />
            <path d="M12.5 3.5H15.5A1 1 0 0 1 16.5 4.5V7.5" />
            <path d="M16.5 12.5V15.5A1 1 0 0 1 15.5 16.5H12.5" />
            <path d="M3.5 12.5V15.5A1 1 0 0 0 4.5 16.5H7.5" />
          </Glyph>
        </ControlButton>
      </div>

      <div className="my-0.5 h-px w-full bg-cc-border" />

      <ControlButton
        label={directionLabel}
        onClick={() => onDirectionChange(isHorizontal ? 'DOWN' : 'RIGHT')}
      >
        <DirectionGlyph direction={direction} />
      </ControlButton>
    </div>
  );
}
