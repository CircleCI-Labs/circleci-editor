import type { ReactNode } from 'react';

import { usePaneHeaderSlot } from './paneHeaderSlot';

interface PanelProps {
  title: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * A titled pane container with a header slot. Stands in for Compass's
 * panel primitive; keep the surface minimal so it's easy to swap out.
 *
 * Issue #208: the header row also renders whatever the layout engine offers via
 * `PaneHeaderSlotContext` -- `Move` and `Collapse`, for the five panes wrapped
 * in a `PaneSlot`. This header is the landmark those controls fold into,
 * because it is the pane's accessible heading and already the row its real
 * controls hang off; see `paneHeaderSlot.ts` for why the injection goes this
 * way round rather than through five pane components' props.
 */
export function Panel({
  title,
  headerExtra,
  children,
  className = '',
  contentClassName = '',
}: PanelProps) {
  const paneControls = usePaneHeaderSlot();

  return (
    <section
      className={`flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-cc-border bg-cc-panel ${className}`}
    >
      {/* py-3 (12px), not the previous py-2.5 (10px): Compass's spacing
          scale is 4px-based with no 10px step.

          Issue #185: `bg-cc-bg`, not `bg-cc-panel-raised`. In dark mode
          `--color-cc-panel-raised` resolves to `#1c273a`, which is bit-for-bit
          the CodeMirror background `panes/yaml/editorTheme.ts` recovered from
          production -- so this header and the YAML editor immediately below it
          measured 1.000:1, which is the surface the report is about. Chrome
          moves to the shell plane instead; every control in this row keeps
          `-panel-raised`, so a button now reads as raised *above* its header
          rather than flush with it (see `design/controlAffordance.ts`). */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cc-border bg-cc-bg px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-cc-text">
          {title}
        </h2>
        {headerExtra || paneControls ? (
          // `flex-wrap`, not a fixed single row: a pane with a lot of header
          // controls (DagPane's undo/redo/workflow-select/layout/add-job
          // buttons, in particular) wraps onto a second line instead of
          // overflowing the panel width, which is what would otherwise risk
          // horizontal scroll on a narrow viewport.
          //
          // The layout engine's controls come *last* in this row (issue #208):
          // rightmost is where they already were on the strip above, and it
          // keeps the pane's own controls in the order and position they have
          // always had. They also keep their resting border while the pane's own
          // controls stay quiet at rest (`design/controlAffordance.ts`), which
          // is what distinguishes "this belongs to the layout" from "this
          // belongs to the pane" now that they share one row.
          <div className="flex flex-wrap items-center justify-end gap-2">
            {headerExtra}
            {paneControls}
          </div>
        ) : null}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${contentClassName}`}>
        {children}
      </div>
    </section>
  );
}
