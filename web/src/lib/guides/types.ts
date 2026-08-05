/**
 * The block model `GET /api/guides` returns (issue #104, widened by #176):
 * twenty of CircleCI's config-adjacent documentation pages plus two pages this
 * project wrote about this editor, parsed from AsciiDoc source by the Go host
 * into a small, closed vocabulary this app renders with its own components.
 *
 * A **mirror of `internal/guides/model.go`** — keep the two in step. The
 * contract is enforced from both ends: that package's tests assert the shape
 * it produces, and `guides.test.ts` here asserts this module's helpers against
 * a fixture in exactly that shape.
 *
 * Why a block model rather than HTML: the pane inherits this app's own
 * light/dark theme, type scale and focus rings instead of importing the docs
 * site's CSS, there is no third-party markup to sanitise, and anything the
 * parser doesn't recognise arrives as a `paragraph` of literal text rather
 * than as a hole.
 */

/** Every block shape the renderer knows how to draw. */
export type BlockKind =
  | 'paragraph'
  | 'code'
  | 'table'
  | 'admonition'
  | 'list'
  | 'heading'
  /** The *parser's own* voice, not the docs': "this part isn't in the offline snapshot, read it on circleci.com". */
  | 'note';

/** Every inline run the renderer knows how to draw. */
export type SpanKind =
  | 'text'
  | 'code'
  | 'strong'
  | 'em'
  /** An outbound link; leaves the app. */
  | 'link'
  /** A cross-reference *within this pane*: `target` is an anchor in the same guide. */
  | 'ref';

export interface Span {
  kind: SpanKind;
  text: string;
  /** Set for `link` only. */
  url?: string;
  /** Set for `ref` only: an anchor to resolve through `Guide.anchors`. */
  target?: string;
  /** Set for `strong`/`em`/`link`/`ref`, which nest. */
  children?: Span[];
}

export interface Cell {
  spans: Span[];
}

export interface GuideTable {
  /** Empty when the source table declared no header row. */
  header?: Cell[];
  rows: Cell[][];
}

export interface ListItem {
  blocks: Block[];
}

export interface Block {
  kind: BlockKind;
  /** A block caption (AsciiDoc's `.Some title`), e.g. on a code sample. */
  title?: string;
  /** Set for `paragraph`, `heading` and `note`. */
  spans?: Span[];
  /** Set for `code`: verbatim source, never span-parsed. */
  text?: string;
  /** Set for `code`: the source's *own* declared language, or absent. Never guessed. */
  language?: string;
  table?: GuideTable;
  /** Set for `admonition`: `NOTE` | `TIP` | `IMPORTANT` | `WARNING` | `CAUTION`. */
  admonition?: string;
  /** Set for `admonition`: its contents, so a warning containing a sample keeps the sample. */
  blocks?: Block[];
  items?: ListItem[];
  ordered?: boolean;
  /** Set for `heading`: the AsciiDoc level (4 or deeper). */
  level?: number;
  /** Set for `heading`: its anchor, resolvable through `Guide.anchors`. */
  id?: string;
}

export interface GuideSection {
  /** Unique within its guide, and how the pane addresses it. */
  id: string;
  /** 2 or 3. Level 3 is where the configuration reference documents each built-in step. */
  level: number;
  /** The heading with formatting stripped: what the nav shows and search matches. */
  title: string;
  titleSpans: Span[];
  /**
   * Canonical live-docs URL. Carries a `#fragment` only when the anchor came
   * from the source's own `[#id]` — see `anchorDerived`.
   */
  url: string;
  /**
   * True when `id` was derived from the title rather than read from the
   * source. Such an id must not be used as a live-page fragment: a wrong
   * fragment still returns 200 and scrolls nowhere (see `docsLinks.ts`).
   */
  anchorDerived?: boolean;
  /**
   * The config keys this section documents, taken from the monospace runs in
   * its own heading. This is the seam between the schema-derived key browser
   * and the prose: `findSectionForKey` uses it so nobody has to maintain a
   * key-to-anchor table by hand.
   */
  keys?: string[];
  blocks: Block[];
}

/**
 * Who wrote a guide.
 *
 * `circleci` is a page vendored from `circleci/circleci-docs`, used with
 * CircleCI's permission. `editor` is documentation *this project* wrote
 * about *this editor* (issue #176) — our words, our MIT licence, never fetched.
 *
 * The pane must render the difference visibly. Twenty of CircleCI's pages and
 * two of ours sit in one picker, and letting a reader mistake ours for official
 * documentation would be dishonest — the more so because our pages are
 * deliberately blunt about what CircleCI's APIs do not expose.
 */
export type GuideOrigin = 'circleci' | 'editor';

export interface Guide {
  /** This project's stable id: `configuration-reference`, `workflows`, `using-this-editor`, … */
  id: string;
  /** `circleci` for CircleCI's own documentation, `editor` for ours. See `GuideOrigin`. */
  origin: GuideOrigin;
  /**
   * The picker's grouping heading (`Workflows`, `Orbs`, `This editor`, …).
   * Twenty-two guides in a flat control is a wall, and the groups deliberately
   * name the *editor feature* that raises the question rather than CircleCI's
   * information architecture, which a reader of this pane has no reason to know.
   */
  category?: string;
  title: string;
  description?: string;
  url: string;
  sections: GuideSection[];
  /** Prose between the document title and the first heading. */
  lead?: Block[];
  /**
   * Every anchor defined anywhere in the page (section anchors *and* the
   * block-level ones upstream cross-references freely) mapped to the id of the
   * section containing it. A `ref` span whose target is absent here is
   * unresolvable — including because upstream's own cross-reference is broken
   * — and must render as plain text rather than as a control that does
   * nothing.
   */
  anchors?: Record<string, string>;
  /**
   * The lowercased basename of every image this page shows (including images
   * inside the partials it includes). Not rendered — the snapshot vendors
   * AsciiDoc, not binary assets. It exists so the host can turn a *citation* of
   * an image asset into a citation of the page that shows it, offline (issue
   * #156, `internal/guides/citations.go`); mirrored here because this type is a
   * mirror of the Go model, not a subset of it.
   */
  images?: string[];
}

/** Where the served guide text came from. */
export type GuideSource = 'vendored' | 'refreshed';

/**
 * Everything needed to say honestly where this text came from and how old it
 * is. All of it is surfaced in the pane: a reference a user can't date is a
 * reference they can't trust.
 */
export interface GuideProvenance {
  repo: string;
  /**
   * The branch `commit` was resolved from (always `"main"` today --
   * `circleci/circleci-docs` publishes no tags or releases to prefer instead,
   * issue #286). Optional so an older host that predates this field still
   * renders sensibly -- the pane must not assume a ref it was never told,
   * even though this codebase has in fact never resolved anything else.
   */
  ref?: string;
  commit: string;
  /** The upstream commit's own timestamp: how old the *text* is. ISO 8601. */
  committedAt: string;
  /** When this copy was obtained (the vendoring time, for the embedded snapshot). ISO 8601. */
  fetchedAt: string;
  source: GuideSource;
  /** An update check is in flight. The content is complete regardless — never render this as loading. */
  refreshing: boolean;
  /** The last update check failed. Never affects what is shown; only what the pane can say about staleness. */
  error?: string;
}

/** One guide's live-docs URL, always present so the pane can link out even with nothing parsed. */
export interface GuideLink {
  id: string;
  label: string;
  url: string;
}

/**
 * The JSON shape of `GET /api/guides`. `available: false` means the host could
 * not parse its own embedded snapshot — not "no token" and not "no network",
 * neither of which this endpoint needs. Callers must render `reason` and
 * `links` in that case, never a blank pane or a spinner.
 */
export interface GuidesResponse {
  available: boolean;
  reason?: string;
  guides?: Guide[];
  provenance: GuideProvenance;
  links: GuideLink[];
}
