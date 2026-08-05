/**
 * Reshapes `CircleciSchema` (`~/lib/schema/circleciSchema`) -- already
 * extracted from the vendored, Apache-2.0 config JSON Schema for YAML
 * autocompletion and the inspector's step-field editors -- into the
 * category list `DocsPane` renders as a browsable reference (issue #83).
 *
 * Deliberately a thin reshape, not a second extraction: every fact here
 * already went through `parseCircleciSchema`'s hand-verified paths into the
 * schema (see that module's doc comment for why it doesn't attempt a
 * generic JSON Schema walk), so this file's only job is grouping those same
 * facts under display headings. Nothing here reads `raw` schema JSON
 * directly.
 */
import type {
  CircleciSchema,
  StepFieldSchema,
} from '~/lib/schema/circleciSchema';

/** One browsable fact: a key, enum value, or step name, with the schema's
 * own description and (for a step) its field schema. */
export interface DocsEntry {
  /** Unique across the whole reference, not just within its section --
   * `"<sectionId>:<label>"`, since e.g. `resource_class` appears as both a
   * job key and (separately) an executor key label. */
  id: string;
  label: string;
  info?: string;
  /** Only set for entries in the "Steps" section. */
  fields?: StepFieldSchema[];
  /**
   * The config key or step keyword this entry *is*, when it is one -- set for
   * every section whose entries are keys or step names, and deliberately unset
   * for the two enum-value sections (`small` is a value of `resource_class`,
   * not a key of its own). It is what `DocsPane` looks up in the prose
   * configuration reference to show a key's explanation next to its schema
   * shape (issue #104); an entry with no `docKey` simply gets no prose, rather
   * than a wrong match.
   */
  docKey?: string;
  /**
   * True for a top-level key that has **no schema description and no section
   * in CircleCI's own configuration reference** -- today `display`, `examples`
   * and `experimental`, which are orb-authoring metadata rather than anything
   * a project config contains.
   *
   * This is the fix for the report that opened issue #104 ("there's some
   * things that just don't make sense in the reference... like `display`. I
   * don't ever see that key; it doesn't even have a description"). The cause
   * was that the pane dumped schema keys with no notion of audience. The
   * classification is *derived* -- from the absence of prose upstream, not
   * from a hand-written list here -- so it corrects itself the day CircleCI
   * documents one of them, instead of quietly rotting.
   */
  orbAuthoringOnly?: boolean;
}

export interface DocsSection {
  id: string;
  title: string;
  entries: DocsEntry[];
}

function toEntries(
  sectionId: string,
  items: readonly { label: string; info?: string }[],
  fieldsByLabel?: Record<string, StepFieldSchema[]>,
): DocsEntry[] {
  return items.map((item) => ({
    id: `${sectionId}:${item.label}`,
    label: item.label,
    info: item.info,
    fields: fieldsByLabel?.[item.label],
    docKey: item.label,
  }));
}

/** Like `toEntries`, but for a section whose labels are enum *values* rather
 * than keys, so nothing is looked up in the prose reference for them. */
function toValueEntries(
  sectionId: string,
  items: readonly { label: string; info?: string }[],
): DocsEntry[] {
  return items.map((item) => ({
    id: `${sectionId}:${item.label}`,
    label: item.label,
    info: item.info,
  }));
}

/**
 * Splits the schema's top-level keys into the ones a project config author
 * writes and the ones that are orb-authoring metadata.
 *
 * A key lands in the second group only when *both* sources have nothing to say
 * about it: the schema carries no description, and CircleCI's own
 * configuration reference has no section documenting it. Either source alone
 * would misclassify -- the schema has no description for `job-groups` either,
 * yet the reference documents it fully.
 *
 * With no `documentedKeys` (the guides unavailable, e.g. the host could not
 * parse its snapshot), nothing is reclassified and the pane behaves exactly as
 * it did before issue #104: better to under-label than to call a real key
 * orb-only on the strength of missing evidence.
 */
function partitionTopLevelKeys(
  entries: readonly DocsEntry[],
  documentedKeys: ReadonlySet<string> | undefined,
): { projectKeys: DocsEntry[]; orbAuthoringKeys: DocsEntry[] } {
  if (!documentedKeys || documentedKeys.size === 0) {
    return { projectKeys: [...entries], orbAuthoringKeys: [] };
  }
  const projectKeys: DocsEntry[] = [];
  const orbAuthoringKeys: DocsEntry[] = [];
  for (const entry of entries) {
    const hasSchemaProse = (entry.info ?? '').trim() !== '';
    const hasGuideProse = documentedKeys.has(entry.label);
    if (hasSchemaProse || hasGuideProse) {
      projectKeys.push(entry);
    } else {
      orbAuthoringKeys.push({ ...entry, orbAuthoringOnly: true });
    }
  }
  return { projectKeys, orbAuthoringKeys };
}

/**
 * Builds the reference's section list from a parsed schema. Order is
 * deliberate -- broadest/most-consulted first (top-level keys, then job
 * keys and steps, since "what goes in a job" is this reference's single
 * most likely lookup), narrowest last (the two enums). A section with zero
 * entries is omitted rather than rendered empty, since `CircleciSchema`
 * already degrades to empty arrays (never throws) when a future schema
 * release restructures a branch `parseCircleciSchema` reads -- an empty
 * section here would otherwise read as "this app claims workflows have no
 * keys," which is actively misleading rather than merely sparse.
 */
export function buildDocsSections(
  schema: CircleciSchema,
  documentedKeys?: ReadonlySet<string>,
): DocsSection[] {
  const { projectKeys, orbAuthoringKeys } = partitionTopLevelKeys(
    toEntries('top-level', schema.topLevelKeys),
    documentedKeys,
  );

  const sections: DocsSection[] = [
    {
      id: 'top-level',
      title: 'Top-level keys',
      entries: projectKeys,
    },
    { id: 'job', title: 'Job keys', entries: toEntries('job', schema.jobKeys) },
    {
      id: 'step',
      title: 'Steps',
      entries: toEntries('step', schema.stepNames, schema.stepFieldSchemas),
    },
    {
      id: 'workflow',
      title: 'Workflow keys',
      entries: toEntries('workflow', schema.workflowKeys),
    },
    {
      id: 'workflow-job',
      title: 'Workflow job options',
      entries: toEntries('workflow-job', schema.workflowJobEntryKeys),
    },
    {
      id: 'executor',
      title: 'Executor keys',
      entries: toEntries('executor', schema.executorKeys),
    },
    {
      id: 'docker',
      title: 'Docker image keys',
      entries: toEntries('docker', schema.dockerImageKeys),
    },
    {
      id: 'resource-class',
      title: 'resource_class values',
      entries: toValueEntries('resource-class', schema.resourceClassValues),
    },
    {
      id: 'job-type',
      title: 'Job type values',
      entries: toValueEntries('job-type', schema.jobTypeValues),
    },
    // Last on purpose: real keys, but not ones a project config author will
    // ever write. Sectioned rather than hidden, because an orb author reading
    // this pane does need them -- and because silently dropping a key the
    // schema validates against would make the pane less trustworthy, not more.
    {
      id: 'orb-authoring',
      title: 'Orb authoring only',
      entries: orbAuthoringKeys,
    },
  ];

  return sections.filter((section) => section.entries.length > 0);
}

/** Case-insensitive substring match against an entry's label, and its
 * description when the label itself doesn't match -- e.g. searching
 * "cache" should surface `save_cache`/`restore_cache` by label, but also
 * any key whose *description* mentions caching even if "cache" isn't in
 * its own name. Empty query matches everything (the unfiltered browse
 * view). */
export function matchesQuery(entry: DocsEntry, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return true;
  if (entry.label.toLowerCase().includes(trimmed)) return true;
  return (entry.info ?? '').toLowerCase().includes(trimmed);
}

/** Filters every section's entries by `matchesQuery`, dropping sections left
 * with none -- what `DocsPane` renders as the user types. */
export function filterDocsSections(
  sections: readonly DocsSection[],
  query: string,
): DocsSection[] {
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => matchesQuery(entry, query)),
    }))
    .filter((section) => section.entries.length > 0);
}
