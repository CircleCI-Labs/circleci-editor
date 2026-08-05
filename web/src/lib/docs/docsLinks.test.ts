import { describe, expect, it } from 'vitest';

import {
  allDocLinks,
  DOCS_LINKS,
  lookupDocLink,
  orbDocsUrl,
  stepDocsUrl,
} from './docsLinks';

describe('docsLinks table shape', () => {
  const entries = allDocLinks();

  it('is non-empty and covers every group issue #78 asks for', () => {
    const groups = new Set(entries.map((e) => e.path.split('.')[0]));
    expect(groups).toEqual(
      new Set([
        'guides',
        'executors',
        'images',
        'reusableConfig',
        'workflows',
        'orbs',
        'steps',
        // Not from #78: added by #105, whose palette Project section links
        // out to the project environment variables docs.
        'env',
      ]),
    );
  });

  // One test per entry (rather than a loop with one `it`) so a failure
  // names the exact table entry that broke in the test-runner's own
  // output -- vitest's `expect` has no chai-style second "message"
  // argument to attach that context to inline.
  it.each(entries)(
    '$path is an absolute https://circleci.com URL with a non-empty label',
    ({ link }) => {
      expect(link.url).toMatch(/^https:\/\/circleci\.com\//);
      expect(link.label.length).toBeGreaterThan(0);
      // No trailing whitespace, no accidental double-slash from string
      // concatenation (`stepDocsUrl` builds its URLs by template) -- exactly
      // the kind of typo a live check wouldn't catch (the server
      // trims/normalizes it away before a status code ever comes back).
      expect(link.url).toBe(link.url.trim());
      expect(link.url).not.toMatch(/[^:]\/\//);
    },
  );

  it('has no duplicate dotted path', () => {
    const paths = entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // Mirrors KNOWN_STEP_KEYS + the four kinds Inspector.tsx's StepDescriptor
  // handles outside that set -- see stepKeywords.ts and docsLinks.ts's own
  // doc comment on why this table is separate from KNOWN_STEP_KEYS itself.
  it.each([
    'checkout',
    'run',
    'when',
    'unless',
    'setup_remote_docker',
    'save_cache',
    'restore_cache',
    'store_artifacts',
    'store_test_results',
    'persist_to_workspace',
    'attach_workspace',
    'add_ssh_keys',
  ])('stepDocsUrl("%s") resolves', (key) => {
    expect(stepDocsUrl(key)).toBeDefined();
  });

  it('stepDocsUrl returns undefined for a keyword with no docs page (an orb command, a custom command reference)', () => {
    expect(stepDocsUrl('circleci/node/install')).toBeUndefined();
    expect(stepDocsUrl('my_custom_command')).toBeUndefined();
  });
});

/**
 * A real, network-hitting check that every URL in the table actually
 * resolves (issue #78: "Verify each URL actually resolves ... a quick
 * automated check over the table would be a good test -- and would catch
 * rot later"). Deliberately tolerant of having no network at all: this
 * suite otherwise runs entirely offline (see the rest of this repo's
 * tests), and a sandboxed/CI environment with no outbound access must not
 * fail the build over a check that simply couldn't run. A URL that *is*
 * reached and comes back 4xx/5xx, though, is a real failure -- that's
 * exactly the rot this test exists to catch.
 */
describe('live link resolution (best-effort; skips itself with no network)', () => {
  const urls = [
    ...new Set(allDocLinks().map(({ link }) => link.url.split('#')[0]!)),
  ].sort();

  it(`checks ${urls.length} distinct doc URLs`, async () => {
    const failures: string[] = [];
    let networkReachable = false;

    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (circleci-editor docs-link-check)',
          },
        });
        clearTimeout(timeout);
        networkReachable = true;
        if (!res.ok) {
          failures.push(`${url} -> HTTP ${res.status}`);
        } else if (
          res.redirected &&
          res.url.replace(/\/$/, '') !== url.replace(/\/$/, '')
        ) {
          // A 200 after following redirects is not good enough. CircleCI's
          // docs moved under /docs/guides/..., /docs/orbs/... and
          // /docs/reference/..., and every old path still 301s -- so a
          // legacy URL looks perfectly healthy to a `redirect: 'follow'`
          // check right up until those redirects are retired, at which
          // point every link in the app breaks at once. Record the
          // destination instead, and fail if the table has drifted back to
          // a path that only works via a redirect.
          failures.push(
            `${url} -> redirects to ${res.url} (use the canonical URL)`,
          );
        }
      } catch (err) {
        // Could be "no network" (this sandbox) or a genuine DNS/host
        // failure (a typo'd domain) -- only the latter should fail the
        // test, and the only way to tell them apart here is whether *any*
        // other URL in the table succeeded. If nothing ever reaches the
        // network, this whole check is skipped rather than failed -- see
        // the assertion below.
        failures.push(
          `${url} -> ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!networkReachable) {
      // eslint-disable-next-line no-console -- deliberately visible in CI output, not a silent skip.
      console.warn(
        `docsLinks.test.ts: no outbound network reachable -- skipping the live link-resolution check for ${urls.length} URLs.`,
      );
      return;
    }

    expect(failures).toEqual([]);
  }, 60_000);
});

// Issue #89's "a docs link to the orb registry entry" -- a per-orb URL
// built off DOCS_LINKS.orbs.registry.url rather than one more fixed table
// entry, since there's one of these per orb in the registry, not a fixed
// handful (see orbDocsUrl's own doc comment for why that rules out this
// file's live per-URL check).
describe('orbDocsUrl', () => {
  it('builds a "/orb/<namespace>/<name>" path off the registry base URL', () => {
    expect(orbDocsUrl('circleci', 'node')).toBe(
      `${DOCS_LINKS.orbs.registry.url}/orb/circleci/node`,
    );
  });

  it('returns undefined for a missing namespace or name rather than a broken link', () => {
    expect(orbDocsUrl('', 'node')).toBeUndefined();
    expect(orbDocsUrl('circleci', '')).toBeUndefined();
  });
});

describe('sanity: the table itself, not just its shape', () => {
  it('every executors/images entry points at a page about execution environments or images, not something unrelated', () => {
    expect(DOCS_LINKS.executors.docker.url).toContain('docker');
    expect(DOCS_LINKS.executors.macos.url).toContain('macos');
    expect(DOCS_LINKS.executors.windows.url).toContain('windows');
  });
});

// Issue #103's "citations... inherit the canonical-URL guarantee": an
// MCP-returned URL that matches a curated entry should resolve to that
// entry, not be treated as an arbitrary external string.
describe('lookupDocLink (issue #103 citation matching)', () => {
  it('finds an exact match', () => {
    expect(lookupDocLink(DOCS_LINKS.orbs.intro.url)).toEqual(
      DOCS_LINKS.orbs.intro,
    );
  });

  it('matches regardless of a query string or #fragment on either side', () => {
    // resourceClass.url is itself `...configuration-reference/#resourceclass`
    // -- insert the query string *before* the `#` so it lands in
    // URL.search rather than becoming part of the fragment.
    const withQuery = DOCS_LINKS.executors.resourceClass.url.replace(
      '#',
      '?utm_source=kapa#',
    );
    expect(lookupDocLink(withQuery)).toEqual(
      DOCS_LINKS.executors.resourceClass,
    );
  });

  it('matches a step anchor URL built by stepDocsUrl', () => {
    const url = stepDocsUrl('save_cache');
    expect(url).toBeDefined();
    expect(lookupDocLink(url!)?.label).toBe('save_cache step');
  });

  it('returns undefined for a URL not in the table', () => {
    expect(
      lookupDocLink('https://circleci.com/docs/some/unrelated/page/'),
    ).toBeUndefined();
  });

  it('returns undefined, not a throw, for a malformed URL', () => {
    expect(lookupDocLink('not a url at all')).toBeUndefined();
  });
});
