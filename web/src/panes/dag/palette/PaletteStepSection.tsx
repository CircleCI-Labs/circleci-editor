/**
 * The palette's Steps section (issue #71): every step keyword from
 * `paletteSteps.ts`'s catalogue, draggable onto a job node on the canvas or
 * into the inspector's steps list, plus a `JobPicker` (the same control
 * `OrbBrowser`'s own command/executor rows already use) so a keyboard-only
 * user -- or one who hasn't selected a job at all -- has an equally direct
 * path: pick a job, click Add.
 *
 * ## Docs link (issue #19)
 *
 * Every one of these cards used to carry no way to learn what its step
 * actually does -- the Executors section right above it has had a `docsLink`
 * on each card since issue #78, and the inspector's own `StepFieldsSection`
 * has linked a step's reference since the same issue, but this section fell
 * through the gap between the two: nobody had wired `stepDocsUrl` in here.
 * That is backwards from where the question is actually asked -- a reader
 * browsing the palette is deciding *whether* to drop `save_cache` onto a
 * job, before there is a step in the document for the inspector to attach
 * anything to at all. `stepDocsUrl` already exists and is already the
 * mechanical, schema-key-derived mapping `StepFieldsSection` uses (see that
 * table's own doc comment); reusing it here is wiring, not a new table.
 * `PaletteCard`'s `docsLink` prop already degrades to "no link" for a
 * keyword it returns `undefined` for -- moot for this catalogue specifically
 * (`PALETTE_STEPS` only ever lists built-in keywords `stepDocsUrl` knows),
 * but the honest-degradation behaviour is inherited for free either way.
 */
import { stepDocsUrl } from '~/lib/docs/docsLinks';
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
        {PALETTE_STEPS.map((step) => {
          const docsUrl = stepDocsUrl(step.key);
          return (
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
                docsLink={
                  docsUrl
                    ? { label: `"${step.key}" step reference`, url: docsUrl }
                    : undefined
                }
              />
              <div className="border-t border-cc-border bg-cc-panel-raised px-2 py-1.5">
                <JobPicker
                  jobNames={localJobNames}
                  onAdd={(jobName) => onAddToJob(jobName, step.key)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-2xs text-cc-text-faint">
        Drag onto a job (on the canvas or in the steps list below), or pick a
        job and click Add.
      </p>
    </div>
  );
}
