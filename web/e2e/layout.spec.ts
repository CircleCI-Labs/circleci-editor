import { expect, test } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Real-browser regression coverage for the "collapsing a pane leaves dead
 * space" bug: `LayoutRoot.test.tsx` already asserts the CSS values
 * (`flex-grow`/`flex-basis`) this fix relies on, but jsdom never actually
 * runs the flexbox layout algorithm, so it can't catch a discrepancy in
 * *how the browser resolves those values* -- which is exactly what the
 * original bug was (see the comment above `fixedChildStyle` in
 * `LayoutRoot.tsx` for the flexbox-spec detail: a lone flexible item whose
 * flex-grow factor is less than 1 only claims that fraction of its
 * collapsed sibling's freed space, not all of it). This measures real,
 * rendered pixel widths in a real Chromium layout instead.
 */
test.describe('layout: collapsing a pane reclaims its space (no dead space)', () => {
  test('defaults to the graph-focus preset on first run', async ({ page }) => {
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Graph focus' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('collapsing the AI assistant in Columns mode lets the workflow graph fill the freed width exactly', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Columns' }).click();
    await page
      .getByRole('button', { name: /collapse ai assistant panel/i })
      .click();

    // Once collapsed, `PaneChrome` renders the strip as a bare "Expand"
    // button (no extra wrapper div, unlike the expanded state's header
    // bar) -- three levels up from it is the flex row it shares with the
    // workflow graph's own region as its sibling.
    const expandAi = page.getByRole('button', {
      name: /expand ai assistant panel/i,
    });
    const rowHandle = await expandAi.evaluateHandle((button) => {
      // button -> PaneSlot's root (flex-col) div -> the NodeRenderer-styled
      // wrapper div -> the flex row both panes share as siblings.
      return button.parentElement!.parentElement!.parentElement!;
    });

    const measurement = await rowHandle.evaluate((row: Element) => {
      const rowWidth = row.getBoundingClientRect().width;
      const childWidths = Array.from(row.children).map(
        (child) => child.getBoundingClientRect().width,
      );
      return { rowWidth, childWidths, childCount: row.children.length };
    });

    // No splitter renders next to a collapsed sibling, so there should be
    // exactly two children here: the collapsed AI strip and the workflow
    // graph's own region.
    expect(measurement.childCount).toBe(2);
    const [aiStripWidth, dagWidth] = measurement.childWidths;
    const sum = aiStripWidth! + dagWidth!;

    // The actual regression check: sum of the visible regions must equal
    // the row's own rendered width -- i.e. nothing left over as dead space.
    expect(Math.round(sum)).toBe(Math.round(measurement.rowWidth));
    // Sanity: the AI strip really did collapse down to a small fixed strip,
    // not just "happen to sum correctly" some other way.
    expect(aiStripWidth).toBeLessThan(60);
    expect(dagWidth).toBeGreaterThan(measurement.rowWidth - 60);
  });
});

/**
 * Issue #183, the reported defect measured rather than eyeballed: *"the move
 * and collapse labels on the different sections are off. Move is actually
 * slightly down and collapse is slightly up."*
 *
 * Measured on the real running app before the fix, at 1440x900 in both themes:
 * `Move`'s vertical centre was 74px and `Collapse`'s was 72px -- a 2px
 * disagreement, in exactly the direction reported. The cause was structural,
 * not a spacing value: `Move` was an `inline-block` button inside a wrapper
 * `<div>` and therefore sat on that div's text baseline (with the line box's
 * descender space below it), while `Collapse`, a direct child of the strip's
 * `items-center` flex row, was blockified and centred. So this asserts the
 * property (one shared centre) rather than a magic number, and it has to run in
 * a real browser: jsdom reports every box as 0x0, so `LayoutRoot.test.tsx` can
 * only pin the DOM structure the fix relies on.
 *
 * Both themes, because the strip's height and the controls' own type metrics are
 * the inputs and a theme that changed either would move them.
 */
test.describe('layout: the pane chrome controls are aligned and read as buttons (issue #183)', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`Move and Collapse share a vertical centre and a button affordance in ${theme} mode`, async ({
      page,
    }) => {
      await page.addInitScript(
        (value) => {
          window.localStorage.setItem('vce.theme', value);
        },
        JSON.stringify({ schemaVersion: 1, preference: theme }),
      );
      await mockHostApi(page);
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Workflow Graph' }),
      ).toBeVisible();

      const pane = page.locator('[data-testid="pane-dag"]');
      const move = pane.getByRole('button', { name: 'Move', exact: true });
      const collapse = pane.getByRole('button', {
        name: 'Collapse Workflow Graph panel',
      });

      const geometry = await page.evaluate(() => {
        const paneEl = document.querySelector('[data-testid="pane-dag"]')!;
        const read = (selector: string) => {
          const el = paneEl.querySelector(selector) as HTMLElement;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            centerY: rect.top + rect.height / 2,
            height: rect.height,
            cursor: style.cursor,
            borderWidth: parseFloat(style.borderTopWidth),
            hasFill: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
          };
        };
        return {
          move: read('button[title="Move Workflow Graph pane"]'),
          collapse: read('button[title="Collapse Workflow Graph panel"]'),
        };
      });

      // The fix. Sub-pixel tolerance only -- these are two flex items of one
      // `items-center` row, so they are either identically centred or something
      // has reintroduced a wrapper.
      expect(
        Math.abs(geometry.move.centerY - geometry.collapse.centerY),
      ).toBeLessThan(0.5);
      // ...and identically sized, so "aligned" can't be satisfied by two
      // differently-shaped boxes that happen to share a midpoint.
      expect(geometry.move.height).toBe(geometry.collapse.height);

      // The affordance half of #183: a real resting boundary, a fill, and a
      // pointer cursor -- all three were absent before (both controls measured
      // `cursor: default`, `border-width: 0`, `background: rgba(0,0,0,0)`).
      // 20px tall inside the 24px strip, a bigger hit area than the 16px line
      // box the bare labels had.
      for (const control of [geometry.move, geometry.collapse]) {
        expect(control.cursor).toBe('pointer');
        expect(control.borderWidth).toBeGreaterThan(0);
        expect(control.hasFill).toBe(true);
        expect(control.height).toBeGreaterThanOrEqual(20);
      }

      // Real buttons, so keyboard reach and the global `:focus-visible` ring
      // both still apply. Asserted by driving the keyboard, not by reading
      // classes: `.focus()` alone does not necessarily set `:focus-visible`.
      await move.focus();
      await page.keyboard.press('Tab');
      await expect(collapse).toBeFocused();
      const outlineWidth = await collapse.evaluate((el) =>
        parseFloat(getComputedStyle(el).outlineWidth),
      );
      expect(outlineWidth).toBeGreaterThan(0);

      // And the pane's name is stated once, by the pane's own header -- not
      // repeated by the chrome strip 24px above it.
      await expect(
        pane.getByText('Workflow Graph', { exact: true }),
      ).toHaveCount(1);
    });
  }
});

/**
 * Issue #208: the chrome strip is gone and `Move`/`Collapse` live in each pane's
 * own header row.
 *
 * > *"The move and collapse buttons are definitely buttons now, but they get a
 * > little too close to the actual elements -- the next box... And honestly,
 * > maybe just rolling the move and collapse button into the top section where it
 * > says Workflow or Config or AI Assistant."*
 *
 * The spacing complaint is answered structurally: there is no longer a strip
 * sitting 0px above the pane's header, so there is no gap left to get wrong.
 *
 * Measured on the real running app at 1440x900, `graph-focus`, before and after
 * (pane body height, i.e. what the pane's content actually gets):
 *
 * | pane | before | after |
 * |---|---|---|
 * | `yaml` | 475 | 499 |
 * | `dag` | 509 | 533 |
 * | `ai` | 149 | 173 |
 * | `palette` | 517 | 541 |
 *
 * +24px each, which is the strip. The honest exception is a pane header narrow
 * enough to wrap the extra two controls onto a second line -- `yaml`'s header is
 * the busiest (`config.yml`, three badges, Source/Compiled, Autosave, Save) and
 * at 1024/1280 it wraps, costing 4px instead of gaining 24. Never worse than
 * that, and a net gain at every width sampled: +4px at 1024, +68 at 1280, +96 at
 * 1440.
 */
test.describe('layout: the pane controls live in the pane’s own header (issue #208)', () => {
  test('no pane renders a chrome strip, and every expanded pane’s controls sit in its own header', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    const report = await page.evaluate(() => {
      const out: Record<
        string,
        {
          strips: number;
          controlsInHeader: number;
          childrenOfPane: number;
          bodyPlusHeader: number;
          paneHeight: number;
        }
      > = {};
      for (const id of ['yaml', 'dag', 'ai', 'palette']) {
        const pane = document.querySelector(`[data-testid="pane-${id}"]`)!;
        const section = pane.querySelector('section')!;
        const header = section.querySelector(':scope > header')!;
        const body = section.lastElementChild!;
        out[id] = {
          // The 24px strip `PaneSlot` used to render above the pane's own
          // header. Its fallback keeps the markup, so this asserts the *fold*
          // happened, not that the code path was deleted.
          strips: pane.querySelectorAll(':scope > div.h-6').length,
          controlsInHeader: header.querySelectorAll(
            'button[title^="Move "], button[title^="Collapse "]',
          ).length,
          childrenOfPane: pane.children.length,
          bodyPlusHeader: Math.round(
            header.getBoundingClientRect().height +
              body.getBoundingClientRect().height,
          ),
          paneHeight: Math.round(pane.getBoundingClientRect().height),
        };
      }
      return out;
    });

    for (const [id, pane] of Object.entries(report)) {
      expect(pane.strips, `${id} still renders a chrome strip`).toBe(0);
      expect(
        pane.controlsInHeader,
        `${id}'s controls are not in its header`,
      ).toBe(2);
      // The pane's whole height is its own header plus its body: nothing else
      // is taking a slice, which is the 24px this change recovers. (The 1px
      // `Panel` border accounts for the tolerance.)
      expect(
        Math.abs(pane.paneHeight - pane.bodyPlusHeader),
      ).toBeLessThanOrEqual(2);
      // One child: the content wrapper. The chrome position renders `null`
      // rather than being dropped, so `children` stays at a stable index -- see
      // `PaneSlot`'s doc comment for why a remount there would lose the YAML
      // editor's cursor.
      expect(pane.childrenOfPane).toBe(1);
    }
  });

  /** The collapsed state has no pane header to fold into, so it is unchanged --
   * including the `parentElement` walk `layout.spec.ts`'s dead-space test above
   * depends on. */
  test('a collapsed pane still shows its labelled Expand strip and no folded controls', async ({
    page,
  }) => {
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // `docs` starts collapsed in every preset (issue #83).
    const docs = page.locator('[data-testid="pane-docs"]');
    const expand = docs.getByRole('button', { name: 'Expand Reference panel' });
    await expect(expand).toHaveText('Reference');
    await expect(
      docs.getByRole('button', { name: 'Move', exact: true }),
    ).toHaveCount(0);

    // Expanding it gives it folded controls in its own header, and no strip.
    await expand.click();
    await expect(
      docs.getByRole('button', { name: 'Collapse Reference panel' }),
    ).toBeVisible();
    expect(
      await docs.evaluate(
        (el) => el.querySelectorAll(':scope > div.h-6').length,
      ),
    ).toBe(0);
  });
});
