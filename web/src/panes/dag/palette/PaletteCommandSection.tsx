/**
 * The palette's Commands section (issue #79: "surface the config's own
 * `commands:` and `parameters:` as palette objects alongside executors --
 * the archived editor had a section per definition type"). A config's own
 * reusable command is exactly as much a first-class object as a built-in
 * executor or an orb command -- the palette already treats both of *those*
 * as draggable/clickable cards, so a locally-defined command earns the
 * same treatment rather than being reachable only by hand-typing its name
 * into a step.
 *
 * Mirrors `PaletteStepSection`'s own shape (a card plus a `JobPicker`, the
 * keyboard/no-mouse-first path issue #71 established) rather than adding
 * drag-and-drop here too: a local command's only meaningful action is
 * "insert as a step in this job", identical to what a step-keyword card
 * already does, so reusing that exact interaction is the smaller surface,
 * not a shortcut.
 */
import type { Document } from 'yaml';

import { DocsLink } from '~/design/components/DocsLink';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { getIn, listKeys } from '~/lib/yaml/documentUtils';
import { JobPicker } from '~/panes/orbs/OrbBrowser';

import { PaletteCard } from './PaletteCard';

interface LocalCommandSummary {
  name: string;
  paramCount: number;
  stepCount: number;
}

/** Reads every top-level `commands:` entry's name plus a couple of at-a-glance counts -- not its full step/parameter bodies, which the inspector's own step editor is where those actually get edited. */
function readLocalCommands(doc: Document): LocalCommandSummary[] {
  return listKeys(doc, ['commands']).map((name) => {
    const params = getIn(doc, ['commands', name, 'parameters']);
    const steps = getIn(doc, ['commands', name, 'steps']);
    return {
      name,
      paramCount:
        params && typeof params === 'object' ? Object.keys(params).length : 0,
      stepCount: Array.isArray(steps) ? steps.length : 0,
    };
  });
}

export function PaletteCommandSection({
  doc,
  localJobNames,
  onAddToJob,
}: {
  doc: Document | null;
  localJobNames: string[];
  onAddToJob: (jobName: string, commandName: string) => void;
}) {
  const commands = doc ? readLocalCommands(doc) : [];

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-2xs text-cc-text-faint">
        This config&rsquo;s own{' '}
        <span className="font-mono normal-case">commands:</span>
        <DocsLink
          label={DOCS_LINKS.reusableConfig.commands.label}
          url={DOCS_LINKS.reusableConfig.commands.url}
        />
      </p>
      {commands.length === 0 ? (
        <p className="text-2xs text-cc-text-faint">
          No reusable commands defined yet. The Steps section above can turn a
          repeated run step sequence into one -- see the palette&rsquo;s
          suggestions when jobs repeat themselves.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {commands.map((command) => (
            <li
              key={command.name}
              className="overflow-hidden rounded-md border border-cc-border-strong"
            >
              <PaletteCard
                avatarSeed={command.name}
                title={command.name}
                badge={`${command.stepCount} step${command.stepCount === 1 ? '' : 's'}`}
                description={
                  command.paramCount > 0
                    ? `${command.paramCount} parameter${command.paramCount === 1 ? '' : 's'}`
                    : undefined
                }
                draggable={false}
              />
              <div className="border-t border-cc-border bg-cc-panel-raised px-2 py-1.5">
                <JobPicker
                  jobNames={localJobNames}
                  onAdd={(jobName) => onAddToJob(jobName, command.name)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
