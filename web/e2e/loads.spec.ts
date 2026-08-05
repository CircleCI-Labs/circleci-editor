import { expect, test } from '@playwright/test';

import { FIXTURE_CONFIG_PATH, FIXTURE_COMMENT, mockHostApi } from './fixtures';

test.describe('app shell', () => {
  test.beforeEach(async ({ page }) => {
    await mockHostApi(page);
  });

  test('loads and shows the three panes with the config path and content', async ({
    page,
  }) => {
    // Wider than Playwright's 1280 default so the app bar is at its `full`
    // tier, where the *absolute* config path is shown. Below that the bar
    // shortens the path by design (issue #154's collapse ladder) and the full
    // form lives in its `title` -- a different assertion, made by
    // `responsive-layout.spec.ts`.
    //
    // This width tracks the `full` threshold, which moves whenever the bar's
    // measured furniture does. 1366 was enough until issue #214 added the branch
    // and repository cells, which put `full`'s own furniture at 1421px and so its
    // threshold at 1436; before that, #149's org/project display had moved it by
    // 110px. 1500 is comfortably clear rather than one pixel over -- this test is
    // about the path, not about the ladder.
    await page.setViewportSize({ width: 1500, height: 800 });
    await page.goto('/');

    // The three panes, identified by their panel headings -- resilient to
    // any restyling as long as the section titles stay put.
    await expect(
      page.getByRole('heading', { name: 'AI Assistant' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
    await expect(
      page.locator('h2').filter({ hasText: 'config.yml' }),
    ).toBeVisible();

    // The config path from the mocked GET /api/meta is surfaced in the app
    // bar. `exact: true` dates from when the AI pane's "what this request
    // will send" transparency line (issue #92) mentioned the same path -- a
    // real second occurrence, not a test bug to work around. #253 deleted
    // that line, and the exact match is kept regardless: matching the app
    // bar's own text is what this assertion means.
    await expect(
      page.getByText(FIXTURE_CONFIG_PATH, { exact: true }),
    ).toBeVisible();

    // The YAML pane's editor renders the fixture's text, including its
    // comment -- a basic sanity check that the loaded config actually made
    // it into the editor unmodified.
    const editorText = await page.locator('.cm-content').innerText();
    expect(editorText).toContain(FIXTURE_COMMENT.replace(/^#\s*/, ''));
    expect(editorText).toContain('version: 2.1');
    expect(editorText).toContain('build_test_deploy');
  });
});
