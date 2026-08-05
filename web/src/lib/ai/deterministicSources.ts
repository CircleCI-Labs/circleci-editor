/**
 * The citations this app can attach **with certainty**, from the error it is
 * already looking at (issue #210).
 *
 * The owner, after running "Fix with AI" on an orb reference that does not
 * resolve:
 *
 * > *"The prompt I think was okay. But then the sources are completely off. Yes,
 * > you list out the orb registry, but the first one is the Slack Block Kit
 * > builder. I don't think that has any reference here. ... If it's offering
 * > changes to the config around orbs, you should show some orb documentation —
 * > maybe even pull in the link to the orb that is changing."*
 *
 * #187/#204 settled whether a citation is *safe to link*. Nothing settled
 * whether it is *relevant*, and for `Cannot find circleci/slack@4.12.5 in the
 * orb registry` the top retrieved source was Slack's Block Kit builder — a page
 * about composing Slack messages, retrieved because the query contained the word
 * "slack". Retrieval was answering a different question from the one the user
 * asked.
 *
 * # Why these are different from retrieved sources
 *
 * Everything here is derived from data the app **already holds** about the
 * specific diagnostic: the namespace and orb name parsed out of the compiler's
 * own message (`lib/validation/diagnostics`'s `DiagnosticTarget`), the schema
 * path a JSON-Schema violation quoted, the version list the orb cache fetched.
 * There is no similarity score anywhere in this file. For an orb error, the orb's
 * own registry page is not *probably* relevant — it is the page for the thing the
 * error names.
 *
 * # Two rules that are not negotiable
 *
 *  - **No URL is constructed that this app cannot vouch for.** Every entry below
 *    is either a `DOCS_LINKS` value — whose live-check test asserts it resolves
 *    and does not redirect — or `orbDocsUrl`, the one place in this app
 *    that builds a per-orb registry URL, reused rather than re-derived.
 *
 *    That is also why an orb's **published versions** arrive as *facts in the
 *    prompt* (see `lib/validation/prompt`) and as words in the registry row's own
 *    title, rather than as a second link: the version list is real, but a
 *    per-version URL shape is not something this app has verified, and a
 *    plausible-looking URL is exactly what #210 forbids. `?version=` on a
 *    single-page app answers 200 whatever you put in it, so "it resolves" would
 *    not even be evidence.
 *
 *  - **A class with nothing certain attaches nothing.** `deterministicSourcesFor`
 *    returning `[]` is a correct outcome, stated in the issue: *"If the diagnostic
 *    class is one where we hold nothing deterministic, attaching nothing and
 *    letting retrieval stand is the correct outcome — do not invent relevance."*
 */
import { DOCS_LINKS, orbDocsUrl } from '~/lib/docs/docsLinks';
import type { AiChatSource } from '~/lib/rpc/client';
import type { DiagnosticTarget } from '~/lib/validation/diagnostics';

/**
 * What a "Fix with AI" conversation is about, in the terms the diagnostic
 * classifier already produces (#163 classifies errors precisely enough to
 * decide whether a mechanical fix can be offered; #210 asks that the same
 * classification shape the prompt and the citations).
 *
 * Deliberately a small, plain, serialisable value rather than the `Diagnostic`
 * itself: it is stored on a transcript message, so it must not drag a document
 * AST or a whole compiler report into the chat history.
 */
export interface FixTopic {
  /** The diagnostic class. Mirrors `DiagnosticTarget['kind']`. */
  kind: DiagnosticTarget['kind'];
  /** Set for `kind: 'orb'`: everything certain about the orb the error names. */
  orb?: OrbTopic;
  /** Set for `kind: 'schemaPath'`: the path the schema report quoted, as plain strings. */
  path?: readonly string[];
}

export interface OrbTopic {
  /** The namespace half of `namespace/name`, parsed from the compiler's message. */
  namespace: string;
  /** The orb's own name. */
  name: string;
  /** The version the config asked for, which is the one that did not resolve. */
  requestedVersion?: string;
  /** Published versions, newest first, when the orb cache has them (#128). Never guessed. */
  versions?: readonly string[];
  /** Which version the registry would resolve a version-less reference to. */
  latestVersion?: string;
}

/**
 * The topic for a diagnostic, or `undefined` when its class carries nothing
 * worth aiming at. `orbVersions` is threaded in by the caller because it comes
 * from the registry (via the orb cache) rather than from the diagnostic — see
 * `panes/yaml/DiagnosticsStrip`, which already fetches it for its own
 * version suggestion and now passes what it learned through here instead of
 * throwing it away.
 */
export function fixTopicFor(
  target: DiagnosticTarget | undefined,
  orbVersions?: { versions?: readonly string[]; latestVersion?: string },
): FixTopic | undefined {
  if (!target) return undefined;
  switch (target.kind) {
    case 'orb': {
      const parsed = parseOrbName(target.orbName);
      if (!parsed) return { kind: 'orb' };
      return {
        kind: 'orb',
        orb: {
          ...parsed,
          ...(target.version ? { requestedVersion: target.version } : {}),
          ...(orbVersions?.versions && orbVersions.versions.length > 0
            ? { versions: orbVersions.versions }
            : {}),
          ...(orbVersions?.latestVersion
            ? { latestVersion: orbVersions.latestVersion }
            : {}),
        },
      };
    }
    case 'schemaPath':
      return {
        kind: 'schemaPath',
        path: target.path.map((segment) => String(segment)),
      };
    default:
      return { kind: target.kind };
  }
}

/** `"circleci/slack"` -> `{namespace: 'circleci', name: 'slack'}`; `undefined` for anything that is not exactly two non-empty segments. */
export function parseOrbName(
  orbName: string,
): { namespace: string; name: string } | undefined {
  const segments = orbName.split('/');
  if (segments.length !== 2) return undefined;
  const [namespace, name] = segments;
  if (!namespace || !name) return undefined;
  return { namespace, name };
}

/**
 * The citations this app can attach for `topic` from what it already knows.
 * Ordered most-specific-first: the thing the error actually names, then the
 * concepts behind it.
 */
export function deterministicSourcesFor(
  topic: FixTopic | undefined,
): AiChatSource[] {
  if (!topic) return [];
  switch (topic.kind) {
    case 'orb':
      return orbSources(topic.orb);
    case 'executor':
      return [
        source(DOCS_LINKS.reusableConfig.executors),
        source(DOCS_LINKS.reusableConfig.overview),
      ];
    case 'command':
      return [
        source(DOCS_LINKS.reusableConfig.commands),
        source(DOCS_LINKS.reusableConfig.overview),
      ];
    case 'requires':
      return [
        source(DOCS_LINKS.workflows.requires),
        source(DOCS_LINKS.guides.configurationReference),
      ];
    case 'workflowJob':
      return [source(DOCS_LINKS.guides.configurationReference)];
    case 'schemaPath':
      return schemaPathSources(topic.path ?? []);
  }
}

/**
 * The orb rows. The registry page is built by `orbDocsUrl` -- the same helper
 * the orb browser's own "docs link to the orb registry entry" uses (#89) -- so
 * there is one URL shape for a per-orb page in this app, not two.
 *
 * The title is written here rather than left to be derived from the URL's last
 * path segment, because "Slack" (what the path yields) is precisely the
 * ambiguity this whole issue is about: the row is the *orb*, not the product.
 * When the orb cache has the version list, the latest published version rides
 * in the title, which is the useful half of "show its published versions"
 * without inventing a URL for it -- see this module's header.
 */
function orbSources(orb: OrbTopic | undefined): AiChatSource[] {
  const rows: AiChatSource[] = [];
  if (orb) {
    const url = orbDocsUrl(orb.namespace, orb.name);
    if (url) {
      const latest = orb.latestVersion ?? orb.versions?.[0];
      rows.push({
        url,
        title: latest
          ? `${orb.namespace}/${orb.name} orb in the registry (latest published: ${latest})`
          : `${orb.namespace}/${orb.name} orb in the registry`,
      });
    }
  }
  rows.push(source(DOCS_LINKS.orbs.intro), source(DOCS_LINKS.orbs.concepts));
  return rows;
}

/**
 * A JSON-Schema violation's own reference page, plus the executor reference when
 * the path the report quoted names one.
 *
 * The executor rule is mechanical, not a guess: `docker`, `machine` and `macos`
 * are keys in the path CircleCI itself printed (`[#/jobs/build/docker/0]`), and
 * each has its own anchor in the configuration reference. Anything else gets the
 * reference page alone.
 */
function schemaPathSources(path: readonly string[]): AiChatSource[] {
  const rows = [source(DOCS_LINKS.guides.configurationReference)];
  if (path.includes('docker')) {
    rows.push(source(DOCS_LINKS.executors.dockerReference));
  } else if (path.includes('machine')) {
    rows.push(source(DOCS_LINKS.executors.machineReference));
  } else if (path.includes('macos')) {
    rows.push(source(DOCS_LINKS.executors.macosReference));
  }
  return rows;
}

function source(link: { label: string; url: string }): AiChatSource {
  return { url: link.url, title: link.label };
}

/**
 * Words that make a retrieved source on-topic for `topic`, lowercased.
 *
 * Used only to *order* retrieved citations and to decide which ones fall off the
 * end of a capped list (see `./sources`'s `rankSources`) -- never to drop one for
 * being off-topic on its own, and never to promote one to being linkable. A term
 * matches against the URL's path and the source's title, both of which the host
 * already resolved; nothing here fetches anything.
 *
 * Deliberately short and literal. A stemmer or a synonym list would make the
 * ordering unexplainable, and "why is this source above that one" has to be
 * answerable from the code by anyone reading it.
 */
export function topicTermsFor(topic: FixTopic | undefined): string[] {
  if (!topic) return [];
  switch (topic.kind) {
    case 'orb':
      return ['orb'];
    case 'executor':
      return ['executor', 'reusing-config', 'execution'];
    case 'command':
      return ['command', 'reusing-config', 'steps'];
    case 'requires':
      return ['workflow', 'requires', 'dependenc'];
    case 'workflowJob':
      return ['workflow', 'job'];
    case 'schemaPath':
      return [
        'configuration-reference',
        ...(topic.path ?? []).filter((segment) => !/^\d+$/.test(segment)),
      ].map((term) => term.toLowerCase());
  }
}
