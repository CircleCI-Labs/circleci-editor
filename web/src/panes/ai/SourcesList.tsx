/**
 * The "Sources" footer under a reply (issues #103, #156, #187, #204, #210).
 *
 * Rendered independent of the reply's own prose, so a citation is never
 * contingent on the model having remembered to write a Markdown link into its
 * answer.
 *
 * # How a row reads (#156)
 *
 * A **title over its destination** rather than one truncated URL:
 * `presentSources` resolves the title (curated label, then the page/section title
 * the host read out of the vendored docs AsciiDoc, then a humanized path — never
 * by fetching anything), drops assets, and collapses duplicates. See
 * `~/lib/ai/sources`.
 *
 * The whole row is the click target — a block-level `<a>` with real padding, not a
 * few characters of text — which is the owner's "make them a little bit more
 * clickable". Being a plain anchor, it is keyboard-reachable and shows a focus
 * ring for free; `rel="noopener noreferrer"` because the destination came
 * (ultimately) from model output and is not a page this app vouches for.
 *
 * Deliberately not `DocsLink`: that component is for URLs from this app's own
 * curated table, and it is worth keeping the component that renders *untrusted*
 * URLs visibly separate from the one that renders vetted ones.
 *
 * # Which of them may be a link at all (#187/#204)
 *
 * A "Sources" list is an implicit endorsement — the app saying *these are the
 * references* — and the URLs in it were chosen by a model reading third-party
 * documentation. So a row whose host is outside the allowlist
 * (`~/lib/markdown/safeUrl`) renders as **plain, unclickable text**, with its
 * destination still shown and a line saying how many were not linked. Not
 * dropped: a Sources list that quietly shrinks makes an answer look
 * better-grounded than it is, which is the same dishonesty the ungrounded-reply
 * notice exists to prevent.
 *
 * # Which of them is worth showing (#210)
 *
 * Two additions, both from the owner's report that the sources for an
 * unresolvable orb reference were led by Slack's Block Kit builder:
 *
 *  - Rows this app attached itself, from the diagnostic rather than from
 *    retrieval, are **labelled** `editor`. They are the most useful rows in the
 *    list and also the ones a reader must not mistake for evidence that the model
 *    was grounded — see `~/lib/ai/deterministicSources`.
 *  - The list is **capped**, and says when the cap removed something. Ordering and
 *    the cap both live in `rankSources`; this component renders the verdict and
 *    does no policy of its own.
 */
import type { PresentedSource, RankedSources } from '~/lib/ai/sources';
import { TRUSTED_HOSTS_SUMMARY } from '~/lib/markdown/safeUrl';

export function SourcesList({ sources }: { sources: RankedSources }) {
  const { rows, dropped } = sources;
  if (rows.length === 0) return null;
  const blocked = rows.filter((source) => !source.linkable);
  const attached = rows.filter((source) => source.origin === 'editor');
  return (
    <div
      className="min-w-0 max-w-full rounded-md border border-cc-border bg-cc-panel px-2 py-1.5"
      data-testid="ai-sources"
    >
      <p className="px-1 text-2xs font-medium uppercase tracking-wide text-cc-text-faint">
        Sources
      </p>
      <ul className="mt-0.5 flex flex-col">
        {rows.map((source) => (
          <SourceRow key={source.url} source={source} />
        ))}
      </ul>
      {attached.length > 0 ? (
        <p
          className="px-1 pb-0.5 pt-1 text-2xs text-cc-text-faint"
          data-testid="ai-sources-editor-note"
        >
          {attached.length === 1 ? 'One source is' : `${attached.length} are`}{' '}
          marked <span className="uppercase tracking-wide">editor</span>: this
          editor attached {attached.length === 1 ? 'it' : 'them'} from the error
          itself, rather than the model having cited{' '}
          {attached.length === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {blocked.length > 0 ? (
        <p className="px-1 pb-0.5 pt-1 text-2xs text-cc-text-faint">
          {blocked.length === 1
            ? '1 source is'
            : `${blocked.length} sources are`}{' '}
          shown without a link. {TRUSTED_HOSTS_SUMMARY}
        </p>
      ) : null}
      {dropped > 0 ? (
        // Said out loud for the same reason a refused link is shown rather than
        // dropped (#204): a list that got shorter without saying so is a list a
        // reader has no way to reason about.
        <p
          className="px-1 pb-0.5 pt-1 text-2xs text-cc-text-faint"
          data-testid="ai-sources-dropped"
        >
          {dropped} further source{dropped === 1 ? '' : 's'} the reply returned
          {dropped === 1 ? ' was' : ' were'} less relevant to this fix and{' '}
          {dropped === 1 ? 'is' : 'are'} not shown.
        </p>
      ) : null}
    </div>
  );
}

function SourceRow({ source }: { source: PresentedSource }) {
  const originTag =
    source.origin === 'editor' ? (
      <span className="shrink-0 text-2xs uppercase tracking-wide text-cc-text-faint">
        editor
      </span>
    ) : null;

  if (!source.linkable) {
    // No anchor, no `href`, no hover affordance: it must not look clickable,
    // because this app is declining to send the user there. Still selectable
    // text, so the destination can be copied by anyone who decides for
    // themselves that they want it.
    return (
      <li className="min-w-0 px-1 py-1" data-testid="ai-source-unlinked">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-xs text-cc-text-muted">
            {source.title}
          </span>
          <span className="shrink-0 text-2xs uppercase tracking-wide text-cc-text-faint">
            not linked
          </span>
        </span>
        <span className="block truncate text-2xs text-cc-text-faint">
          {source.detail}
        </span>
      </li>
    );
  }

  return (
    <li className="min-w-0">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={
          source.origin === 'editor'
            ? 'ai-source-editor'
            : 'ai-source-retrieved'
        }
        className="flex min-w-0 flex-col gap-0.5 rounded px-1 py-1 outline-none hover:bg-cc-panel-raised focus-visible:ring-1 focus-visible:ring-cc-accent"
      >
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-xs text-cc-text">{source.title}</span>
          {originTag}
          {/* A north-east arrow, the same external-link glyph `DocsLink` uses --
              this app has no icon-asset convention. */}
          <span
            aria-hidden="true"
            className="shrink-0 text-2xs text-cc-text-faint"
          >
            &#8599;
          </span>
        </span>
        <span className="truncate text-2xs text-cc-text-faint">
          {source.detail}
        </span>
      </a>
    </li>
  );
}
