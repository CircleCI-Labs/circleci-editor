import { expect, test } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #181, in the real built app: the resource classes the executor field
 * offers, and the architecture control that narrows them.
 *
 * Worth a browser test rather than only unit coverage because the defect that
 * opened the issue was a *browser* observation -- "when I go to Docker I just
 * see medium plus, large, extra large, 2xlarge, and other, so it doesn't look
 * like the Docker ARM ones are actually there". The unit tests prove the
 * extraction and the filtering; these prove what a user sees when they open the
 * dialog.
 *
 * The classes come from the `/api/resource-classes` stub in `fixtures.ts`; the
 * host's own derivation of them from CircleCI's vendored tables is pinned in
 * `internal/guides/resourceclasses_test.go`.
 */

/** Opens the palette's Docker card, which opens the "New job" dialog. */
async function openDockerJobDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^Docker\b/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('the Docker executor offers Arm and gen2 classes, grouped as CircleCI groups them', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  const resourceClass = dialog.getByLabel('Resource class');

  // Each upstream table is its own group, under CircleCI's own heading.
  await expect(
    resourceClass
      .locator('optgroup')
      .evaluateAll((groups) =>
        groups.map((group) => (group as HTMLOptGroupElement).label),
      ),
  ).resolves.toEqual(['x86', 'x86 (gen2)', 'Arm']);

  // The three things the hand-written list got wrong, visible in one dropdown.
  await expect(resourceClass.locator('option[value="arm.medium"]')).toHaveCount(
    1,
  );
  await expect(
    resourceClass.locator('option[value="arm.2xlarge"]'),
  ).toHaveCount(1);
  await expect(
    resourceClass.locator('option[value="xlarge.gen2"]'),
  ).toHaveCount(1);

  // The escape hatch survives, so a class newer than the vendored snapshot is
  // still writable.
  await expect(resourceClass.locator('option[value="__custom__"]')).toHaveCount(
    1,
  );

  // And the field still says where the list comes from, and what it is not.
  await expect(dialog.getByText(/not your plan/i)).toContainText(
    'resource-class tables',
  );
});

test('the architecture control narrows the list and is reachable by keyboard alone', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  const architecture = dialog.getByLabel('Architecture');
  const resourceClass = dialog.getByLabel('Resource class');

  // Opens unfiltered: every class the executor offers is present before anyone
  // touches the filter. Pre-filtering would have recreated the reported defect.
  await expect(architecture).toHaveValue('');
  await expect(resourceClass.locator('option[value="medium"]')).toHaveCount(1);
  await expect(resourceClass.locator('option[value="arm.medium"]')).toHaveCount(
    1,
  );

  // Focused and changed with the keyboard only -- no pointer at any step.
  await architecture.focus();
  await expect(architecture).toBeFocused();
  await architecture.selectOption('arm64');

  await expect(resourceClass.locator('option[value="arm.medium"]')).toHaveCount(
    1,
  );
  await expect(resourceClass.locator('option[value="small"]')).toHaveCount(0);
  await expect(
    resourceClass.locator('option[value="xlarge.gen2"]'),
  ).toHaveCount(0);
  // Issue #212: `medium` is x86, and a control that says it filters must filter, so
  // it is gone from the list. This used to assert that it survived *and stayed
  // selected*, which is exactly the defect the owner reported -- "the control says
  // it is filtering and the field says otherwise". Where the value went instead is
  // asserted in `architecture-filter.spec.ts`: it is named, and a switch is offered.
  await expect(resourceClass.locator('option[value="medium"]')).toHaveCount(0);
  await expect(resourceClass).not.toHaveValue('medium');

  // It is a filter, and says so: there is no `architecture` key to write.
  await expect(dialog.getByText(/filters the list below/i)).toContainText(
    'no architecture key',
  );
});

test('creating a job with an Arm class writes it, leaving the rest of the file alone', async ({
  page,
}) => {
  const host = await mockHostApi(page);
  await page.goto('/');
  await openDockerJobDialog(page);

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Architecture').selectOption('arm64');
  await dialog.getByLabel('Resource class').selectOption('arm.2xlarge');
  await dialog.getByRole('button', { name: /create job/i }).click();
  await expect(dialog).toBeHidden();

  // Same save flow as `save-roundtrip.spec.ts`: nothing is written until the
  // diff has been shown and confirmed.
  await page.getByRole('button', { name: 'Review and save config' }).click();
  const saveDialog = page.getByRole('dialog');
  await expect(
    saveDialog.getByText('resource_class: arm.2xlarge'),
  ).toBeVisible();
  await saveDialog.getByRole('button', { name: 'Save changes' }).click();

  await expect.poll(() => host.getSaveCount()).toBeGreaterThan(0);
  const saved = host.getSavedConfig();
  expect(saved).toContain('resource_class: arm.2xlarge');
  // The write is surgical, so the fixture's own comments survive it -- the same
  // property `roundtrip.test.ts` asserts at the mutation level.
  expect(saved).toContain('#');
});

test('the macOS executor offers no architecture control, because its table states none', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: /^macOS\b/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // A control whose every option showed the same list would be worse than none.
  await expect(dialog.getByLabel('Architecture')).toHaveCount(0);
  await expect(
    dialog.getByLabel('Resource class').locator('option[value="m4pro.medium"]'),
  ).toHaveCount(1);
});
