import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Regression test for the reported bug: "it doesn't always tab autocomplete,
 * like when I'm editing the version... I have cimg/python at 3.12, I start
 * erasing 3.12, I want to see 3.x -- I'm not seeing it." (Reproduced here
 * against the shared fixture's own pinned `cimg/node:20.0`.)
 *
 * `autocompletion({ activateOnTyping: true })` fires on input but never on
 * deletion, so the single most common way of changing a value you already have
 * offered no help at all. See `~/panes/yaml/reopenCompletionOnDelete`.
 *
 * Driven through the real editor rather than unit-testing the extension: the
 * bug was entirely about *when CodeMirror asks* the completion source, not
 * about what the source answers (which already had unit coverage and was
 * always correct here). Only a real editor exercises the trigger.
 */

/**
 * `mockHostApi` deliberately does not stub `GET /api/schema` -- most specs want
 * schema-driven features to degrade to "no schema", so it falls through to a
 * 404. This suite needs the opposite: with no schema the completion source is
 * an empty `override` array and nothing can complete regardless of triggering,
 * which is a much less interesting test than the one intended. (Learned the
 * hard way: this spec failed against the real, working fix until the stub was
 * added -- the product was fine, the harness wasn't.)
 */
async function mockSchema(page: Page): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    await route.fulfill({
      json: { properties: { version: {}, jobs: {}, workflows: {} } },
    });
  });
}

test('erasing an image tag re-opens the version completions', async ({
  page,
}) => {
  await mockHostApi(page);
  await mockSchema(page);
  // The tag list normally comes from the host's Docker Hub proxy. Stubbed so
  // this test asserts the *trigger*, and never depends on Docker Hub being
  // reachable from CI.
  await page.route('**/api/docker-tags**', async (route) => {
    await route.fulfill({
      json: {
        available: true,
        tags: ['22.14.0', '20.19.0', '18.20.7'],
        fetchedAt: '2026-07-28T00:00:00Z',
      },
    });
  });
  await page.goto('/');

  const imageLine = page
    .locator('.cm-content .cm-line', { hasText: 'cimg/node:20.0' })
    .first();
  await imageLine.click();
  await page.keyboard.press('End');

  const popup = page.locator('.cm-tooltip-autocomplete');
  // Nothing open yet: clicking and moving the caret is not an edit.
  await expect(popup).toHaveCount(0);

  // Erase "20.0" the way a person does, one character at a time.
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Backspace');
  }

  // The prefix is now `cimg/node:`, which the completion source has always
  // been able to answer -- nothing had asked it to.
  await expect(popup).toBeVisible();
  await expect(popup.getByText('22.14.0')).toBeVisible();
});

test('deleting ordinary text opens nothing', async ({ page }) => {
  await mockHostApi(page);
  await mockSchema(page);
  await page.goto('/');

  // A deletion in a spot with no completions must stay silent -- the fix asks
  // the source to run on every deletion, so "the source declines" is the thing
  // keeping this from being an popup that fires constantly.
  const versionLine = page
    .locator('.cm-content .cm-line', { hasText: 'version: 2.1' })
    .first();
  await versionLine.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');

  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
});
