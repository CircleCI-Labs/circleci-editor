import { expect, test } from '@playwright/test';

import { FIXTURE_CONFIG, FIXTURE_CONFIG_PATH, mockHostApi } from './fixtures';
import { openConfigFile } from './switcher';

/**
 * Issue #177's first half, in a real browser: closing the window with unsaved
 * changes must produce the browser's own "Leave site?" confirmation, and
 * closing it with nothing unsaved must not.
 *
 * Only a real browser can prove this. `beforeunload` is the one event whose
 * effect is entirely up to the user agent -- the page cannot choose the
 * wording, cannot force the dialog, and (in Chromium) gets no dialog at all
 * without prior user interaction on the page. jsdom, where
 * `useBeforeUnloadGuard.test.ts` lives, can only check that the handler
 * cancels the event; whether that turns into a prompt is what these specs
 * check.
 *
 * `page.close({ runBeforeUnload: true })` is the deliberate window close.
 * Playwright's default close skips `beforeunload` entirely, which is exactly
 * the difference being exercised here.
 */

const SECOND_CONFIG_PATH = '/home/dev/widgets/.circleci/continue-config.yml';
const SECOND_CONFIG = `version: 2.1

jobs:
  continue:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
`;

/**
 * Stubs a two-file `.circleci` so a spec can dirty one file and switch to the
 * other. `fixtures.ts`' default listing is deliberately single-file (see its
 * own note), so multi-file specs bring their own.
 */
async function mockTwoConfigFiles(page: import('@playwright/test').Page) {
  await page.route('**/api/config-files**', async (route) => {
    await route.fulfill({
      json: {
        dir: '/home/dev/widgets/.circleci',
        primaryPath: FIXTURE_CONFIG_PATH,
        files: [
          {
            path: FIXTURE_CONFIG_PATH,
            relPath: 'config.yml',
            size: FIXTURE_CONFIG.length,
            isPrimary: true,
            isConfig: true,
            configReason: 'Declares version: 2.1.',
          },
          {
            path: SECOND_CONFIG_PATH,
            relPath: 'continue-config.yml',
            size: SECOND_CONFIG.length,
            isPrimary: false,
            isConfig: true,
            configReason: 'Declares version: 2.1.',
          },
        ],
      },
    });
  });

  // Only `?path=`-carrying reads are answered here; the app's initial,
  // unparameterized GET falls back to the fixture.
  await page.route('**/api/config?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path !== SECOND_CONFIG_PATH) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { path: SECOND_CONFIG_PATH, contents: SECOND_CONFIG, exists: true },
    });
  });
}

/**
 * Closes the page the way a user closes the window and reports the type of
 * whatever dialog that raised, or null if it raised none. Dismissing rather
 * than accepting keeps the two outcomes distinguishable: an accepted
 * `beforeunload` and an absent one both end with the page closed.
 */
async function closeWindowAndCaptureDialog(
  page: import('@playwright/test').Page,
): Promise<string | null> {
  let dialogType: string | null = null;
  page.on('dialog', (dialog) => {
    dialogType = dialog.type();
    void dialog.dismiss();
  });

  await page.close({ runBeforeUnload: true });
  // `page.close` resolves without waiting for a dialog that may still be on
  // its way, so give one a bounded chance to arrive. Deliberately not
  // `page.waitForTimeout`: when no dialog is raised -- the outcome the
  // negative spec asserts -- the page really does close, and waiting *on the
  // page* would then throw "target closed" instead of reporting the absence.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return dialogType;
}

test.describe('unsaved-changes warning on window close (issue #177)', () => {
  test('does not warn when nothing is unsaved', async ({ page }) => {
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // A real interaction, with no edit: Chromium suppresses `beforeunload`
    // dialogs on a page the user has never touched, so clicking here is what
    // makes this a genuine "the app chose not to warn" result rather than a
    // pass the browser handed over for free.
    await page.locator('.cm-line').first().click();

    expect(await closeWindowAndCaptureDialog(page)).toBeNull();
  });

  test('warns when the open file has unsaved changes', async ({ page }) => {
    await mockHostApi(page);
    await page.goto('/');

    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n# e2e-unsaved-note');

    expect(await closeWindowAndCaptureDialog(page)).toBe('beforeunload');
  });

  // The case the issue singles out: per-file state means switching away does
  // not discard the file you left, so the file on screen being clean
  // says nothing about whether there is work to lose.
  test('warns when a different file in .circleci has unsaved changes', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockTwoConfigFiles(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // Dirty config.yml...
    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n# e2e-unsaved-note');

    // ...then switch away from it. The editor now shows a clean file.
    await openConfigFile(page, 'continue-config.yml');
    await expect(page.locator('.cm-content')).toContainText('continue');
    await expect(page.locator('.cm-content')).not.toContainText(
      'e2e-unsaved-note',
    );

    expect(await closeWindowAndCaptureDialog(page)).toBe('beforeunload');
  });
});
