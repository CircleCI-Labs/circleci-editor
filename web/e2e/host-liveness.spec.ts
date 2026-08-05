import { expect, test } from '@playwright/test';

import { FIXTURE_COMMENT, mockHostApi } from './fixtures';

/**
 * Issue #110's central risk, driven end-to-end: after the host process
 * dies, this single-page app keeps the whole document in memory and stays
 * fully responsive, so the failure this suite exists to catch is someone
 * working for a while in a window that still looks healthy and only
 * discovering the tool is dead when Save fails. `fixtures.ts`'s
 * `killHost()` simulates that death without a real Go process to kill --
 * see its own doc comment for how.
 */
test.describe('host liveness (issue #110)', () => {
  test('does not show the overlay while the host is reachable', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');

    await expect(
      page.getByText(/connection to circleci-editor was lost/i),
    ).toHaveCount(0);
  });

  test('blocks the page and offers to recover unsaved changes once the host is gone', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const hostApi = await mockHostApi(page);
    await page.goto('/');

    // Dirty the document before killing the host -- this is the whole
    // scenario: an edit made in a window whose host has since died.
    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n# e2e-unsaved-note');

    await hostApi.killHost();

    const overlay = page.getByText(/connection to circleci-editor was lost/i);
    await expect(overlay).toBeVisible();

    // Not a toast: the whole point is that the page stops presenting
    // itself as a live editor. Proven here by checking that the editor
    // underneath is no longer a valid click target -- `{ trial: true }`
    // performs Playwright's actionability check without actually
    // clicking, and it fails precisely because the overlay now sits on
    // top of the button and intercepts pointer events.
    await expect(async () => {
      await page
        .getByRole('button', { name: 'Review and save config' })
        .click({ trial: true, timeout: 500 });
    }).rejects.toThrow();

    // Recovery action 1: download. The exact bytes matter as much as the
    // filename -- this is the one copy of the edit that can still reach
    // disk.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /download config\.yml/i }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('config.yml');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const downloaded = Buffer.concat(chunks).toString('utf-8');
    expect(downloaded).toContain(FIXTURE_COMMENT);
    expect(downloaded).toContain('e2e-unsaved-note');

    // Recovery action 2: copy to clipboard -- same content, the other way
    // out of the tab.
    await page.getByRole('button', { name: /copy to clipboard/i }).click();
    await expect(page.getByRole('button', { name: /^copied$/i })).toBeVisible();
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toContain('e2e-unsaved-note');
    expect(clipboardText).toBe(downloaded);
  });

  test('when there are no unsaved changes, says so and attempts to close the window itself', async ({
    page,
  }) => {
    // Spying, not letting the real thing happen: actually closing the
    // Playwright-controlled page here would tear down the rest of the
    // test. This is exactly the "best-effort, might not be honored" call
    // `HostGoneOverlay`'s own comment describes -- this sandboxed
    // environment can't confirm what a real, non-automated browser window
    // would do here.
    await page.addInitScript(() => {
      (window as unknown as { __closeCalled: boolean }).__closeCalled = false;
      window.close = () => {
        (window as unknown as { __closeCalled: boolean }).__closeCalled = true;
      };
    });

    const hostApi = await mockHostApi(page);
    await page.goto('/');

    await hostApi.killHost();

    await expect(page.getByText(/you can close this tab/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /download/i })).toHaveCount(
      0,
    );

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __closeCalled: boolean }).__closeCalled,
        ),
      )
      .toBe(true);
  });
});
