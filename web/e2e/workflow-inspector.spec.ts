import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_COMMENT, mockHostApi } from './fixtures';

/**
 * Issue #288: "the workflow itself can have different parameters... how do I
 * edit the workflow stuff?" This belongs in Playwright, not only in
 * `Inspector.test.tsx`/`appStore.test.ts`, for the reason the issue's own
 * verification note gives: this change is about canvas *selection*
 * (clicking empty canvas, clicking a workflow tab, clicking a job node),
 * and the DAG pane's unit tests mock `@xyflow/react` entirely -- they can
 * assert the selection *state* changes correctly (see `DagPane.test.tsx`),
 * but not that a real pointer click on the real rendered canvas reaches it.
 *
 * The owner's own stated risk -- "selecting the workflow must not break
 * selecting a job, or clear a job selection surprisingly" -- is the thing
 * every test here is ultimately checking.
 */

/**
 * Waits for the graph to actually be laid out (ELK's layout is asynchronous)
 * before anything in this spec touches the canvas. Skipping this is what
 * `dag.spec.ts`'s own tests already wait on before their first canvas
 * interaction -- without it, an early "empty canvas" probe reads an
 * unlaid-out canvas as empty everywhere, and a job-node click races a
 * bounding box that hasn't settled into its final position yet.
 */
async function waitForGraph(page: Page): Promise<void> {
  await expect(
    page.locator('.vce-dag-node').getByText('build', { exact: true }),
  ).toBeVisible();
}

/**
 * A point on the DAG canvas that is not under any `.vce-dag-node`, found by
 * probing rather than assumed -- mirrors `dag.spec.ts`'s own
 * `findEmptyCanvasPoint` (issue #87's own reasoning for why a probe, not a
 * guessed corner, is what keeps a false "empty canvas" click from silently
 * landing on a node instead).
 */
async function findEmptyCanvasPoint(
  page: Page,
): Promise<{ x: number; y: number }> {
  const canvasBox = await page.getByTestId('dag-canvas').boundingBox();
  if (!canvasBox) throw new Error('dag-canvas has no bounding box');
  for (const fx of [0.05, 0.5, 0.95]) {
    for (const fy of [0.05, 0.5, 0.95]) {
      const x = canvasBox.x + canvasBox.width * fx;
      const y = canvasBox.y + canvasBox.height * fy;
      const hitsNode = await page.evaluate(
        ({ x, y }) =>
          !!document.elementFromPoint(x, y)?.closest('.vce-dag-node'),
        { x, y },
      );
      if (!hitsNode) return { x, y };
    }
  }
  throw new Error(
    'every sampled canvas point sits under a node -- fixture layout changed?',
  );
}

async function clickEmptyCanvas(page: Page): Promise<void> {
  const point = await findEmptyCanvasPoint(page);
  await page.mouse.click(point.x, point.y);
}

/** Scopes queries to the Inspector pane's own container -- both its header (the `Inspector` heading) and its scrollable body -- so e.g. `getByText('build_test_deploy')` can't also match the (differently-purposed) `WorkflowTabs` tab of the same name elsewhere in the DAG pane. */
function inspectorPane(page: Page) {
  return page
    .getByRole('heading', { name: 'Inspector' })
    .locator('..')
    .locator('..');
}

/** Opens the "Condition"/"Triggers" `<details>` sections (issue #219: closed by default while empty) by clicking their summary heading. */
async function openWorkflowSection(
  page: Page,
  title: 'Condition' | 'Triggers',
): Promise<void> {
  await inspectorPane(page)
    .getByRole('heading', { name: title, level: 4 })
    .click();
}

test('clicking empty canvas selects the workflow itself, not a job', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await waitForGraph(page);

  await clickEmptyCanvas(page);

  const inspector = inspectorPane(page);
  await expect(inspector.getByText('workflow', { exact: true })).toBeVisible();
  await expect(
    inspector.getByText('build_test_deploy', { exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByRole('heading', { name: 'Condition', level: 4 }),
  ).toBeVisible();
  await expect(
    inspector.getByRole('heading', { name: 'Triggers', level: 4 }),
  ).toBeVisible();
  await expect(inspector.getByLabel('max_auto_reruns')).toBeVisible();

  await openWorkflowSection(page, 'Condition');
  await expect(page.getByRole('button', { name: 'Add “when”' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add “unless”' }),
  ).toBeVisible();

  await openWorkflowSection(page, 'Triggers');
  await expect(
    page.getByRole('button', { name: 'Add a schedule trigger' }),
  ).toBeVisible();

  // Not a job body: no "Job name" field, no per-node Remove button (issue
  // #288's own header note -- Remove is a job-entry action with nothing to
  // mean for the workflow itself).
  await expect(page.getByLabel(/^job name$/i)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Remove ".*" from the graph$/ }),
  ).toHaveCount(0);
});

test('selecting a job after the workflow, and the workflow after a job, both work (issue #288 own risk)', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await waitForGraph(page);

  // Workflow first.
  await clickEmptyCanvas(page);
  await expect(
    inspectorPane(page).getByText('workflow', { exact: true }),
  ).toBeVisible();

  // Then a job -- must still work exactly as it always has.
  await page
    .locator('.vce-dag-node')
    .getByText('build', { exact: true })
    .click();
  await expect(page.getByLabel(/^job name$/i)).toHaveValue('build');
  await expect(
    inspectorPane(page).getByText('workflow', { exact: true }),
  ).toHaveCount(0);

  // Back to the workflow -- the job's own fields must be gone, not layered
  // underneath.
  await clickEmptyCanvas(page);
  await expect(
    inspectorPane(page).getByText('workflow', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^job name$/i)).toHaveCount(0);

  // And a job again, one more time, to prove this isn't a one-shot toggle.
  await page
    .locator('.vce-dag-node')
    .getByText('deploy', { exact: true })
    .click();
  await expect(page.getByLabel(/^job name$/i)).toHaveValue('deploy');
});

test('a workflow tab clicked while already active is the second entry point', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await waitForGraph(page);

  // Select a job so there's something for the tab click to override.
  await page
    .locator('.vce-dag-node')
    .getByText('build', { exact: true })
    .click();
  await expect(page.getByLabel(/^job name$/i)).toHaveValue('build');

  const tab = page.getByRole('tab', { name: /build_test_deploy/ });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await tab.click();

  await expect(
    inspectorPane(page).getByText('workflow', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^job name$/i)).toHaveCount(0);

  // The job is selectable again afterward -- the tab click didn't corrupt
  // anything.
  await page
    .locator('.vce-dag-node')
    .getByText('test', { exact: true })
    .click();
  await expect(page.getByLabel(/^job name$/i)).toHaveValue('test');
});

test('adding when: and a schedule trigger writes them surgically, preserving the fixture comment', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await waitForGraph(page);

  const editorTextBefore = await page.locator('.cm-content').innerText();
  expect(editorTextBefore).toContain(FIXTURE_COMMENT.replace(/^#\s*/, ''));

  await clickEmptyCanvas(page);
  await openWorkflowSection(page, 'Condition');

  await page.getByRole('button', { name: 'Add “when”' }).click();
  const conditionField = page.getByPlaceholder(
    '<< pipeline.parameters.deploy >>',
  );
  await conditionField.fill('<< pipeline.parameters.run-it >>');
  await conditionField.blur();

  await openWorkflowSection(page, 'Triggers');
  await page.getByRole('button', { name: 'Add a schedule trigger' }).click();
  const cronField = page.getByLabel('cron', { exact: true });
  await expect(cronField).toHaveValue('0 0 * * *');

  const editorText = await page.locator('.cm-content').innerText();
  expect(editorText).toContain(FIXTURE_COMMENT.replace(/^#\s*/, ''));
  expect(editorText).toContain('when:');
  expect(editorText).toContain('run-it');
  expect(editorText).toContain('triggers:');
  expect(editorText).toContain('cron:');

  // Every job/step line from the original fixture is still there --
  // additive, not a reformat.
  expect(editorText).toContain('pnpm install');
  expect(editorText).toContain('./deploy.sh');
});

test('a malformed cron warns without blocking the edit ("unknown" never rendered as "invalid")', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await waitForGraph(page);

  await clickEmptyCanvas(page);
  await openWorkflowSection(page, 'Triggers');
  await page.getByRole('button', { name: 'Add a schedule trigger' }).click();

  const cronField = page.getByLabel('cron', { exact: true });
  await cronField.fill('99 9 * * *');
  await expect(page.getByText(/Malformed cron/i)).toBeVisible();
  await cronField.blur();

  // Still written -- a warning, never a refusal.
  const editorText = await page.locator('.cm-content').innerText();
  expect(editorText).toContain('99 9 * * *');

  // Fixing it clears the warning.
  await cronField.fill('0 9 * * 1-5');
  await expect(page.getByText(/Malformed cron/i)).toHaveCount(0);
});
