import { describe, expect, it } from 'vitest';

import { DOCS_LINKS, orbDocsUrl } from '~/lib/docs/docsLinks';
import { groupCompileErrors } from '~/lib/validation/diagnostics';

import {
  deterministicSourcesFor,
  fixTopicFor,
  parseOrbName,
  topicTermsFor,
} from './deterministicSources';

/**
 * Issue #210. The owner's case, end to end at this layer: for `Cannot find
 * circleci/slack@4.12.5 in the orb registry`, the citations this app attaches are
 * the orb's own registry page and the two vendored Orbs pages — and not one of
 * them involved a similarity score, a network request, or a URL this app cannot
 * vouch for.
 */
const ORB_ERROR =
  'Cannot find circleci/slack@4.12.5 in the orb registry. Check that the namespace, orb name and version are correct.';

function targetFor(message: string) {
  return groupCompileErrors([message])[0]?.target;
}

describe('fixTopicFor', () => {
  it("reads the orb out of the compiler's own message", () => {
    const topic = fixTopicFor(targetFor(ORB_ERROR), {
      versions: ['5.1.1', '5.0.0'],
      latestVersion: '5.1.1',
    });
    expect(topic).toEqual({
      kind: 'orb',
      orb: {
        namespace: 'circleci',
        name: 'slack',
        requestedVersion: '4.12.5',
        versions: ['5.1.1', '5.0.0'],
        latestVersion: '5.1.1',
      },
    });
  });

  it('carries the orb with no version list at all, because the registry may be unreachable', () => {
    // No token, no network: the diagnostic is still classified, and the registry
    // page is still the right citation. Only the version facts are missing, and
    // they are simply absent rather than filled in with a guess.
    const topic = fixTopicFor(targetFor(ORB_ERROR));
    expect(topic?.orb).toEqual({
      namespace: 'circleci',
      name: 'slack',
      requestedVersion: '4.12.5',
    });
  });

  it('reduces a schema path to plain strings, so a transcript never holds an AST', () => {
    const topic = fixTopicFor({
      kind: 'schemaPath',
      path: ['jobs', 'build', 'docker', 0],
      key: 'imag',
    });
    expect(topic).toEqual({
      kind: 'schemaPath',
      path: ['jobs', 'build', 'docker', '0'],
    });
  });

  it('is absent for a diagnostic with no target at all', () => {
    // The classifier refuses to extract a target when doing so would mean
    // guessing (#163), and that refusal has to survive to here.
    expect(fixTopicFor(undefined)).toBeUndefined();
  });
});

describe('parseOrbName', () => {
  it('accepts exactly namespace/name', () => {
    expect(parseOrbName('circleci/slack')).toEqual({
      namespace: 'circleci',
      name: 'slack',
    });
  });

  it('refuses anything else, rather than half-parsing it into a URL', () => {
    for (const raw of ['slack', 'a/b/c', '/slack', 'circleci/', '']) {
      expect(parseOrbName(raw)).toBeUndefined();
    }
  });
});

describe('deterministicSourcesFor', () => {
  it('cites the orb itself first, then the two vendored Orbs pages', () => {
    const sources = deterministicSourcesFor(
      fixTopicFor(targetFor(ORB_ERROR), { latestVersion: '5.1.1' }),
    );
    expect(sources.map((source) => source.url)).toEqual([
      orbDocsUrl('circleci', 'slack'),
      DOCS_LINKS.orbs.intro.url,
      DOCS_LINKS.orbs.concepts.url,
    ]);
    // The row names the *orb*, not the product. "Slack" is precisely the
    // ambiguity that produced a Block Kit builder citation in the first place.
    expect(sources[0]?.title).toContain('circleci/slack orb in the registry');
    expect(sources[0]?.title).toContain('latest published: 5.1.1');
  });

  it('states the latest published version only when the registry told us one', () => {
    const sources = deterministicSourcesFor(fixTopicFor(targetFor(ORB_ERROR)));
    expect(sources[0]?.title).toBe('circleci/slack orb in the registry');
    expect(sources[0]?.title).not.toContain('latest');
  });

  it('never builds a per-version URL, however much it knows about the versions', () => {
    // The version list is real; a `?version=` URL shape is not something this app
    // has verified, and a single-page app answers 200 to anything you put there --
    // so "it resolves" would not even be evidence. The versions go in the prompt
    // instead. See this module's header.
    const sources = deterministicSourcesFor(
      fixTopicFor(targetFor(ORB_ERROR), {
        versions: ['5.1.1', '5.0.0'],
        latestVersion: '5.1.1',
      }),
    );
    for (const source of sources) {
      expect(source.url).not.toContain('5.1.1');
      expect(source.url).not.toContain('version=');
      expect(source.url).not.toContain('@');
    }
  });

  it('still cites the Orbs pages for an orb reference it could not parse', () => {
    // A malformed reference is still an orb problem, and the concepts pages still
    // apply. What drops out is only the row we cannot build honestly.
    const sources = deterministicSourcesFor({ kind: 'orb' });
    expect(sources.map((source) => source.url)).toEqual([
      DOCS_LINKS.orbs.intro.url,
      DOCS_LINKS.orbs.concepts.url,
    ]);
  });

  it('cites the executors key for an undefined executor', () => {
    const sources = deterministicSourcesFor(
      fixTopicFor(
        targetFor('Cannot find a definition for executor named nope'),
      ),
    );
    expect(sources.map((source) => source.url)).toEqual([
      DOCS_LINKS.reusableConfig.executors.url,
      DOCS_LINKS.reusableConfig.overview.url,
    ]);
  });

  it('adds the executor reference when the schema path itself names one', () => {
    // Mechanical, not a guess: `docker` is a key CircleCI printed in the pointer
    // it quoted.
    const sources = deterministicSourcesFor({
      kind: 'schemaPath',
      path: ['jobs', 'build', 'docker', '0'],
    });
    expect(sources.map((source) => source.url)).toEqual([
      DOCS_LINKS.guides.configurationReference.url,
      DOCS_LINKS.executors.dockerReference.url,
    ]);
  });

  it('attaches nothing at all when there is no topic', () => {
    // #210, in as many words: "If the diagnostic class is one where we hold
    // nothing deterministic, attaching nothing and letting retrieval stand is the
    // correct outcome -- do not invent relevance."
    expect(deterministicSourcesFor(undefined)).toEqual([]);
  });

  it('only ever cites URLs the curated table already vouches for, plus the orb page', () => {
    // The live-check in `docsLinks.test.ts` is what keeps these from rotting, and
    // that only covers URLs that are actually in the table. Anything this module
    // invents outside it would be unchecked.
    const known = new Set(
      Object.values(DOCS_LINKS).flatMap((group) =>
        Object.values(group).map((link) => link.url),
      ),
    );
    const topics = [
      fixTopicFor(targetFor(ORB_ERROR)),
      fixTopicFor(
        targetFor('Cannot find a definition for executor named nope'),
      ),
      fixTopicFor(targetFor('Cannot find a definition for command named nope')),
      fixTopicFor(targetFor('Cannot find a definition for job named nope')),
      { kind: 'requires' as const },
      { kind: 'schemaPath' as const, path: ['jobs', 'build', 'macos'] },
    ];
    for (const topic of topics) {
      for (const source of deterministicSourcesFor(topic)) {
        const allowed =
          known.has(source.url) ||
          source.url === orbDocsUrl('circleci', 'slack');
        expect(allowed, `${source.url} is not a checked URL`).toBe(true);
      }
    }
  });
});

describe('topicTermsFor', () => {
  it('aims an orb fix at orbs', () => {
    expect(topicTermsFor(fixTopicFor(targetFor(ORB_ERROR)))).toEqual(['orb']);
  });

  it('drops the array indices out of a schema path, which are not words', () => {
    expect(
      topicTermsFor({
        kind: 'schemaPath',
        path: ['jobs', 'build', 'docker', '0'],
      }),
    ).toEqual(['configuration-reference', 'jobs', 'build', 'docker']);
  });

  it('has nothing to say with no topic, so nothing is ever ranked on a guess', () => {
    expect(topicTermsFor(undefined)).toEqual([]);
  });
});
