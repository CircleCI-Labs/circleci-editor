import { expect, test, type Page } from '@playwright/test';

import {
  contrastRatio,
  parseRgb,
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
} from '../src/lib/color/contrast';
import { mockHostApi } from './fixtures';

/**
 * Issue #86: a minimal stand-in for `GET /api/schema`'s real response,
 * shaped just enough for `circleciSchema.ts#extractStepFieldSchemas` to
 * find `run`'s `command` field. Without this, `/api/schema` goes unmocked
 * (this suite otherwise never needs it) and `useCircleciSchema` silently
 * falls back to the all-empty schema on the resulting fetch failure -- see
 * that hook's own doc comment -- which means `run`'s field list never
 * includes `command`, `StepFieldsSection` never reaches the branch that
 * renders `Inspector.tsx`'s `CommandField`, and this audit would silently
 * sample a plain read-only fallback `<p>` instead of the real CodeMirror
 * instance issue #86 is actually about. Caught by first writing this
 * probe *without* the stub and noticing `.cm-content` only ever matched
 * the YAML pane's one instance -- exactly the "confirm the product is
 * broken, not the probe" trap this file's own module doc warns about.
 */
const SCHEMA_STUB = {
  definitions: {
    step: {
      oneOf: [
        {},
        {
          properties: {
            run: {
              properties: {
                command: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['command'],
            },
            checkout: {},
          },
        },
      ],
    },
  },
};

/**
 * Selects the fixture's "build" job and expands its "pnpm install" `run`
 * step, exercising issue #87 part 2 (the whole row is now the disclosure
 * target, not just its chevron) on the way to revealing `CommandField` --
 * the specific editor issue #86 part 1 fixes and part 2 adds shell
 * highlighting/line numbers to.
 */
async function expandRunCommandField(page: Page): Promise<void> {
  await page.locator('[data-testid="rf__node-build"] .vce-dag-node').click();
  // `getByText` would also match the YAML source pane's own (read-only,
  // syntax-highlighted) rendering of the same literal text -- `getByTitle`
  // is unique to the Inspector's row (`StepRow`'s label `<span>` carries a
  // `title` attribute; the YAML pane's token span doesn't).
  await page.getByTitle('pnpm install', { exact: true }).click();
  // `CommandField`'s CodeMirror instance is the *second* `.cm-content` on
  // the page once expanded (the YAML pane's own editor is always mounted,
  // first) -- waiting on it specifically confirms the step actually
  // expanded, rather than racing the rest of this test against a DOM that
  // still only has the YAML editor in it.
  await expect(page.locator('.cm-content').nth(1)).toBeVisible();
}

/**
 * Issue #52 (light/dark mode) contrast audit: a real Playwright probe that
 * walks the *rendered* DOM in each theme and computes WCAG contrast from
 * live `getComputedStyle` values -- not from reading `styles.css`'s
 * declared hex values, which would only prove the CSS says what it says,
 * not that the browser actually paints it that way (cascade layers,
 * specificity, and CodeMirror's own extension precedence have all bitten
 * this app before -- see `yamlHighlight.ts`'s `Prec.highest` comment for a
 * real regression this exact category of bug caused: `basicSetup`'s
 * default highlighter briefly rendered YAML keys at ~1:1 contrast).
 *
 * Deliberately narrow about what counts as a violation:
 *  - Only elements with their own direct, non-whitespace text nodes are
 *    probed -- an ancestor `<div>` wrapping a `<span>` would otherwise be
 *    double-counted against the same rendered text.
 *  - Background is resolved by alpha-compositing every ancestor's
 *    `background-color` from `<html>` inward (most text-bearing elements
 *    themselves have `background-color: transparent` and inherit their
 *    visible backdrop; several real ancestors here, e.g. `.cm-activeLine`,
 *    are only *partially* transparent, so this has to composite rather than
 *    just take the first non-transparent layer -- see `resolveBackground`).
 *  - Elements that are `disabled`/`aria-disabled`, hidden
 *    (`display:none`/`visibility:hidden`/zero-size), or `aria-hidden` are
 *    skipped: WCAG 1.4.3 explicitly exempts inactive UI text, and a hidden
 *    or decorative node has no rendered contrast to measure.
 *  - The large-text threshold (3:1) applies at >=18.66px, or >=14.66px at
 *    `font-weight >= 700`, per WCAG 1.4.3's "18pt / 14pt bold" definition
 *    (using the same 1.333px/pt conversion browsers use for `pt` CSS units).
 *
 * Known limitation, not solved here: this reads `color`/`background-color`
 * as painted, which does *not* account for `opacity < 1` blending a
 * text/background pair toward some third colour neither declares directly.
 * Nothing in this app currently renders text through a fractional-opacity
 * ancestor, so it isn't exercised, but a future one could pass this probe
 * while still failing a real contrast-blending check.
 */

interface ContrastSample {
  selector: string;
  text: string;
  color: string;
  backgroundColor: string;
  isLarge: boolean;
}

async function sampleContrast(page: Page): Promise<ContrastSample[]> {
  return page.evaluate(() => {
    function isVisible(el: Element): boolean {
      const style = getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      )
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isDisabled(el: Element): boolean {
      let node: Element | null = el;
      while (node) {
        if ((node as HTMLButtonElement).disabled) return true;
        if (node.getAttribute('aria-disabled') === 'true') return true;
        node = node.parentElement;
      }
      return false;
    }

    function isAriaHidden(el: Element): boolean {
      let node: Element | null = el;
      while (node) {
        if (node.getAttribute('aria-hidden') === 'true') return true;
        node = node.parentElement;
      }
      return false;
    }

    function hasOwnText(el: Element): string | null {
      let text = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      }
      text = text.trim();
      return text.length > 0 ? text : null;
    }

    // First pass at this used "stop at the first ancestor whose background
    // isn't fully transparent" -- wrong the moment that ancestor is
    // *partially* transparent rather than opaque, which several real
    // layers in this app are (`.cm-activeLine`'s highlight, e.g.). Treating
    // e.g. `rgba(26, 102, 247, 0.06)` as if it were the fully-opaque
    // `rgb(26, 102, 247)` (a vivid blue) instead of a 6%-strength tint over
    // whatever is further back produced two false-positive "failures" this
    // audit initially reported that the real rendered pixels don't have --
    // caught by cross-checking against the manually-measured ratios in
    // `yamlHighlight.ts`'s own comments before trusting the probe. Fixed by
    // properly alpha-compositing every ancestor's background from the
    // outermost (<html>) inward, `src-over` per layer, the same way the
    // browser itself paints them.
    // Issue #69 gave this app's `--color-cc-*` tokens real `oklch()` values
    // (previously every one was a flat hex literal, resolved through `var()`
    // chains). That surfaced a probe bug this file never had to care about
    // before: `getComputedStyle(...).backgroundColor`/`.color` no longer
    // reliably serialises as legacy comma-separated `rgb()`/`rgba()` --
    // Chromium's CSS Color 4 support preserves modern notations in the
    // *computed* value (an element whose specified colour is `oklch(...)`
    // reports back literally `"oklch(0.193 0.032 264.5)"`, and
    // `color-mix()`/partial-alpha `oklch()` results come back as
    // `"color(srgb 0.87 0.63 0.32 / 0.22)"`), which a regex built only for
    // `rgb(a, b, c)` can't parse -- `parseRgba` below returned `null` for
    // every such ancestor, `resolveBackground` treated that as "fully
    // transparent, skip", and the composite silently fell through to its
    // opaque-white default instead of the real (dark) surface underneath.
    // That produced exactly the false-positive failures a first pass at
    // this fix turned up -- white text measured against an assumed *white*
    // background instead of the actual navy one, i.e. the probe was wrong,
    // not the product (confirmed by screenshotting the real rendered page
    // alongside this fix, per the PR description).
    //
    // Rather than teach the regex a second (or third, once `lab()`/`lch()`/
    // `color()` show up) notation by hand, hand the string to the one thing
    // in the page that already understands every CSS colour syntax
    // authoritatively: `CanvasRenderingContext2D`. Painting into a 1x1
    // canvas and reading the pixel back with `getImageData` forces the
    // browser to rasterise the colour through its real colour-management
    // pipeline, the same step that puts pixels on screen -- so this always
    // agrees with what the user actually sees, regardless of whether the
    // *specified* value was `#hex`, `rgb()`, `oklch()`, `color-mix()`, or
    // anything else CSS Color 4 adds later.
    const swatch = document.createElement('canvas');
    swatch.width = 1;
    swatch.height = 1;
    const swatchCtx = swatch.getContext('2d', { willReadFrequently: true })!;

    function toRgba(
      value: string,
    ): { r: number; g: number; b: number; a: number } | null {
      // Reset to a sentinel first: an *invalid* colour string leaves
      // `fillStyle` unchanged rather than throwing (per the Canvas spec),
      // so without a reset a bad `value` would silently read back
      // whatever colour the previous call happened to leave behind.
      swatchCtx.clearRect(0, 0, 1, 1);
      swatchCtx.fillStyle = '#000';
      swatchCtx.fillStyle = value;
      swatchCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = swatchCtx.getImageData(0, 0, 1, 1).data;
      // `value` was `transparent`/an unparsed `currentColor`/etc: alpha 0
      // means nothing was actually painted, i.e. no real colour to report,
      // same as this function returning `null` for "couldn't parse" below.
      if (a === 0) return null;
      return { r, g, b, a: a / 255 };
    }

    function resolveBackground(el: Element): string {
      const chain: Element[] = [];
      let node: Element | null = el;
      while (node) {
        chain.push(node);
        node = node.parentElement;
      }
      chain.reverse(); // outermost (<html>) first, innermost (el itself) last.

      // The browser's own canvas is opaque white beneath everything --
      // matches what a real display shows behind a transparent <html>.
      let composited = { r: 255, g: 255, b: 255 };
      for (const ancestor of chain) {
        const parsed = toRgba(getComputedStyle(ancestor).backgroundColor);
        if (!parsed) continue;
        composited = {
          r: parsed.r * parsed.a + composited.r * (1 - parsed.a),
          g: parsed.g * parsed.a + composited.g * (1 - parsed.a),
          b: parsed.b * parsed.a + composited.b * (1 - parsed.a),
        };
      }
      return `rgb(${Math.round(composited.r)}, ${Math.round(composited.g)}, ${Math.round(composited.b)})`;
    }

    function isLargeText(style: CSSStyleDeclaration): boolean {
      const px = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      return px >= 18.66 || (px >= 14.66 && weight >= 700);
    }

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const testId = el.getAttribute('data-testid');
      const testIdPart = testId ? `[data-testid=${testId}]` : '';
      const cls =
        el.className && typeof el.className === 'string'
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${tag}${id}${testIdPart}${cls}`;
    }

    const samples: ContrastSample[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const text = hasOwnText(el);
      if (!text) continue;
      if (!isVisible(el)) continue;
      if (isDisabled(el)) continue;
      if (isAriaHidden(el)) continue;

      const style = getComputedStyle(el);
      // Foreground text colour needs the same modern-notation normalising
      // as the background chain above -- `style.color` can come back as
      // `oklch(...)` too now that this app's `--color-cc-text*` tokens
      // resolve through it, and the Node-side `parseRgb` (shared with
      // `contrastRatio`'s unit tests, see `src/lib/color/contrast.ts`) only
      // understands legacy `rgb()`/`rgba()`.
      const fg = toRgba(style.color);
      samples.push({
        selector: describe(el),
        text: text.slice(0, 40),
        color: fg ? `rgb(${fg.r}, ${fg.g}, ${fg.b})` : style.color,
        backgroundColor: resolveBackground(el),
        isLarge: isLargeText(style),
      });
    }
    return samples;
  });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem(
      'vce.theme',
      JSON.stringify({ schemaVersion: 1, preference: t }),
    );
  }, theme);
  await page.reload();
}

interface Failure {
  selector: string;
  text: string;
  ratio: number;
  required: number;
}

function findFailures(samples: ContrastSample[]): Failure[] {
  const failures: Failure[] = [];
  for (const sample of samples) {
    const fg = parseRgb(sample.color);
    const bg = parseRgb(sample.backgroundColor);
    if (!fg || !bg) continue; // Couldn't resolve a solid colour on one side -- nothing to compute.
    const ratio = contrastRatio(fg, bg);
    const required = sample.isLarge ? AA_LARGE_TEXT : AA_NORMAL_TEXT;
    if (ratio < required) {
      failures.push({
        selector: sample.selector,
        text: sample.text,
        ratio,
        required,
      });
    }
  }
  return failures;
}

function formatFailures(failures: Failure[]): string {
  return failures
    .map(
      (f) =>
        `${f.selector} "${f.text}": ${f.ratio.toFixed(2)}:1 (needs ${f.required}:1)`,
    )
    .join('\n');
}

test.describe('contrast audit (issue #52)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHostApi(page);
    // Registered before the first navigation (see `expandRunCommandField`'s
    // own doc comment) -- persists across the theme reload below, since
    // Playwright routes stay active for the page's lifetime, not just the
    // navigation they were registered during.
    await page.route('**/api/schema', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SCHEMA_STUB),
      }),
    );
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`every visible text node clears its WCAG AA threshold in ${theme} mode`, async ({
      page,
    }) => {
      await page.goto('/');
      await setTheme(page, theme);
      await expect(
        page.getByRole('heading', { name: 'Workflow Graph' }),
      ).toBeVisible();

      // The DAG pane's job nodes and the YAML editor both render
      // asynchronously (ELK layout, CodeMirror mount) -- give them a beat
      // to actually paint before sampling, so the audit covers them too
      // instead of an empty canvas.
      await page.waitForTimeout(500);

      // Issue #86: expand the "pnpm install" `run` step's fields so
      // `CommandField`'s own CodeMirror instance is actually in the DOM
      // for the sample below to catch -- without this, the audit never
      // exercised the one field the bug report was about (see this file's
      // own module doc for how that produced a false "all clear" before).
      await expandRunCommandField(page);

      const samples = await sampleContrast(page);
      expect(samples.length).toBeGreaterThan(10); // Sanity check the probe found anything at all.

      const failures = findFailures(samples);
      expect(
        failures,
        `Contrast failures in ${theme} mode:\n${formatFailures(failures)}`,
      ).toEqual([]);
    });
  }

  test('toggling the theme control actually repaints the app (not just the attribute)', async ({
    page,
  }) => {
    // Without pinning this, a headless browser's default colour-scheme
    // emulation (light) could coincidentally match the "Light" button
    // pressed further down, making the first assertion pass for the wrong
    // reason -- pin it to dark so "System" and "Light" are provably
    // different starting points.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    const bgBefore = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const bgAfterLight = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(bgAfterLight).not.toBe(bgBefore);

    await page.getByRole('button', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bgAfterDark = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(bgAfterDark).not.toBe(bgAfterLight);
  });
});
