/**
 * The Project pane's Project tab (issue #248; moved off the reference
 * pane's own tab strip onto this shared-slot surface by issue #306, see
 * `panes/docs/DocsPane.tsx`): the project record, its
 * settings, its environment variable *names*, and the outbound links the
 * owner asked for -- moved here from the palette's old Project section
 * (issue #105), which this tab replaces and whose section is deleted as
 * part of this change.
 *
 * ## Why it moved
 *
 * The owner's own framing, and it is the whole reason this tab exists rather
 * than a seventh palette section: *"The palette needs to be: is this
 * clickable and draggable, and does it allow me to edit the config? ...
 * Projects doesn't really fit there. It's helpful info, but doesn't belong
 * there."* Resource classes made the same move for the same reason in #153.
 * Everything here is read-only reference material -- exactly
 * what this pane is for -- and nothing here is draggable.
 *
 * **Contexts stay in the palette.** They *are* draggable (dropped onto a
 * workflow job's `context:` list), so by the owner's own rule they belong
 * where things you drag into a config live. Moving them would have broken
 * the contract this issue exists to restore. See
 * `panes/dag/palette/PaletteContextSection.tsx`, unchanged by this issue.
 *
 * **Values are never shown.** Not even the four-character preview a context
 * variable's own detail shows appears here -- CircleCI's project-variables endpoint
 * discloses only a mask for these, which the Go host drops at its own
 * boundary (`internal/circleci.ProjectVariable`) rather than forwarding
 * something that isn't a value at all. Names only, every time.
 *
 * ## Why the identity states get their own branches, not one "unavailable"
 *
 * Issues #149/#150 established that "not a CircleCI project", "unknown to
 * CircleCI" and "unverified" are different situations that must not render
 * identically -- flattening them into one grey message is the exact failure
 * those issues fixed at the top bar. This view reuses the same
 * `projectLookup` classification `layout/ProjectIdentity.tsx` already uses,
 * so the two surfaces agree by construction rather than by two hand-written
 * copies of the same judgement drifting apart. The absent/present/
 * malformed model for `.circleci/info.yml` gets the same treatment: a
 * binding that exists and could not be read is its own state, not a "not a
 * CircleCI project" in disguise.
 */
import { useEffect } from 'react';

import { Badge, type BadgeTone } from '~/design/components/Badge';
import { DocsLink } from '~/design/components/DocsLink';
import { Spinner } from '~/design/components/Spinner';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import { unreadableBindingTooltip } from '~/layout/ProjectIdentity';
import { ProjectContextWarnings } from '~/panes/dag/palette/ProjectContextWarnings';
import { useAppStore } from '~/state/appStore';
import {
  projectLookup,
  useProjectContextStore,
} from '~/state/projectContextStore';

/** One outbound link, or the honest absence of one -- never a link that would 404. */
function OutboundProjectLink({
  href,
  children,
}: {
  href?: string;
  children: React.ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-2xs text-cc-accent hover:underline"
    >
      {children} ↗
    </a>
  );
}

export function ProjectReferenceView() {
  const meta = useAppStore((s) => s.meta);
  const state = useProjectContextStore((s) => s.state);
  const reason = useProjectContextStore((s) => s.reason);
  const storeError = useProjectContextStore((s) => s.error);
  const project = useProjectContextStore((s) => s.project);
  const settings = useProjectContextStore((s) => s.settings);
  const projectVariables = useProjectContextStore((s) => s.projectVariables);
  const warnings = useProjectContextStore((s) => s.warnings);
  const load = useProjectContextStore((s) => s.load);

  // Shares the one load with the top bar and (until this issue) the palette
  // -- `load` is a no-op while a request is in flight or has already
  // succeeded, so mounting this alongside them still costs one request.
  useEffect(() => {
    void load();
  }, [load]);

  if (!meta || state === 'idle' || state === 'loading') {
    return (
      <div
        className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-cc-text-muted"
        data-testid="project-reference-view"
      >
        <Spinner size={14} label="Loading" />
        <span>Loading project information…</span>
      </div>
    );
  }

  const slug = meta.projectSlug;
  const binding = meta.projectBinding;

  // `unavailable`/`error` both mean nothing was fetched at all -- the store
  // clears `project`/`settings`/`projectVariables` on this path (see
  // `useProjectContextStore`'s `load`), so there is nothing degraded to
  // render underneath a warning card the way the `ready` branch below can.
  // Issue #198's split is preserved rather than collapsed: a binding file
  // that exists and could not be read is a local, fixable problem, not the
  // calm "this config isn't connected to CircleCI" state next door, and
  // "no token" is not "not a project" either -- both get their own sentence.
  if (state === 'unavailable' || state === 'error') {
    if (!slug && binding?.status === 'malformed') {
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="project-reference-view"
        >
          <p className="text-sm font-medium text-cc-text">
            Project binding unreadable
          </p>
          <p className="max-w-sm text-xs text-cc-text-muted">
            {unreadableBindingTooltip(binding)}
          </p>
        </div>
      );
    }
    if (!slug) {
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="project-reference-view"
        >
          <p className="text-sm font-medium text-cc-text">
            Not a CircleCI project
          </p>
          <p className="max-w-sm text-xs text-cc-text-muted">
            This config isn&apos;t in a repository connected to CircleCI, so
            there is no project record, settings or environment variables to
            show. Everything else in the editor works as normal.
          </p>
        </div>
      );
    }
    // A slug exists (from the environment or a binding) but the request
    // itself could not be answered or could not be made at all -- no token,
    // or a transport failure. Either way this project's identity is
    // unconfirmed, which is the same "Unverified" judgement the top bar makes
    // for the same underlying states (see `projectLookup`).
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="project-reference-view"
      >
        <span title={slug}>
          <Badge tone="neutral">Unverified</Badge>
        </span>
        <p className="max-w-sm text-xs text-cc-text-muted">
          {reason ?? storeError ?? 'This project could not be confirmed.'}
        </p>
      </div>
    );
  }

  const lookup = projectLookup({ state, warnings, project, reason });

  let identityBadge: {
    label: string;
    tone: BadgeTone;
    explanation: string;
  } | null = null;
  if (lookup.status === 'absent') {
    identityBadge = {
      label: 'Unknown to CircleCI',
      tone: 'warning',
      explanation:
        lookup.warning?.detail ??
        `CircleCI has no project matching ${project?.slug || slug}. Most often that means this repository has not been set up on CircleCI yet.`,
    };
  } else if (lookup.status === 'unreachable') {
    identityBadge = {
      label: 'Unverified',
      tone: 'neutral',
      explanation:
        lookup.warning?.detail ??
        lookup.reason ??
        storeError ??
        `This is the project the CircleCI CLI named for this checkout (${slug}). CircleCI could not be reached to confirm it.`,
    };
  }

  const canonicalSlug = project?.slug || slug;
  const displayName = project?.name || canonicalSlug;

  // Everything except the context list, which `PaletteContextSection`
  // reports on -- contexts didn't move, so a warning about them doesn't
  // belong beside data that also didn't move (issue #150's own rule: a
  // warning shown next to data it is not about reads as a broken feature).
  const projectWarnings = warnings.filter(
    (warning) => warning.kind !== 'contexts' && warning.kind !== 'organization',
  );
  const variablesUnlisted = warnings.some(
    (warning) => warning.kind === 'projectVariables',
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-3"
      data-testid="project-reference-view"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-cc-text">
            {displayName}
          </p>
          <p className="truncate font-mono text-2xs text-cc-text-muted">
            {canonicalSlug}
          </p>
        </div>
        {identityBadge ? (
          <Badge tone={identityBadge.tone}>{identityBadge.label}</Badge>
        ) : null}
      </div>

      {/* Visible text, not just a hover tooltip on the badge above: the
          explanation is exactly the sentence #149/#150 exist to make
          legible, and a hover-only affordance would make it invisible on a
          touch device and unread by anyone who doesn't hover a badge. */}
      {identityBadge ? (
        <p className="mb-3 text-2xs text-cc-text-muted">
          {identityBadge.explanation}
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-3">
        <OutboundProjectLink
          href={project ? project.webUrl : meta.projectWebUrl}
        >
          Open project
        </OutboundProjectLink>
        <OutboundProjectLink href={project?.settingsUrl}>
          Open settings
        </OutboundProjectLink>
        {project && !project.webUrl ? (
          <span className="text-2xs text-cc-text-faint">
            CircleCI addresses this {project.vcsProvider || 'standalone'}{' '}
            project by ID rather than by organization and repository name, so
            there is no page these links could open.
          </span>
        ) : null}
      </div>

      <ProjectContextWarnings
        warnings={projectWarnings}
        degraded={projectVariables.length > 0 || settings !== null}
      />

      {project || settings ? (
        <div className="mb-3 space-y-1">
          <p className="text-2xs font-medium text-cc-text">Project record</p>
          <ul className="space-y-1">
            {project?.organizationName ? (
              <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
                <span>Organization</span>
                <span className="text-cc-text">{project.organizationName}</span>
              </li>
            ) : null}
            {project?.vcsProvider ? (
              <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
                <span>VCS provider</span>
                <span className="text-cc-text">{project.vcsProvider}</span>
              </li>
            ) : null}
            <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
              <span>Default branch</span>
              <span className="font-mono text-cc-text">
                {project?.defaultBranch || 'unknown'}
              </span>
            </li>
            {settings ? (
              <>
                <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
                  <span>Dynamic config</span>
                  <Badge tone={settings.dynamicConfig ? 'success' : 'neutral'}>
                    {settings.dynamicConfig ? 'enabled' : 'disabled'}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
                  <span>Unversioned config</span>
                  <Badge
                    tone={settings.unversionedConfig ? 'success' : 'neutral'}
                  >
                    {settings.unversionedConfig ? 'accepted' : 'not accepted'}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2 text-2xs text-cc-text-muted">
                  <span>Fork PRs get secrets</span>
                  <Badge
                    tone={settings.passSecretsToForkPrs ? 'warning' : 'neutral'}
                  >
                    {settings.passSecretsToForkPrs ? 'yes' : 'no'}
                  </Badge>
                </li>
              </>
            ) : null}
          </ul>
          {settings && !settings.dynamicConfig ? (
            <p className="text-2xs text-cc-text-faint">
              A <span className="font-mono">setup: true</span> config only does
              anything once dynamic config is enabled for this project.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-2xs font-medium text-cc-text">
          <span>Environment variables</span>
          <DocsLink
            label={DOCS_LINKS.env.projectVariables.label}
            url={DOCS_LINKS.env.projectVariables.url}
          />
        </p>
        {projectVariables.length === 0 ? (
          variablesUnlisted ? null : (
            <p className="text-2xs text-cc-text-faint">
              This project has no environment variables of its own. Add them in
              the CircleCI web UI, then reference them as{' '}
              <span className="font-mono">$NAME</span> inside a run command.
            </p>
          )
        ) : (
          <>
            <ul className="space-y-1">
              {projectVariables.map((variable) => (
                <li
                  key={variable.name}
                  className="truncate rounded-md border border-cc-border-strong bg-cc-panel-raised px-2 py-1 font-mono text-2xs text-cc-text"
                  title={variable.name}
                >
                  {variable.name}
                </li>
              ))}
            </ul>
            <p className="text-2xs text-cc-text-faint">
              Names only — CircleCI does not return project variable values.
              These also complete as <span className="font-mono">$NAME</span>{' '}
              while you type a run command in the YAML editor.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
