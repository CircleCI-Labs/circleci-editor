/**
 * The palette's Steps section (issue #71): every step keyword from
 * `paletteSteps.ts`'s catalogue, draggable onto a job node on the canvas or
 * into the inspector's steps list, plus a `JobPicker` (the same control
 * `OrbBrowser`'s own command/executor rows already use) so a keyboard-only
 * user -- or one who hasn't selected a job at all -- has an equally direct
 * path: pick a job, click Add.
 */
import { JobPicker } from '~/panes/orbs/OrbBrowser';

import { PaletteCard } from './PaletteCard';
import { PALETTE_STEPS, setPaletteStepDragPayload } from './paletteSteps';

export function PaletteStepSection({
  localJobNames,
  onAddToJob,
}: {
  localJobNames: string[];
  onAddToJob: (jobName: string, stepKey: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <ul className="space-y-1.5">
        {PALETTE_STEPS.map((step) => (
          <li
            key={step.key}
            className="overflow-hidden rounded-md border border-cc-border-strong"
          >
            <PaletteCard
              avatarSeed={step.label}
              title={step.label}
              badge={step.key}
              description={step.description}
              draggable
              onDragStart={(event) =>
                setPaletteStepDragPayload(event.dataTransfer, step.key)
              }
            />
            <div className="border-t border-cc-border bg-cc-panel-raised px-2 py-1.5">
              <JobPicker
                jobNames={localJobNames}
                onAdd={(jobName) => onAddToJob(jobName, step.key)}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-cc-text-faint">
        Drag onto a job (on the canvas or in the steps list below), or pick a
        job and click Add.
      </p>
    </div>
  );
}
