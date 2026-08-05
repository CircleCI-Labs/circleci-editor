import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_COMMENT, mockHostApi } from './fixtures';

/**
 * Issue #287: the owner's own framing was "we don't have a diff checker" --
 * a diff of the working buffer against disk already existed twice over (the
 * Save dialog, the AI pane's approval dialog), but only ever as a step
 * inside someone else's flow. This adds a third mode to the pane's own
 * Source/Compiled toggle, so "what have I changed?" is answerable without
 * opening either dialog first.
 *
 * This spec drives the real, built app (no component mocking, unlike
 * `YamlPane.test.tsx`), so it can assert on things a unit test can't see:
 * the actual `.cm-editor`/pane layout math (mirroring `compiled-view.spec.ts`
 * for issue #201) and real Chromium text layout for the toggle's own width
 * budget (mirroring `docs-pane.spec.ts` for issue #248) -- exactly the gap
 * issue #295 flagged when a previous view change shipped with unit test
 * coverage but no e2e assertion of its own.
 */

/** Mirrors `scroll-regions.spec.ts`'s and `compiled-view.spec.ts`'s own
 * probe -- see either file's doc comment for why "overflow: auto/scroll AND
 * content genuinely exceeds the box" is the right definition of
 * "scrollable", not just the CSS property. */
async function countScrollableRegionsIn(
  page: Page,
  testId: string,
): Promise<number> {
  return page.evaluate((id) => {
    const container = document.querySelector(`[data-testid="${id}"]`);
    if (!container) throw new Error(`no element with data-testid="${id}"`);
    const all = container.querySelectorAll('*');
    let count = 0;
    for (const element of all) {
      const cs = getComputedStyle(element);
      const scrollsY =
        /auto|scroll/.test(cs.overflowY) &&
        element.scrollHeight > element.clientHeight + 2;
      const scrollsX =
        /auto|scroll/.test(cs.overflowX) &&
        element.scrollWidth > element.clientWidth + 2;
      if (scrollsY || scrollsX) count += 1;
    }
    return count;
  }, testId);
}

test.describe('the Diff view (issue #287)', () => {
  test('states "no changes" plainly, not an empty pane, for an unedited buffer', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Diff' }).click();
    await expect(page.getByRole('button', { name: 'Diff' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const diffView = page.getByTestId('yaml-diff-view');
    await expect(
      diffView.getByText("No changes -- this file matches what's on disk."),
    ).toBeVisible();
    await expect(page.getByText('Diff vs. disk (no changes)')).toBeVisible();
  });

  test('shows exactly the edited line, in context, and updates live as you keep typing -- the minimal-diff promise made visible', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');

    // A single-character edit deep in the fixture -- the surgical-edit case
    // the product exists for, per the issue's own framing. `.cm-line` with
    // `hasText`, not a direct `getByText` on the line's own text, because
    // CodeMirror's syntax highlighting can split a line's text across
    // several decorated spans (see `xcode-and-tags.spec.ts`'s identical
    // pattern for clicking into a specific line).
    await page
      .locator('.cm-content .cm-line', { hasText: 'cimg/node:20.0' })
      .first()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('.1');

    await page.getByRole('button', { name: 'Diff' }).click();

    const diffView = page.getByTestId('yaml-diff-view');
    await expect(diffView.getByText('cimg/node:20.0.1')).toBeVisible();
    // `unifiedDiff`'s 3-line context window (see `lib/yaml/diff.ts`) means
    // only lines *near* the edit render as unchanged context -- not the
    // whole file, which would defeat the point of a minimal diff. `docker:`,
    // two lines above the edited image line, is inside that window.
    await expect(diffView.getByText('docker:')).toBeVisible();
    // The fixture's own comment, several lines further away, falls outside
    // that window and is correctly absent -- this is a diff, not a render of
    // the entire file with one line highlighted.
    await expect(
      diffView.getByText(FIXTURE_COMMENT.replace(/^#\s*/, '')),
    ).not.toBeVisible();
    await expect(page.getByText(/diff vs\. disk/i)).toContainText('+1');
    await expect(page.getByText(/diff vs\. disk/i)).toContainText('-1');

    // Switching to Source and back re-derives the diff against the buffer's
    // *current* text -- it is not a one-shot snapshot taken when the tab was
    // first opened.
    await page.getByRole('button', { name: 'Source' }).click();
    // Clicking the toggle moved keyboard focus to that button, not into the
    // (still-mounted-but-was-hidden) editor -- re-click the line to focus it
    // again before typing, same as the very first edit above.
    await page
      .locator('.cm-content .cm-line', { hasText: 'cimg/node:20.0.1' })
      .first()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('9');
    await page.getByRole('button', { name: 'Diff' }).click();
    await expect(diffView.getByText('cimg/node:20.0.19')).toBeVisible();
  });

  test('still renders a diff against invalid YAML, since a text diff needs no successful parse', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    // An unterminated flow sequence -- reliably a parse error regardless of
    // indentation context, unlike a stray top-level key whose validity
    // depends on exactly where the cursor landed. `insertText`, not `type`:
    // CodeMirror's `closeBrackets` extension auto-inserts the matching `]`
    // for a *typed* `[` (each keystroke goes through its own keydown
    // handling), which would make this valid, empty-array YAML instead of
    // the unterminated sequence the test needs -- `insertText` delivers the
    // whole string as one input event, the same as a paste, bypassing that.
    await page.keyboard.insertText('\nbroken: [\n');
    // Exact match: the parse-error banner at the bottom of the pane says
    // "Invalid YAML: <message>", which `getByText('Invalid YAML')` (a
    // substring match by default) also matches -- this is checking the
    // header badge specifically.
    await expect(page.getByText('Invalid YAML', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Diff' }).click();
    await expect(
      page.getByTestId('yaml-diff-view').getByText('broken: ['),
    ).toBeVisible();
  });

  test('the diff fills its pane with no overflow and exactly one scroll region (issue #201, #88)', async ({
    page,
  }) => {
    // A long config with a change on *every* job's image line -- a single
    // isolated one-line change wouldn't overflow a pane regardless of how
    // long the surrounding file is, since the diff view only ever renders
    // the changed lines plus `unifiedDiff`'s 3-line context window around
    // them (see the previous test). Consecutive job entries here are only 3
    // lines apart, so their context windows touch and the diff library
    // merges them into hunks spanning most of the file -- which is what
    // gives this test real content to overflow the pane's height with, the
    // same shape of check `compiled-view.spec.ts` makes for the Compiled
    // view after its own #201 fix.
    const manyJobs = (tag: string) =>
      Array.from(
        { length: 80 },
        (_, i) => `  job-${i}:\n    docker:\n      - image: cimg/base:${tag}`,
      ).join('\n');
    const longConfig = `version: 2.1\njobs:\n${manyJobs('2024.01')}\n`;
    const editedConfig = `version: 2.1\njobs:\n${manyJobs('2024.02')}\n`;
    await mockHostApi(page, { config: longConfig });
    await page.goto('/');

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+A');
    // `insertText`, not `type`: replacing 240+ lines one keystroke at a time
    // is both slow and, per the previous test's own note, subject to
    // `closeBrackets` altering anything with a bracket in it -- a single
    // input event matches how a real paste (or this app's own `setText`
    // from a large programmatic change) actually lands.
    await page.keyboard.insertText(editedConfig);

    await page.getByRole('button', { name: 'Diff' }).click();
    // 80 near-identical added lines -- `.first()` because asserting
    // "at least one is visible" is the point, not which one.
    await expect(
      page.getByTestId('yaml-diff-view').getByText('cimg/base:2024.02').first(),
    ).toBeVisible();

    const paneBox = await page.getByTestId('pane-yaml').boundingBox();
    const diffBox = await page.getByTestId('yaml-diff-view').boundingBox();
    if (!paneBox || !diffBox) throw new Error('missing bounding box');

    const overflowPx =
      diffBox.y + diffBox.height - (paneBox.y + paneBox.height);
    expect(overflowPx).toBeLessThanOrEqual(1); // 1px tolerance for rounding

    const scrollRegions = await countScrollableRegionsIn(page, 'pane-yaml');
    expect(scrollRegions).toBe(1);

    // Whatever sits below the pane must still be reachable -- the diff
    // hasn't bled out of its own box and painted over it.
    const belowPaneY = paneBox.y + paneBox.height + 5;
    const belowPaneX = paneBox.x + paneBox.width / 2;
    const hitsOwnPane = await page.evaluate(
      ({ x, y, testId }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return false;
        return el.closest(`[data-testid="${testId}"]`) !== null;
      },
      { x: belowPaneX, y: belowPaneY, testId: 'pane-yaml' },
    );
    expect(hitsOwnPane).toBe(false);
  });
});

/**
 * The toggle's own width budget, measured rather than assumed (this
 * project's convention -- see #226, #217). `MIN_PANE_PX.yaml` (300px,
 * `layout/constants.ts`) is the pane's real floor; 260px is also checked as
 * a stricter stress case, since #248 already found that a fourth control at
 * that width needed padding clawed back to fit, and this control shares its
 * header row with the autosave switch, Run and Save rather than owning a
 * strip of its own.
 */
test.describe('Source/Compiled/Diff toggle width budget', () => {
  for (const widthPx of [300, 260]) {
    test(`the three-segment toggle fits at a ${widthPx}px pane width without wrapping or overflowing`, async ({
      page,
    }) => {
      await mockHostApi(page);
      await page.goto('/');
      // The pane and its own toggle render asynchronously (after the host
      // API calls this test just stubbed resolve) -- `page.evaluate` has no
      // auto-waiting of its own, unlike a locator assertion, so it must wait
      // for the real target to exist first.
      await page.getByRole('button', { name: 'Diff' }).waitFor();

      const measurement = await page.evaluate((width) => {
        const paneEl = document.querySelector(
          '[data-testid="pane-yaml"]',
        ) as HTMLElement | null;
        if (!paneEl) return null;
        paneEl.style.setProperty('width', `${width}px`, 'important');
        paneEl.style.setProperty('flex', `0 0 ${width}px`, 'important');
        paneEl.style.setProperty('max-width', `${width}px`, 'important');

        const group = paneEl.querySelector('[aria-label="Config view"]');
        if (!group) return null;
        const rect = group.getBoundingClientRect();
        const buttons = Array.from(group.querySelectorAll('button')).map(
          (button) => {
            const buttonRect = button.getBoundingClientRect();
            return {
              label: button.textContent,
              top: Math.round(buttonRect.top),
            };
          },
        );
        return {
          paneWidth: Math.round(paneEl.getBoundingClientRect().width),
          groupScrollWidth: group.scrollWidth,
          groupClientWidth: Math.round(rect.width),
          buttonTops: buttons.map((b) => b.top),
          buttonLabels: buttons.map((b) => b.label),
        };
      }, widthPx);

      expect(measurement).not.toBeNull();
      // eslint-disable-next-line no-console -- deliberate: this project
      // measures rather than asserts blind, and the number is the point.
      console.log(
        `[yaml toggle width budget, ${widthPx}px] pane=${measurement!.paneWidth}px ` +
          `group scrollWidth=${measurement!.groupScrollWidth}px ` +
          `clientWidth=${measurement!.groupClientWidth}px ` +
          `labels=${JSON.stringify(measurement!.buttonLabels)}`,
      );

      expect(measurement!.buttonLabels).toEqual(['Source', 'Compiled', 'Diff']);
      // No horizontal overflow inside the toggle itself...
      expect(measurement!.groupScrollWidth).toBeLessThanOrEqual(
        measurement!.groupClientWidth + 1,
      );
      // ...and no wrapping to a second row: every button's top edge is the
      // same.
      expect(new Set(measurement!.buttonTops).size).toBe(1);
    });
  }
});
