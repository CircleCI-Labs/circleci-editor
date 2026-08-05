/**
 * The confirmation that stands between a button press and somebody's money
 * (issue #194).
 *
 * ## What it must say, and why each part is load-bearing
 *
 * Triggering a build is an outward-facing act: it spends credits, it appears in
 * the whole organization's CircleCI dashboard, and it runs with the same
 * environment variables, contexts and OIDC claims a real VCS-triggered build on
 * that branch would get. So this dialog names all four of the things that
 * decide what actually happens:
 *
 *  1. **The project** — CircleCI's own canonical slug, from the host, not one
 *     assembled in the browser.
 *  2. **The branch** — and where that came from (the checkout's HEAD or
 *     `CIRCLE_BRANCH`), because those can differ and only one of them is what
 *     the user is looking at.
 *  3. **Which config** — the editor's buffer or what is on disk. This is the
 *     question the issue calls out specifically, and the honest answer needs the
 *     diff: when there are unsaved changes, "the version in this editor" is a
 *     different document from the file, and the user is entitled to see exactly
 *     how before paying for it.
 *  4. **The contexts it will ask for** — with the four-state usability
 *     model from issue #105, reused rather than re-modelled.
 *     `other-projects-only` is the case this earns its keep on: the config
 *     compiles, the pipeline starts, and the job dies when CircleCI declines
 *     the context. Knowing that beforehand is
 *     worth a great deal more here than it is in the palette.
 *
 * ## The default branch gets a harder gate
 *
 * On the project's default branch, confirming means typing the branch name.
 * That is not decoration: an unversioned config can run on a protected branch
 * without going through a code review, which is the security implication
 * CircleCI's own documentation leads with, and `main` is where an accidental
 * deploy job does the most damage. The type-to-confirm shape is borrowed
 * directly from CircleCI's VS Code extension, which gates the same action the
 * same way.
 *
 * When the default branch is *unknown*, the dialog says so rather than quietly
 * choosing the weaker gate — the same rule as everywhere else here: absence of
 * evidence is never rendered as evidence of absence.
 *
 * ## There is no "don't ask again"
 *
 * `confirmStore` exists and this dialog is deliberately not in it. Its own rule
 * is that suppressing a prompt never changes the edit; suppressing *this* prompt
 * would change what a click costs. The same rule governs `rerun_workflow`:
 * a rejected YAML edit costs nothing, and a run spends money.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { DiffView } from '~/design/components/DiffView';
import { Spinner } from '~/design/components/Spinner';
import { referencedContexts } from '~/lib/contexts/referencedContexts';
import {
  restrictionCertainty,
  RESTRICTION_PRESENTATION,
  type RestrictionCertainty,
} from '~/lib/contexts/usability';
import { unifiedDiff } from '~/lib/yaml/diff';
import { useAppStore } from '~/state/appStore';
import {
  contextListCoverage,
  useProjectContextStore,
} from '~/state/projectContextStore';
import { runTargetsDefaultBranch, useRunStore } from '~/state/runStore';

interface RunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file name, for the diff header. */
  filename: string;
}

/**
 * What this editor can say about one context the config references.
 *
 * `certainty` reuses the shared restriction model when it is known -- which
 * since issue #251 distinguishes "restricted in a way we cannot evaluate" from
 * "we could not check" and from "we do not know which project we are", three
 * things this dialog used to render with one sentence naming a cause that was
 * often not the real one. The other three kinds are not a competing model --
 * they are the cases where the question was never asked, or cannot be asked, and
 * each has a different honest answer:
 *
 *  - `known`       -- the context was opened in the palette, so its restriction
 *                     state was actually fetched. Renders the shared badge.
 *  - `unchecked`   -- the organization has a context with this name, but its
 *                     restrictions were never fetched (they are fetched per
 *                     context, on demand). We know it exists; we do not
 *                     know if this project may use it.
 *  - `missing`     -- the full context list was retrieved and nothing in it has
 *                     this name. The job will fail. Only ever claimed when the
 *                     list is known to be complete.
 *  - `unknowable`  -- there is no complete context list to check against (no
 *                     token, a partial fetch, an unknown project). Says so.
 */
type ContextCheck =
  | {
      name: string;
      kind: 'known';
      certainty: RestrictionCertainty;
    }
  | { name: string; kind: 'unchecked' | 'missing' | 'unknowable' };

export function RunDialog({ open, onOpenChange, filename }: RunDialogProps) {
  const text = useAppStore((state) => state.text);
  const savedText = useAppStore((state) => state.savedText);
  const isDirty = useAppStore((state) => state.isDirty);
  const doc = useAppStore((state) => state.doc);

  const availability = useRunStore((store) => store.availability);
  const state = useRunStore((store) => store.state);
  const trigger = useRunStore((store) => store.trigger);

  const contexts = useProjectContextStore((store) => store.contexts);
  const details = useProjectContextStore((store) => store.details);
  const coverage = useProjectContextStore((store) =>
    contextListCoverage({ state: store.state, warnings: store.warnings }),
  );

  const [typed, setTyped] = useState('');

  // Cleared on every open, so a name typed for a previous branch can never
  // satisfy the gate for this one.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const branch = availability?.branch ?? '';
  const projectSlug = availability?.projectSlug ?? '';
  const onDefaultBranch = runTargetsDefaultBranch(availability);
  const defaultBranchKnown = Boolean(availability?.defaultBranch);
  const triggering = state === 'triggering';

  const diffLines = useMemo(
    () => (isDirty ? unifiedDiff(savedText, text, filename) : []),
    [isDirty, savedText, text, filename],
  );

  const checks = useMemo<ContextCheck[]>(() => {
    const byName = new Map(contexts.map((context) => [context.name, context]));
    return referencedContexts(doc).map((name): ContextCheck => {
      const context = byName.get(name);
      if (!context) {
        // Only a complete list licenses "this does not exist".
        return {
          name,
          kind: coverage === 'complete' ? 'missing' : 'unknowable',
        };
      }
      const detail = details[context.id];
      if (!detail) return { name, kind: 'unchecked' };
      return { name, kind: 'known', certainty: restrictionCertainty(detail) };
    });
  }, [contexts, details, coverage, doc]);

  const canConfirm =
    !triggering &&
    branch !== '' &&
    availability?.status === 'available' &&
    (!onDefaultBranch || typed === branch);

  const handleConfirm = () => {
    void trigger(text, branch).then(() => onOpenChange(false));
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-black/60" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 flex max-h-[80vh] w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-cc-border-strong bg-cc-panel shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-cc-border px-4 py-3">
            <RadixDialog.Title className="text-sm font-semibold text-cc-text">
              Run this config on CircleCI without committing it
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close dialog">
                Close
              </Button>
            </RadixDialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {/* What will happen, in the plainest terms available, before
                anything else on screen. */}
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
              data-testid="run-target"
            >
              <dt className="text-cc-text-faint">Project</dt>
              <dd className="font-mono text-cc-text">
                {projectSlug || 'unknown'}
              </dd>

              <dt className="text-cc-text-faint">Branch</dt>
              <dd className="font-mono text-cc-text">
                {branch || 'unknown'}
                {availability?.branchSource ? (
                  <span className="ml-2 font-sans text-2xs text-cc-text-faint">
                    {availability.branchSource === 'checkout'
                      ? '(this checkout’s current branch)'
                      : '(from CIRCLE_BRANCH)'}
                  </span>
                ) : null}
              </dd>

              <dt className="text-cc-text-faint">Config</dt>
              <dd className="text-cc-text" data-testid="run-config-source">
                {isDirty ? (
                  <>
                    <strong>the version in this editor</strong>, including your
                    unsaved changes — not the file on disk
                  </>
                ) : (
                  <>
                    the version in this editor, which matches{' '}
                    <span className="font-mono">{filename}</span> on disk
                  </>
                )}
              </dd>
            </dl>

            <p className="mt-3 text-2xs leading-relaxed text-cc-text-muted">
              CircleCI will check out{' '}
              <span className="font-mono">{branch}</span> and run the config
              above <em>instead of</em> the one committed there. The run{' '}
              <strong>costs credits</strong> and appears in your
              organization&apos;s CircleCI dashboard like any other pipeline —
              it is not marked as a test. It is attributable: CircleCI&apos;s
              audit log records that a pipeline was run with an uncommitted
              config, and who ran it.
            </p>

            {/* CircleCI's own security team's words about this capability, not
                a paraphrase and not softened. It is the honest cost of the
                feature and the user is entitled to it before paying. */}
            <p
              className="mt-2 text-2xs leading-relaxed text-cc-warning"
              data-testid="run-security-note"
            >
              This run gets the same environment variables, contexts and OIDC
              tokens a normal build on{' '}
              <span className="font-mono">{branch}</span> would. CircleCI&apos;s
              security team&apos;s assessment of the setting that permits this
              is that it{' '}
              <strong>
                does an end-run around context restrictions and OIDC claims
              </strong>{' '}
              — an uncommitted config can run on a protected branch without
              passing through code review.
            </p>

            {/* The one mitigation, named. Documented in CircleCI's contexts
                guide as an expression restriction; the point of surfacing it
                here is that, as the feature's own team put it, "you need to know
                to use it". */}
            <p className="mt-2 text-2xs leading-relaxed text-cc-text-muted">
              A context can be restricted against exactly this, with an{' '}
              <em>expression</em> restriction on{' '}
              <span className="font-mono">pipeline.config_source</span>: for
              instance{' '}
              <span className="font-mono">
                not (pipeline.config_source starts-with &quot;api&quot;)
              </span>{' '}
              refuses the context to any pipeline whose config came from the API
              rather than from the repository.
            </p>

            {availability?.dynamicConfig ? (
              <p
                className="mt-2 text-2xs leading-relaxed text-cc-warning"
                data-testid="run-dynamic-config-warning"
              >
                This project uses dynamic configuration. CircleCI&apos;s
                documentation says unversioned config is disabled for such
                projects, but this editor could not confirm that is still
                enforced — so the run is offered and may be refused.
              </p>
            ) : null}

            {availability?.identityDisagrees ? (
              <p
                className="mt-2 text-2xs leading-relaxed text-cc-warning"
                data-testid="run-identity-disagreement"
              >
                This checkout&apos;s{' '}
                <span className="font-mono">.circleci/info.yml</span> and the
                environment the CircleCI CLI passed in name{' '}
                <strong>different projects</strong>. The run will go to{' '}
                <span className="font-mono">{projectSlug}</span>, from{' '}
                <span className="font-mono">info.yml</span> — the same project
                the rest of this editor is showing. The environment said{' '}
                <span className="font-mono">
                  {availability.environmentSlug}
                </span>
                . Check which one you meant before spending credits.
              </p>
            ) : null}

            {!defaultBranchKnown ? (
              <p
                className="mt-2 text-2xs leading-relaxed text-cc-warning"
                data-testid="run-default-branch-unknown"
              >
                This editor could not determine which branch is this
                project&apos;s default, so it cannot tell you whether{' '}
                <span className="font-mono">{branch}</span> is a protected
                branch. Check before confirming.
              </p>
            ) : null}

            {checks.length > 0 ? (
              <div className="mt-3" data-testid="run-contexts">
                <h3 className="text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
                  Contexts this config asks for
                </h3>
                <ul className="mt-1 space-y-1">
                  {checks.map((check) => (
                    <li key={check.name} className="text-2xs">
                      <span className="font-mono text-cc-text">
                        {check.name}
                      </span>{' '}
                      {check.kind === 'known' ? (
                        <>
                          <Badge
                            tone={
                              RESTRICTION_PRESENTATION[check.certainty].tone
                            }
                          >
                            {RESTRICTION_PRESENTATION[check.certainty].label}
                          </Badge>
                          <span className="ml-1 text-cc-text-muted">
                            {RESTRICTION_PRESENTATION[check.certainty].note}
                          </span>
                        </>
                      ) : check.kind === 'missing' ? (
                        <>
                          <Badge tone="danger">Not found</Badge>
                          <span className="ml-1 text-cc-text-muted">
                            No context with this name exists in this
                            organization, so any job requesting it will fail.
                          </span>
                        </>
                      ) : check.kind === 'unchecked' ? (
                        <>
                          <Badge tone="neutral">Not checked</Badge>
                          <span className="ml-1 text-cc-text-muted">
                            This context exists. Whether this project may use it
                            was not checked — open it in the Contexts palette to
                            find out.
                          </span>
                        </>
                      ) : (
                        <>
                          <Badge tone="warning">Unknown</Badge>
                          <span className="ml-1 text-cc-text-muted">
                            This editor has no complete list of this
                            organization&apos;s contexts, so it cannot say
                            whether this one exists or can be used here.
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {isDirty ? (
              <div className="mt-3" data-testid="run-diff">
                <h3 className="text-2xs font-semibold uppercase tracking-wide text-cc-text-faint">
                  Unsaved changes that will be included
                </h3>
                <div className="mt-1 overflow-auto rounded border border-cc-border">
                  <DiffView lines={diffLines} />
                </div>
              </div>
            ) : null}

            {onDefaultBranch ? (
              <div className="mt-3" data-testid="run-default-branch-gate">
                <label
                  className="text-2xs leading-relaxed text-cc-warning"
                  htmlFor="run-confirm-branch"
                >
                  <span className="font-mono">{branch}</span> is this
                  project&apos;s <strong>default branch</strong>. An uncommitted
                  config can run there without going through code review. Type
                  the branch name to confirm.
                </label>
                <input
                  id="run-confirm-branch"
                  className="mt-1 w-full rounded border border-cc-border-interactive bg-cc-bg px-2 py-1 font-mono text-xs text-cc-text"
                  value={typed}
                  placeholder={branch}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
            <RadixDialog.Close asChild>
              <Button variant="secondary" size="sm" disabled={triggering}>
                Cancel
              </Button>
            </RadixDialog.Close>
            {/* Named after what it does, never "OK". `danger`, not `primary`:
                this is the one button in the app that spends money. */}
            <Button
              variant="danger"
              size="sm"
              disabled={!canConfirm}
              onClick={handleConfirm}
            >
              {triggering ? (
                <>
                  <Spinner /> Starting run…
                </>
              ) : (
                `Run on ${branch || 'CircleCI'}`
              )}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
