/**
 * Turns the citations a reply carries into rows worth showing (issue #156: "for
 * the sources, where it lists the different sources, it'd be nice to display
 * that a little bit nicer... or make them a little bit more clickable").
 *
 * # Where a title comes from, in order
 *
 *  1. **This app's own curated table** (`~/lib/docs/docsLinks`'s
 *     `lookupDocLink`). A hand-written label for a URL this app already links
 *     to elsewhere, and — the reason it wins — a URL confirmed canonical and
 *     non-redirecting. A match replaces the URL as well as the label.
 *  2. **The title the host resolved from the vendored AsciiDoc**
 *     (`internal/guides/citations.go`). The real page or section title of a
 *     `circleci.com/docs` page, resolved offline from the snapshot the app
 *     already ships — *not* by fetching the URL. See that file's comment for
 *     why fetching model-chosen URLs is a surface this tool declines to open.
 *  3. **The URL's own last path segment, humanized.** `/docs/guides/
 *     execution-managed/persist-data/` reads as "Persist data": a guess about
 *     wording, never about *where the link goes*, and far more use than a
 *     truncated URL.
 *  4. **The hostname**, for a URL with no path to speak of.
 *
 * # What is dropped, and what is kept but not linked
 *
 * A source is **dropped** when it is not an `http:`/`https:` URL, or when it
 * points at an image, stylesheet, script or font. The host already applies
 * exactly this policy (and can additionally *remap* a cited image to the page
 * that shows it, which needs the vendored AsciiDoc). It is repeated here
 * deliberately: this module is the last thing between a URL and an `href`, the
 * transcript is assembled in the browser, and "an asset is never a source"
 * should not depend on which build of the host happens to be running.
 *
 * A source on a host outside the allowlist (`~/lib/markdown/safeUrl`, issue
 * #187) is **kept and marked `linkable: false`**. It is not dropped, because a
 * "Sources" list that quietly shrinks makes an answer look better-grounded than
 * it is — the same honesty principle as the ungrounded-reply notice. The row
 * still shows its destination as text; `SourcesList` renders no anchor for it,
 * and says how many were not linked.
 *
 * # Relevance, and the cap (issue #210)
 *
 * Safety and relevance are different questions, and until #210 only the first
 * had an answer here. `rankSources` is the second: it merges the citations this
 * app attached *with certainty* from the diagnostic itself
 * (`./deterministicSources`) with whatever retrieval returned, orders the
 * retrieved ones by whether they mention what the fix is actually about, caps the
 * list, and reports how many fell off the end.
 *
 * Two properties, easy to get wrong in opposite directions:
 *
 *  - **A source that is merely safe is not automatically worth showing.** Five
 *    rows of which one is on-topic reads as noise, which is #210's report almost
 *    verbatim.
 *  - **Nothing shrinks silently.** The cap reports its own casualties, exactly as
 *    an unlinkable row reports itself rather than vanishing (#187/#204). A list
 *    that quietly got shorter is the same dishonesty in a different coat.
 */
import { classifyUrl } from '~/lib/markdown/safeUrl';
import { lookupDocLink } from '~/lib/docs/docsLinks';
import type { AiChatSource } from '~/lib/rpc/client';

import {
  deterministicSourcesFor,
  topicTermsFor,
  type FixTopic,
} from './deterministicSources';

/** One rendered "Sources" row. */
export interface PresentedSource {
  /** The destination, validated as `http:`/`https:`. Only ever reaches an `href` when `linkable` is true. */
  url: string;
  /** What the row is called: a real title where one is known, a humanized path otherwise. */
  title: string;
  /** The host + path shown under the title, so the destination is always visible. */
  detail: string;
  /** True when `title` is a real title (curated or resolved from the docs snapshot) rather than derived from the URL. */
  titleResolved: boolean;
  /**
   * False when the host is not one this app will link to (#187). The row is
   * still rendered — as plain, unclickable text — because a citation that
   * exists but cannot be offered is information, not noise.
   */
  linkable: boolean;
  /** The parsed hostname behind a `linkable: false` row, so the UI can name it without re-parsing. */
  blockedHost?: string;
  /**
   * Where the row came from (#210). `'editor'` rows were attached by this app
   * from the diagnostic itself and are labelled as such in the UI: a reader is
   * entitled to know which references the *model* found and which ones this
   * editor put there, not least because the second kind are present even on a
   * reply that had no docs grounding at all.
   */
  origin: SourceOrigin;
}

export type SourceOrigin = 'retrieved' | 'editor';

/**
 * Extensions that are never a source. Mirrors `assetExtensions` in
 * `internal/guides/citations.go` — the two are the same policy at two layers,
 * and the frontend one is the backstop.
 */
const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'css',
  'js',
  'mjs',
  'cjs',
  'map',
  'woff',
  'woff2',
  'ttf',
  'eot',
]);

/**
 * Presents `sources` as rows: unsafe (non-http) and asset URLs dropped, hosts
 * outside the allowlist kept but not linkable, duplicates collapsed, each row
 * titled by the rules in this module's own comment. Order is preserved — the
 * provider's order reflects which source the answer leant on most, and
 * reordering it would quietly editorialise.
 */
export function presentSources(
  sources: readonly AiChatSource[] | undefined,
  origin: SourceOrigin = 'retrieved',
): PresentedSource[] {
  if (!sources || sources.length === 0) return [];

  const rows: PresentedSource[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    // One gate for scheme *and* host, shared with the Markdown renderer (#187).
    // A `scheme` rejection is dropped outright, exactly as before: a
    // `javascript:` "citation" is not a reference the user is missing out on.
    const verdict = classifyUrl(source.url ?? '');
    if (!verdict.allowed && verdict.reason === 'scheme') continue;

    const parsed = parseUrl(source.url);
    if (!parsed) continue;
    if (isAsset(parsed)) continue;

    const linkable = verdict.allowed;
    const blockedHost = verdict.allowed ? undefined : verdict.hostname;
    // The curated table only ever holds this app's own vetted docs URLs, so it
    // can neither rescue an untrusted host nor be consulted for one.
    const curated = linkable ? lookupDocLink(parsed.href) : undefined;
    const url = curated?.url ?? parsed.href;

    // Deduplicate on where the row actually points, after the curated table has
    // had its chance to canonicalize it -- two spellings of one page must not
    // produce two rows.
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);

    const resolved = curated?.label ?? source.title?.trim() ?? '';
    rows.push({
      url,
      title: resolved !== '' ? resolved : deriveTitle(parsed),
      detail: describeUrl(parsed),
      titleResolved: resolved !== '',
      linkable,
      origin,
      ...(blockedHost === undefined ? {} : { blockedHost }),
    });
  }

  return rows;
}

/**
 * How many rows the "Sources" footer ever shows.
 *
 * Four, from #210's own argument: *"Five sources of which one is on-topic reads
 * as noise."* It is a number about attention, not about correctness — three
 * deterministic rows plus the best retrieved one is a footer a person reads,
 * where nine rows is a footer a person skips. Whatever the cap removes is
 * counted and stated.
 */
export const MAX_SOURCES = 4;

export interface RankedSources {
  rows: PresentedSource[];
  /** How many rows the cap removed. Rendered as a line, never swallowed. */
  dropped: number;
}

/**
 * The "Sources" footer for one reply: what this app knows for certain about the
 * error being fixed, then what retrieval returned, ordered by whether it is
 * about the same thing, capped at `MAX_SOURCES`.
 *
 * The ordering rule, in full, because "why is this one first" must be answerable
 * from the code:
 *
 *  1. **Deterministic rows**, in `deterministicSourcesFor`'s own order
 *     (most-specific first). They are not similar to the error; they are *about*
 *     it.
 *  2. **Retrieved rows that mention the topic**, linkable ones first.
 *  3. **Every other retrieved row**, linkable ones first.
 *
 * Within each of those the provider's order is preserved for the reason it always
 * was: it reflects which source the answer leant on, and reshuffling it would
 * quietly editorialise. What is new is that group 3 sinks below group 2 — a
 * relevance judgement this app can defend, made from terms in the URL and the
 * title rather than from a similarity score it does not have.
 *
 * The linkable-first tiebreak earns its keep on the owner's own case. Their five
 * sources were led by Slack's **Block Kit builder**, which sits on a host this app
 * refuses to link (#187) — so without the tiebreak the one retrieved row the cap
 * kept would have been the least useful in the list, purely because the provider
 * ranked it first. This is not #204's "refused links are dropped" coming back: a
 * refused row is still shown whenever it makes the cap, it is never removed
 * *because* it was refused, and whatever the cap removes is counted and stated. It
 * is a preference between rows competing for one slot.
 *
 * A reply with no topic (an ordinary question, not a seeded fix) ranks nothing
 * and attaches nothing: every row is retrieved, in the order it arrived, capped.
 * That is deliberate — #210 asks for relevance where relevance is *known*, and
 * inventing it elsewhere is the failure mode, not the fix.
 */
export function rankSources(
  retrieved: readonly AiChatSource[] | undefined,
  topic?: FixTopic,
): RankedSources {
  const deterministic = presentSources(
    deterministicSourcesFor(topic),
    'editor',
  );
  const claimed = new Set(deterministic.map((row) => dedupeKey(row.url)));
  // A retrieved citation that happens to be one we already attached is not a
  // second row: the deterministic one wins, because it carries the better title
  // and the honest origin.
  const rest = presentSources(retrieved).filter(
    (row) => !claimed.has(dedupeKey(row.url)),
  );

  const terms = topicTermsFor(topic);
  const onTopic = rest.filter((row) => matchesTopic(row, terms));
  const offTopic = rest.filter((row) => !matchesTopic(row, terms));

  const ordered = [
    ...deterministic,
    ...linkableFirst(onTopic),
    ...linkableFirst(offTopic),
  ];
  return {
    rows: ordered.slice(0, MAX_SOURCES),
    dropped: Math.max(0, ordered.length - MAX_SOURCES),
  };
}

/**
 * Within one relevance tier, a row this app will link to outranks one it has
 * refused to link (#187) -- see `rankSources`'s own comment for why this is a
 * preference between rows competing for a slot and not #204's "refused links are
 * dropped" coming back. Two stable filters rather than a comparator, so the
 * provider's order survives inside each half.
 */
function linkableFirst(rows: PresentedSource[]): PresentedSource[] {
  return [
    ...rows.filter((row) => row.linkable),
    ...rows.filter((row) => !row.linkable),
  ];
}

/**
 * Does this row mention what the fix is about? Matched against the URL's path
 * and the row's title, lowercased, as plain substrings.
 *
 * Substrings rather than word boundaries on purpose: `orb` has to match
 * `/docs/orbs/use/orb-intro/` and `Orb concepts` alike, and `dependenc` has to
 * match both spellings of the word. The cost is that a term can match inside an
 * unrelated word, and the consequence of that is a source being ordered one place
 * too high -- which is a great deal cheaper than the ordering being unexplainable.
 */
function matchesTopic(row: PresentedSource, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const haystack = `${row.detail} ${row.title}`.toLowerCase();
  return terms.some((term) => term !== '' && haystack.includes(term));
}

/**
 * Parses `raw` for its *parts* (path segments, fragment) once `classifyUrl` has
 * already ruled on whether it is safe. Deliberately does no policy of its own —
 * there is exactly one gate, and this isn't it.
 */
function parseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw.trim());
  } catch {
    return undefined;
  }
}

function isAsset(url: URL): boolean {
  const basename = url.pathname.split('/').pop() ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return false;
  return ASSET_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

function dedupeKey(raw: string): string {
  try {
    const url = new URL(raw);
    // Query dropped (only tracking ever adds one), fragment kept: two sections
    // of one page are two sources. Same rule as `lookupDocLink`'s matching and
    // as the host's own `citationKey`.
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.hash}`;
  } catch {
    return raw;
  }
}

/**
 * A readable label from the URL's own last path segment: `.../persist-data/`
 * becomes "Persist data". Falls back to the hostname when there is no path
 * worth reading (a bare domain), so a row is never blank.
 */
function deriveTitle(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined || last === 'docs') return url.host;
  const words = decodeSegment(last)
    .replace(/\.(html?|adoc|md)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (words === '') return url.host;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed percent-escape is not worth failing a row over.
    return segment;
  }
}

/** Host + path + fragment, with the query dropped: enough to see where a row goes. */
function describeUrl(url: URL): string {
  return `${url.host}${url.pathname}${url.hash}`;
}
