import { expect, test } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #23: `$NAME` completions for CircleCI *context* variables inside a
 * `run` command, scoped to the contexts the job being edited actually
 * attaches (via its workflow entry's `context:`) -- never to every context
 * the organization has.
 *
 * `envVarCompletion.test.ts` already unit-tests
 * `createContextVarCompletionSource` directly, including its scoping and its
 * degraded-with-no-token path. What that cannot prove is that the source is
 * actually wired into the real editor and actually reacts to typing in a real
 * `CodeMirror` instance -- the same reasoning `completion-on-delete.spec.ts`
 * and `orb-completion.spec.ts` already give for driving their own completion
 * sources through a real browser instead of stopping at the unit level.
 */

/**
 * A two-job config where `deploy` attaches `deploy-prod` via its workflow
 * entry and `build` attaches nothing -- the shape issue #23 itself describes
 * ("a job adds `context: [deploy-prod]` and then references those variables
 * in a script"), plus the sibling job that must not see them.
 */
const CONFIG_WITH_JOB_CONTEXT = `version: 2.1

jobs:
  build:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: pnpm build

  deploy:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: ./deploy.sh

workflows:
  build_test_deploy:
    jobs:
      - build
      - deploy:
          requires:
            - build
          context: [deploy-prod]
`;

test('completes a variable held by the context this job attaches, typed inside its own run command', async ({
  page,
}) => {
  await mockHostApi(page, { config: CONFIG_WITH_JOB_CONTEXT });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  const deployLine = page
    .locator('.cm-content .cm-line', { hasText: './deploy.sh' })
    .first();
  await deployLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' $AWS');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  // The label carries the `$` sigil (see `createContextVarCompletionSource`'s
  // `label`), and `$AWS_ROLE` is itself a prefix of `$AWS_ROLE_ARN` -- exact
  // matching on the shorter one is what tells the two options apart here.
  await expect(popup.getByText('$AWS_ROLE', { exact: true })).toBeVisible();
  await expect(popup.getByText('$AWS_ROLE_ARN')).toBeVisible();
});

test('does not offer that context’s variables inside a sibling job that never attaches it', async ({
  page,
}) => {
  await mockHostApi(page, { config: CONFIG_WITH_JOB_CONTEXT });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  // `build`'s workflow entry attaches no context at all, even though
  // `deploy-prod` is a context this organization -- and this token -- can
  // read perfectly well. Offering `AWS_ROLE` here would be exactly the
  // "looks like a guarantee" failure issue #23 warns against.
  const buildLine = page
    .locator('.cm-content .cm-line', { hasText: 'pnpm build' })
    .first();
  await buildLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' $AWS');

  await expect(page.getByText('$AWS_ROLE', { exact: true })).toHaveCount(0);
});

test('with no CircleCI token, offers nothing rather than an empty-looking list', async ({
  page,
}) => {
  await mockHostApi(page, {
    config: CONFIG_WITH_JOB_CONTEXT,
    hasToken: false,
  });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  const deployLine = page
    .locator('.cm-content .cm-line', { hasText: './deploy.sh' })
    .first();
  await deployLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' $AWS');

  // Absent, not a popup that could be mistaken for "this context holds
  // nothing" -- the missing-credential state has its own, unmistakable
  // explanation elsewhere (the palette's Contexts section, already covered by
  // `project-context.spec.ts`), never this popup pretending to have checked.
  await expect(page.getByText('$AWS_ROLE', { exact: true })).toHaveCount(0);
});
