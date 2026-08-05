import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #108: *"The orbs section up at the top where we define orbs -- it'd
 * be nice to be able to do tab autocomplete for there."* There was no
 * orb-name completion source at all before this, so typing under `orbs:`
 * offered nothing.
 *
 * Driven through the real editor, not just `completion.test.ts`'s unit
 * coverage of `resolveOrbNameCompletions`/`resolveOrbVersionCompletions`:
 * this is the async branch of `createCircleciCompletionSource`, and (per
 * `completion-on-delete.spec.ts`'s own lesson, restated here on purpose) a
 * spec that forgets to stub `GET /api/schema` fails against *working* code,
 * since `mockHostApi` deliberately leaves that endpoint unstubbed for specs
 * that want "no schema" as their baseline.
 */

/** See `completion-on-delete.spec.ts` for why this stub exists at all. */
async function mockSchema(page: Page): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    await route.fulfill({
      json: { properties: { version: {}, orbs: {}, jobs: {}, workflows: {} } },
    });
  });
}

/**
 * Overrides `mockHostApi`'s own `/api/orbs/search` stub (which always
 * answers `{ results: [] }`, i.e. "nothing configured to search") with real
 * `internal/orbs`-shaped results, keyed by the "q" query parameter -- the
 * shape this suite actually needs to exercise the feature. Playwright runs
 * the most-recently-registered matching route first, so this simply
 * shadows the earlier one for the lifetime of the page.
 */
async function mockOrbSearch(
  page: Page,
  byQuery: Record<
    string,
    {
      name: string;
      certified: boolean;
      latestVersion: string;
      versions: string[];
      matchedOn: string;
    }[]
  >,
): Promise<void> {
  await page.route('**/api/orbs/search**', async (route) => {
    const q = (
      new URL(route.request().url()).searchParams.get('q') ?? ''
    ).toLowerCase();
    const results = byQuery[q] ?? [];
    await route.fulfill({
      json: {
        available: true,
        status: { ready: true, complete: true, count: 6354, warming: false },
        results: results.map((r) => ({
          name: r.name,
          private: false,
          certified: r.certified,
          listed: true,
          latestVersion: r.latestVersion,
          versions: r.versions,
          matchedOn: r.matchedOn,
        })),
      },
    });
  });
}

/** Positions the caret on a fresh, empty, two-space-indented line right after the fixture's `orbs:\n  node: circleci/node@5.2.0` entry, ready to type a new alias. */
async function openFreshOrbLine(page: Page): Promise<void> {
  const orbLine = page
    .locator('.cm-content .cm-line', { hasText: 'node: circleci/node@5.2.0' })
    .first();
  await orbLine.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  // Whatever auto-indent CodeMirror's YAML mode put on the new blank line,
  // select it and overwrite with an explicit two spaces -- so this test
  // doesn't depend on (or accidentally verify) auto-indent behaviour that
  // isn't what issue #108 is about.
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.keyboard.type('  ');
}

test("typing an orb's bare name under orbs: offers it without the namespace, and accepting inserts a full namespace/orb@version reference", async ({
  page,
}) => {
  await mockHostApi(page);
  await mockSchema(page);
  await mockOrbSearch(page, {
    slack: [
      {
        name: 'circleci/slack',
        certified: true,
        latestVersion: '4.12.0',
        versions: ['4.12.0', '4.11.3'],
        matchedOn: 'exact-name',
      },
    ],
  });
  await page.goto('/');

  await openFreshOrbLine(page);
  await page.keyboard.type('slack');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  await expect(
    popup.getByText('circleci/slack', { exact: true }),
  ).toBeVisible();

  // Click the option directly rather than driving it via ArrowDown+Enter --
  // CodeMirror applies a completion on `mousedown` over its `<li>`, and this
  // sidesteps a keyboard-focus race against CodeMirror's own re-render that
  // was observed to flake under `fullyParallel` load.
  await popup.getByText('circleci/slack', { exact: true }).click();

  const editorText = await page.locator('.cm-content').innerText();
  // The whole point of #108/#59: a full "<alias>: <namespace>/<orb>@<version>"
  // line, never a bare "slack@version".
  expect(editorText).toContain('slack: circleci/slack@4.12.0');
  expect(editorText).not.toMatch(/[^/]slack@4\.12\.0/); // no unnamespaced form snuck in anywhere
});

test('"act" resolves cci-labs/act without the namespace typed first', async ({
  page,
}) => {
  await mockHostApi(page);
  await mockSchema(page);
  await mockOrbSearch(page, {
    act: [
      {
        name: 'cci-labs/act',
        certified: false,
        latestVersion: '2.1.0',
        versions: ['2.1.0'],
        matchedOn: 'exact-name',
      },
    ],
  });
  await page.goto('/');

  await openFreshOrbLine(page);
  await page.keyboard.type('act');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  await expect(popup.getByText('cci-labs/act', { exact: true })).toBeVisible();

  // See the previous test for why this clicks the option directly.
  await popup.getByText('cci-labs/act', { exact: true }).click();

  const editorText = await page.locator('.cm-content').innerText();
  expect(editorText).toContain('act: cci-labs/act@2.1.0');
});

test("editing an existing orb reference's version behaves like editing an image tag: erasing it re-opens the version completions (#107)", async ({
  page,
}) => {
  await mockHostApi(page);
  await mockSchema(page);
  await mockOrbSearch(page, {
    'circleci/node': [
      {
        name: 'circleci/node',
        certified: true,
        latestVersion: '5.3.0',
        versions: ['5.3.0', '5.2.0', '5.1.0'],
        matchedOn: 'exact-full-name',
      },
    ],
  });
  await page.goto('/');

  const orbLine = page
    .locator('.cm-content .cm-line', { hasText: 'node: circleci/node@5.2.0' })
    .first();
  await orbLine.click();
  await page.keyboard.press('End');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toHaveCount(0); // clicking/moving the caret is not an edit

  // Erase "5.2.0" the way a person does, one character at a time -- exactly
  // `completion-on-delete.spec.ts`'s cimg-tag scenario, against an orb
  // reference instead of a docker image tag.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Backspace');
  }

  await expect(popup).toBeVisible();
  await expect(popup.getByText('5.3.0')).toBeVisible();
  await expect(popup.getByText('latest version')).toBeVisible();
});

// Issue #160: orb search itself no longer needs a token -- the public
// registry answers unauthenticated -- so completion under `orbs:` now works
// exactly the same with no token as with one. This replaces what used to be
// a "degrades to no completions without a token" test: that premise is no
// longer true, and asserting the old behaviour here would pin a regression
// rather than a feature.
test('typing under orbs: still completes from the public registry when the host has no token', async ({
  page,
}) => {
  await mockHostApi(page, { hasToken: false });
  await mockSchema(page);
  await mockOrbSearch(page, {
    slack: [
      {
        name: 'circleci/slack',
        certified: true,
        latestVersion: '4.12.5',
        versions: ['4.12.5'],
        matchedOn: 'exact-name',
      },
    ],
  });
  await page.goto('/');

  await openFreshOrbLine(page);
  await page.keyboard.type('slack');

  const editorText = await page.locator('.cm-content').innerText();
  expect(editorText).toContain('slack');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  await expect(
    popup.getByText('circleci/slack', { exact: true }),
  ).toBeVisible();
});

// The one thing a missing token still changes: this host cannot see a
// *private* orb, because an anonymous crawl never sees a private namespace
// -- see orb-filters.spec.ts's Private-filter coverage of the same fact.
// Completion degrades to nothing only when the host genuinely could not
// search at all, which is a different, and today hypothetical, response
// shape (`available: false`) than "no token".
test('typing under orbs: degrades to no completions only when the host reports search itself unavailable', async ({
  page,
}) => {
  await mockHostApi(page, { hasToken: false });
  await mockSchema(page);
  await page.route('**/api/orbs/search**', async (route) => {
    await route.fulfill({
      json: {
        available: false,
        reason: 'the orb registry could not be reached',
      },
    });
  });
  await page.goto('/');

  await openFreshOrbLine(page);
  await page.keyboard.type('slack');

  // Typing itself was never blocked by the pending (host-side-unavailable)
  // lookup -- the characters landed regardless.
  const editorText = await page.locator('.cm-content').innerText();
  expect(editorText).toContain('slack');

  // And no completion popup can appear for a search the host could not
  // even attempt.
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
});
