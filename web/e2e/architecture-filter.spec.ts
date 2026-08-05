import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #212, in the real built app: what happens to a selected resource class when
 * the architecture filter no longer includes it.
 *
 * Worth a browser test rather than only unit coverage, because the defect was a
 * browser observation and so is the fix. The owner's words: "let's say I select ARM:
 * medium is already selected, and you can see that it's x86 medium as a selection...
 * that doesn't really make sense." What has to be *seen* is that the list narrows,
 * that the class the config actually holds is still named, that switching is offered
 * and only happens on request, and that the write which follows is one undoable
 * change to one line.
 *
 * The classes come from the `/api/resource-classes` stub in `fixtures.ts`.
 */

/** Opens the palette's Docker card, which opens the "New job" dialog. */
async function openDockerJobDialog(page: Page) {
  await page.getByRole('button', { name: /^Docker\b/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('choosing an architecture the current class is not in names it and changes nothing', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Resource class')).toHaveValue('medium');

  await dialog.getByLabel('Architecture').selectOption('arm64');

  // The class is named, with the fact that nothing has been written yet.
  const notice = dialog.getByRole('status');
  await expect(notice).toContainText('medium');
  await expect(notice).toContainText('not Arm (arm64)');
  await expect(notice).toContainText('nothing in your config has changed');

  // The switch is offered, not taken.
  await expect(
    dialog.getByRole('button', { name: /Switch to arm\.medium/ }),
  ).toBeVisible();
});

test('switching to the equivalent class is one keyboard action, and one undoable write', async ({
  page,
}) => {
  const host = await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  const architecture = dialog.getByLabel('Architecture');

  // Keyboard only, from the filter to the switch: no pointer at any step.
  await architecture.focus();
  await architecture.selectOption('arm64');
  const switchButton = dialog.getByRole('button', {
    name: /Switch to arm\.medium/,
  });
  await switchButton.focus();
  await expect(switchButton).toBeFocused();
  await page.keyboard.press('Enter');

  // The select now holds the Arm class, the notice says what changed, and the
  // "not Arm" warning is gone.
  await expect(dialog.getByLabel('Resource class')).toHaveValue('arm.medium');
  await expect(dialog.getByRole('status')).toContainText(
    'Changed medium to arm.medium',
  );
  await expect(dialog.getByRole('status')).toContainText('Undo reverts it');

  // And it is the value that gets written -- through the same review-then-save
  // flow as everything else, so the user sees the one-line diff before it lands.
  await dialog.getByRole('button', { name: /create job/i }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Review and save config' }).click();
  const saveDialog = page.getByRole('dialog');
  await expect(
    saveDialog.getByText('resource_class: arm.medium'),
  ).toBeVisible();
  await saveDialog.getByRole('button', { name: 'Save changes' }).click();

  await expect.poll(() => host.getSaveCount()).toBeGreaterThan(0);
  const saved = host.getSavedConfig();
  expect(saved).toContain('resource_class: arm.medium');
  // Surgical: the fixture's own comment survives.
  expect(saved).toContain(
    '# Managed by the platform team -- do not edit by hand.',
  );
});

test('a class with no counterpart says so rather than offering the nearest size', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  // `small` is x86-only in the stub, as it is in CircleCI's own tables.
  await dialog.getByLabel('Resource class').selectOption('small');
  await dialog.getByLabel('Architecture').selectOption('arm64');

  const notice = dialog.getByRole('status');
  await expect(notice).toContainText('no Arm (arm64) equivalent of');
  await expect(notice).toContainText('small');
  // Answering `arm.medium` here would hand the job a different machine than it
  // asked for, which is worse than saying "no".
  await expect(dialog.getByRole('button', { name: /Switch to/ })).toHaveCount(
    0,
  );
});

test('clearing the filter restores the list and the selection, having written nothing', async ({
  page,
}) => {
  const host = await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  const architecture = dialog.getByLabel('Architecture');
  const resourceClass = dialog.getByLabel('Resource class');

  await architecture.selectOption('arm64');
  await expect(dialog.getByRole('status')).toBeVisible();
  await architecture.selectOption('');

  // Back exactly where it started, with no trace of the detour.
  await expect(resourceClass).toHaveValue('medium');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await expect(resourceClass.locator('option[value="arm.medium"]')).toHaveCount(
    1,
  );
  // Narrowing a filter is a view, not an edit: nothing reached the host.
  expect(host.getSaveCount()).toBe(0);
});
