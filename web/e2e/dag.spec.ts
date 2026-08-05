import { expect, test } from '@playwright/test';

import { FIXTURE_JOB_NAMES, mockHostApi } from './fixtures';

/**
 * The workflow graph is derived read-only from the parsed config (see
 * `src/panes/dag/DagPane.tsx`); DAG editing itself is being built out
 * concurrently, so this only checks the one thing that must keep working
 * regardless of how that lands: one node per job in the active workflow.
 */
test('workflow graph renders a node per job in the fixture', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  for (const jobName of FIXTURE_JOB_NAMES) {
    await expect(
      page.locator('.vce-dag-node').getByText(jobName, { exact: true }),
    ).toBeVisible();
  }

  await expect(page.locator('.vce-dag-node')).toHaveCount(
    FIXTURE_JOB_NAMES.length,
  );
});

/**
 * Issue #70: "it'd be really nice to be able to click and drag things...
 * but with how the workflow DAG is looking right now, it's all pretty
 * static." A real mouse drag, in a real browser, followed by a real page
 * reload -- the one path unit tests (`DagPane.test.tsx`, which mocks
 * `@xyflow/react` entirely and never touches `localStorage`) can't cover:
 * that a dragged position actually survives a fresh page load, not just a
 * React re-render within the same session.
 *
 * Issue #85 (P0 regression): the #70 test above this comment used to only
 * check the position *after* `mouse.up()` -- exactly the gap that let a
 * node which never visibly moved until release still pass. `flowNodes` was
 * a fully controlled array recomputing every node's position from
 * `nodePositionStore`/ELK on every render, which stomped React Flow's own
 * in-flight drag position; only `onNodeDragStop` ever wrote back, so the
 * transform sat frozen for the whole drag and only jumped once, on
 * release. Measured on the running app before the fix:
 *
 *   start    : translate(12px, 240px)    dragging: false
 *   mid-drag : translate(12px, 240px)    dragging: true     <- never moves
 *   mid-drag2: translate(12px, 240px)    dragging: true
 *   after up : translate(345.333px, 493.333px)
 *
 * Sampling the transform *mid-drag* (before `mouse.up()`), not just after,
 * is what actually catches that. The `dragging` class assertion covers the
 * other half of the issue: a subtle "picked up" lift, via React Flow's own
 * `dragging` state (previously left unstyled).
 */
test('dragging a node moves live and persists its position across a reload', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  const nodeWrapper = page.locator('[data-testid="rf__node-build"]');
  const node = nodeWrapper.locator('.vce-dag-node');
  await expect(node).toBeVisible();

  const box = await node.boundingBox();
  if (!box) throw new Error('build node has no bounding box');

  const transformBeforeDrag = await nodeWrapper.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();

  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 + 40,
    { steps: 5 },
  );
  const transformMidDrag = await nodeWrapper.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );
  await expect(node).toHaveClass(/vce-dag-node--dragging/);
  expect(transformMidDrag).not.toBe(transformBeforeDrag);

  await page.mouse.move(
    box.x + box.width / 2 + 140,
    box.y + box.height / 2 + 90,
    { steps: 10 },
  );
  const transformMidDrag2 = await nodeWrapper.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );
  expect(transformMidDrag2).not.toBe(transformMidDrag);

  await page.mouse.up();
  await expect(node).not.toHaveClass(/vce-dag-node--dragging/);

  const transformAfterDrag = await nodeWrapper.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );

  await page.reload();
  const nodeWrapperAfterReload = page.locator('[data-testid="rf__node-build"]');
  await expect(nodeWrapperAfterReload.locator('.vce-dag-node')).toBeVisible();
  const transformAfterReload = await nodeWrapperAfterReload.evaluate(
    (el) => (el as HTMLElement).style.transform,
  );

  expect(transformAfterReload).toBe(transformAfterDrag);
});

/**
 * Issue #70: "it's really hard to hit that little circle to link... connecting
 * must not be mouse-only." Drives the whole two-step anchor/complete state
 * machine (`DagPane.handleHandleActivate`) via nothing but `Tab`-reachable
 * focus and `Enter` -- no `page.mouse` calls at all -- which is the one
 * thing that actually proves this is keyboard-operable rather than just
 * "the callback exists and unit tests call it directly" (see
 * `DagPane.test.tsx`'s own keyboard-connecting tests, which call
 * `data.onActivateHandle` directly rather than going through a real,
 * focusable DOM element).
 */
test('connecting two nodes via keyboard adds a requires edge', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  const buildHandle = page
    .locator('[data-testid="rf__node-build"] .vce-dag-handle')
    .first();
  const deployHandle = page
    .locator('[data-testid="rf__node-deploy"] .vce-dag-handle')
    .first();

  await buildHandle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText(/connecting from/i);
  await expect(page.getByRole('status')).toContainText('build');

  await deployHandle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveCount(0);

  // `deploy` already requires `test` (see FIXTURE_CONFIG) -- this adds a
  // second, direct requirement on `build` alongside it, which is only
  // possible at all because build -> test -> deploy contains no cycle for
  // a build -> deploy edge to close.
  await page.locator('[data-testid="rf__node-deploy"] .vce-dag-node').click();
  await expect(
    page.getByRole('button', { name: 'Remove requirement on build' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove requirement on test' }),
  ).toBeVisible();
});

/**
 * Issue #289: "I can click and drag that little arrow to link things...
 * but how do I unlink things?" Linking has a highly visible dedicated
 * handle (#70); unlinking had no on-canvas affordance at all -- only an
 * undiscoverable "select the edge, then press Delete" that this same real
 * browser confirms was already wired (`onEdgesDelete`, since #22) but never
 * surfaced. This is the discoverability half: hovering the edge grows a
 * small "×" (`RequiresEdge.tsx`'s `canRemove`), the on-canvas counterpart to
 * the drag handle, and clicking it removes exactly that dependency.
 */
test('hovering a requires edge reveals a delete affordance, and clicking it removes that dependency', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  // `toBeVisible`/unforced actionability checks don't work reliably against
  // a bare SVG `<g>` (no `offsetWidth`/`offsetHeight`, the DOM properties
  // that check relies on) -- confirmed live: computed style, opacity and a
  // real non-empty bounding box all say "visible" here, yet Playwright's own
  // `isVisible()` still reports `false`. `toHaveCount` (below, and already
  // this file's own pattern for edges, e.g. the dangling-edge test) and
  // `{ force: true }` route around exactly that, the same way this file
  // already drives node drags via raw coordinates rather than a bare
  // `.click()`.
  const edge = page.locator('[data-testid="rf__edge-build->test"]');
  await expect(edge).toHaveCount(1);
  await expect(page.locator('.vce-dag-edge-delete-affordance')).toHaveCount(0);

  await edge.hover({ force: true });
  const deleteButton = page.locator('.vce-dag-edge-delete-affordance');
  await expect(deleteButton).toBeVisible();

  const editorTextBefore = await page.locator('.cm-content').innerText();
  expect(editorTextBefore).toMatch(/test:\s*\n\s*requires:\s*\n\s*- build/);

  await deleteButton.click();

  await expect(
    page.locator('[data-testid="rf__edge-build->test"]'),
  ).toHaveCount(0);
  const editorTextAfter = await page.locator('.cm-content').innerText();
  // `test` still requires nothing else, so the whole `requires:` key is gone
  // -- not left behind as `requires: []` -- and `test` collapses back to a
  // bare list entry. `deploy` still requires `test` (untouched, and the
  // reason "requires" as a whole document substring can't be the check),
  // so this asserts the shape directly: `test` sits between `build` and
  // `deploy` as a bare entry, with no `requires:` line anywhere before it.
  expect(editorTextAfter).not.toMatch(/test:\s*\n\s*requires:/);
  expect(editorTextAfter).toMatch(/- build\s*\n\s*- test\s*\n\s*- deploy/);
});

/**
 * Issue #289's keyboard half: React Flow's own default edge a11y (each edge
 * is a focusable, `role="group"` element once selectable, confirmed live
 * here rather than assumed -- see the issue's "check what the canvas
 * already has" instruction) already reaches edges the same way node
 * deletion already worked; this proves the whole path end to end in a real
 * browser, including the byte-identical undo the issue calls out as the
 * property most likely to quietly break.
 */
test('selecting an edge and pressing Backspace removes it, and undo restores the original bytes exactly', async ({
  page,
}) => {
  await mockHostApi(page);
  // CodeMirror only mounts the lines within its own scroll viewport, and
  // nothing here scrolls it -- a normal-height window leaves the fixture's
  // last few lines (the `deploy` workflow entry, `filters:`) permanently
  // unmounted, which would make an exact `.cm-content` equality check fail
  // for a reason that has nothing to do with this fix (confirmed live: the
  // same content is genuinely present in the CodeMirror `Text` the editor
  // holds, just never rendered into the DOM without an explicit scroll).
  // A tall viewport is the simplest way to make the whole ~40-line fixture
  // fit inside the pane's own scrollport with nothing to virtualize away.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.goto('/');

  // A bare `.innerText()` immediately after `goto` can race CodeMirror's own
  // mount of the fixture's last few lines even with the tall viewport above
  // -- confirmed live, and `expect.poll` (unlike a fixed `waitForTimeout`)
  // retries until the real content is actually there instead of gambling on
  // a delay long enough on this machine but not necessarily on a slower one.
  await expect
    .poll(() => page.locator('.cm-content').innerText())
    .toMatch(/only:\s*main/);
  const editorTextBefore = await page.locator('.cm-content').innerText();

  // `{ force: true }`: see the previous test's comment on why an unforced
  // click on a bare SVG `<g>` never passes Playwright's own actionability
  // check here, despite the element being genuinely visible and clickable.
  const edge = page.locator('[data-testid="rf__edge-build->test"]');
  await edge.click({ force: true });
  await expect(edge).toHaveClass(/selected/);

  await page.keyboard.press('Backspace');

  await expect(
    page.locator('[data-testid="rf__edge-build->test"]'),
  ).toHaveCount(0);
  const editorTextAfterDelete = await page.locator('.cm-content').innerText();
  expect(editorTextAfterDelete).not.toBe(editorTextBefore);
  // Only `test`'s own `requires:` is gone -- `deploy` still requires `test`,
  // untouched, so "requires" as a whole-document substring can't be the
  // check (see the previous test's identical comment).
  expect(editorTextAfterDelete).not.toMatch(/test:\s*\n\s*requires:/);

  // The deleted edge's own `<g>` held DOM focus (React Flow's default
  // edge a11y) and no longer exists, so focus has reverted to `<body>` --
  // outside this pane's own `onKeyDown` subtree (deliberately scoped, see
  // `handleKeyDown`'s own comment, so it never fights the YAML editor's
  // native undo). Clicking a node brings focus back inside the pane, same
  // as a user would naturally do before trying another canvas shortcut.
  await page.locator('[data-testid="rf__node-build"] .vce-dag-node').click();

  // Undo must land exactly back on the original text -- not just an
  // equivalent parse -- since this is the inverse of the drag-to-link
  // gesture and the two are meant to cancel out exactly.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    page.locator('[data-testid="rf__edge-build->test"]'),
  ).toHaveCount(1);
  const editorTextAfterUndo = await page.locator('.cm-content').innerText();
  expect(editorTextAfterUndo).toBe(editorTextBefore);
});

/**
 * Issue #70: "it's really hard to hit that little circle" -- a real
 * measurement in a real browser (not jsdom, which has no layout engine) of
 * both halves of the fix: the hit area itself is bigger than the visible
 * dot, and the historical 3px horizontal-overflow bug (see `styles.css`'s
 * long comment on `.vce-dag-node .vce-dag-handle.react-flow__handle-left`)
 * hasn't come back now that the handle is larger.
 */
test('connection handles have a larger hit area than the visible dot, with no node overflow', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  const handle = page.locator('.vce-dag-handle').first();
  await expect(handle).toBeVisible();
  const hitAreaSize = await handle.evaluate((el) => ({
    width: el.offsetWidth,
    height: el.offsetHeight,
  }));
  const dotSize = await handle.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    return { width: parseFloat(after.width), height: parseFloat(after.height) };
  });
  expect(hitAreaSize.width).toBeGreaterThan(dotSize.width);
  expect(hitAreaSize.height).toBeGreaterThan(dotSize.height);

  const overflowDeltas = await page
    .locator('.vce-dag-node')
    .evaluateAll((els) =>
      els.map((el) => ({
        dx: el.scrollWidth - el.clientWidth,
        dy: el.scrollHeight - el.clientHeight,
      })),
    );
  for (const delta of overflowDeltas) {
    expect(delta).toEqual({ dx: 0, dy: 0 });
  }
});

/**
 * Issue #87 part 1: a spot on the canvas background this test can confirm,
 * at runtime, does not sit under any `.vce-dag-node` -- rather than
 * guessing a corner and hoping the fixture's ELK layout never places a node
 * there. Scans a small grid instead of one fixed point for the same reason
 * this whole file is skeptical of assumed coordinates: CodeMirror
 * virtualizing its DOM and a toggle closing a panel have both produced
 * false alarms in this codebase before (see the task history for #85/#87),
 * and a probe that silently lands on a node instead of empty canvas would
 * make a "no error banner" assertion pass for the *wrong* reason -- because
 * the drop actually was valid, not because it was correctly blocked.
 */
async function findEmptyCanvasPoint(
  page: import('@playwright/test').Page,
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

/**
 * Issue #87 part 1: "dragging anywhere onto the workflow graph -- not on a
 * specific job, just in the void -- still shows as green, but then drops as
 * an error." Uses `page.dragAndDrop` (a real, CDP-backed drag on Chromium),
 * not raw `page.mouse` calls: a hand-dispatched `DragEvent` with a manually
 * constructed `DataTransfer` turned out, while verifying this fix, to leave
 * `dataTransfer.dropEffect` silently read-only (confirmed with a minimal
 * repro outside this app entirely -- Chromium only honors writes to it
 * inside a genuine native drag session), so a probe built that way would
 * "pass" for the wrong reason. `page.dragAndDrop` drives the real thing, so
 * what this actually proves is the same thing a user would see: no error
 * banner, and the config left untouched.
 */
test('a palette step dropped on empty canvas is refused before release, not after (issue #87)', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await page.getByText('Steps', { exact: true }).click();

  const checkoutCard = page
    .locator('button[title="Drag onto the graph, or click to add"]')
    .filter({ hasText: 'checkout' })
    .first();
  await expect(checkoutCard).toBeVisible();

  const canvasBox = await page.getByTestId('dag-canvas').boundingBox();
  if (!canvasBox) throw new Error('dag-canvas has no bounding box');
  const point = await findEmptyCanvasPoint(page);

  const editorTextBefore = await page.locator('.cm-content').innerText();

  await page.dragAndDrop(
    'button[title="Drag onto the graph, or click to add"]:has-text("checkout")',
    '[data-testid="dag-canvas"]',
    {
      targetPosition: { x: point.x - canvasBox.x, y: point.y - canvasBox.y },
      force: true,
    },
  );

  await expect(page.getByRole('alert')).toHaveCount(0);
  const editorTextAfter = await page.locator('.cm-content').innerText();
  expect(editorTextAfter).toBe(editorTextBefore);
});

/**
 * Issue #87 part 1, the symmetric case: "an executor over a job node is
 * also refused today" -- an executor only ever creates a *new* job, never
 * retrofits an existing one, so dropping one on a job node must be refused
 * the same way, before release.
 */
test('a palette executor dropped on an existing job node is refused before release (issue #87 symmetric case)', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  const dockerCard = page
    .locator('button[title="Drag onto the graph, or click to add"]')
    .filter({ hasText: 'Docker' })
    .first();
  await expect(dockerCard).toBeVisible();

  const buildNode = page.locator(
    '[data-testid="rf__node-build"] .vce-dag-node',
  );
  await expect(buildNode).toBeVisible();
  const nodeBox = await buildNode.boundingBox();
  const canvasBox = await page.getByTestId('dag-canvas').boundingBox();
  if (!nodeBox || !canvasBox)
    throw new Error('node or canvas has no bounding box');

  const editorTextBefore = await page.locator('.cm-content').innerText();

  await page.dragAndDrop(
    'button[title="Drag onto the graph, or click to add"]:has-text("Docker")',
    '[data-testid="dag-canvas"]',
    {
      targetPosition: {
        x: nodeBox.x + nodeBox.width / 2 - canvasBox.x,
        y: nodeBox.y + nodeBox.height / 2 - canvasBox.y,
      },
      force: true,
    },
  );

  await expect(page.getByRole('alert')).toHaveCount(0);
  const editorTextAfter = await page.locator('.cm-content').innerText();
  expect(editorTextAfter).toBe(editorTextBefore);
});

/**
 * The other half of issue #87's requirement: "keep the green '+' for
 * genuinely valid targets -- the user explicitly likes it." A step over an
 * existing, defined job node is exactly that -- this drop must still
 * actually succeed, not just fail to error.
 */
test('a palette step dropped on a defined job node still succeeds (issue #87 positive case)', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await page.getByText('Steps', { exact: true }).click();

  const checkoutCard = page
    .locator('button[title="Drag onto the graph, or click to add"]')
    .filter({ hasText: 'checkout' })
    .first();
  await expect(checkoutCard).toBeVisible();

  const buildNode = page.locator(
    '[data-testid="rf__node-build"] .vce-dag-node',
  );
  await expect(buildNode).toBeVisible();
  const nodeBox = await buildNode.boundingBox();
  const canvasBox = await page.getByTestId('dag-canvas').boundingBox();
  if (!nodeBox || !canvasBox)
    throw new Error('node or canvas has no bounding box');

  const editorTextBefore = await page.locator('.cm-content').innerText();

  await page.dragAndDrop(
    'button[title="Drag onto the graph, or click to add"]:has-text("checkout")',
    '[data-testid="dag-canvas"]',
    {
      targetPosition: {
        x: nodeBox.x + nodeBox.width / 2 - canvasBox.x,
        y: nodeBox.y + nodeBox.height / 2 - canvasBox.y,
      },
      force: true,
    },
  );

  await expect(page.getByRole('alert')).toHaveCount(0);
  const editorTextAfter = await page.locator('.cm-content').innerText();
  expect(editorTextAfter).not.toBe(editorTextBefore);
  expect(editorTextAfter.match(/checkout/g) ?? []).toHaveLength(
    (editorTextBefore.match(/checkout/g) ?? []).length + 1,
  );
});

/**
 * Issue #12. Two halves, both of which only a real browser can show:
 *
 *  1. Deleting a job in the middle of a chain reconciles every reference, and
 *     the result renders as a *visibly broken* graph rather than a silently
 *     re-wired one -- no invented `build -> deploy` edge, and a dashed
 *     placeholder node where the deleted job's alias used to be if anything
 *     still names it. (Here `deleteJob` prunes the reference, so the graph is
 *     honestly disconnected instead.)
 *  2. A hand-written dangling `requires:` (the state a config can always be
 *     in, and what a pre-#12 rename left behind) draws a real dashed edge into
 *     a `missing` placeholder, laid out by the real elkjs -- which is the
 *     thing that would throw if the placeholder didn't exist.
 */
test('deleting a mid-chain job leaves the graph honestly disconnected, never auto-rewired', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  await page.locator('[data-testid="rf__node-test"] .vce-dag-node').click();
  // The node's own delete affordance, which appears once it is selected --
  // the same popover the Delete key opens, via a path that doesn't depend on
  // React Flow's keyboard focus being where this spec assumes.
  await page.getByRole('button', { name: 'Remove "test" node' }).click();

  const dialog = page.getByRole('dialog');
  // The prompt names the actual sites, and the no-auto-rewiring caveat.
  await expect(dialog).toContainText('Deleting test changes');
  await expect(dialog).toContainText("removed from deploy's requires:");
  await expect(dialog).toContainText(
    'not re-pointed at whatever test required',
  );

  await dialog.getByRole('button', { name: 'Delete job' }).click();

  // `test` is gone from the canvas; `build` and `deploy` both remain, and no
  // edge was invented between them.
  await expect(page.locator('[data-testid="rf__node-test"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="rf__node-build"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="rf__node-deploy"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  // ...and the whole multi-site reconciliation undoes in one step.
  await page.getByRole('button', { name: /undo last change/i }).click();
  await expect(page.locator('[data-testid="rf__node-test"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
});

test('a dangling requires: renders as a broken edge into a missing placeholder, and elk lays it out', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await mockHostApi(page, {
    config: `# Hand-edited, with a reference to a job that does not exist.
version: 2.1

jobs:
  deploy:
    docker:
      - image: cimg/base:current
    steps:
      - checkout

workflows:
  main:
    jobs:
      - deploy:
          requires:
            - build
`,
  });
  await page.goto('/');

  // The placeholder exists, is labelled, and explains itself.
  const placeholder = page.locator('[data-testid="rf__node-build"]');
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder.locator('.vce-dag-node--missing')).toHaveCount(1);
  await expect(placeholder.getByText('missing')).toBeVisible();
  await expect(placeholder.locator('.vce-dag-node')).toHaveAttribute(
    'title',
    /Nothing in this workflow provides "build"/,
  );

  // The broken dependency is drawn, not hidden.
  await expect(page.locator('.vce-dag-edge--dangling')).toHaveCount(1);

  // ELK actually placed it: a real, non-degenerate transform, upstream of the
  // node that requires it. This is the assertion that would fail if elkjs
  // threw or skipped the node.
  const placeholderBox = await placeholder.boundingBox();
  const deployBox = await page
    .locator('[data-testid="rf__node-deploy"]')
    .boundingBox();
  expect(placeholderBox).not.toBeNull();
  expect(deployBox).not.toBeNull();
  expect(placeholderBox!.width).toBeGreaterThan(0);
  expect(placeholderBox!.x).toBeLessThan(deployBox!.x);

  // The problem banner still says so in words.
  await expect(
    page.getByText('requires unknown job "build"', { exact: false }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
