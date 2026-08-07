import { expect, test, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

import { mockHostApi } from './fixtures';

/**
 * Issue #105's palette Contexts section, and (since issue #248) the
 * reference pane's Project tab that replaced this file's old palette
 * Project section, exercised end-to-end in a real browser.
 *
 * The unit tests mount `PaletteContextSection`/`ProjectReferenceView`
 * directly and drive `configMutations` directly; neither can catch a
 * mistake in how a section is actually wired into its pane, nor prove that
 * the "add" path reaches a real saved document. That is what this covers.
 */

/**
 * `mockHostApi` deliberately does not stub `GET /api/schema` -- most specs
 * don't need it, and stubbing it there would hide a missing stub from the
 * specs that do (see `docs-pane.spec.ts`'s own note).
 *
 * The Project tab no longer renders resource classes (issue #153),
 * but this stub is kept and still supplies a `resource_class` enum on purpose:
 * it is what makes "they are not shown here" a real assertion rather than one
 * that would also pass against no schema at all.
 */
async function stubSchema(page: Page): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    await route.fulfill({
      json: {
        properties: {
          executors: {
            additionalProperties: {
              oneOf: [
                {
                  properties: {
                    resource_class: {
                      oneOf: [
                        {
                          type: 'string',
                          enum: ['small', 'medium', 'large'],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  });
}

/**
 * Opens the reference pane (collapsed by default on every preset -- see
 * `layout/presets.ts`), switches it to the Project surface (issue #306:
 * Project/Policies/Caches share a slot with Reference, mutually exclusive --
 * see `DocsPane.tsx`'s own doc comment) and selects its Project tab (issue
 * #248).
 */
async function openProjectTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: /expand reference panel/i }).click();
  await page
    .getByRole('group', { name: 'Reference pane view' })
    .getByRole('button', { name: 'Project', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Project' }).click();
}

test('the Contexts section lists contexts, shows truncated previews, and adds one to a workflow entry', async ({
  page,
}) => {
  const hostApi = await mockHostApi(page);
  await stubSchema(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  // The palette is open by default (see `DagPane`) -- deliberately not
  // toggling it, since a toggle click can as easily close an already-open
  // panel as open one.
  await page.getByText('Contexts', { exact: true }).first().click();

  await expect(page.getByText('build-secrets')).toBeVisible();
  await expect(page.getByText('deploy-prod')).toBeVisible();

  // Drilling in fetches that context's variables, and shows CircleCI's own
  // truncated preview -- labelled unmistakably as a preview, never a value.
  await page.getByText('build-secrets').click();
  await expect(page.getByText('AWS_ROLE', { exact: true })).toBeVisible();
  await expect(page.getByText('AWS_ROLE_ARN')).toBeVisible();
  await expect(page.getByText(/truncated previews, not values/i)).toBeVisible();
  await expect(
    page.getByText(/never returned by the CircleCI API, by design/i),
  ).toBeVisible();

  // The keyboard path: pick a workflow entry and add. Drag-and-drop must never
  // be the only way to make an edit.
  await page
    .getByRole('combobox', { name: /job to add to/i })
    .selectOption('build');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Save, and assert the context landed on the *workflow entry*, not on the
  // job definition.
  const saveButton = page.getByRole('button', {
    name: 'Review and save config',
  });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No changes to save.')).toHaveCount(0);
  await expect(dialog.getByText('build-secrets')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();

  await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);

  const saved = hostApi.getSavedConfig();
  expect(saved).not.toBeNull();
  const parsed = parseYaml(saved!) as {
    workflows: Record<string, { jobs: unknown[] }>;
    jobs: Record<string, Record<string, unknown>>;
  };
  const entries = parsed.workflows.build_test_deploy!.jobs;
  const buildEntry = entries.find(
    (entry) => typeof entry === 'object' && entry !== null && 'build' in entry,
  ) as { build: { context?: string[] } } | undefined;

  expect(buildEntry?.build?.context).toEqual(['build-secrets']);
  // Never on the job definition -- `context:` is a workflow-entry key, which
  // is what lets the same job carry different contexts in different workflows.
  expect(parsed.jobs.build).not.toHaveProperty('context');
});

/**
 * Issue #21: a palette context could already be dropped onto a job node on
 * the canvas (`JobNode.tsx`'s `onDropContext`) -- but not onto the
 * inspector's own `Contexts` field, the one control whose entire subject is
 * contexts and where a user editing them is already standing. That drop had
 * no unit-level surface of its own to exercise end to end (the field's drop
 * handler is a same-file addition to `ContextField.tsx`, not a new mutation
 * -- see that file's module comment), so this is the one place proving it
 * actually reaches a saved document through the real, built app.
 *
 * Driven the same way the empty-steps-list tests in
 * `inspector-sections-steps.spec.ts` drive a drop target directly: a
 * synthetic `DragEvent` with a real `DataTransfer`, dispatched on the
 * field's own drop region. The field's `onAdd` prop is the exact same one
 * the keyboard/typed path already calls (`addWorkflowJobEntryContext`), so
 * what this proves beyond the unit tests is that `Inspector`/`ContextField`
 * are wired up to receive a real cross-pane drag in the first place.
 */
test('a palette context dropped on the inspector’s Contexts field is added to that workflow entry, surviving a save', async ({
  page,
}) => {
  const hostApi = await mockHostApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await page
    .locator('.vce-dag-node')
    .getByText('build', { exact: true })
    .click();

  // The Context section starts collapsed for `build`, which has none yet
  // (issue #219's content rule) -- same click-to-toggle every other
  // inspector section uses.
  await page.getByRole('heading', { name: 'Context', exact: true }).click();
  const contextField = page.getByTestId('context-field-drop-region');
  await expect(contextField).toBeVisible();

  await contextField.evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.setData(
      'application/x-vce-palette-context',
      JSON.stringify({ contextName: 'deploy-prod' }),
    );
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 10,
      clientY: rect.top + rect.height / 2,
      dataTransfer: transfer,
    };
    el.dispatchEvent(new DragEvent('dragover', init));
    el.dispatchEvent(new DragEvent('drop', init));
  });

  // The pill appears immediately, in the field the user is standing in.
  await expect(contextField.getByText('deploy-prod')).toBeVisible();

  const saveButton = page.getByRole('button', {
    name: 'Review and save config',
  });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('deploy-prod')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);

  const saved = hostApi.getSavedConfig();
  expect(saved).not.toBeNull();
  const parsed = parseYaml(saved!) as {
    workflows: Record<string, { jobs: unknown[] }>;
    jobs: Record<string, Record<string, unknown>>;
  };
  const entries = parsed.workflows.build_test_deploy!.jobs;
  const buildEntry = entries.find(
    (entry) => typeof entry === 'object' && entry !== null && 'build' in entry,
  ) as { build: { context?: string[] } } | undefined;

  expect(buildEntry?.build?.context).toEqual(['deploy-prod']);
  // Same rule as the palette's own drop onto a job node: `context:` lives on
  // the workflow entry, never on the job definition.
  expect(parsed.jobs.build).not.toHaveProperty('context');
});

test('the Project tab lists env var names and flags dynamic config being off, without a resource-class list', async ({
  page,
}) => {
  await mockHostApi(page);
  await stubSchema(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  await openProjectTab(page);

  await expect(page.getByText('DEPLOY_TARGET')).toBeVisible();
  await expect(page.getByText('WIDGETS_API_URL')).toBeVisible();
  await expect(
    page.getByText(/does not return project variable values/i),
  ).toBeVisible();

  // The stub has dynamic config off, so the `setup: true` note must appear.
  await expect(
    page.getByText(/only does anything once dynamic config is enabled/i),
  ).toBeVisible();

  // Issue #153: resource classes are not project metadata and are no
  // longer listed here -- they moved to the inspector's resource-class field
  // (where one is actually chosen) and to the reference pane (for browsing).
  // The schema *is* stubbed, so this fails if the block comes back.
  await expect(page.getByText('Resource classes')).toHaveCount(0);
  await expect(
    page.getByText(/From the config schema, not your plan/i),
  ).toHaveCount(0);
});

// The degrade-honestly invariant, in a real browser: with no token both
// sections explain themselves, and nothing else in the app is affected.
test('with no CircleCI token, both sections explain themselves and the rest of the app still works', async ({
  page,
}) => {
  await mockHostApi(page, { hasToken: false });
  await stubSchema(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  await page.getByText('Contexts', { exact: true }).first().click();
  await expect(
    page.getByText(/Contexts need a CircleCI project and API token/i),
  ).toBeVisible();
  // Never the "this organization has no contexts" message, which would be a
  // lie, and never a spinner that cannot resolve.
  await expect(
    page.getByText(/This organization has no contexts/i),
  ).toHaveCount(0);
  await expect(page.getByText(/Loading contexts/i)).toHaveCount(0);

  await openProjectTab(page);
  // A project slug exists (the CLI-injected environment names one), but
  // nothing could be asked without a token -- "Unverified", not the calm
  // "not a CircleCI project" state, and not a lie about there being no
  // environment variables either. Scoped to the tab itself: the top bar's
  // own identity badge (issue #149) shows the same word for the same
  // underlying state, and this is a check on the tab, not on the top bar.
  const projectTab = page.getByTestId('project-reference-view');
  await expect(
    projectTab.getByText('Unverified', { exact: true }),
  ).toBeVisible();
  await expect(
    projectTab.getByText(/No CircleCI API token is available/i),
  ).toBeVisible();
  // And still no resource-class list, with or without a token (#153).
  await expect(page.getByText('Resource classes')).toHaveCount(0);

  // And the rest of the editor is untouched.
  await expect(page.getByTestId('dag-canvas')).toBeVisible();
  await expect(page.locator('.cm-content').first()).toBeVisible();
});

/**
 * Issue #150, in a real browser: a repository that is not set up on CircleCI.
 * The whole point of the fix is that this state is now legible, so the spec
 * asserts the sentence a user actually reads -- the slug that was tried, the
 * status, and what is consequently missing -- and that the context list beside
 * it is still shown, because it loads from the organization and is unaffected.
 */
test('a project that CircleCI has never heard of says so, names the slug, and does not blame the token', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectContext: {
      available: true,
      projectSlug: 'gh/example-org/flakey-todo-list',
      contexts: [
        { id: 'ctx-build', name: 'build-secrets' },
        { id: 'ctx-deploy', name: 'deploy-prod' },
      ],
      projectVariables: [],
      warnings: [
        {
          kind: 'project',
          headline:
            'No CircleCI project matches gh/example-org/flakey-todo-list.',
          detail:
            'The CircleCI API returned HTTP 404 for that project slug. Most often that means this repository has not been set up on CircleCI.',
          consequences: [
            "This project's default branch and settings are not shown.",
          ],
        },
        {
          kind: 'projectVariables',
          headline:
            "This project's environment variable names could not be listed.",
          detail: 'The CircleCI API has no record of it (HTTP 404).',
          consequences: [
            'The Project section lists no environment variables, and their names do not complete as $NAME while you type a run command.',
          ],
        },
      ],
    },
  });
  await stubSchema(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  await openProjectTab(page);
  // Scoped to the tab itself throughout: the top bar shows the same badge
  // word (issue #149) for the same underlying state, and these checks are
  // about the tab, not the top bar.
  const projectTab = page.getByTestId('project-reference-view');

  // The distinguishable state itself (issues #149/#150): a 404 reads as
  // "Unknown to CircleCI", never as the calm "not a CircleCI project" state
  // and never as an unlabelled generic failure.
  await expect(
    projectTab.getByText('Unknown to CircleCI', { exact: true }),
  ).toBeVisible();
  await expect(
    projectTab.getByText(
      /No CircleCI project matches gh\/example-org\/flakey-todo-list/,
    ),
  ).toBeVisible();
  await expect(projectTab.getByText(/HTTP 404/).first()).toBeVisible();
  // Shown twice by design (the badge's own visible explanation, and the
  // detailed warning card below it -- see `ProjectReferenceView`'s doc
  // comment on why the explanation is never hover-only), so `.first()`.
  await expect(
    projectTab.getByText(/has not been set up on CircleCI/).first(),
  ).toBeVisible();
  await expect(
    projectTab.getByText(/default branch and settings are not shown/),
  ).toBeVisible();
  // The reported confusion was "I think I have a valid token" -- nothing here
  // may point at credentials.
  await expect(page.getByText(/rejected this token/)).toHaveCount(0);

  // And the contexts, which load from the organization, are still all there.
  await page.getByText('Contexts', { exact: true }).first().click();
  await expect(page.getByText('build-secrets')).toBeVisible();
  await expect(page.getByText('deploy-prod')).toBeVisible();
  // Not repeated in the section it has nothing to do with.
  await expect(page.getByText(/No CircleCI project matches/)).toHaveCount(1);
});
