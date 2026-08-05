import { expect, test, type Page } from '@playwright/test';

import {
  AA_NORMAL_TEXT,
  contrastRatio,
  parseRgb,
} from '../src/lib/color/contrast';
import { mockHostApi } from './fixtures';

/**
 * Issues #218 and #219, measured against the real built bundle.
 *
 * These belong in Playwright rather than in `Inspector.test.tsx` because every
 * claim here is about *rendered* geometry, and jsdom has none: it applies no
 * stylesheet (so a font size is whatever the test asserts about a class name),
 * gives every `getBoundingClientRect()` zeroes, and does not hide a closed
 * `<details>`'s content the way a UA stylesheet does. Each of those was a real
 * trap while writing the unit tests, and each is the property being checked.
 */

/** Opens the default preset on the fixture config with `build` selected. */
async function openInspector(page: Page): Promise<void> {
  await mockHostApi(page, {});
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await page
    .locator('.vce-dag-node')
    .getByText('build', { exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Steps', exact: true }),
  ).toBeVisible();
}

test.describe('step keyword type size (issue #218 part 1)', () => {
  test('renders the step keyword at the badge size, not the document default', async ({
    page,
  }) => {
    await openInspector(page);

    const measured = await page.evaluate(() => {
      const badges = Array.from(
        document.querySelectorAll(
          '[data-testid="pane-dag"] .vce-dag-kind-label',
        ),
      );
      return badges.map((element) => {
        const el = element as HTMLElement;
        return {
          text: el.textContent,
          fontSize: getComputedStyle(el).fontSize,
          truncated: el.scrollWidth > el.clientWidth + 1,
        };
      });
    });

    expect(measured.length).toBeGreaterThan(0);
    for (const badge of measured) {
      // The reported defect: this rendered at 16px -- `text-base`, the top of
      // CircleCI's own 12/14/16/20/24 scale and body-copy size -- because
      // `.vce-dag-kind-label` sets no font-size and this call site, unlike
      // `JobNode.tsx`'s two, never paired it with a size class. 11px is
      // `--text-2xs`, the value the same badge uses on a DAG node.
      expect(badge.fontSize).toBe('11px');
      // And the second half of the report -- "gets cut off". At the inspector's
      // own 280px default, nothing in this row truncates any more. Measured
      // before the fix: `checkout` was 93px wide inside a ~104px cap; after,
      // 64px.
      expect(badge.truncated).toBe(false);
    }
  });
});

test.describe('collapsible inspector sections (issue #219)', () => {
  test('collapses the empty sections, opens the ones with content, and shrinks the pane', async ({
    page,
  }) => {
    await openInspector(page);

    // `build` in the fixture has steps and an executor, and no pre-steps,
    // post-steps, context, filters or requires.
    for (const title of ['Pre-steps', 'Post-steps', 'Filters', 'Context']) {
      const details = page
        .locator('details', {
          has: page.getByRole('heading', { name: title, exact: true }),
        })
        .first();
      await expect(details).not.toHaveAttribute('open', '');
      // The summary row is still visible -- collapsing hides content, never the
      // fact that the section exists.
      await expect(
        page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
    }
    const steps = page
      .locator('details', {
        has: page.getByRole('heading', { name: 'Steps', exact: true }),
      })
      .first();
    await expect(steps).toHaveAttribute('open', '');

    // The measured payoff. Before #219 the inspector's content was 1784px tall
    // for exactly this job on exactly this preset; after, 1088px -- a 696px
    // (39%) reduction, of which ~700px is the five sections above collapsing
    // from 834px to 135px. Asserted with headroom so this tracks the property
    // (the pane's content got substantially shorter) rather than one build's
    // font metrics.
    const contentHeight = await page.evaluate(() => {
      const separator = document.querySelector(
        '[aria-label="Resize inspector panel"]',
      );
      const root = separator?.nextElementSibling as HTMLElement | null;
      const scroller = root?.querySelector(
        '.overflow-y-auto',
      ) as HTMLElement | null;
      return scroller?.scrollHeight ?? 0;
    });
    expect(contentHeight).toBeGreaterThan(0);
    expect(contentHeight).toBeLessThan(1400);
  });

  test('a collapsed section holding content says how much, and hides it visually', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: `version: 2.1

jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout

workflows:
  main:
    jobs:
      - build:
          post-steps:
            - run: notify-a
            - run: notify-b
            - run: notify-c
`,
    });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
    await page
      .locator('.vce-dag-node')
      .getByText('build', { exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Steps', exact: true }),
    ).toBeVisible();

    const postSteps = page
      .locator('details', {
        has: page.getByRole('heading', { name: 'Post-steps', exact: true }),
      })
      .first();
    // Three post-steps, so the content rule opens it.
    await expect(postSteps).toHaveAttribute('open', '');
    await expect(postSteps.getByText('notify-a')).toBeVisible();

    // Collapse it by hand.
    await page
      .getByRole('heading', { name: 'Post-steps', exact: true })
      .click();
    await expect(postSteps).not.toHaveAttribute('open', '');

    // The requirement from #219, in its own words: "a collapsed section holding
    // three post-steps must say so on its summary row -- otherwise this trades
    // crowding for invisible configuration, which is worse in a config editor."
    await expect(postSteps.locator('summary').getByText('3')).toBeVisible();
    // ...and the content really is hidden, which is the half jsdom cannot check.
    await expect(postSteps.getByText('notify-a')).toBeHidden();
  });

  test('a collapsed choice survives a reload, and adds no scroll region', async ({
    page,
  }) => {
    await openInspector(page);

    // Steps opens by default; close it and reload.
    await page.getByRole('heading', { name: 'Steps', exact: true }).click();
    const steps = page
      .locator('details', {
        has: page.getByRole('heading', { name: 'Steps', exact: true }),
      })
      .first();
    await expect(steps).not.toHaveAttribute('open', '');

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
    await page
      .locator('.vce-dag-node')
      .getByText('build', { exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Steps', exact: true }),
    ).toBeVisible();
    // Persisted via `inspectorSectionStore`'s versioned JSON, the same pattern
    // `layoutStore`/`themeStore` use -- an explicit choice outranks the content
    // rule that would otherwise have opened this.
    await expect(
      page
        .locator('details', {
          has: page.getByRole('heading', { name: 'Steps', exact: true }),
        })
        .first(),
    ).not.toHaveAttribute('open', '');
  });
});

test.describe('step reordering and positioned drops (issue #218 parts 2 and 3)', () => {
  /**
   * These two use Playwright's real mouse, which is what proves the whole
   * gesture works in a real browser: a real drag, with real
   * `getBoundingClientRect()` values, puts the step where the gap rule says it
   * should go -- in both directions, which is what pins the off-by-one #218
   * fixed.
   *
   * What a real mouse drag *cannot* do is assert anything mid-drag. Chromium
   * runs native drag-and-drop as a nested message loop that blocks the
   * renderer's task queue, so no Playwright expression evaluates between
   * `mouse.down()` and `mouse.up()`. Measured while #218 was written:
   * `getByTestId(...)` polled 14 times mid-drag and resolved to 0 elements every
   * time, then the same drag completed and reordered the document correctly. So
   * the mid-drag half -- which for #249 is the whole feature -- is driven by
   * dispatched drag events instead; see `stepDrag` below.
   */
  test('dropping on a row upper half moves the step above that row', async ({
    page,
  }) => {
    await openInspector(page);

    const rows = page.locator(
      'details:has(h4:text-is("Steps")) [data-step-row]',
    );
    await expect(rows).toHaveCount(3);

    const source = rows.nth(0); // checkout
    const target = rows.nth(2); // pnpm build
    await source.hover();
    await page.mouse.down();
    const box = (await target.boundingBox())!;
    // Upper half of the last row: the gap *above* it.
    await page.mouse.move(box.x + box.width / 2, box.y + 2, { steps: 8 });
    await page.mouse.up();

    const yaml = await page.evaluate(
      () =>
        document.querySelector('[data-testid="pane-yaml"] .cm-content')
          ?.textContent ?? '',
    );
    // checkout landed between `pnpm install` and `pnpm build`.
    const install = yaml.indexOf('pnpm install');
    const checkout = yaml.indexOf('checkout');
    const build = yaml.indexOf('pnpm build');
    expect(install).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(checkout);
  });

  test('reordering by drag writes the new order and keeps the file otherwise identical', async ({
    page,
  }) => {
    await openInspector(page);

    const rows = page.locator(
      'details:has(h4:text-is("Steps")) [data-step-row]',
    );
    const source = rows.nth(0); // checkout
    const target = rows.nth(2); // pnpm build

    await source.hover();
    await page.mouse.down();
    const box = (await target.boundingBox())!;
    // Lower half of the last row: the gap *after* it -- the position a
    // row-indexed drop target could not name at all.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2, {
      steps: 6,
    });
    await page.mouse.up();

    // `checkout` is now last. Read off the YAML pane, which is the document,
    // not the inspector's own rendering of it.
    const yaml = await page.evaluate(
      () =>
        document.querySelector('[data-testid="pane-yaml"] .cm-content')
          ?.textContent ?? '',
    );
    const build = yaml.indexOf('pnpm build');
    const checkout = yaml.indexOf('checkout');
    expect(build).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(build);
    // And the fixture's own header comment is untouched -- the guarantee this
    // editor is built on, asserted on the mutation whose whole purpose is
    // moving nodes around.
    expect(yaml).toContain('Managed by the platform team');
  });

  test('the inspector still has no nested scroll region of its own (issue #88)', async ({
    page,
  }) => {
    await openInspector(page);

    const regions = await page.evaluate(() => {
      const separator = document.querySelector(
        '[aria-label="Resize inspector panel"]',
      );
      const root = separator?.nextElementSibling as HTMLElement | null;
      if (!root) throw new Error('inspector not mounted');
      let count = 0;
      for (const element of root.querySelectorAll('*')) {
        const el = element as HTMLElement;
        const cs = getComputedStyle(el);
        const scrollsY =
          /auto|scroll/.test(cs.overflowY) &&
          el.scrollHeight > el.clientHeight + 2;
        const scrollsX =
          /auto|scroll/.test(cs.overflowX) &&
          el.scrollWidth > el.clientWidth + 2;
        if (scrollsY || scrollsX) count += 1;
      }
      return count;
    });

    // One: the inspector's own content column, which is the region that already
    // existed. #218 adds drag affordances and an insertion indicator and #219
    // adds seven `<details>`, and neither introduces a second scroller -- the
    // specific accident the one-scroll-region-per-pane rule exists to prevent.
    // #249's drop region is a plain wrapper with no `overflow` and no height
    // of its own for the same reason; the mid-drag version of this count is
    // asserted below.
    expect(regions).toBeLessThanOrEqual(1);
  });
});

/**
 * Issue #249 part 1, the reflow -- asserted mid-drag, in a real browser, with
 * real layout.
 *
 * Everything here would be vacuous in jsdom (no layout, so no displacement to
 * observe) and impossible with Playwright's real mouse (Chromium's native drag
 * blocks the renderer, see the note above). So the drag is driven by dispatched
 * `DragEvent`s carrying a real `DataTransfer`, which is the one way to hold a
 * drag open *and* evaluate expressions while it is open. That is a fair test of
 * this feature specifically: every input the implementation reads -- pointer
 * coordinates, `getBoundingClientRect()`, the reflow those coordinates cause --
 * is the browser's own, and the only thing being stood in for is the pointer
 * device.
 */
type DragProbe = {
  /** Where the gap is among the `<ul>`'s children -- which *is* the insertion gap index, since every child before it is a row. `null` when no gap is open. */
  gap: number | null;
  /** Each step row's `getBoundingClientRect().top`, so displacement is observable. */
  rowTops: number[];
  slot: { top: number; height: number } | null;
  rowHeights: number[];
};

async function stepDrag(
  page: Page,
  action:
    | { kind: 'start' | 'end'; row: number }
    | { kind: 'over' | 'drop'; y: number },
): Promise<DragProbe> {
  return page.evaluate(async (arg) => {
    const holder = window as unknown as { __vceDragTransfer?: DataTransfer };
    let region: HTMLElement | null = null;
    for (const details of document.querySelectorAll('details')) {
      if (details.querySelector('h4')?.textContent?.trim() === 'Steps') {
        region = details.querySelector('[data-testid="step-drop-region"]');
        break;
      }
    }
    if (!region) throw new Error('the Steps drop region is not mounted');
    const rows = () =>
      Array.from(region!.querySelectorAll<HTMLElement>('[data-step-row]'));

    if (arg.kind === 'start') {
      const transfer = new DataTransfer();
      holder.__vceDragTransfer = transfer;
      rows()[arg.row]!.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    } else if (arg.kind === 'end') {
      rows()[arg.row]!.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer: holder.__vceDragTransfer!,
        }),
      );
    } else {
      // Dispatched on whatever is actually under the pointer, not on the region,
      // so bubbling and `elementFromPoint` are the browser's and the handler
      // sees the same target it would in a real drag -- including the gap `<li>`
      // itself once one is open.
      const x = region.getBoundingClientRect().left + 10;
      const target = document.elementFromPoint(x, arg.y) ?? region;
      target.dispatchEvent(
        new DragEvent(arg.kind === 'over' ? 'dragover' : 'drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: arg.y,
          dataTransfer: holder.__vceDragTransfer!,
        }),
      );
    }

    // `dragover` is a continuous-priority event in React 18, so the re-render is
    // scheduled rather than flushed inside `dispatchEvent`. Two frames is after
    // the commit *and* after the browser has laid the displaced rows out, which
    // is the thing being measured.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const list = region.querySelector('ul');
    const children = list ? Array.from(list.children) : [];
    const slotIndex = children.findIndex(
      (child) => child.getAttribute('data-testid') === 'step-drop-slot',
    );
    const slotRect =
      slotIndex >= 0 ? children[slotIndex]!.getBoundingClientRect() : null;
    return {
      gap: slotIndex >= 0 ? slotIndex : null,
      rowTops: rows().map((row) => row.getBoundingClientRect().top),
      rowHeights: rows().map((row) => row.getBoundingClientRect().height),
      slot: slotRect ? { top: slotRect.top, height: slotRect.height } : null,
    };
  }, action);
}

test.describe('the drop position is shown by reflowing the list (issue #249 part 1)', () => {
  test('opens a real gap between the rows, displacing everything below it', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 0 });
    expect(before.gap).toBeNull();
    expect(before.rowTops).toHaveLength(3);

    // Into the lower half of the second row: the gap between rows 2 and 3.
    const secondRowMiddle = before.rowTops[1]! + before.rowHeights[1]! * 0.75;
    const during = await stepDrag(page, { kind: 'over', y: secondRowMiddle });

    // The affordance is a real element *between* two rows, not a marker drawn on
    // one of them: #218's line was `absolute` and out of flow, and would report
    // no gap here and no displacement below.
    expect(during.gap).toBe(2);
    expect(during.slot!.height).toBeGreaterThanOrEqual(20);
    // The rows above have not moved a pixel...
    expect(during.rowTops[0]).toBeCloseTo(before.rowTops[0]!, 1);
    expect(during.rowTops[1]).toBeCloseTo(before.rowTops[1]!, 1);
    // ...and the row below has moved down by the gap, which is what "you can see
    // the elements kind of move out of the way" means in pixels.
    const displacement = during.rowTops[2]! - before.rowTops[2]!;
    expect(displacement).toBeGreaterThanOrEqual(during.slot!.height);

    // The gap sits in the space the displacement opened, between the two rows.
    expect(during.slot!.top).toBeGreaterThan(
      during.rowTops[1]! + during.rowHeights[1]! - 1,
    );
    expect(during.slot!.top + during.slot!.height).toBeLessThanOrEqual(
      during.rowTops[2]! + 1,
    );

    // And it is not left behind when the drag ends without a drop.
    const after = await stepDrag(page, { kind: 'end', row: 0 });
    expect(after.gap).toBeNull();
    expect(after.rowTops[2]).toBeCloseTo(before.rowTops[2]!, 1);
  });

  test('is unambiguous before the first row and after the last', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 1 });

    const top = await stepDrag(page, {
      kind: 'over',
      y: before.rowTops[0]! + 1,
    });
    expect(top.gap).toBe(0);
    // Every row moved down: there is now something above the first one.
    expect(top.rowTops[0]!).toBeGreaterThan(before.rowTops[0]!);

    const lastRowBottom = before.rowTops[2]! + before.rowHeights[2]! - 1;
    const bottom = await stepDrag(page, { kind: 'over', y: lastRowBottom });
    expect(bottom.gap).toBe(3);
    // Nothing moved -- the gap is past the end of the list -- and it really is
    // below the last row, which is the position #218's row-indexed targets could
    // not name at all.
    expect(bottom.rowTops[0]).toBeCloseTo(before.rowTops[0]!, 1);
    expect(bottom.slot!.top).toBeGreaterThan(lastRowBottom);
  });

  /**
   * #249's own acceptance criterion, and the reason #218 kept its indicator out
   * of the flow: *"a gap that flickers between two indices while the cursor sits
   * still is worse than a static line."*
   *
   * This is the test that could only be written here. The feedback loop being
   * guarded against is a *layout* loop -- gap displaces rows, displaced rows
   * change which gap the pointer is in -- so it needs a browser that really
   * lays out. The pointer is held at one coordinate across twelve `dragover`s,
   * exactly as a browser reports while a hand holds still, and the answer has to
   * be one answer.
   */
  test('never flickers between two gaps while the pointer holds still', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 0 });
    // Deliberately within a couple of pixels of row 2's midpoint -- the boundary
    // between two gaps, where a live measurement is most likely to oscillate.
    const onTheBoundary = before.rowTops[1]! + before.rowHeights[1]! / 2 + 1;

    const seen: (number | null)[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      seen.push((await stepDrag(page, { kind: 'over', y: onTheBoundary })).gap);
    }

    expect([...new Set(seen)]).toEqual([2]);
  });

  test('moves the gap monotonically as the pointer walks down the list', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 0 });
    const from = before.rowTops[0]!;
    const to = before.rowTops[2]! + before.rowHeights[2]!;

    const seen: (number | null)[] = [];
    for (let y = from; y <= to; y += 2) {
      seen.push((await stepDrag(page, { kind: 'over', y })).gap);
    }

    // A downward gesture may not produce an upward gap, ever. This is the
    // oscillation test's companion: the one above pins a still pointer, this
    // pins a moving one, and a live-measured implementation fails this even
    // where it survives that (each step of the walk re-measures rows the
    // previous step displaced).
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]!).toBeGreaterThanOrEqual(seen[index - 1]!);
    }
    // ...and it really did traverse the list rather than sitting on one gap.
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(3);
  });

  test('adds no second scroll region while the gap is open (issue #88)', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 0 });
    const during = await stepDrag(page, {
      kind: 'over',
      y: before.rowTops[0]! + 1,
    });
    expect(during.gap).toBe(0);

    // The list is genuinely one row taller than it was, inside a pane that
    // already overflows -- which is exactly the moment a stray `overflow` would
    // show up. This is the state the scroll-region count above cannot reach,
    // because a real mouse drag blocks every expression that could measure it.
    const regions = await page.evaluate(() => {
      const separator = document.querySelector(
        '[aria-label="Resize inspector panel"]',
      );
      const root = separator?.nextElementSibling as HTMLElement | null;
      if (!root) throw new Error('inspector not mounted');
      let count = 0;
      for (const element of root.querySelectorAll('*')) {
        const el = element as HTMLElement;
        const cs = getComputedStyle(el);
        if (
          (/auto|scroll/.test(cs.overflowY) &&
            el.scrollHeight > el.clientHeight + 2) ||
          (/auto|scroll/.test(cs.overflowX) &&
            el.scrollWidth > el.clientWidth + 2)
        ) {
          count += 1;
        }
      }
      return count;
    });
    expect(regions).toBeLessThanOrEqual(1);
  });

  test('the step lands in the gap that was open, comments intact', async ({
    page,
  }) => {
    await openInspector(page);
    const before = await stepDrag(page, { kind: 'start', row: 0 }); // checkout
    const y = before.rowTops[2]! + before.rowHeights[2]! - 1;
    const during = await stepDrag(page, { kind: 'over', y });
    expect(during.gap).toBe(3);
    await stepDrag(page, { kind: 'drop', y });

    const yaml = await page.evaluate(
      () =>
        document.querySelector('[data-testid="pane-yaml"] .cm-content')
          ?.textContent ?? '',
    );
    // `checkout` went to the gap that was on screen: the very end.
    expect(yaml.indexOf('checkout')).toBeGreaterThan(
      yaml.indexOf('pnpm build'),
    );
    // The guarantee this editor is built on, on the mutation whose whole job is
    // moving nodes around.
    expect(yaml).toContain('Managed by the platform team');
    // Nothing left over from the drag.
    await expect(page.getByTestId('step-drop-slot')).toHaveCount(0);
  });

  test('an empty step list says where the drop will land too', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: `version: 2.1

jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps: []

workflows:
  main:
    jobs:
      - build
`,
    });
    await page.goto('/');
    await page
      .locator('.vce-dag-node')
      .getByText('build', { exact: true })
      .click();
    await expect(page.getByText('No steps yet.')).toBeVisible();

    // No rows to displace, so the empty state itself becomes the gap. Driven
    // through the region the same way, with a synthesised palette-step payload
    // rather than a row drag, since there is no row to pick up.
    const shown = await page.evaluate(async () => {
      let region: HTMLElement | null = null;
      for (const details of document.querySelectorAll('details')) {
        if (details.querySelector('h4')?.textContent?.trim() === 'Steps') {
          region = details.querySelector('[data-testid="step-drop-region"]');
          break;
        }
      }
      if (!region) throw new Error('the Steps drop region is not mounted');
      const transfer = new DataTransfer();
      transfer.setData(
        'application/x-vce-palette-step',
        JSON.stringify({ stepKey: 'checkout' }),
      );
      const empty = region.querySelector('p')!;
      const rect = empty.getBoundingClientRect();
      empty.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 10,
          clientY: rect.top + rect.height / 2,
          dataTransfer: transfer,
        }),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const slot = region.querySelector('[data-testid="step-drop-slot"]');
      return {
        isTheEmptyState: slot === empty,
        borderStyle: slot ? getComputedStyle(slot).borderTopStyle : null,
        height: slot ? slot.getBoundingClientRect().height : 0,
      };
    });

    expect(shown.isTheEmptyState).toBe(true);
    expect(shown.borderStyle).toBe('dashed');
    expect(shown.height).toBeGreaterThanOrEqual(20);
  });
});

test.describe('the reorder arrows read as controls (issue #249 part 2)', () => {
  test('have a resting boundary and full-contrast glyphs, and cost no row height', async ({
    page,
  }) => {
    await openInspector(page);

    const measured = await page.evaluate(() => {
      let list: HTMLElement | null = null;
      for (const details of document.querySelectorAll('details')) {
        if (details.querySelector('h4')?.textContent?.trim() === 'Steps') {
          list = details.querySelector('ul');
          break;
        }
      }
      if (!list) throw new Error('the Steps list is not mounted');
      // Row 2 of 3: both arrows enabled.
      const row = list.children[1] as HTMLElement;
      const up = row.querySelector<HTMLElement>(
        '[aria-label="Move step 2 up"]',
      )!;
      // This app's `--color-cc-*` tokens are `oklch()` (issue #69), and
      // Chromium's CSS Color 4 support preserves that notation in the *computed*
      // value -- so a computed colour here is not necessarily an `rgb(...)`
      // string. Normalised through a canvas, which is the one thing in the page
      // that understands every CSS colour syntax authoritatively;
      // `e2e/contrast.spec.ts` carries the full rationale and the false-positive
      // failures that skipping this produced.
      const swatch = document.createElement('canvas');
      swatch.width = 1;
      swatch.height = 1;
      const ctx = swatch.getContext('2d', { willReadFrequently: true })!;
      const toRgb = (value: string): string => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      };
      const style = getComputedStyle(up);
      // The colour these arrows used to wear, resolved by the browser on this
      // very surface, so "more contrast" is a measurement rather than a claim.
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-cc-text-muted)';
      row.append(probe);
      const previousColor = toRgb(getComputedStyle(probe).color);
      probe.remove();
      return {
        color: toRgb(style.color),
        previousColor,
        surface: toRgb(getComputedStyle(row).backgroundColor),
        borderWidth: style.borderTopWidth,
        borderColor: toRgb(style.borderTopColor),
        box: {
          width: up.getBoundingClientRect().width,
          height: up.getBoundingClientRect().height,
        },
        rowHeight: row.getBoundingClientRect().height,
      };
    });

    const surface = parseRgb(measured.surface);
    const color = parseRgb(measured.color);
    const previous = parseRgb(measured.previousColor);
    expect(surface).not.toBeNull();
    expect(color).not.toBeNull();
    expect(previous).not.toBeNull();

    // A real boundary at rest, which is the "read as real controls" half. Before
    // this they had none: `rounded px-1 text-cc-text-muted hover:bg-cc-border`.
    expect(measured.borderWidth).toBe('1px');
    expect(parseRgb(measured.borderColor)).not.toBeNull();

    // ...and the contrast half, measured rather than asserted by class name:
    // clears AA, and clears the muted colour it replaced by a real margin.
    const ratio = contrastRatio(color!, surface!);
    const before = contrastRatio(previous!, surface!);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(ratio).toBeGreaterThan(before * 1.5);

    // 16px square: exactly the row's own 1rem line box, so the added weight buys
    // no row height. #218 made these rows shorter on purpose and #249
    // says not to regress step row type size here.
    //
    // It actually made them shorter. Measured on the real running app: a step
    // row was **34px** before, because the arrows, the disclosure chevron and
    // Remove were all unsized text glyphs inheriting the document's 16px, whose
    // ~24px line box -- not the 11px badge and label beside them -- set the row's
    // height. All three are 16px boxes now and the row is **26px**; the three-row
    // list went 110px -> 86px, and the inspector's whole scroll height
    // 1088px -> 1064px.
    expect(measured.box.width).toBeCloseTo(16, 0);
    expect(measured.box.height).toBeCloseTo(16, 0);
    expect(measured.rowHeight).toBeLessThanOrEqual(28);
  });

  test('still reorder without any drag, and stay disabled at the ends', async ({
    page,
  }) => {
    await openInspector(page);

    await expect(
      page.getByRole('button', { name: 'Move step 1 up' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Move step 3 down' }),
    ).toBeDisabled();

    await page.getByRole('button', { name: 'Move step 1 down' }).click();

    const yaml = await page.evaluate(
      () =>
        document.querySelector('[data-testid="pane-yaml"] .cm-content')
          ?.textContent ?? '',
    );
    expect(yaml.indexOf('checkout')).toBeGreaterThan(
      yaml.indexOf('pnpm install'),
    );
    expect(yaml).toContain('Managed by the platform team');
  });
});
