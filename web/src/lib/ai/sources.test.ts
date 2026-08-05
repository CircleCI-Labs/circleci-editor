import { describe, expect, it } from 'vitest';

import { DOCS_LINKS } from '~/lib/docs/docsLinks';

import type { FixTopic } from './deterministicSources';
import { MAX_SOURCES, presentSources, rankSources } from './sources';

describe('presentSources', () => {
  it('prefers the curated label, and adopts the curated canonical URL with it', () => {
    // A URL in `docsLinks.ts` has been checked non-redirecting by hand,
    // so a match replaces the MCP server's spelling of it as well as labelling
    // it.
    const rows = presentSources([
      { url: DOCS_LINKS.executors.resourceClass.url, title: 'resource_class' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: DOCS_LINKS.executors.resourceClass.url,
      title: DOCS_LINKS.executors.resourceClass.label,
      titleResolved: true,
    });
  });

  it('uses the host-resolved title for a page the curated table does not know', () => {
    const rows = presentSources([
      {
        url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/#enable',
        title: 'Enable dynamic config',
      },
    ]);

    expect(rows[0]?.title).toBe('Enable dynamic config');
    expect(rows[0]?.titleResolved).toBe(true);
    // The destination stays visible under the title, so the reader can always
    // see where a row goes.
    expect(rows[0]?.detail).toBe(
      'circleci.com/docs/guides/orchestrate/dynamic-config/#enable',
    );
  });

  it('humanizes the last path segment when nothing resolved a title', () => {
    const rows = presentSources([
      {
        url: 'https://circleci.com/docs/guides/execution-managed/persist-data/',
      },
    ]);

    expect(rows[0]).toMatchObject({
      title: 'Persist data',
      titleResolved: false,
    });
  });

  it('falls back to the hostname when there is no path to read', () => {
    expect(presentSources([{ url: 'https://circleci.com/' }])[0]?.title).toBe(
      'circleci.com',
    );
    expect(
      presentSources([{ url: 'https://circleci.com/docs/' }])[0]?.title,
    ).toBe('circleci.com');
  });

  it('drops an image, stylesheet, script or font citation outright', () => {
    // The host maps a *mappable* image to its page before this point (issue
    // #156); anything still shaped like an asset here is noise, and this is the
    // last stop before an `href`.
    expect(
      presentSources([
        { url: 'https://circleci.com/docs/guides/_images/workspace.png' },
        { url: 'https://circleci.com/assets/site.css' },
        { url: 'https://circleci.com/assets/app.js' },
        { url: 'https://circleci.com/assets/inter.woff2' },
      ]),
    ).toEqual([]);
  });

  it('drops anything that is not an http(s) URL', () => {
    expect(
      presentSources([
        { url: 'javascript:alert(1)' },
        { url: 'data:text/html,<script>alert(1)</script>' },
        { url: 'file:///etc/passwd' },
        { url: '/api/ai/key' },
        { url: 'circleci-docs/guides/_images/workspace.png' },
        { url: '' },
      ]),
    ).toEqual([]);
  });

  it('collapses duplicates, including two spellings of one page', () => {
    const rows = presentSources([
      { url: 'https://circleci.com/docs/guides/orchestrate/workflows/' },
      { url: 'https://circleci.com/docs/guides/orchestrate/workflows' },
      {
        url: 'https://circleci.com/docs/guides/orchestrate/workflows/?utm_source=kapa',
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps two distinct sections of one page as two rows', () => {
    const rows = presentSources([
      {
        url: 'https://circleci.com/docs/reference/configuration-reference/#docker',
      },
      {
        url: 'https://circleci.com/docs/reference/configuration-reference/#macos',
      },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('preserves the provider’s order', () => {
    const rows = presentSources([
      { url: 'https://circleci.com/docs/second/' },
      { url: 'https://circleci.com/docs/first/' },
    ]);
    expect(rows.map((row) => row.title)).toEqual(['Second', 'First']);
  });

  /**
   * Issue #187. A "Sources" list is an implicit endorsement, so a citation to an
   * untrusted host must not become a link — and must not vanish either, because
   * a list that quietly shrinks makes an answer look better-grounded than it is.
   */
  describe('the host allowlist', () => {
    it('keeps an untrusted citation as a non-linkable row rather than dropping it', () => {
      // The exact case reported: `app.slack.com` alongside real CircleCI docs.
      const rows = presentSources([
        {
          url: 'https://circleci.com/docs/guides/orchestrate/workflows/',
          title: 'Use workflows',
        },
        {
          url: 'https://app.slack.com/client/T00000000/C00000000',
          title: 'Ask in #ci',
        },
      ]);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ linkable: true });
      expect(rows[0]?.blockedHost).toBeUndefined();
      expect(rows[1]).toMatchObject({
        linkable: false,
        blockedHost: 'app.slack.com',
        // Still shows where it went, as text.
        detail: 'app.slack.com/client/T00000000/C00000000',
      });
    });

    it('refuses a look-alike domain that a naive suffix check would accept', () => {
      const rows = presentSources([
        { url: 'https://circleci.com.evil.example/docs/guides/' },
        { url: 'https://evil-circleci.com/docs/' },
      ]);
      expect(rows.map((row) => row.linkable)).toEqual([false, false]);
      expect(rows.map((row) => row.blockedHost)).toEqual([
        'circleci.com.evil.example',
        'evil-circleci.com',
      ]);
    });

    it('links GitHub only for CircleCI-owned orgs', () => {
      const rows = presentSources([
        { url: 'https://github.com/CircleCI-Public/slack-orb/wiki' },
        { url: 'https://github.com/someone/random' },
      ]);
      expect(rows.map((row) => row.linkable)).toEqual([true, false]);
    });

    it('never consults the curated docs table for an untrusted host', () => {
      // `lookupDocLink` canonicalizes a URL as well as labelling it, so
      // letting an untrusted host near it could only ever mislabel a row.
      const rows = presentSources([
        {
          url: 'https://evil.example/docs/reference/configuration-reference/',
        },
      ]);
      expect(rows[0]?.linkable).toBe(false);
      expect(rows[0]?.url).toBe(
        'https://evil.example/docs/reference/configuration-reference/',
      );
      expect(rows[0]?.detail.startsWith('evil.example')).toBe(true);
    });
  });

  it('returns nothing for an absent or empty list', () => {
    expect(presentSources(undefined)).toEqual([]);
    expect(presentSources([])).toEqual([]);
  });
});

/**
 * Issue #210: relevance, and the cap. The owner's report is the fixture — an
 * unresolvable `circleci/slack` orb reference whose top retrieved source was
 * Slack's Block Kit builder, followed by semantic versioning, orb versions, node
 * and reusable config.
 */
describe('rankSources', () => {
  const ORB_TOPIC: FixTopic = {
    kind: 'orb',
    orb: {
      namespace: 'circleci',
      name: 'slack',
      requestedVersion: '4.12.5',
      latestVersion: '5.1.1',
    },
  };

  /** The owner's own list, in the owner's own order. */
  const OWNERS_SOURCES = [
    {
      url: 'https://app.slack.com/block-kit-builder',
      title: 'Block Kit Builder',
    },
    { url: 'https://semver.org/', title: 'Semantic Versioning' },
    {
      url: 'https://circleci.com/docs/orbs/use/orb-concepts/#orb-version',
      title: 'Orb version',
    },
    {
      url: 'https://circleci.com/developer/orbs/orb/circleci/node',
      title: 'Node orb',
    },
    {
      url: 'https://circleci.com/docs/reference/reusing-config/',
      title: 'Reusable config',
    },
  ];

  it("leads with the orb the error names, not with the product's own site", () => {
    const { rows } = rankSources(OWNERS_SOURCES, ORB_TOPIC);
    expect(rows[0]?.url).toBe(
      'https://circleci.com/developer/orbs/orb/circleci/slack',
    );
    expect(rows[0]?.origin).toBe('editor');
    expect(rows[0]?.title).toContain('latest published: 5.1.1');
    // Block Kit is off-topic *and* on a host this app will not link, so it loses
    // the last slot to a page that is at least about orbs.
    expect(rows.map((row) => row.title)).not.toContain('Block Kit Builder');
  });

  it('caps the list, and says how many it dropped', () => {
    const { rows, dropped } = rankSources(OWNERS_SOURCES, ORB_TOPIC);
    expect(rows).toHaveLength(MAX_SOURCES);
    // Three deterministic plus the owner's five retrieved: eight rows in, four
    // shown, four counted. Five sources of which one was on-topic is what the
    // owner reported; four of which three are the orb itself is the fix.
    expect(rows.length + dropped).toBe(8);
    expect(dropped).toBe(4);
  });

  it('sinks an off-topic source below an on-topic one, without reordering within either', () => {
    // `workflowJob` attaches exactly one deterministic row, which leaves three
    // slots for four retrieved ones -- so the cap is what makes the ordering
    // *observable*, which is the point: the row that falls off is the one that has
    // nothing to do with the fix, and it is not the one the provider ranked last.
    const { rows, dropped } = rankSources(
      [
        { url: 'https://semver.org/', title: 'Semantic Versioning' },
        {
          url: 'https://circleci.com/docs/guides/orchestrate/workflows/#a',
          title: 'Workflows A',
        },
        {
          url: 'https://circleci.com/docs/guides/orchestrate/workflows/#b',
          title: 'Workflows B',
        },
        {
          url: 'https://circleci.com/docs/reference/reusing-config/#the-jobs-key',
          title: 'Jobs key',
        },
      ],
      { kind: 'workflowJob' },
    );
    const titles = rows.map((row) => row.title);
    // The three on-topic pages are all in, in the provider's own order...
    expect(titles.indexOf('Workflows A')).toBeLessThan(
      titles.indexOf('Workflows B'),
    );
    expect(titles.indexOf('Workflows B')).toBeLessThan(
      titles.indexOf('Jobs key'),
    );
    // ...and semantic versioning, which the provider ranked *first*, is the one
    // dropped.
    expect(titles).not.toContain('Semantic Versioning');
    expect(dropped).toBe(1);
  });

  it('does not show a retrieved duplicate of a row it attached itself', () => {
    const { rows } = rankSources(
      [{ url: DOCS_LINKS.orbs.intro.url, title: 'Orbs introduction' }],
      ORB_TOPIC,
    );
    const intro = rows.filter((row) => row.url === DOCS_LINKS.orbs.intro.url);
    expect(intro).toHaveLength(1);
    // ...and the surviving one is the honest one: this editor attached it.
    expect(intro[0]?.origin).toBe('editor');
  });

  it('ranks nothing and attaches nothing for an ordinary question', () => {
    // No seeded fix, so no topic, so no relevance is claimed: the provider's order
    // stands, and every row says it came from retrieval.
    const { rows, dropped } = rankSources([
      {
        url: 'https://circleci.com/docs/guides/orchestrate/workflows/',
        title: 'Use workflows',
      },
      {
        url: 'https://circleci.com/docs/reference/reusing-config/',
        title: 'Reusable config',
      },
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'Use workflows',
      'Reusable config',
    ]);
    expect(rows.every((row) => row.origin === 'retrieved')).toBe(true);
    expect(dropped).toBe(0);
  });

  it('keeps a refused source when it makes the cap, and never links it (#187/#204)', () => {
    const { rows } = rankSources([
      {
        url: 'https://circleci.com/docs/guides/orchestrate/workflows/',
        title: 'Use workflows',
      },
      { url: 'https://app.slack.com/client/T0/C0', title: 'Ask in #ci' },
    ]);
    expect(rows).toHaveLength(2);
    const refused = rows.find((row) => row.url.includes('app.slack.com'));
    expect(refused).toBeDefined();
    expect(refused?.linkable).toBe(false);
    expect(refused?.blockedHost).toBe('app.slack.com');
  });

  it('is empty, not a box with nothing in it, when there is nothing to show', () => {
    expect(rankSources(undefined)).toEqual({ rows: [], dropped: 0 });
    expect(rankSources([])).toEqual({ rows: [], dropped: 0 });
  });
});
