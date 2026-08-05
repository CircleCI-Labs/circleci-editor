/**
 * The top bar's "which CircleCI project is this?" indicator (issue #149).
 *
 * The owner's report was that a config gives no clue which project or
 * organization it belongs to, and the host already knew: `/api/meta` carries
 * the CLI-injected project slug and a deep link built from it, and
 * `/api/project-context` carries the project record CircleCI itself returned.
 *
 * ## Two sources, on purpose
 *
 * The slug comes from the environment and is available instantly, with no
 * token and no request. The organization's *display* name comes from CircleCI
 * and is available only if that lookup succeeded. Rendering the slug
 * immediately and enriching it afterwards is what stops this element being a
 * spinner in the top bar -- and it is also what makes the three states below
 * distinguishable at all.
 *
 * The two sources are not equal, though, and issue #182 is about which one wins.
 * `meta` carries what the *checkout claims*: a slug assembled from injected
 * environment variables, and a link built from the VCS type among them.
 * `project` carries what *CircleCI says*: the canonical slug
 * (`gh/example-org/flaky-todo-list`), the provider, and a link built from that
 * slug host-side. So the moment the record arrives, it replaces the claim
 * wholesale -- including replacing a link with *no link*, when the record's slug
 * turns out to be the ID-addressed `circleci/...` kind that has no
 * name-addressed page. Mixing the two would be how you produce a confident
 * link to a URL shape this project does not use.
 *
 * ## The three states, which must not look alike
 *
 * Issue #149 is explicit about this, and it is the whole reason this component
 * has any logic in it:
 *
 * - **Not a CircleCI project.** No source named one. Editing a config outside
 *   a connected checkout is a perfectly ordinary thing to do, so this says so
 *   plainly and reads as information, not as a fault.
 * - **Unknown to CircleCI.** There is a slug, and CircleCI answered that no
 *   project matches it (a 404 -- see issue #150, whose fix is what made this
 *   distinguishable). The identity is still shown, because it is still what
 *   this checkout says it is, but the badge says CircleCI does not recognise
 *   it. Not an error on our side and not a credential problem.
 * - **Unverified.** There is a slug and we could not ask, or asking failed:
 *   no token, a network failure, a timeout, a rate limit. The identity shown
 *   is the environment's own claim, unconfirmed.
 *
 * ## Issue #198: where the identity came from, and one state that had to split
 *
 * There are now two sources for the slug, not one -- `.circleci/info.yml`, which
 * `circleci project link` writes and which survives a repository rename, and the
 * CLI-injected environment, which does not. The host picks (the binding wins) and
 * reports which via `meta.projectSlugSource`, so this element says so in its
 * tooltip rather than presenting two rather different confidences identically. A
 * binding that *disagrees* with the environment is named on both sides: one of
 * them is stale, and which is which is the most useful thing to be able to say.
 *
 * The "not a CircleCI project" state above had to split, and this is the honest
 * part of the change rather than a cosmetic one. "Nothing names a project" and
 * "the file that names the project could not be read" are different situations
 * with different fixes, so the second gets its own text and its own badge. What
 * it must never do is render as the calm first one, which would be a silent
 * fallback dressed as success.
 *
 * Nothing here ever offers to create or repair `.circleci/info.yml`. It is a
 * committed file; suggesting `circleci project link` is the whole of what this
 * app is allowed to do about it.
 *
 * Deep-linking rather than rendering any run information holds this app's
 * scope exactly where it already is: author here, observe in the web UI.
 */
import { useEffect } from 'react';

import { Badge, type BadgeTone } from '~/design/components/Badge';
import { Tooltip } from '~/design/components/Tooltip';
import type { Meta, ProjectBindingInfo } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';
import {
  projectLookup,
  useProjectContextStore,
} from '~/state/projectContextStore';

/** Splits a `<vcs>/<org>/<repo>` slug, tolerating anything that isn't one. */
function splitProjectSlug(slug: string): { org: string; repo: string } | null {
  const parts = slug.split('/');
  if (parts.length < 3) return null;
  const repo = parts[parts.length - 1];
  const org = parts[parts.length - 2];
  if (!org || !repo) return null;
  return { org, repo };
}

interface IdentityStatus {
  label: string;
  tone: BadgeTone;
  explanation: string;
}

/**
 * One sentence saying where this project's identity came from (issue #198), or
 * `''` when there is nothing worth saying.
 *
 * Exported because it is the part of this component with a decision in it and it
 * is worth pinning on its own. The three cases it distinguishes are the ones that
 * matter to a reader trying to work out why the editor thinks this is the project:
 * a recorded binding, a recorded binding that *contradicts* the CLI, and a
 * CLI-derived slug with no binding behind it.
 */
export function slugProvenance(meta: Meta): string {
  const binding = meta.projectBinding;

  if (meta.projectSlugSource === 'binding') {
    if (binding?.disagreesWithEnvironment && binding.environmentSlug) {
      return `Recorded in ${binding.path ?? '.circleci/info.yml'} by \`circleci project link\`. The CircleCI CLI names ${binding.environmentSlug} for this directory instead — a recorded binding survives a repository rename and a git remote does not, so the binding wins, but the two disagreeing means one of them is out of date.`;
    }
    return `Recorded in ${binding?.path ?? '.circleci/info.yml'} by \`circleci project link\`, which is what this checkout itself says it is bound to.`;
  }

  if (meta.projectSlugSource === 'environment') {
    if (binding?.status === 'malformed') {
      return `From the CircleCI CLI's own view of this directory. This checkout does record a binding, in ${binding.path ?? '.circleci/info.yml'}, and this editor could not use it: ${binding.problem ?? ''}`;
    }
    return "From the CircleCI CLI's own view of this directory. This checkout records no CircleCI project binding of its own, so a repository renamed since it was cloned would still be named here by its old name.";
  }

  return '';
}

/**
 * What to say when `.circleci/info.yml` exists, could not be read, and nothing
 * else named a project either (issue #198).
 *
 * Its own function, and exported, because it is the wording that carries the
 * honest-degrade rule at this surface: it must name the file, name the problem in
 * the host's words, and say that nothing was changed -- and it must not read like
 * the calm "not a CircleCI project" sentence next door.
 */
export function unreadableBindingTooltip(binding: ProjectBindingInfo): string {
  const path = binding.path ?? '.circleci/info.yml';
  return (
    `${path} records which CircleCI project this checkout belongs to, and this editor could not use it. ` +
    `${binding.problem ?? ''} Nothing else named a project either. ` +
    'This file is written by `circleci project link`; this editor never changes it. ' +
    'Everything else in the editor works as normal.'
  );
}

export function ProjectIdentity() {
  const meta = useAppStore((state) => state.meta);
  const project = useProjectContextStore((state) => state.project);
  const state = useProjectContextStore((state) => state.state);
  const warnings = useProjectContextStore((state) => state.warnings);
  const reason = useProjectContextStore((state) => state.reason);
  const load = useProjectContextStore((state) => state.load);

  // Shares the palette's one load: `load` is a no-op while a request is in
  // flight or has already succeeded, so mounting this alongside the palette's
  // two sections still costs a single request between the three of them.
  useEffect(() => {
    void load();
  }, [load]);

  if (!meta) return null;

  const binding = meta.projectBinding;
  const slug = meta.projectSlug;
  if (!slug) {
    // Issue #198: two ways to have no project, and only one of them is calm.
    // A binding that exists and could not be read means the answer was *there*
    // and we could not use it, which is a thing to fix rather than a thing to
    // shrug at -- so it says so, in the host's own words, and wears a badge.
    if (binding?.status === 'malformed') {
      return (
        <span
          className="flex min-w-0 shrink items-center gap-1.5"
          data-testid="project-identity"
        >
          <Tooltip content={unreadableBindingTooltip(binding)}>
            <span tabIndex={0} className="shrink-0 text-2xs text-cc-text-faint">
              Project binding unreadable
            </span>
          </Tooltip>
        </span>
      );
    }
    return (
      <Tooltip content="This config isn’t in a repository connected to CircleCI, so there is no project or organization to show. Everything else in the editor works as normal.">
        <span
          tabIndex={0}
          className="shrink-0 text-2xs text-cc-text-faint"
          data-testid="project-identity"
        >
          Not a CircleCI project
        </span>
      </Tooltip>
    );
  }

  // CircleCI's own spelling of the slug once there is one, and otherwise the
  // (already CLI-normalised) slug the host looked up. Both are shown to the
  // user in tooltips, so they should read the way CircleCI writes them.
  const canonicalSlug = project?.slug || slug;
  const parts = splitProjectSlug(canonicalSlug);
  const orgName = project?.organizationName || parts?.org || canonicalSlug;
  const repoName = project?.name || parts?.repo || '';
  const label = repoName ? `${orgName}/${repoName}` : orgName;

  // A record present means CircleCI answered, so its URL -- or its deliberate
  // lack of one -- is the answer. No `??` chain onto `meta.projectWebUrl` here,
  // on purpose: see this file's header.
  const webUrl = project ? project.webUrl : meta.projectWebUrl;

  const lookup = projectLookup({ state, warnings, project, reason });

  let status: IdentityStatus | null = null;
  if (lookup.status === 'absent') {
    status = {
      label: 'Unknown to CircleCI',
      tone: 'warning',
      explanation:
        lookup.warning?.detail ??
        `CircleCI has no project matching ${canonicalSlug}. Most often that means this repository has not been set up on CircleCI yet.`,
    };
  } else if (lookup.status === 'unreachable') {
    status = {
      label: 'Unverified',
      tone: 'neutral',
      explanation:
        lookup.warning?.detail ??
        lookup.reason ??
        `This is the project the CircleCI CLI named for this checkout (${canonicalSlug}). CircleCI could not be reached to confirm it.`,
    };
  }

  // Appended to whichever tooltip is chosen below rather than woven into each of
  // them: where the identity came from is orthogonal to whether it is linkable
  // and to whether CircleCI confirmed it, and three copies of the same sentence
  // is three places for it to drift.
  const provenance = slugProvenance(meta);

  const destinationTooltip = !webUrl
    ? // No URL. When CircleCI answered, we can say why with confidence -- this
      // project is addressed by ID rather than by organization and repository
      // name, which is how GitLab and GitHub App projects work -- and
      // `vcsProvider` names the integration rather than listing possibilities.
      // Without a record we say only what is true: there is no page this slug
      // can address.
      `${canonicalSlug} — ${
        project
          ? `CircleCI addresses this ${project.vcsProvider || 'standalone'} project by ID rather than by organization and repository name`
          : 'the project this checkout claims to belong to. CircleCI has no page this slug can address'
      }, so there is nothing to open here.`
    : lookup.status === 'confirmed'
      ? // Issue #214 moved this link from the pipelines page to the project
        // *overview*, on the owner's own reasoning: *"from the overview page you
        // can browse anywhere you want."* The host builds the URL; see
        // `Environment.ProjectWebURLForSlug` for the route and for how it was
        // verified in a real browser.
        `${label} on CircleCI (${canonicalSlug}). Opens this project’s overview in the CircleCI web UI, from where its pipelines, insights and settings are one click away.`
      : `${canonicalSlug} — the project this checkout claims to belong to. Opens its overview in the CircleCI web UI.`;

  const identityTooltip = provenance
    ? `${destinationTooltip} ${provenance}`
    : destinationTooltip;

  const identity = webUrl ? (
    <a
      href={webUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="max-w-[11rem] truncate rounded text-xs text-cc-text-muted underline decoration-dotted underline-offset-2 outline-none hover:text-cc-accent focus-visible:text-cc-accent focus-visible:ring-1 focus-visible:ring-cc-accent"
    >
      {label}
    </a>
  ) : (
    // No URL: a project whose web pages are addressed by ID rather than by
    // organization and repository name (GitLab, GitHub App). Plain text beats a
    // link that 404s -- and after issue #182 this branch is also reached when
    // the *record* says so while the environment's VCS type would happily have
    // produced a name-addressed link.
    <span className="max-w-[11rem] truncate text-xs text-cc-text-muted">
      {label}
    </span>
  );

  return (
    <span
      className="flex min-w-0 shrink items-center gap-1.5"
      data-testid="project-identity"
    >
      <Tooltip content={identityTooltip}>{identity}</Tooltip>
      {status ? (
        <Tooltip content={status.explanation}>
          <span tabIndex={0} className="shrink-0">
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}
