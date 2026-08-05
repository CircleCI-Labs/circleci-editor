import { expect, test } from '@playwright/test';

import { FIXTURE_COMMENT, mockHostApi } from './fixtures';

/**
 * The single most important guarantee this editor makes: every visual edit
 * is a surgical AST mutation, so comments and formatting must survive a
 * real save. This spec types into the YAML editor, opens the save
 * confirmation dialog (which must show a diff before writing anything),
 * confirms the save, and inspects the body actually sent to
 * `PUT /api/config` -- not just what's shown in the editor -- to prove the
 * fixture's original comment made it all the way through a real browser
 * round trip. A prior version of this project shipped a regression exactly
 * here: comments silently vanished on save.
 */
test('typing, saving, and confirming preserves the original comment on write', async ({
  page,
}) => {
  const hostApi = await mockHostApi(page);
  await page.goto('/');

  // Sanity check: the comment is present before we touch anything.
  const editorTextBefore = await page.locator('.cm-content').innerText();
  expect(editorTextBefore).toContain(FIXTURE_COMMENT.replace(/^#\s*/, ''));

  // Insert a new line at the very start of the document -- this dirties the
  // editor without touching the fixture's own comment line, which is what
  // we're asserting survives.
  await page.locator('.cm-line').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.type('# e2e-appended-note\n');

  const saveButton = page.getByRole('button', {
    name: 'Review and save config',
  });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  // The confirmation dialog must show a real diff before anything is
  // written -- this is the trust mechanism the product relies on.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No changes to save.')).toHaveCount(0);
  await expect(dialog.getByText('e2e-appended-note')).toBeVisible();

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);

  const saved = hostApi.getSavedConfig();
  expect(saved).not.toBeNull();
  expect(saved).toContain(FIXTURE_COMMENT);
  expect(saved).toContain('e2e-appended-note');
});
