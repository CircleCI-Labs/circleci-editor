import { expect, test } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

import { FIXTURE_COMMENT, mockHostApi } from './fixtures';

/**
 * Issue #79's highest-value item, exercised end-to-end in a real browser --
 * not just the unit-level `DuplicationSuggestions`/`configMutations` tests,
 * which mount components or call mutations directly and can't catch a
 * mistake in how the palette is actually wired into `DagPane`. `FIXTURE_CONFIG`
 * (see `fixtures.ts`) already has `build`/`test`/`deploy` all sharing the
 * exact same inline `docker: cimg/node:20.0` executor -- a real duplicate,
 * not a fixture invented for this spec.
 */
test('suggests extracting a shared inline executor, applies it, and the saved YAML only changes the intended region', async ({
  page,
}) => {
  const hostApi = await mockHostApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  // The palette is open by default (see DagPane's own `readStoredPaletteOpen`)
  // -- deliberately not toggling it, since a toggle click can as easily
  // *close* an already-open panel as open one, which has caused false
  // alarms in this suite before.
  const suggestion = page.getByText(
    /3 jobs share an identical docker executor/i,
  );
  await expect(suggestion).toBeVisible();
  await expect(page.getByText('(build, test, deploy)')).toBeVisible();

  // Accept the default name and extract.
  const nameInput = page.getByLabel('New name');
  await expect(nameInput).toHaveValue('docker-executor');
  await page.getByRole('button', { name: 'Extract' }).click();

  // The suggestion must disappear on its own once the document no longer
  // has anything to suggest -- all three jobs now reference the same named
  // executor instead of an inline one, so `findDuplicateExecutors` (which
  // only looks at *inline* executors) has nothing left to report.
  await expect(suggestion).toHaveCount(0);

  // Save, and inspect the body actually written -- not just what the editor
  // shows -- exactly like save-roundtrip.spec.ts's own trust mechanism.
  await page.getByRole('button', { name: 'Review and save config' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);

  const saved = hostApi.getSavedConfig();
  expect(saved).not.toBeNull();
  const after = saved!;

  // Comment survives, byte-for-byte.
  expect(after).toContain(FIXTURE_COMMENT);

  // Structural assertions via a real YAML parse, not regexes against
  // indentation -- robust to exactly how `yaml`'s stringifier formats the
  // new `executors:` block.
  const parsed = parseYaml(after) as {
    executors?: Record<string, unknown>;
    jobs: Record<
      string,
      { executor?: string; docker?: unknown; steps: unknown[] }
    >;
    workflows: { build_test_deploy: { jobs: unknown[] } };
  };
  expect(parsed.executors).toEqual({
    'docker-executor': { docker: [{ image: 'cimg/node:20.0' }] },
  });
  for (const jobName of ['build', 'test', 'deploy']) {
    const job = parsed.jobs[jobName]!;
    expect(job.executor).toBe('docker-executor');
    expect(job.docker).toBeUndefined();
  }
  // Every job's own steps -- the completely separate concern this
  // extraction must never touch -- survive exactly as they were.
  expect(parsed.jobs.build!.steps).toEqual([
    'checkout',
    { run: 'pnpm install' },
    { run: 'pnpm build' },
  ]);
  expect(parsed.jobs.test!.steps).toEqual(['checkout', { run: 'pnpm test' }]);
  expect(parsed.jobs.deploy!.steps).toEqual([
    'checkout',
    { run: './deploy.sh' },
  ]);
  // The workflow's requires/filters -- also untouched.
  expect(parsed.workflows.build_test_deploy.jobs).toEqual([
    'build',
    { test: { requires: ['build'] } },
    { deploy: { requires: ['test'], filters: { branches: { only: 'main' } } } },
  ]);
});
