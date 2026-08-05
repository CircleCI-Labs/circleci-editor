import { expect, test, type Page } from '@playwright/test';

import { mockHostApi, VALID_STUB, type ValidateStub } from './fixtures';

/**
 * Issue #201: the source editor's `<CodeMirror>` is height-constrained
 * (`className="h-full"` on the component itself, load-bearing per that
 * file's own comment -- a 30-line config used to render a 790px editor
 * inside a 210px flex slot and paint over the diagnostics strip below it).
 * The compiled view's `<CodeMirror>` had no such className, so the same
 * shape of bug was reachable there too, just unverified against a
 * genuinely long compiled output. This spec reproduces it against the real
 * built app with a several-hundred-line stub `outputYaml` (a real orb
 * expansion would do the same thing; the fixture doesn't need to run one
 * to prove the layout bug).
 *
 * The "does it paint over something below it" check is against a point
 * just past the pane's own bottom edge, not a specific strip component:
 * `DiagnosticsStrip`/`RunStrip` only render conditionally (empty for a
 * plain valid config, in this codebase's current shape), so asserting
 * against one of them by name would be coupled to whichever happens to be
 * visible today. An overflowing editor bleeding out of its own pane would
 * paint over whatever sits below or beside it regardless of what that turns
 * out to be, so that's what's measured -- generalising the original bug
 * (which happened to land on `DiagnosticsStrip`) rather than depending on it.
 */

/** A compiled-looking config long enough to overflow a normal pane's height by a wide margin. Content doesn't need to be a real orb expansion -- only tall. */
function longCompiledYaml(lines: number): string {
  const jobs = Array.from(
    { length: lines },
    (_, i) =>
      `  expanded-step-${i}:\n    image: cimg/base:2024.01\n    command: echo step-${i}`,
  ).join('\n');
  return `version: 2.1\njobs:\n${jobs}\n`;
}

const LONG_YAML = longCompiledYaml(120);

function validStubWithOutput(outputYaml: string): ValidateStub {
  return { ...VALID_STUB, outputYaml };
}

/** Mirrors `scroll-regions.spec.ts`'s own probe -- see that file's doc
 * comment for why "overflow: auto/scroll AND content genuinely exceeds the
 * box" is the right definition of "scrollable", not just the CSS property. */
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

test.describe("the compiled view's CodeMirror stays inside its pane (issue #201)", () => {
  test('a long compiled config does not overflow past the pane, and nothing outside the pane becomes unreachable', async ({
    page,
  }) => {
    await mockHostApi(page, { validate: validStubWithOutput(LONG_YAML) });
    await page.goto('/');

    await page.getByRole('button', { name: 'Compiled' }).click();
    await expect(
      page.getByRole('button', { name: 'Compiled' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // The compiled `.cm-editor` must be visible and must not extend past the
    // bottom of its pane -- the exact shape of overflow this issue is about
    // (measured on the source view's pre-fix version: a 790px editor inside a
    // 210px slot, per `YamlPane.tsx`'s own comment on the source editor's
    // `h-full`).
    const paneBox = await page.getByTestId('pane-yaml').boundingBox();
    const editorBox = await page.locator('.cm-editor:visible').boundingBox();
    if (!paneBox || !editorBox) throw new Error('missing bounding box');

    const overflowPx =
      editorBox.y + editorBox.height - (paneBox.y + paneBox.height);
    // Reported with the actual number either way, so a regression shows a
    // real pixel count rather than just "fail". Measured on the real built
    // app: 6304.14px of overflow before this fix (a 120-"step" compiled
    // config, same shape of bug as the source view's own pre-fix defect,
    // just unverified until now); comfortably negative (inset by the new
    // padding) after it.
    expect(overflowPx).toBeLessThanOrEqual(1); // 1px tolerance for rounding

    // Still exactly the one scroll region this app allows per pane
    // (#88): `.cm-scroller`, doing the scrolling internally -- not a
    // second one from the editor spilling into `Panel`'s own `overflow-auto`
    // wrapper.
    const scrollRegions = await countScrollableRegionsIn(page, 'pane-yaml');
    expect(scrollRegions).toBe(1);

    // Whatever sits just past the pane's own bottom edge (a sibling pane in
    // most presets) must still be reachable there -- not painted over by an
    // editor that's bled out of its own box. This is the generalised form of
    // the reported symptom (the diagnostics strip, specifically, being
    // covered): an overflowing editor doesn't respect pane boundaries at all,
    // and whatever happens to be below it is what would have paid for that.
    const belowPaneY = paneBox.y + paneBox.height + 5;
    const belowPaneX = paneBox.x + paneBox.width / 2;
    const hitsOwnPane = await page.evaluate(
      ({ x, y, testId }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return false; // nothing there at all -- can't be a paint-over
        return el.closest(`[data-testid="${testId}"]`) !== null;
      },
      { x: belowPaneX, y: belowPaneY, testId: 'pane-yaml' },
    );
    expect(hitsOwnPane).toBe(false);
  });

  test('a short compiled config still renders normally (no regression for the common case)', async ({
    page,
  }) => {
    await mockHostApi(page, {
      validate: validStubWithOutput('version: 2.1\njobs: {}\n'),
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Compiled' }).click();
    await expect(page.locator('.cm-editor:visible')).toBeVisible();
    await expect(
      page
        .getByLabel('Compiled CircleCI config (read-only)')
        .getByText('version: 2.1'),
    ).toBeVisible();

    const scrollRegions = await countScrollableRegionsIn(page, 'pane-yaml');
    expect(scrollRegions).toBeLessThanOrEqual(1);
  });
});
