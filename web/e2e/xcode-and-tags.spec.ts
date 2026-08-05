import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issues #211 (and #203) and #213 in the real built app: the macOS executor's Xcode
 * field, the `xcode:` completion in the YAML pane, and the Docker image tag
 * combobox that replaced a row of buttons.
 *
 * Worth browser tests because all three are about what a user can *reach*. The Xcode
 * list is only a fix if the unsupported `15.3.0` is genuinely no longer offered; the
 * completion is only a fix if it appears where the caret is; and the tag combobox is
 * only a fix if typing narrows it and free text still commits.
 *
 * The versions and tags come from the `/api/xcode-versions` and `/api/docker-tags`
 * stubs in `fixtures.ts`. What the host extracts from CircleCI's own vendored table
 * is pinned in `internal/guides/xcodeversions_test.go`.
 */

async function openJobDialog(page: Page, cardName: RegExp) {
  await page.getByRole('button', { name: cardName }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('the macOS card offers CircleCI’s supported Xcode versions, defaulting to a non-beta', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openJobDialog(page, /^macOS\b/);

  const dialog = page.getByRole('dialog');
  const xcode = dialog.getByLabel('Xcode version', { exact: true });

  // Issue #203: the old field was a text input pre-filled with `15.3.0`, a version
  // CircleCI does not offer. The default is now derived, and it is not a beta even
  // though the table's newest row is one.
  await expect(xcode).toHaveValue('26.5');
  await expect(xcode.locator('option[value="15.3.0"]')).toHaveCount(0);

  // Pre-releases are offered, in their own group, in upstream's own words.
  await expect(
    xcode
      .locator('optgroup')
      .evaluateAll((groups) =>
        groups.map((group) => (group as HTMLOptGroupElement).label),
      ),
  ).resolves.toEqual(['Supported', 'Pre-release (not frozen -- may change)']);

  // The escape hatch survives, so an Xcode released today is writable before the
  // vendored snapshot refreshes.
  await expect(xcode.locator('option[value="__custom__"]')).toHaveCount(1);

  // And the field names the table it came from.
  await expect(
    dialog.getByRole('link', { name: /supported-Xcode table/ }),
  ).toBeVisible();
});

test('choosing a pre-release Xcode says what that means for the job', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openJobDialog(page, /^macOS\b/);

  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Xcode version', { exact: true })
    .selectOption('27.0');

  // Not just "this is a beta" -- what a beta does to a build. Upstream's own beta
  // section is where the wording comes from.
  await expect(dialog.getByText(/CircleCI lists Xcode 27\.0 as a beta/)) //
    .toBeVisible();
  await expect(dialog.getByText(/not\s+frozen/)).toBeVisible();
});

test('a macOS job writes the chosen Xcode version, quoted where YAML needs it', async ({
  page,
}) => {
  const host = await mockHostApi(page);
  await page.goto('/');
  await openJobDialog(page, /^macOS\b/);

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /create job/i }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Review and save config' }).click();
  const saveDialog = page.getByRole('dialog');
  // `26.5` unquoted is a YAML float, which is a different value from the string
  // CircleCI's table lists -- and the difference only shows up when CircleCI
  // rejects the config.
  await expect(saveDialog.getByText('xcode: "26.5"')).toBeVisible();
  await saveDialog.getByRole('button', { name: 'Save changes' }).click();

  await expect.poll(() => host.getSaveCount()).toBeGreaterThan(0);
  const saved = host.getSavedConfig();
  expect(saved).toContain('xcode: "26.5"');
  expect(saved).not.toContain('15.3.0');
});

/**
 * `mockHostApi` deliberately does not stub `GET /api/schema` -- most specs want
 * schema-driven features to degrade to "no schema". A completion spec needs the
 * opposite: with no schema the completion source is an empty `override` array and
 * nothing can complete regardless of triggering. Same helper, and the same lesson,
 * as `completion-on-delete.spec.ts`.
 */
async function mockSchema(page: Page): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    await route.fulfill({
      json: { properties: { version: {}, jobs: {}, workflows: {} } },
    });
  });
}

/** A config with a macOS job, so the caret can be put inside a real `xcode:` value. */
const MACOS_CONFIG = `# Managed by the platform team -- do not edit by hand.
version: 2.1

jobs:
  ios:
    macos:
      xcode: 26.4.1
    steps:
      - checkout

workflows:
  build:
    jobs:
      - ios
`;

test('editing an xcode: value completes the supported versions, and re-offers them on delete', async ({
  page,
}) => {
  await mockHostApi(page, { config: MACOS_CONFIG });
  await mockSchema(page);
  await page.goto('/');

  // Driven through the real editor: the point is *when CodeMirror asks* and what
  // the source answers at that caret, neither of which a unit test reaches.
  const xcodeLine = page
    .locator('.cm-content .cm-line', { hasText: 'xcode: 26.4.1' })
    .first();
  await expect(xcodeLine).toBeVisible();
  await xcodeLine.click();
  await page.keyboard.press('End');

  // Deleting is the commonest way to change a version you already have, which is
  // exactly why `reopenCompletionOnDelete` exists -- so the popup comes back
  // rather than leaving the user to re-trigger it by hand.
  await page.keyboard.press('Backspace');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  // `26.4.` now: still the 26 line, so the 26.x versions are offered.
  await expect(popup).toContainText('26.4.1');

  // Delete back to nothing and the whole list is offered again.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('26.5');
  await expect(popup).toContainText('26.4.1');
  // The invented version is not completable, because it is not in the table.
  await expect(popup).not.toContainText('15.3.0');

  // And typing narrows by prefix.
  await page.keyboard.type('26.4');
  await expect(popup).toContainText('26.4.1');
  await expect(popup).not.toContainText('26.5');
});

test('the Docker image tag control is a combobox: type to filter, free text still commits', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openJobDialog(page, /^Docker\b/);

  const dialog = page.getByRole('dialog');
  // The Docker card starts on `cimg/base`; pick a repo with tags in the stub.
  await dialog.getByRole('option', { name: /cimg\/node/ }).click();

  const tag = dialog.getByRole('combobox', { name: 'Image tag' });
  await tag.click();

  // Issue #213: one input with a filtered popup, not a wrapped row of buttons.
  const list = dialog.getByRole('listbox', {
    name: /Published cimg\/node tags/,
  });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(4);
  // #77's recommendation framing survives the control change.
  await expect(list).toContainText('Recommended');
  await expect(list).toContainText('newest');

  // Type to filter -- the actual requirement at this scale.
  await tag.fill('browsers');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option')).toContainText('20.11.0-browsers');

  // Arrow keys and Enter commit the highlighted option.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Image', { exact: true })).toHaveValue(
    'cimg/node:20.11.0-browsers',
  );

  // Free text still commits, so a tag published minutes ago is writable now.
  await tag.fill('99.9.9');
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Image', { exact: true })).toHaveValue(
    'cimg/node:99.9.9',
  );
});

test('typing a mutable tag warns, citing CircleCI, without refusing it', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openJobDialog(page, /^Docker\b/);

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option', { name: /cimg\/node/ }).click();

  const tag = dialog.getByRole('combobox', { name: 'Image tag' });
  await tag.fill('latest');
  await page.keyboard.press('Enter');

  // #77's warning off `latest` survives, and now fires at the moment someone does
  // the thing rather than sitting next to an option nobody picked.
  await expect(dialog.getByText(/is a mutable tag/)).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: /Why not to pin a mutable tag/ }),
  ).toBeVisible();
  // Warned, not blocked: the value the user asked for is what the field holds.
  await expect(dialog.getByLabel('Image', { exact: true })).toHaveValue(
    'cimg/node:latest',
  );
});
