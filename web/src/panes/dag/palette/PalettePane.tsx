/**
 * Issue #88: the top-level layout pane the object palette lives in, instead
 * of the fixed 320px column `DagPane` used to render inline next to its own
 * resizable inspector -- together the narrowest useful region on screen
 * became the workflow graph itself, in the one preset whose whole purpose
 * is the graph.
 *
 * This component is only ever a portal *target*: a plain `<div>` registered
 * with `usePalettePortalTarget` on mount. `DagPane` still owns every bit of
 * the palette's actual behaviour -- drag payloads, `useOrbInsertion`/
 * `usePaletteInsertion`, `ConfigureJobDialog`/`ParamsDialog` -- and portals
 * the real `<Palette>` into the div rendered here. See
 * `palettePortalTarget.ts`'s own doc comment for why a portal, rather than
 * lifting all of that state up to a shared ancestor.
 *
 * No internal heading of its own, unlike `Palette.tsx`'s content in its
 * pre-#88 fallback rendering: `Panel`'s own title bar already says
 * "Palette" here, and every other top-level pane (`DocsPane`, in
 * particular) relies on that same title rather than duplicating it.
 */
import { useEffect, useRef } from 'react';

import { Panel } from '~/design/components/Panel';

import { usePalettePortalTarget } from './palettePortalTarget';

export function PalettePane() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setTarget = usePalettePortalTarget((state) => state.setTarget);

  useEffect(() => {
    setTarget(containerRef.current);
    return () => setTarget(null);
  }, [setTarget]);

  return (
    <Panel title="Palette" contentClassName="p-0">
      <div ref={containerRef} className="h-full w-full" />
    </Panel>
  );
}
