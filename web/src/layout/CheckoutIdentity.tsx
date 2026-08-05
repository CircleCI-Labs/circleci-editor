/**
 * The top bar's "which checkout is this, and where does it live?" indicator
 * (issue #214).
 *
 * The owner, alongside the project identity #149 put here:
 *
 * > *"Might be good to also pull in the branch that we're currently on... if you
 * > can pull the git info in terms of a link to their GitHub or VCS, and also
 * > just the branch that they're currently on. You can put it up at the top
 * > where we have example-org."*
 *
 * Two cells, both narrow, both derived from `GET /api/meta` and so present
 * before (and regardless of whether) any CircleCI call succeeds:
 *
 * - **the branch**, and
 * - **a link to the repository** on its VCS host.
 *
 * ## Which branch, when two sources disagree
 *
 * `CIRCLE_BRANCH` and the working tree's own `HEAD` can say different things,
 * and the host prefers the checkout: the user is editing *this* tree, so a
 * stale injected value would be worse than none. This component's job is to
 * make that visible rather than silent -- when the two differ, the tooltip
 * names both and says which one is on screen. See `Meta.branchSource`.
 *
 * ## Why the repository link is deliberately modest
 *
 * It is labelled by the *host* ("GitHub", "Bitbucket", a self-hosted
 * hostname), not by the repository name -- for two reasons. It is shorter,
 * which matters in a bar whose furniture budget is measured (#175). And
 * it avoids the trap #198 documented: a git remote can be stale after a
 * repository rename, so a remote-derived *name* must not be shown next to (or
 * worse, instead of) the name CircleCI's own project record gives. The name is
 * in the tooltip, described as where this checkout pushes; `ProjectIdentity`
 * remains the only thing in this bar that claims to say what the project is
 * called.
 *
 * A remote whose host has no web layout this app is willing to assume renders
 * as plain text rather than as a link that cannot work -- the same rule
 * `ProjectIdentity` already applies to CircleCI's own URLs.
 *
 * ## Why it links to the repository and not to the branch
 *
 * `<repo>/tree/<branch>` is the more satisfying destination, and it was
 * rejected on a case that is not rare at all: a branch created locally and not
 * yet pushed. It exists in the working tree -- the source this component
 * deliberately prefers -- and not on the remote, so that URL 404s. A link that
 * cannot work is worse than no link, so the destination is the
 * repository, which always exists, and the tooltip says which branch you are on
 * separately from where the link goes.
 *
 * ## Why this demotes by tier
 *
 * The two cells cost a measured 81px, and the app bar's ladder is driven by
 * measured furniture (#175). At the tersest tier that 81px was enough to
 * collapse the file switcher for an *ordinary two-file* `.circleci` directory at
 * 1024px -- caught by `e2e/responsive-layout.spec.ts`, which exists to assert
 * that a collapse is a response to real crowding and not to a width. So this is
 * a bounded item like the app name and the config path, and it gives ground the
 * same way: at `tight` the two cells become one 38px link, labelled with the
 * branch and still pointing at the repository.
 *
 * Nothing becomes unreachable, which is the ladder's own rule. The repository is
 * a link at every tier, and both the `aria-label` and the tooltip name the
 * destination in full however short the visible label gets.
 */
import { Tooltip } from '~/design/components/Tooltip';
import { useAppStore } from '~/state/appStore';

/**
 * The short brand name for a git host, or the hostname itself when it is not
 * one of the three whose name is worth spelling.
 *
 * Substring matching on a lower-cased host, which is the rule the host side
 * already uses for the same question (`CanonicalVCSSegment`,
 * `isWebBrowsableGitHost`): a self-hosted instance is spelled
 * "github.example.com" and is still GitHub. A host this doesn't recognise is
 * shown as itself, which is honest and still short.
 */
export function gitHostLabel(host: string): string {
  const h = host.toLowerCase();
  if (h.includes('github')) return 'GitHub';
  if (h.includes('bitbucket')) return 'Bitbucket';
  if (h.includes('gitlab')) return 'GitLab';
  return host;
}

/** What the branch cell's tooltip says, which is the whole of this component's
 * answer to "two sources that can disagree". */
export function branchTooltip(
  branch: string,
  source: 'checkout' | 'environment' | undefined,
  envBranch: string | undefined,
): string {
  if (source === 'checkout') {
    if (envBranch && envBranch !== branch) {
      return `Branch ${branch}, read from this working tree’s own HEAD. CIRCLE_BRANCH says ${envBranch}; the checkout wins, because the tree is what you are editing.`;
    }
    return `Branch ${branch}, checked out in this working tree.`;
  }
  return `Branch ${branch}, from the CIRCLE_BRANCH the CircleCI CLI injected. This directory is not a git checkout a branch could be read from, so this is the environment’s claim rather than the tree’s.`;
}

function repoTooltip(
  repoName: string,
  repoHost: string | undefined,
  linked: boolean,
): string {
  const where = `${repoName}${repoHost ? ` on ${repoHost}` : ''} — the repository this checkout’s origin remote points at`;
  return linked
    ? `${where}. Opens it in a new tab. This is where the checkout pushes, which is not necessarily what CircleCI calls the project.`
    : `${where}. There is no web page this app is willing to assume for that host, so there is nothing to open here.`;
}

const linkClassName =
  'shrink-0 rounded text-2xs text-cc-text-muted underline decoration-dotted underline-offset-2 outline-none hover:text-cc-accent focus-visible:text-cc-accent focus-visible:ring-1 focus-visible:ring-cc-accent';
const textClassName =
  'max-w-[9rem] shrink truncate rounded text-2xs text-cc-text-muted outline-none focus-visible:ring-1 focus-visible:ring-cc-accent';

export function CheckoutIdentity({ tight }: { tight: boolean }) {
  const meta = useAppStore((state) => state.meta);
  if (!meta) return null;

  const { branch, branchSource, envBranch, repoWebUrl, repoName, repoHost } =
    meta;
  // Nothing to say: the ordinary state for a config edited outside a checkout,
  // and it costs the app bar's furniture budget nothing.
  if (!branch && !repoName) return null;

  const branchHint = branch
    ? branchTooltip(branch, branchSource, envBranch)
    : '';

  // The `tight` form: one link, labelled with the branch, still pointing at the
  // repository. Only used when there is both a branch and a link to fold it
  // into -- otherwise the fullest form below already renders exactly one cell.
  if (tight && branch && repoWebUrl && repoName) {
    return (
      <span
        className="flex min-w-0 shrink items-center"
        data-testid="checkout-identity"
      >
        <Tooltip
          content={`${branchHint} ${repoTooltip(repoName, repoHost, true)}`}
        >
          <a
            href={repoWebUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={`max-w-[9rem] truncate font-mono ${linkClassName}`}
            data-testid="checkout-branch-link"
            aria-label={`Branch ${branch}. Opens ${repoName}${repoHost ? ` on ${repoHost}` : ''} in a new tab.`}
          >
            {branch}
          </a>
        </Tooltip>
      </span>
    );
  }

  const hostLabel = repoHost ? gitHostLabel(repoHost) : '';

  return (
    <span
      className="flex min-w-0 shrink items-center gap-1.5"
      data-testid="checkout-identity"
    >
      {branch ? (
        <Tooltip content={branchHint}>
          <span
            tabIndex={0}
            // `max-w` plus `truncate`: a long-lived feature branch name is
            // easily 60 characters, and this cell must give ground rather than
            // push the file switcher into its menu form.
            className={`font-mono ${textClassName}`}
            data-testid="checkout-branch"
          >
            {branch}
          </span>
        </Tooltip>
      ) : null}
      {repoName ? (
        <Tooltip content={repoTooltip(repoName, repoHost, Boolean(repoWebUrl))}>
          {repoWebUrl ? (
            <a
              href={repoWebUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={linkClassName}
              data-testid="checkout-repo-link"
              aria-label={`Opens ${repoName}${repoHost ? ` on ${repoHost}` : ''} in a new tab.`}
            >
              {hostLabel || repoName}
            </a>
          ) : (
            <span
              tabIndex={0}
              className={textClassName}
              data-testid="checkout-repo-text"
            >
              {hostLabel || repoName}
            </span>
          )}
        </Tooltip>
      ) : null}
    </span>
  );
}
