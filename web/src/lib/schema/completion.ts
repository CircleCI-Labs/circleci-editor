/**
 * Builds a `@codemirror/autocomplete` `CompletionSource` for CircleCI YAML,
 * combining the schema-derived fact tables from `circleciSchema.ts` with
 * things only the *document itself* can supply (the user's own job names,
 * for `requires:` and a workflow's `jobs:` list; orb aliases, for steps and
 * `executor:`) and one thing only the *host* can supply: the orb registry
 * itself, for completing `orbs:` block entries (`namespace/orb@version`,
 * issue #108) -- see `orbSearch.ts`. Where completion should land at the
 * cursor comes from `yamlPath.ts`.
 */
import type {
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';
import { parseDocument, type Document } from 'yaml';

import { orbsEntry } from '~/lib/orbs/snippets';
import { getJobNames, listKeys } from '~/lib/yaml/documentUtils';
import type { OrbSearchResult } from '~/lib/rpc/client';
import { getLoadedXcodeVersions } from '~/lib/xcodeVersions/useXcodeVersions';
import {
  xcodeVersionTitle,
  xcodeVersionsMatching,
} from '~/lib/xcodeVersions/xcodeVersionOptions';

import type { CircleciSchema, SchemaCompletionItem } from './circleciSchema';
import {
  CIMG_IMAGES,
  cimgImageCandidates,
  machineImageCandidates,
  type ImageCompletionItem,
} from './images';
import { fetchCimgTags } from './imageTags';
import { COMPLETION_SEARCH_LIMIT, fetchOrbSearch } from './orbSearch';
import {
  isInsideOpaqueScalar,
  resolveCursorContext,
  type PathSegment,
} from './yamlPath';

interface KeyCompletionOptions {
  /** A positive boost ranks these above generic matches (job/orb names, which change per document, ahead of the fixed schema vocabulary would be backwards); a negative one ranks them below. */
  boost?: number;
  /** Appends `": "` to the inserted text -- appropriate for a schema *key* (the overwhelmingly likely next step is typing its value), never for a *value* or a bare list item. */
  appendColon?: boolean;
}

function fromSchema(
  items: readonly SchemaCompletionItem[],
  opts: KeyCompletionOptions = {},
): Completion[] {
  const { boost = 0, appendColon = false } = opts;
  return items.map((item) => ({
    label: item.label,
    info: item.info,
    boost,
    apply: appendColon ? `${item.label}: ` : undefined,
  }));
}

function fromLabels(
  labels: readonly string[],
  detail: string,
  boost = 0,
): Completion[] {
  return labels.map((label) => ({ label, detail, boost }));
}

/**
 * CodeMirror's own fuzzy filter (still active on every keystroke since
 * these results don't set `filter: false` -- see below) matches the typed
 * text against `Completion.label`, over the *entire* range from `from` to
 * the cursor. For a resource_class-style value that range is exactly the
 * token being typed, so `item.label`'s short display text (`medium`) is
 * also the right match target. For an image value it isn't: `from` is the
 * start of the *whole* `image:` value, so by the variant-suffix stage the
 * typed text is e.g. `cimg/node:20.11-b`, which `item.label`'s short
 * display text (`20.11-browsers`) doesn't contain as a prefix. `label` is
 * therefore set to the *full* resulting value (`item.apply`) so the match
 * always succeeds, with `displayLabel` overriding what's actually shown in
 * the popup to `item.label`'s short form -- see `Completion.displayLabel`.
 */
function fromImageCandidates(
  items: readonly ImageCompletionItem[],
  detail: string,
): Completion[] {
  return items.map((item) => ({
    label: item.apply,
    displayLabel: item.label,
    apply: item.apply,
    info: item.info,
    detail,
  }));
}

/** True when `path` is the container of a `docker:` array entry's own keys -- i.e. `[..., 'docker', <index>]` -- the shape `resolveCursorContext` reports for both `jobs.<name>.docker` and `executors.<name>.docker`. */
function isDockerImageEntry(path: readonly PathSegment[]): boolean {
  return (
    path.length >= 2 &&
    path[path.length - 2] === 'docker' &&
    typeof path[path.length - 1] === 'number'
  );
}

/** True when `path`'s last segment is `machine` -- i.e. the cursor is inside a `machine:` executor object (`jobs.<name>.machine` or `executors.<name>.machine`), as opposed to a `macos:` object (which has no `image` key at all -- see images.ts) or the deprecated bare-string `machine: true` form (which has no keys to complete inside). */
function isMachineExecutor(path: readonly PathSegment[]): boolean {
  return path[path.length - 1] === 'machine';
}

/** True when `path`'s last segment is `macos` -- the cursor is inside a `macos:` executor object (`jobs.<name>.macos` or `executors.<name>.macos`), the only place an `xcode:` key means anything. */
function isMacosExecutor(path: readonly PathSegment[]): boolean {
  return path[path.length - 1] === 'macos';
}

/**
 * Completions for an `xcode:` value: the versions CircleCI's own supported-Xcode
 * table lists (issue #211), read from the same module cache the macOS executor
 * field uses so the two surfaces cannot offer different answers.
 *
 * Synchronous, and empty when the list has not arrived yet -- see
 * `getLoadedXcodeVersions` for why `undefined` must mean "offer nothing" rather
 * than "offer a guess", and why one keystroke later there is an answer.
 * `YamlPane` primes the fetch on mount.
 *
 * A prefix match rather than CodeMirror's fuzzy default over the whole list: see
 * `xcodeVersionsMatching`. `label` is the plain version string and `from`/`to`
 * already span the whole value (as for `resource_class`), so CodeMirror's own
 * filter matches the same text this filtered on -- no `displayLabel`/`apply`
 * divergence of the kind image values need.
 *
 * Pre-releases are offered, ranked below the supported ones and labelled with
 * upstream's own word for them. Offering them unranked would make "the newest
 * thing in the list" a beta whose image is not frozen; hiding them would make a
 * legal value uncompletable.
 */
function xcodeVersionCompletions(prefix: string): Completion[] {
  const response = getLoadedXcodeVersions();
  if (!response) return [];
  return xcodeVersionsMatching(response.versions, prefix).map((version) => ({
    label: version.version,
    detail: version.prerelease
      ? (version.prereleaseKind ?? 'pre-release')
      : 'Xcode version',
    info: xcodeVersionTitle(version),
    // Negative so a supported version outranks a beta of a higher number, which
    // is the order the table's own newest-first listing would otherwise invert.
    boost: version.prerelease ? -1 : 0,
  }));
}

/** True when `path`'s last two segments are `[key, <a sequence index>]` -- i.e. the cursor is at the *first* key of the `key:`-list's `index`'th item (see `yamlPath.ts`'s doc comment on why a bare scalar item and a single-key map item share this same shape). */
function isFirstEntryOf(path: readonly PathSegment[], key: string): boolean {
  return (
    path.length >= 2 &&
    path[path.length - 2] === key &&
    typeof path[path.length - 1] === 'number'
  );
}

function orbAliasCompletions(doc: Document): Completion[] {
  return listKeys(doc, ['orbs']).map((alias) => ({
    label: alias,
    detail: 'orb',
    boost: -1,
  }));
}

/**
 * True when `path` is exactly `['orbs']` -- the container of every entry in
 * the `orbs:` map, whether it's a fresh alias key being typed
 * (`orbs:\n  ‸`) or an existing alias's value (`orbs:\n  slack: ‸`;
 * `resolveCursorContext`'s doc comment explains why both shapes report the
 * same single-segment containerPath here, just as a `steps:` item's
 * bare-scalar and single-key-map forms share one path).
 */
function isOrbsBlock(path: readonly PathSegment[]): boolean {
  return path.length === 1 && path[0] === 'orbs';
}

/**
 * `internal/orbs/search.go`'s `MatchedOn` labels for the two match tiers
 * that mean "this text denotes exactly one orb", not a fuzzy or
 * substring guess -- the only two safe to resolve a *version* list
 * against (see `resolveOrbVersionCompletions`). Duplicated here rather than
 * imported because the Go constants aren't (and shouldn't be) exposed
 * across the host/SPA boundary; this is the wire value, not the Go symbol.
 */
const EXACT_ORB_MATCH_LABELS: ReadonlySet<string> = new Set([
  'exact-full-name',
  'exact-name',
]);

/**
 * Builds one `orbs:`-block completion for the orb search result `pkg`.
 * Always inserts a full `namespace/orb@version` reference, never a bare
 * `orb@version` -- issue #59 was a P1 caused by exactly that reaching a
 * real user's config, so this never has an unnamespaced code path to begin
 * with, regardless of how much (or little) of `pkg.name`'s namespace the
 * user actually typed.
 *
 * `withAlias`, when true (the `orbs:` map's fresh-key slot -- see
 * `isOrbsBlock`), means the alias itself hasn't been written yet, so
 * `apply` inserts the *whole* line (`<alias>: <ref>`), deriving the default
 * alias via `orbsEntry`'s own `sanitizeAlias` -- exactly what dropping this
 * orb onto the canvas already produces (`lib/orbs/snippets.ts`), so an
 * orb's alias means the same thing everywhere in the app. When false (an
 * *existing* alias's value is being completed/edited), `apply` is just the
 * bare reference, since the alias is already written.
 *
 * Callers filter out any `pkg` with an empty `latestVersion` before this is
 * ever reached: a reserved orb name with nothing published has no version
 * to complete to, so it can't produce a full reference at all (mirroring
 * `internal/orbs.isUsable`).
 */
function orbReferenceCompletion(
  pkg: OrbSearchResult,
  withAlias: boolean,
): Completion {
  const ref = `${pkg.name}@${pkg.latestVersion}`;
  const apply = withAlias ? `${orbsEntry(ref).alias}: ${ref}` : ref;
  return {
    label: pkg.name,
    apply,
    detail: pkg.certified ? 'certified orb' : 'orb',
    info: ref,
  };
}

/**
 * Resolves the `orbs:` block's name-search stage (issue #108's stage 1):
 * asks the host's orb registry cache (via `orbSearch.ts`'s `fetchOrbSearch`)
 * for `query`, and builds one completion per *usable* result --
 * deliberately never requiring a namespace prefix first
 * (`internal/orbs.Search`'s own doc comment: typing "act" must find
 * "cci-labs/act" without knowing which namespace publishes it, the property
 * the orb browser already has and this editor lacked before #108).
 *
 * Never rejects (`fetchOrbSearch` doesn't), so an unavailable host (no
 * token, offline) simply resolves to no completions here -- never blocking
 * typing.
 */
async function resolveOrbNameCompletions(
  query: string,
  withAlias: boolean,
): Promise<Completion[]> {
  const state = await fetchOrbSearch(query, COMPLETION_SEARCH_LIMIT);
  return state.results
    .filter((pkg) => pkg.latestVersion !== '')
    .map((pkg) => orbReferenceCompletion(pkg, withAlias));
}

/**
 * Resolves the `orbs:` block's version stage (issue #108's stage 2, once an
 * `@` has been typed). `namespacePart` -- the ref text before the `@` --
 * must resolve to *exactly one* orb (an `EXACT_ORB_MATCH_LABELS` hit, not a
 * fuzzy or substring guess) before any version is offered; otherwise this
 * returns nothing rather than guessing which orb's versions to show.
 *
 * Every completion's `apply` is rebuilt from the *resolved* package's own
 * `name`, never by echoing `namespacePart` back -- the #59 guard applies
 * here too: even a bare `slack@` typed by hand resolves against the real
 * `circleci/slack` (an `exact-name` hit) and completes to a fully-qualified
 * `circleci/slack@<version>`, never `slack@<version>`. `from`/`to` in the
 * caller always span the *entire* value typed so far (not just the text
 * after `@`), so this replacement is what actually fixes up a bare
 * reference in place, not just what's appended to it.
 *
 * Marks the package's own `latestVersion` (consistent with issue #89's
 * "recommend the latest"). The host already returns `versions` newest-first
 * (`sortVersionsDescending`), so no client-side re-sort is needed to keep it
 * at the top of whatever subset matches `versionPrefix`.
 */
async function resolveOrbVersionCompletions(
  namespacePart: string,
  versionPrefix: string,
): Promise<Completion[]> {
  const state = await fetchOrbSearch(namespacePart, COMPLETION_SEARCH_LIMIT);
  const pkg = state.results[0];
  if (!pkg || !EXACT_ORB_MATCH_LABELS.has(pkg.matchedOn)) return [];

  return pkg.versions
    .filter((version) => version.startsWith(versionPrefix))
    .map((version) => ({
      label: version,
      apply: `${pkg.name}@${version}`,
      detail: version === pkg.latestVersion ? 'latest version' : 'version',
    }));
}

/**
 * Resolves the `orbs:` block's value slot -- an existing alias's value
 * being typed or edited -- dispatching to the name stage (no `@` typed
 * yet) or the version stage (`@` already typed), per issue #108's stages 1
 * and 2. The alias itself is never touched here: unlike the fresh-key slot
 * (`resolveOrbNameCompletions` called with `withAlias: true`), the map key
 * already exists.
 */
async function resolveOrbValueCompletions(
  prefix: string,
): Promise<Completion[]> {
  const atIdx = prefix.indexOf('@');
  if (atIdx === -1) return resolveOrbNameCompletions(prefix, false);
  return resolveOrbVersionCompletions(
    prefix.slice(0, atIdx),
    prefix.slice(atIdx + 1),
  );
}

/** Candidates for a fresh map key at `path`. */
function keyCandidates(
  schema: CircleciSchema,
  doc: Document,
  path: readonly PathSegment[],
): Completion[] {
  if (path.length === 0)
    return fromSchema(schema.topLevelKeys, { appendColon: true });
  if (path.length === 2 && path[0] === 'jobs')
    return fromSchema(schema.jobKeys, { appendColon: true });
  if (path.length === 2 && path[0] === 'executors')
    return fromSchema(schema.executorKeys, { appendColon: true });
  if (path.length === 2 && path[0] === 'workflows')
    return fromSchema(schema.workflowKeys, { appendColon: true });
  if (
    path.length === 5 &&
    path[0] === 'workflows' &&
    path[2] === 'jobs' &&
    typeof path[3] === 'number'
  ) {
    return fromSchema(schema.workflowJobEntryKeys, { appendColon: true });
  }
  if (
    isFirstEntryOf(path, 'steps') ||
    isFirstEntryOf(path, 'pre-steps') ||
    isFirstEntryOf(path, 'post-steps')
  ) {
    return [
      ...fromSchema(schema.stepNames, { boost: 1 }),
      ...fromLabels(listKeys(doc, ['commands']), 'command', 1),
      ...orbAliasCompletions(doc),
    ];
  }
  if (isFirstEntryOf(path, 'requires')) {
    return fromLabels(getJobNames(doc), 'job', 1);
  }
  if (
    path.length === 4 &&
    path[0] === 'workflows' &&
    path[2] === 'jobs' &&
    typeof path[3] === 'number'
  ) {
    return fromLabels(getJobNames(doc), 'job', 1);
  }
  if (isFirstEntryOf(path, 'docker')) {
    return fromSchema(schema.dockerImageKeys, { appendColon: true });
  }
  return [];
}

/**
 * Candidates for the value of an already-written `key`. `path` is the
 * value's *own* containing map (the same shape `keyCandidates` receives
 * for a fresh key at this level) -- needed here only to disambiguate
 * `image:`, which means two unrelated things depending on where it
 * appears (see `isDockerImageEntry`/`isMachineExecutor`); every other
 * branch below is context-free and ignores it.
 */
function valueCandidates(
  schema: CircleciSchema,
  doc: Document,
  key: string,
  path: readonly PathSegment[],
  prefix: string,
): Completion[] {
  if (key === 'resource_class') return fromSchema(schema.resourceClassValues);
  if (key === 'type') return fromSchema(schema.jobTypeValues);
  if (key === 'executor') {
    return [
      ...fromLabels(listKeys(doc, ['executors']), 'executor', 1),
      ...orbAliasCompletions(doc),
    ];
  }
  if (key === 'image' && isDockerImageEntry(path)) {
    return fromImageCandidates(cimgImageCandidates(prefix), 'cimg image');
  }
  if (key === 'image' && isMachineExecutor(path)) {
    return fromImageCandidates(machineImageCandidates(prefix), 'machine image');
  }
  if (key === 'xcode' && isMacosExecutor(path)) {
    return xcodeVersionCompletions(prefix);
  }
  return [];
}

/**
 * True iff `key`/`path`/`prefix` describe a `docker: - image:` value whose
 * tag portion has already started (a `:` typed) against a repo that
 * matches one of `CIMG_IMAGES` -- the one shape of image value this module
 * can enrich with *live* Docker Hub version tags (see `imageTags.ts`),
 * returning the matched image's bare name if so.
 *
 * Deliberately narrow: the repo-name stage (no `:` yet) and every
 * non-cimg/non-image value stay on the synchronous path below, both
 * because there's nothing live to fetch for them and so that
 * `circleciCompletionSource` only ever returns a `Promise` where there's
 * actually something async to await (this, or the `orbs:` block -- see
 * `isOrbsBlock`) -- see that function's own doc comment for why that
 * matters for the CodeMirror wiring around it, not just for
 * `completion.test.ts`'s existing synchronous assertions.
 */
function cimgLiveTagRepoName(
  key: string,
  path: readonly PathSegment[],
  prefix: string,
): string | null {
  if (key !== 'image' || !isDockerImageEntry(path)) return null;

  const colonIdx = prefix.indexOf(':');
  if (colonIdx === -1) return null;

  const rawRepo = prefix.slice(0, colonIdx);
  if (!rawRepo.startsWith('cimg/')) return null;
  const repoName = rawRepo.slice('cimg/'.length);
  return CIMG_IMAGES.some((img) => img.name === repoName) ? repoName : null;
}

/**
 * Resolves the completions for a `cimg/<repoName>:<tagPrefix>` value:
 * `fetchCimgTags`'s live/cached ranked version tags (issue #77's follow-up
 * user feedback -- "it doesn't go as far as showing the different
 * versions" -- specifically about this completion source, not just the
 * image picker) ranked ahead of (`boost: 1`) the existing offline variant
 * suggestions from `cimgImageCandidates`, which this never replaces: a
 * variant suffix (`-browsers`, `-node`, ...) is still exactly as useful to
 * append after a version as it always was, live data or not.
 *
 * Never rejects, mirroring `fetchCimgTags` itself -- a Docker Hub/host
 * failure resolves to an empty live-tag contribution, leaving the offline
 * variant suggestions as the completion source's own graceful degradation
 * (no separate handling needed here).
 */
async function resolveCimgTagCompletions(
  repoName: string,
  prefix: string,
): Promise<Completion[]> {
  const offline = fromImageCandidates(
    cimgImageCandidates(prefix),
    'cimg image',
  );

  const tagPrefix = prefix.slice(prefix.indexOf(':') + 1);
  const tagsState = await fetchCimgTags(repoName);
  const live: Completion[] = tagsState.tags
    .filter((tag) => tag.startsWith(tagPrefix))
    .map((tag) => ({
      label: `cimg/${repoName}:${tag}`,
      displayLabel: tag,
      apply: `cimg/${repoName}:${tag}`,
      detail: 'version',
      info:
        tagsState.source === 'live'
          ? 'Recently published on Docker Hub'
          : 'From a previous Docker Hub fetch (cached copy)',
      boost: 1,
    }));

  return [...live, ...offline];
}

/**
 * Builds the completion source. `schema` should come from
 * `parseCircleciSchema` applied to `GET /api/schema`'s response; an
 * (unlikely, but handled) empty schema still lets document-derived
 * completions (job names, orb aliases) through, it just proposes nothing
 * for schema-only positions like a bare top-level key.
 *
 * Returns a plain `CompletionResult` (or `null`) for every position except
 * two, each backed by a host lookup CodeMirror's own `CompletionSource`
 * type already accepts a `Promise` result for: a `cimg/*` image's tag stage
 * (see `cimgLiveTagRepoName`) and anywhere inside the `orbs:` block (see
 * `isOrbsBlock`, issue #108). Returning a `Promise` only when there's
 * actually something async to await keeps every other, purely
 * document/schema-derived completion (job names, other orb aliases,
 * resource classes, ...) exactly as synchronous as it was before this
 * module ever talked to a network -- deliberate, not incidental: see
 * `completion.test.ts`'s `runSync` helper, which exists specifically to
 * catch a change that accidentally widens the async surface.
 */
export function createCircleciCompletionSource(schema: CircleciSchema) {
  return function circleciCompletionSource(
    context: CompletionContext,
  ): CompletionResult | Promise<CompletionResult | null> | null {
    const text = context.state.doc.toString();
    const pos = context.pos;

    // Parsed once here, leniently (`.errors` may be non-empty -- composed
    // nodes still have real ranges) so it can double as: (a) the
    // quoted/block-scalar suppression check below, and (b) the source of
    // this document's own job names / orb aliases / executor names, all
    // without a second parse of the (unmodified) full document.
    const doc = parseDocument(text, { merge: true });
    if (isInsideOpaqueScalar(doc, pos)) return null;

    const cursor = resolveCursorContext(text, pos);
    if (!cursor) return null;

    if (cursor.slot === 'key') {
      if (isOrbsBlock(cursor.containerPath)) {
        return resolveOrbNameCompletions(cursor.prefix, true).then((options) =>
          options.length === 0
            ? null
            : { from: cursor.from, to: pos, options, filter: false },
        );
      }
      const options = keyCandidates(schema, doc, cursor.containerPath);
      return options.length === 0
        ? null
        : { from: cursor.from, to: pos, options };
    }
    if (cursor.key === undefined) return null;

    if (isOrbsBlock(cursor.containerPath)) {
      return resolveOrbValueCompletions(cursor.prefix).then((options) =>
        options.length === 0
          ? null
          : { from: cursor.from, to: pos, options, filter: false },
      );
    }

    const liveRepoName = cimgLiveTagRepoName(
      cursor.key,
      cursor.containerPath,
      cursor.prefix,
    );
    if (liveRepoName) {
      return resolveCimgTagCompletions(liveRepoName, cursor.prefix).then(
        (options) =>
          options.length === 0 ? null : { from: cursor.from, to: pos, options },
      );
    }

    const options = valueCandidates(
      schema,
      doc,
      cursor.key,
      cursor.containerPath,
      cursor.prefix,
    );
    return options.length === 0
      ? null
      : { from: cursor.from, to: pos, options };
  };
}
