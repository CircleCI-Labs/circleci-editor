import { expect, test } from '@playwright/test';

import { DOCS_LINKS, stepDocsUrl } from '../src/lib/docs/docsLinks';
import { mockHostApi } from './fixtures';

/**
 * Issue #78: docs links must render where a user is most likely to be
 * unsure, open externally, and point at a real page -- checked here as
 * actual `href`s in the real, built app rather than only unit-testing the
 * `docsLinks` table in isolation (see `docsLinks.test.ts`) or the `DocsLink`
 * component alone (`DocsLink.test.tsx`).
 *
 * The expected `href`s are read from `DOCS_LINKS` rather than written out
 * literally. A literal duplicated the URL in two places, and when the table
 * was corrected to CircleCI's post-redirect canonical paths this spec kept
 * asserting the stale one and failed -- a maintenance trap, not a real
 * signal. What is worth pinning here is that *the table's* URL reaches the
 * rendered `href`; whether that URL is right is `docsLinks.test.ts`'s job,
 * and it checks it against the live site.
 */
test('docs links render on executor palette cards and open externally', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  const dockerCard = page
    .getByRole('button', { name: /^Docker\b/ })
    .locator('..');
  const dockerDocsLink = dockerCard.getByRole('link');
  await expect(dockerDocsLink).toHaveAttribute(
    'href',
    DOCS_LINKS.executors.docker.url,
  );
  await expect(dockerDocsLink).toHaveAttribute('target', '_blank');
  await expect(dockerDocsLink).toHaveAttribute('rel', 'noreferrer');

  // Selecting a job shows the inspector's own Executor section, which also
  // carries a docs link -- CodeMirror/React Flow virtualize their own DOM,
  // but this is a plain node in the graph, not something that needs
  // scrolling into view first.
  await page
    .locator('.vce-dag-node')
    .getByText('build', { exact: true })
    .click();
  const executorHeading = page.getByRole('heading', {
    name: 'Executor',
    exact: true,
  });
  await expect(executorHeading).toBeVisible();
  const executorSectionLink = executorHeading.locator('..').getByRole('link');
  await expect(executorSectionLink).toHaveAttribute(
    'href',
    DOCS_LINKS.executors.docker.url,
  );

  // Issue #19: the Steps section header itself, distinct from the per-step
  // link `StepFieldsSection` already carries once a step is expanded --
  // this is the one a reader with an *empty* steps list, or who just wants
  // "what is a step" rather than "what does this one take", had nothing for.
  const stepsHeading = page.getByRole('heading', {
    name: 'Steps',
    exact: true,
  });
  await expect(stepsHeading).toBeVisible();
  await expect(stepsHeading.locator('..').getByRole('link')).toHaveAttribute(
    'href',
    DOCS_LINKS.jobs.steps.url,
  );
});

/**
 * Issue #19: the palette's Steps section listed every built-in step with no
 * way to learn what it does, even though `stepDocsUrl` -- the exact mapping
 * the inspector's own field editor already links through -- has covered
 * every one of these keywords since issue #78. `PaletteStepSection` now
 * wires it in; this is the real, built-app check that the link actually
 * reaches the palette card, not only that `PaletteStepSection.test.tsx`'s
 * component-level render does.
 */
test('a docs link reaches the palette Steps section, from the same table the inspector already uses', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  // Steps starts closed (see Palette.tsx's own doc comment) -- open it.
  // Targets the `<summary>` specifically, the same way `orb-filters.spec.ts`
  // opens the Orbs section next to it: a plain-text match on "Steps" would
  // also hit the inspector's own "Steps" heading once a job is selected.
  await page.locator('summary').filter({ hasText: 'Steps' }).click();

  const saveCacheCard = page
    .getByRole('button', { name: /^Save cache\b/ })
    .locator('..');
  const docsLink = saveCacheCard.getByRole('link');
  await expect(docsLink).toHaveAttribute('href', stepDocsUrl('save_cache')!);
  await expect(docsLink).toHaveAttribute('target', '_blank');
});
