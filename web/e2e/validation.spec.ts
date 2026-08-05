import { expect, test } from '@playwright/test';

import {
  invalidStub,
  mockHostApi,
  unavailableStub,
  VALID_STUB,
} from './fixtures';

/**
 * `POST /api/validate` drives a small state machine (see
 * `src/state/appStore.ts`'s `ValidationState`) whose whole point is to keep
 * three outcomes visually distinct: confirmed valid, confirmed invalid, and
 * "we couldn't check" (`unavailable`, e.g. no CIRCLE_TOKEN on the host).
 * `unavailable` must never read as "invalid" -- that would be a false
 * positive telling a user their config is broken when it simply wasn't
 * checked.
 */
test.describe('validation states', () => {
  test('stubbed valid shows a "Valid" indicator', async ({ page }) => {
    await mockHostApi(page, { validate: VALID_STUB });
    await page.goto('/');

    await expect(
      page.getByText('Valid', { exact: true }).first(),
    ).toBeVisible();
  });

  test('stubbed invalid shows the compiler error messages', async ({
    page,
  }) => {
    const messages = ['job "test" requires undefined job "buidl"'];
    await mockHostApi(page, { validate: invalidStub(messages) });
    await page.goto('/');

    await expect(
      page.getByText('Invalid', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(messages[0])).toBeVisible();
  });

  test('stubbed unavailable shows an "unavailable" state, not an invalid one', async ({
    page,
  }) => {
    await mockHostApi(page, {
      validate: unavailableStub('This host has no CIRCLE_TOKEN configured.'),
    });
    await page.goto('/');

    await expect(
      page.getByText('Validation unavailable').first(),
    ).toBeVisible();
    // Must never claim the config is invalid just because it couldn't be checked.
    await expect(page.getByText('Invalid', { exact: true })).toHaveCount(0);
  });
});
