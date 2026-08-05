/**
 * The palette's Executors section (issue #71) -- built-in kinds plus every
 * executor already defined in this document's own `executors:` block.
 * Orb-provided executors are reached through the Orbs section instead of
 * being pre-enumerated here (there is no "list every orb's executors"
 * without already knowing which orbs to ask -- see `Palette.tsx`'s module
 * doc for the fuller rationale); this section's own `PaletteExecutorPayload`
 * type only covers `builtin`/`local` for that reason.
 *
 * Every card is reachable by drag (`onDragStart`) or by click
 * (`onActivate`) -- both funnel into the exact same
 * `PaletteExecutorPayload`, so a keyboard-only user reaches the identical
 * "create job" flow a drag-and-drop onto the canvas would.
 */
import type { Document } from 'yaml';

import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { listExecutorNames } from '~/lib/graph/resolveExecutor';

import { PaletteCard } from './PaletteCard';
import {
  BUILTIN_EXECUTORS,
  setPaletteExecutorDragPayload,
  type PaletteExecutorPayload,
} from './paletteExecutors';

/**
 * `BuiltinExecutorDef.mutationKind` only distinguishes the three real
 * CircleCI executor types (`docker`/`machine`/`macos` -- see that module's
 * doc comment on why Windows/GPU are both `machine`), but issue #78 wants
 * Windows to link to its *own* docs page, not the generic Linux-VM one --
 * this maps by the card's own `id` instead, which is unique per card.
 */
const EXECUTOR_DOCS_BY_ID: Record<string, { label: string; url: string }> = {
  docker: DOCS_LINKS.executors.docker,
  machine: DOCS_LINKS.executors.machine,
  macos: DOCS_LINKS.executors.macos,
  windows: DOCS_LINKS.executors.windows,
  // GPU is a `machine` executor under the hood with no docs page of its
  // own -- the Linux VM page is the honest closest match, not a guess.
  gpu: DOCS_LINKS.executors.machine,
};

export function PaletteExecutorSection({
  doc,
  onActivate,
}: {
  doc: Document | null;
  onActivate: (payload: PaletteExecutorPayload) => void;
}) {
  const localExecutorNames = doc ? listExecutorNames(doc) : [];

  return (
    <div className="space-y-3">
      <div>
        <h5 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
          Built-in
        </h5>
        <ul className="space-y-1.5">
          {BUILTIN_EXECUTORS.map((def) => {
            const payload: PaletteExecutorPayload = {
              source: 'builtin',
              builtinId: def.id,
            };
            return (
              <li key={def.id}>
                <PaletteCard
                  avatarSeed={def.label}
                  title={def.label}
                  badge={def.mutationKind}
                  description={def.description}
                  onDragStart={(event) =>
                    setPaletteExecutorDragPayload(event.dataTransfer, payload)
                  }
                  onActivate={() => onActivate(payload)}
                  docsLink={EXECUTOR_DOCS_BY_ID[def.id]}
                />
              </li>
            );
          })}
        </ul>
      </div>

      {localExecutorNames.length > 0 ? (
        <div>
          <h5 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
            From this config&rsquo;s{' '}
            <span className="font-mono normal-case">executors:</span>
          </h5>
          <ul className="space-y-1.5">
            {localExecutorNames.map((name) => {
              const payload: PaletteExecutorPayload = {
                source: 'local',
                executorName: name,
              };
              return (
                <li key={name}>
                  <PaletteCard
                    avatarSeed={name}
                    title={name}
                    onDragStart={(event) =>
                      setPaletteExecutorDragPayload(event.dataTransfer, payload)
                    }
                    onActivate={() => onActivate(payload)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <p className="text-2xs text-cc-text-faint">
        Drag onto the canvas to create a job, or click a card. Orb-provided
        executors are in the Orbs section below.
      </p>
    </div>
  );
}
