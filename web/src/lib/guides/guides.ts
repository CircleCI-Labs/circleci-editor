/**
 * Helpers over the guide block model (`./types`): flattening spans to text,
 * searching, and — the interesting one — reconciling the prose guides with the
 * schema-derived key browser.
 *
 * The reconciliation is the point of issue #104. The app already had a
 * reference generated from the vendored config JSON Schema, which gives
 * per-key precision (exact keys, types, enums, required-ness) and cannot drift
 * from what this editor validates against. The guides give prose and worked
 * examples the schema does not encode. Neither replaces the other, and
 * shipping two competing references would be worse than either, so they
 * compose: **the schema stays the index, and the guides supply the
 * explanation** for whichever key you selected. `findSectionForKey` is that
 * join.
 *
 * The join is discovered, not hand-maintained: the configuration reference
 * writes every key it documents as a monospace run in that key's own heading
 * (`== *`+ backtick + `version` + backtick + `*`), which the Go parser records
 * as `GuideSection.keys`. A hand-written key-to-anchor table would be one more
 * thing to rot; this one updates itself the next time the snapshot refreshes.
 */
import type { Block, Guide, GuideSection, Span } from './types';

/** The configuration reference's stable id — the guide the key browser joins against. */
export const CONFIGURATION_REFERENCE_ID = 'configuration-reference';

/** Flattens spans to their text, for search and for a plain-text summary. */
export function spansToText(spans: readonly Span[] | undefined): string {
  if (!spans) return '';
  return spans
    .map((span) =>
      span.children && span.children.length > 0
        ? spansToText(span.children)
        : span.text,
    )
    .join('');
}

/** Flattens blocks to their text, recursing into admonitions, lists and tables. */
export function blocksToText(blocks: readonly Block[] | undefined): string {
  if (!blocks) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.spans) parts.push(spansToText(block.spans));
    if (block.text) parts.push(block.text);
    if (block.blocks) parts.push(blocksToText(block.blocks));
    if (block.items) {
      for (const item of block.items) parts.push(blocksToText(item.blocks));
    }
    if (block.table) {
      for (const cell of block.table.header ?? []) {
        parts.push(spansToText(cell.spans));
      }
      for (const row of block.table.rows) {
        for (const cell of row) parts.push(spansToText(cell.spans));
      }
    }
  }
  return parts.join(' ');
}

/**
 * The first paragraph of a section, as plain text — the one-line summary shown
 * inline in the key browser before a reader commits to opening the full
 * section. Skips a leading admonition (a version-support note is almost never
 * the sentence that explains what a key *is*) but will fall back to one if
 * that is genuinely all the section has.
 */
export function sectionSummary(section: GuideSection): string {
  const paragraph = section.blocks.find((block) => block.kind === 'paragraph');
  if (paragraph) return spansToText(paragraph.spans).trim();
  const admonition = section.blocks.find(
    (block) => block.kind === 'admonition',
  );
  if (admonition) return blocksToText(admonition.blocks).trim();
  return '';
}

/**
 * Finds the section documenting `key`, or `undefined` when the guide documents
 * no such key.
 *
 * Ranking, in order, and each rule earns its place against a real collision in
 * the vendored snapshot:
 *
 *  1. **A section whose whole title *is* the key.** `docker` appears both in
 *     the overview heading "Executor `docker` / `machine` / `macos`" (3 blocks)
 *     and in its own "`docker`" section (33 blocks). The dedicated section is
 *     the one a reader wants.
 *  2. **Document order.** `version` and `jobs` are each documented twice — once
 *     at the top level and once inside `workflows`. The top-level one comes
 *     first in the page and is the one a project-config author means by default.
 *  3. **Any section merely mentioning the key in its heading.** The fallback,
 *     so a key that only ever appears in a shared heading still finds prose.
 */
export function findSectionForKey(
  guide: Guide | undefined,
  key: string,
): GuideSection | undefined {
  if (!guide) return undefined;
  const wanted = key.trim();
  if (wanted === '') return undefined;

  let fallback: GuideSection | undefined;
  for (const section of guide.sections) {
    if (!section.keys?.includes(wanted)) continue;
    if (section.title === wanted) return section;
    fallback ??= section;
  }
  return fallback;
}

/**
 * Every key any section of `guide` documents. The key browser uses this to
 * answer a question the schema alone cannot: *is this key part of the
 * documented project-config surface at all?*
 *
 * That is the fix for the owner's report that `display` "doesn't even have a
 * description". `display`, `examples` and `experimental` are real schema keys
 * with no schema description — and the official configuration reference does
 * not document them either, because they are orb-authoring metadata. Their
 * absence *from this set* is the evidence, so the pane can label them honestly
 * without this project maintaining a denylist that would silently rot the day
 * CircleCI documents one of them.
 */
export function documentedKeys(guide: Guide | undefined): Set<string> {
  const out = new Set<string>();
  if (!guide) return out;
  for (const section of guide.sections) {
    for (const key of section.keys ?? []) out.add(key);
  }
  return out;
}

/** One search hit: the guide and section that matched, and why. */
export interface GuideSearchResult {
  guideId: string;
  guideTitle: string;
  section: GuideSection;
  /** True when the query matched the section's own title rather than its body. */
  titleMatch: boolean;
}

/**
 * Lowercased body text per section, memoised.
 *
 * Search runs on every keystroke across every guide, and flattening a section's
 * blocks to a string is the expensive part. With three guides that cost was
 * invisible; at twenty-two it is ~370 sections and roughly half a megabyte of
 * prose per keystroke, re-derived from an object graph that never changes.
 *
 * A `WeakMap` keyed on the section object is the right cache here precisely
 * because a refresh replaces the whole guide array rather than mutating it (see
 * `internal/guides.Cache.publish`): new sections are new objects, so they miss
 * the cache and the old entries become collectable. There is no invalidation to
 * get wrong, and no staleness possible.
 */
const sectionTextCache = new WeakMap<GuideSection, string>();

function sectionText(section: GuideSection): string {
  const cached = sectionTextCache.get(section);
  if (cached !== undefined) return cached;
  const text = blocksToText(section.blocks).toLowerCase();
  sectionTextCache.set(section, text);
  return text;
}

/**
 * Case-insensitive search across every guide's section titles and bodies,
 * title matches first (a reader typing "save_cache" wants that section, not
 * every section that mentions caching). `limit` bounds the result list because
 * a two-letter query legitimately matches most of a 3,900-line reference — and
 * bounds it harder now that there are twenty-two guides rather than three: an
 * unbounded list is the "wall of results" issue #176 asked to avoid, and the
 * results list must stay scannable rather than merely scrollable.
 */
export function searchGuides(
  guides: readonly Guide[],
  query: string,
  limit = 40,
): GuideSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const titleHits: GuideSearchResult[] = [];
  const bodyHits: GuideSearchResult[] = [];

  for (const guide of guides) {
    for (const section of guide.sections) {
      const hit = {
        guideId: guide.id,
        guideTitle: guide.title,
        section,
        titleMatch: false,
      };
      if (section.title.toLowerCase().includes(needle)) {
        titleHits.push({ ...hit, titleMatch: true });
        continue;
      }
      // Title hits alone can already fill the budget, in which case no body
      // text needs flattening at all. Worth the branch: "docker" matches 30-odd
      // headings across the executor pages before any prose is read.
      if (titleHits.length >= limit) continue;
      if (sectionText(section).includes(needle)) {
        bodyHits.push(hit);
      }
    }
  }
  return [...titleHits, ...bodyHits].slice(0, limit);
}

/** One group in the guide picker: a category heading and the guides under it. */
export interface GuideCategory {
  title: string;
  guides: Guide[];
}

/**
 * Groups guides by `category`, preserving the host's order within and between
 * groups.
 *
 * This exists because the picker had to change shape. With three guides it was a
 * row of buttons; at twenty-two that row wraps into a block taller than the
 * content it introduces — the "guide list becomes a wall" failure issue #176
 * names. The replacement is one grouped `<select>`: constant height whatever the
 * page count, natively keyboard- and screen-reader-operable, and — the
 * constraint from issue #88 — **not a new scrolling region**, which a
 * scrollable button rail would have been.
 *
 * Order is not sorted here. `internal/guides.Sources` already puts the
 * configuration reference first and this project's own pages last, on purpose,
 * and re-sorting alphabetically in the view would silently undo that.
 */
export function groupGuidesByCategory(
  guides: readonly Guide[],
): GuideCategory[] {
  const out: GuideCategory[] = [];
  for (const guide of guides) {
    // Fall back to the guide's own title rather than dropping it or inventing an
    // "Other" bucket: an uncategorised guide is a host-side omission, and it
    // must still be reachable in the picker.
    const title = guide.category ?? guide.title;
    const last = out.at(-1);
    if (last && last.title === title) {
      last.guides.push(guide);
      continue;
    }
    out.push({ title, guides: [guide] });
  }
  return out;
}

/**
 * Resolves a `ref` span's target to the id of the section to navigate to, or
 * `undefined` when it cannot be resolved — in which case the caller must
 * render the label as plain text rather than as a control that does nothing.
 * Upstream ships three such broken cross-references today, which is exactly
 * why this returns `undefined` instead of guessing.
 */
export function resolveRef(
  guide: Guide | undefined,
  target: string | undefined,
): string | undefined {
  if (!guide || !target) return undefined;
  return guide.anchors?.[target] ?? undefined;
}

/** Looks a guide up by its stable id. */
export function findGuide(
  guides: readonly Guide[],
  id: string,
): Guide | undefined {
  return guides.find((guide) => guide.id === id);
}
