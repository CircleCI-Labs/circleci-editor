import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Browser end-to-end coverage for the guides half of the reference pane
 * (issue #104, widened by #176): CircleCI's config-adjacent documentation,
 * rendered in-app from the AsciiDoc snapshot the Go host parses
 * (`internal/guides`), plus this project's own pages about the editor.
 *
 * These specs drive the *real built bundle* against a stubbed `GET /api/guides`,
 * because that endpoint's own behaviour (snapshot, checksums, TTL refresh,
 * degraded responses) is already covered by Go tests in `internal/guides` and
 * `internal/host`. What only a browser can prove is what this file asserts:
 * that the block model actually *renders* -- headings, prose, a verbatim YAML
 * sample, a table, an admonition, an in-pane cross-reference -- and that the
 * schema-derived key browser really does hand off to it.
 *
 * The fixture is a faithful excerpt of the real payload, taken from the shapes
 * `internal/guides` emits for these exact sections, rather than an invented
 * one.
 */

const CONFIGURATION_REFERENCE = {
  id: 'configuration-reference',
  origin: 'circleci',
  category: 'Configuration reference',
  title: 'Configuration reference',
  description: 'Reference for .circleci/config.yml',
  url: 'https://circleci.com/docs/reference/configuration-reference/',
  lead: [
    {
      kind: 'paragraph',
      spans: [
        {
          kind: 'text',
          text: 'This document is a reference for the CircleCI 2.x configuration keys.',
        },
      ],
    },
  ],
  anchors: {
    version: 'version',
    savecache: 'savecache',
    'the-when-attribute': 'savecache',
  },
  sections: [
    {
      id: 'version',
      level: 2,
      title: 'version',
      titleSpans: [{ kind: 'code', text: 'version' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#version',
      keys: ['version'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'The ' },
            { kind: 'code', text: 'version' },
            {
              kind: 'text',
              text: ' field is intended to be used in order to issue warnings for deprecation.',
            },
          ],
        },
        {
          kind: 'table',
          table: {
            header: [
              { spans: [{ kind: 'text', text: 'Key' }] },
              { spans: [{ kind: 'text', text: 'Required' }] },
              { spans: [{ kind: 'text', text: 'Type' }] },
            ],
            rows: [
              [
                { spans: [{ kind: 'code', text: 'version' }] },
                { spans: [{ kind: 'text', text: 'Y' }] },
                { spans: [{ kind: 'text', text: 'String' }] },
              ],
            ],
          },
        },
        {
          kind: 'code',
          title: 'Version',
          language: 'yaml',
          text: 'version: 2.1',
        },
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'See the ' },
            {
              kind: 'ref',
              text: 'save_cache',
              target: 'savecache',
              children: [{ kind: 'code', text: 'save_cache' }],
            },
            { kind: 'text', text: ' section below.' },
          ],
        },
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'Upstream links out too: ' },
            {
              kind: 'link',
              text: 'Reusable Configuration',
              url: 'https://circleci.com/docs/reference/reusing-config/',
            },
          ],
        },
      ],
    },
    {
      id: 'savecache',
      level: 3,
      title: 'save_cache',
      titleSpans: [{ kind: 'code', text: 'save_cache' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#savecache',
      keys: ['save_cache'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            {
              kind: 'text',
              text: 'Generates and stores a cache of a file or directory of files.',
            },
          ],
        },
        {
          kind: 'code',
          language: 'yaml',
          text: '- save_cache:\n    key: v1-myapp\n    paths:\n      - /home/ubuntu/.m2',
        },
        {
          kind: 'admonition',
          admonition: 'NOTE',
          blocks: [
            {
              kind: 'paragraph',
              spans: [
                {
                  kind: 'text',
                  text: 'Wildcards are not currently supported in save_cache paths.',
                },
              ],
            },
          ],
        },
        {
          kind: 'note',
          spans: [
            {
              kind: 'text',
              text: 'This part of the page (guides:ROOT:partial$notes/gone.adoc) is not included in the offline snapshot: it was not part of the snapshot. ',
            },
            {
              kind: 'link',
              text: 'Read it on circleci.com',
              url: 'https://circleci.com/docs/reference/configuration-reference/',
            },
          ],
        },
      ],
    },
  ],
};

const REUSING_CONFIG = {
  id: 'reusing-config',
  origin: 'circleci',
  category: 'Configuration reference',
  title: 'Reusable config reference',
  url: 'https://circleci.com/docs/reference/reusing-config/',
  anchors: { 'the-commands-key': 'the-commands-key' },
  sections: [
    {
      id: 'the-commands-key',
      level: 3,
      title: 'The commands key',
      titleSpans: [{ kind: 'text', text: 'The commands key' }],
      url: 'https://circleci.com/docs/reference/reusing-config/#the-commands-key',
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            {
              kind: 'text',
              text: 'A command definition defines a sequence of steps as a map.',
            },
          ],
        },
      ],
    },
  ],
};

const DYNAMIC_CONFIG = {
  id: 'dynamic-config',
  origin: 'circleci',
  category: 'Dynamic config',
  title: 'Dynamic configuration overview',
  url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
  anchors: { 'enable-dynamic-config': 'enable-dynamic-config' },
  sections: [
    {
      id: 'enable-dynamic-config',
      level: 3,
      title: 'Enable dynamic configuration',
      titleSpans: [{ kind: 'text', text: 'Enable dynamic configuration' }],
      url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/#enable-dynamic-config',
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            {
              kind: 'text',
              text: 'Set up dynamic configuration in your project settings.',
            },
          ],
        },
      ],
    },
  ],
};

/**
 * This project's *own* page about the editor (issue #176): `origin: 'editor'`,
 * a URL in this repository rather than on circleci.com, and prose that says so.
 */
const EDITOR_GUIDE = {
  id: 'using-this-editor',
  origin: 'editor',
  category: 'This editor',
  title: 'Using this editor',
  url: 'https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor/using-this-editor.adoc',
  lead: [
    {
      kind: 'paragraph',
      spans: [
        {
          kind: 'text',
          text: 'This page is about this application, and is not official CircleCI documentation.',
        },
      ],
    },
  ],
  anchors: { 'the-panes': 'the-panes' },
  sections: [
    {
      id: 'the-panes',
      level: 2,
      title: 'The panes',
      titleSpans: [{ kind: 'text', text: 'The panes' }],
      url: 'https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor/using-this-editor.adoc#the-panes',
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            {
              kind: 'text',
              text: 'Five panes, each independently movable and collapsible.',
            },
          ],
        },
      ],
    },
  ],
};

const GUIDES_PROVENANCE = {
  repo: 'circleci/circleci-docs',
  // Issue #286: the snapshot now records the ref it was pinned from, not just
  // the commit -- a bare SHA answers "which bytes" but not "is this current".
  ref: 'main',
  commit: '447dc483ede459622c680265e914768f67aafce6',
  committedAt: '2026-07-28T20:35:15Z',
  fetchedAt: '2026-07-29T00:00:00Z',
  source: 'vendored',
  refreshing: false,
};

const GUIDES_LINKS = [
  {
    id: 'configuration-reference',
    label: 'Configuration reference',
    url: 'https://circleci.com/docs/reference/configuration-reference/',
  },
  {
    id: 'reusing-config',
    label: 'Reusable config',
    url: 'https://circleci.com/docs/reference/reusing-config/',
  },
  {
    id: 'dynamic-config',
    label: 'Dynamic config',
    url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
  },
  {
    id: 'using-this-editor',
    label: 'Using this editor',
    url: 'https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor/using-this-editor.adoc',
  },
];

/** A minimal schema, enough for the Keys view to have a `save_cache` step to select. */
const MINIMAL_SCHEMA = {
  properties: {
    version: { description: 'Config version, e.g. 2.1.' },
    jobs: { markdownDescription: 'Collections of steps run in an executor.' },
    display: {},
  },
  definitions: {
    saveCacheStep: {
      properties: {
        save_cache: {
          properties: {
            paths: { type: 'array' },
            key: { type: 'string' },
          },
          required: ['paths', 'key'],
        },
      },
    },
  },
};

async function mockSchema(page: Page): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    await route.fulfill({ json: MINIMAL_SCHEMA });
  });
}

type GuidesOverrides = Record<string, unknown>;

async function mockGuides(
  page: Page,
  overrides: GuidesOverrides = {},
): Promise<void> {
  await page.route('**/api/guides', async (route) => {
    await route.fulfill({
      json: {
        available: true,
        guides: [
          CONFIGURATION_REFERENCE,
          REUSING_CONFIG,
          DYNAMIC_CONFIG,
          EDITOR_GUIDE,
        ],
        provenance: GUIDES_PROVENANCE,
        links: GUIDES_LINKS,
        ...overrides,
      },
    });
  });
}

/** The reference pane starts collapsed in every preset (see `presets.ts`). */
async function openReference(page: Page): Promise<void> {
  await page.getByRole('button', { name: /expand reference panel/i }).click();
  await expect(page.getByRole('heading', { name: 'Reference' })).toBeVisible();
}

async function openGuides(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Guides' }).click();
}

/**
 * Clicks a section in the guides nav specifically. Scoped, because a section
 * title can legitimately appear twice on screen at once -- once in the nav and
 * once as an in-pane cross-reference in the prose (`save_cache` does exactly
 * that), which is the behaviour these specs are here to check rather than a
 * collision to rename away.
 */
async function selectSection(page: Page, name: string): Promise<void> {
  await page.getByTestId('guide-nav').getByRole('button', { name }).click();
}

/**
 * Chooses a guide through the picker.
 *
 * A grouped `<select>` since #176: a wrapping row of twenty-two buttons is
 * taller than the content it introduces, and a scrollable rail would have added
 * the second scroll region issue #88 records users objecting to.
 */
async function selectGuide(page: Page, guideId: string): Promise<void> {
  await page.getByLabel(/choose a guide/i).selectOption(guideId);
}

test.describe('Reference pane: the built-in guides (issue #104)', () => {
  test('renders all three guides, with real prose, a verbatim YAML sample, a table and an admonition', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    // Every guide the host served is selectable, grouped by category, in one
    // constant-height control rather than a wrapping row of buttons.
    const picker = page.getByLabel(/choose a guide/i);
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveText([
      'Configuration reference',
      'Reusable config reference',
      'Dynamic configuration overview',
      'Using this editor',
    ]);
    expect(
      await picker
        .locator('optgroup')
        .evaluateAll((groups) =>
          groups.map((group) => group.getAttribute('label')),
        ),
    ).toEqual(['Configuration reference', 'Dynamic config', 'This editor']);

    // The guide's own lead prose, before anything is selected -- never a blank
    // reading column.
    await expect(
      page.getByText(/This document is a reference for the CircleCI 2.x/),
    ).toBeVisible();

    await selectSection(page, 'version');

    // Prose with inline monospace intact.
    await expect(
      page.getByText(/field is intended to be used in order to issue/),
    ).toBeVisible();
    // The table, as a real table with a header.
    await expect(
      page.getByRole('columnheader', { name: 'Required' }),
    ).toBeVisible();
    // The code sample, byte-exact and with its caption.
    await expect(page.locator('pre code')).toHaveText('version: 2.1');
    await expect(page.getByText('Version', { exact: true })).toBeVisible();

    await selectSection(page, 'save_cache');
    await expect(
      page.getByText(/Generates and stores a cache of a file/),
    ).toBeVisible();
    // The admonition keeps its label and its own contents.
    await expect(page.getByText('NOTE', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Wildcards are not currently supported/),
    ).toBeVisible();
    // A YAML sample's exact indentation survives the round trip, because users
    // copy these into a config.
    await expect(page.locator('pre code')).toHaveText(
      '- save_cache:\n    key: v1-myapp\n    paths:\n      - /home/ubuntu/.m2',
    );
  });

  test('an in-pane cross-reference navigates the pane instead of leaving the app', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await selectSection(page, 'version');

    // `<<savecache>>` in the source became a button, not a link: the whole
    // point of having the guides in-app.
    const crossRef = page
      .getByTestId('guide-content')
      .getByRole('button', { name: 'save_cache' });
    await expect(crossRef).toBeVisible();
    await crossRef.click();

    await expect(
      page.getByText(/Generates and stores a cache of a file/),
    ).toBeVisible();

    // An upstream link, by contrast, stays a real outbound link.
    await selectSection(page, 'version');
    await expect(
      page.getByRole('link', { name: 'Reusable Configuration' }),
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/reusing-config/',
    );
  });

  test('search spans every guide, not only the selected one', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await page
      .getByLabel(/search the documentation guides/i)
      .fill('dynamic configuration in your project');

    const hit = page.getByRole('button', {
      name: /Enable dynamic configuration/,
    });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(
      page.getByText(/Set up dynamic configuration in your project settings/),
    ).toBeVisible();
  });

  test('the pane states which upstream commit the text came from and how old it is', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await expect(
      page.getByText(
        'circleci/circleci-docs@main · 447dc48 · pinned 2026-07-28',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Read on circleci.com/ }),
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/',
    );
  });

  // Twenty of the pages in this picker are CircleCI's and two are this
  // project's. Confusing the two would mean a reader drawing conclusions about
  // CircleCI from text CircleCI never wrote -- the more so because our pages are
  // deliberately blunt about what CircleCI's APIs do not expose (issue #176).
  test("marks this project's own pages as being about the editor, not as CircleCI documentation", async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    // CircleCI's page: their attribution in the pane header, and a way out to
    // circleci.com.
    await expect(page.getByText('CircleCI docs · offline')).toBeVisible();

    await selectGuide(page, 'using-this-editor');

    // Ours: the header badge stops attributing the page to CircleCI, and the
    // footer and the page's own prose say whose it is.
    await expect(page.getByText('CircleCI docs · offline')).toBeHidden();
    await expect(
      page.getByText('About this editor', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('About this editor · ships with this build'),
    ).toBeVisible();
    await expect(
      page.getByText(/is not official CircleCI documentation/),
    ).toBeVisible();

    // And no upstream provenance is claimed over it: that commit describes
    // CircleCI's bytes and says nothing about a page we wrote.
    await expect(
      page.getByText(
        'circleci/circleci-docs@main · 447dc48 · pinned 2026-07-28',
      ),
    ).toBeHidden();
    await expect(
      page.getByRole('link', { name: /Read on circleci.com/ }),
    ).toBeHidden();
    await expect(
      page.getByRole('link', { name: /View the source of this page/ }),
    ).toHaveAttribute('href', /github\.com\/CircleCI-Labs\/circleci-editor/);

    await selectSection(page, 'The panes');
    await expect(
      page.getByText(/Five panes, each independently movable/),
    ).toBeVisible();
  });

  // The pane's standing complaint (issue #88) is nested scrolling. The
  // picker had to grow from three entries to twenty-two without becoming a third
  // scroll region beside the section nav and the reading column.
  test('the widened guide list adds no new scrolling region', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    // Every element *inside the reference pane* that declares itself scrollable,
    // identified by test id. Asserted on the declared `overflow-y` rather than on
    // whether it currently overflows, so the result does not depend on the
    // viewport or on how much content the fixture happens to have.
    const scrollables = await page
      .getByLabel(/choose a guide/i)
      .evaluate((select) => {
        const pane = select.closest('section') ?? document.body;
        return Array.from(pane.querySelectorAll<HTMLElement>('*'))
          .filter((element) =>
            ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
          )
          .map((element) => element.dataset.testid ?? element.tagName);
      });

    // Three, and all three predate this change: `Panel`'s own content wrapper
    // (one per pane, `overflow-auto`, shared by every pane in the app) plus the
    // section nav and the reading column the Guides view has always had. The
    // picker is not among them.
    expect(scrollables.sort()).toEqual(['DIV', 'guide-content', 'guide-nav']);
  });

  test('a failed background refresh is reported without hiding the cached content', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page, {
      provenance: {
        ...GUIDES_PROVENANCE,
        error: 'fetch guides: dial tcp: lookup raw.githubusercontent.com',
      },
    });
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await expect(page.getByText(/last update check failed/i)).toBeVisible();
    // The content is right there regardless -- a stale reference beats none.
    await expect(
      page.getByText(/This document is a reference for the CircleCI 2.x/),
    ).toBeVisible();
  });

  // Issue #285: the manual "check now" refresh button in the guide footer.
  test('the footer Refresh button sends refresh=1 and shows the checked-for-updates result', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);

    let refreshRequested = false;
    await page.route('**/api/guides**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('refresh') === '1') {
        refreshRequested = true;
        await route.fulfill({
          json: {
            available: true,
            guides: [
              CONFIGURATION_REFERENCE,
              REUSING_CONFIG,
              DYNAMIC_CONFIG,
              EDITOR_GUIDE,
            ],
            provenance: {
              ...GUIDES_PROVENANCE,
              commit: 'ffffffffffffffffffffffffffffffffffffffff',
              fetchedAt: '2026-07-30T00:00:00Z',
            },
            links: GUIDES_LINKS,
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          available: true,
          guides: [
            CONFIGURATION_REFERENCE,
            REUSING_CONFIG,
            DYNAMIC_CONFIG,
            EDITOR_GUIDE,
          ],
          provenance: GUIDES_PROVENANCE,
          links: GUIDES_LINKS,
        },
      });
    });

    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await expect(
      page.getByText(GUIDES_PROVENANCE.commit.slice(0, 7)),
    ).toBeVisible();

    await page.getByRole('button', { name: /^refresh$/i }).click();
    expect(refreshRequested).toBe(true);

    await expect(page.getByText('fffffff')).toBeVisible();
    // The content is still right there -- a refresh only ever replaces it.
    await expect(
      page.getByText(/This document is a reference for the CircleCI 2.x/),
    ).toBeVisible();
  });

  test('a part of the page the snapshot could not reproduce says so, and links out', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);
    await openGuides(page);

    await selectSection(page, 'save_cache');

    // Never a silent hole: the reader is told there is more on the live page.
    const note = page.getByTestId('guide-parser-note');
    await expect(note).toContainText('not included in the offline snapshot');
    await expect(
      note.getByRole('link', { name: 'Read it on circleci.com' }),
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/',
    );
  });

  test('degrades honestly, with an explanation and outbound links, when the host cannot supply the guides', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.route('**/api/guides', async (route) => {
      await route.fulfill({ status: 500, body: 'boom' });
    });
    await page.goto('/');
    await openReference(page);

    // The Keys view is entirely unaffected: it reads a different endpoint.
    await expect(page.getByRole('button', { name: 'version' })).toBeVisible();

    await openGuides(page);
    await expect(page.getByText(/built-in guides unavailable/i)).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Dynamic config/ }).first(),
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
    );
    // Only CircleCI's canonical pages are offered here, and that is right: the
    // host never answered, so the SPA falls back to its own hard-coded link
    // table (`useGuides`) rather than guessing at a page set it never received.
    // ...and the rest of the app still works.
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
  });

  test('the Keys view hands off to the matching guide section, and labels orb-authoring keys', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await mockGuides(page);
    await page.goto('/');
    await openReference(page);

    // `display` has no schema description *and* no section in the
    // configuration reference -- issue #104's originating complaint. It is
    // sectioned and explained rather than shown as a bare word.
    await expect(page.getByText('Orb authoring only')).toBeVisible();
    await page.getByRole('button', { name: 'display' }).click();
    await expect(page.getByText(/an orb-authoring key/i)).toBeVisible();

    // A key the guide *does* document offers the prose, and one click lands in
    // the Guides view at that exact section.
    await page.getByRole('button', { name: 'version' }).click();
    await expect(
      page.getByText(/from the configuration reference/i),
    ).toBeVisible();
    await page
      .getByRole('button', { name: /read the full "version" section/i })
      .click();

    await expect(page.getByRole('tab', { name: 'Guides' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByText(/field is intended to be used in order to issue/),
    ).toBeVisible();
  });
});
