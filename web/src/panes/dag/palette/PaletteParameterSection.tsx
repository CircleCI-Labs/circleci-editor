/**
 * The palette's Parameters section: this config's own top-level `parameters:`
 * -- pipeline parameters, referenced elsewhere in the config as
 * `<< pipeline.parameters.name >>`.
 *
 * # It used to be read-only, and that was the bug (issue #250)
 *
 * The owner's complaint was exact: *"people should be able to edit the
 * parameters and mess around with them. But right now... I'm not even able to
 * edit them -- I'm not able to say hey it's a Boolean, or has a default, or
 * anything like that."* The section listed each parameter's name and type as
 * two badges and told the user to go and edit the YAML by hand.
 *
 * The original doc comment defended that, and its argument was half right. It
 * said there is no single "drop this parameter onto a job" action that would
 * mean the same thing everywhere a pipeline parameter can appear, so inventing
 * one would be guessing at an interaction. That remains true, and this section
 * still offers no drag. What did not follow was the conclusion: "it cannot be a
 * drag source" is not a reason for the one section named after parameters to be
 * unable to change one. Declaring a parameter -- its name, its type, its
 * default, its description, its `enum:` values -- is a perfectly well-defined
 * edit with exactly one meaning, and it is now what this section does
 * (`ParametersEditor`).
 *
 * # Not a drag source, said out loud
 *
 * Issue #250's first half is that the section *looks* draggable because it sits
 * in a palette whose contract is "drag this into your config". Two things
 * address that here without touching pane layout (issue #248, the placement
 * question, is parked by the owner):
 *
 *  - the rows are form controls in a `<li>`, not `PaletteCard` buttons -- the
 *    thing that actually communicates "draggable" in this pane is the card, and
 *    there is none here (contrast `PaletteCommandSection`, which uses a card
 *    with `draggable={false}` and still advertises "Drag onto the graph" in its
 *    `title`);
 *  - the prose says it, once, in the section's own words, and says what to do
 *    instead: reference a parameter by *writing* it.
 *
 * # Job parameters are not here
 *
 * A job's own `parameters:` is a different namespace with a different reference
 * syntax and a different set of legal types, and it belongs to the job -- so it
 * is edited where a job is edited, in the inspector's "Declared parameters"
 * section, by this same `ParametersEditor` with a job scope. This section names
 * the jobs that have them so the split is discoverable rather than a dead end.
 */
import type { Document } from 'yaml';

import { ParametersEditor } from '~/design/components/ParametersEditor';
import { DocsLink } from '~/design/components/DocsLink';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { getJobNames, listKeys } from '~/lib/yaml/documentUtils';

/** Signature `DagPane` hands down -- `useAppStore`'s `mutate`. */
type MutateFn = (fn: (doc: Document) => void) => void;

/** Jobs declaring at least one parameter of their own, with how many. */
function jobsWithOwnParameters(
  doc: Document,
): { jobName: string; count: number }[] {
  return getJobNames(doc)
    .map((jobName) => ({
      jobName,
      count: listKeys(doc, ['jobs', jobName, 'parameters']).length,
    }))
    .filter((entry) => entry.count > 0);
}

export function PaletteParameterSection({
  doc,
  mutate,
}: {
  doc: Document | null;
  mutate: MutateFn;
}) {
  const jobScoped = doc ? jobsWithOwnParameters(doc) : [];

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-1.5 text-2xs text-cc-text-faint">
        This config&rsquo;s own pipeline{' '}
        <span className="font-mono normal-case">parameters:</span>
        <DocsLink
          label={DOCS_LINKS.guides.pipelineVariables.label}
          url={DOCS_LINKS.guides.pipelineVariables.url}
        />
      </p>
      <p className="text-2xs text-cc-text-faint">
        Editable here, but not draggable: a parameter is used by{' '}
        <em>writing</em>{' '}
        <span className="font-mono">{'<< pipeline.parameters.name >>'}</span>{' '}
        into a field, so there is no one place on the graph to drop it.
      </p>

      <ParametersEditor
        doc={doc}
        scope={{ kind: 'pipeline' }}
        mutate={mutate}
      />

      {jobScoped.length > 0 ? (
        <p className="text-2xs text-cc-text-faint">
          {`${jobScoped.map((entry) => `${entry.jobName} (${entry.count})`).join(', ')} also `}
          {jobScoped.length === 1 ? 'declares' : 'declare'} parameters of their
          own. Those are scoped to the job, so select it in the graph and use
          the inspector&rsquo;s Declared parameters section.
        </p>
      ) : null}
    </div>
  );
}
