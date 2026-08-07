import { expect, test, type Page } from '@playwright/test';

import {
  AA_LARGE_TEXT,
  contrastRatio,
  parseRgb,
} from '../src/lib/color/contrast';
import { invalidStub, mockHostApi, unavailableStub } from './fixtures';

/**
 * Issue #9: the inline squiggle under the exact offending span, distinct
 * from (and additive to) issue #148's whole-line tint, which
 * `diagnostics.spec.ts` already covers. `SCHEMA_ERROR` here is the same
 * verbatim, captured-from-the-live-API report `diagnostics.spec.ts` uses for
 * the same misspelled-key case (see `src/lib/validation/apiFixtures.ts`'s
 * own doc comment, and this feature's own PR description for a fresh
 * capture confirming the shape hasn't changed) -- this file adds no new
 * error-message fixture, only new assertions about *where* the underline
 * lands and what it looks like.
 */

const SCHEMA_ERROR = [
  'ERROR IN CONFIG FILE:',
  '[#/jobs/build] 0 subschemas matched instead of one',
  '1. [#/jobs/build] only 1 subschema matches out of 2',
  '|   1. [#/jobs/build] 2 schema violations found',
  '|   |   1. [#/jobs/build] extraneous key [stpes] is not permitted',
  '|   |   |   Permitted keys:',
  '|   |   |     - description',
  '|   |   |     - docker',
  '|   |   |     - steps',
  '|   |   |     - executor',
  '|   |   2. [#/jobs/build] required key [steps] not found',
  '2. [#/jobs/build] expected type: String, found: Mapping',
  '|   Job may be a string reference to another job',
  '3. [#/jobs/build] required key [type] not found',
];

/** `stpes:` for `steps:` on line 6 -- the same offending key `SCHEMA_ERROR` names. */
function configWithMisspelledSteps(): string {
  return `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/node:20.0
    stpes:
      - checkout
  test:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
workflows:
  build_test_deploy:
    jobs:
      - build
      - test
`;
}

/** A workflow entry naming a job with no `jobs:` definition -- `buildWorkflowGraph`'s own "warning", not a compile error, so this exercises the *other* severity (see `buildGraph.ts`'s `!node.isDefined` branch). */
function configWithUndefinedWorkflowJob(): string {
  return `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - ghost
`;
}

const strip = (page: Page) => page.getByTestId('diagnostics-strip');
const underline = (page: Page) => page.locator('.vce-diagnostic-underline');

/**
 * The squiggle's own colour, alpha-composited over every ancestor background
 * from `<html>` inward -- the resolved line's 12%/20% danger/warning wash
 * (`.vce-diagnostic-line`) sits *behind* the very text the squiggle is drawn
 * under, so measuring against the editor's plain background alone would be
 * measuring the wrong backdrop.
 *
 * One `page.evaluate` doing the whole computation in-browser, not a Node-side
 * loop calling back into the page per ancestor -- an earlier version of this
 * helper did the compositing in Node from strings fetched one at a time, and
 * extracted each layer's alpha with a regex against `rgba(...)`. That silently
 * read `1` (opaque) for every colour Chromium serialises in a *modern* CSS
 * Color 4 notation instead -- exactly what `color-mix()` (this app's washed
 * diagnostic-line backgrounds) actually computes to
 * (`color(srgb r g b / a)`), not legacy `rgba()`. The bug was invisible until
 * the numbers came back wrong: a 20% wash of the same hue as the squiggle,
 * misread as fully opaque, composites to a background nearly *identical* to
 * the foreground -- a ~1:1 ratio that looked like a real accessibility
 * failure and was actually a test bug. Reading each layer's real alpha off
 * `CanvasRenderingContext2D`'s rasterised pixel (as `contrast.spec.ts`'s own
 * `toRgba` already does, for this exact reason -- see its module doc comment)
 * is authoritative regardless of notation, so this mirrors that function
 * instead of re-deriving a weaker one.
 */
async function underlineContrast(
  page: Page,
): Promise<{ ratio: number; foreground: string; background: string }> {
  const { fg, bg } = await underline(page)
    .first()
    .evaluate((el) => {
      const swatch = document.createElement('canvas');
      swatch.width = 1;
      swatch.height = 1;
      const ctx = swatch.getContext('2d', { willReadFrequently: true })!;

      function toRgba(
        value: string,
      ): { r: number; g: number; b: number; a: number } | null {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        if (a === 0) return null;
        return { r, g, b, a: a / 255 };
      }

      const chain: Element[] = [];
      let node: Element | null = el;
      while (node) {
        chain.push(node);
        node = node.parentElement;
      }
      chain.reverse(); // outermost (<html>) first, matching contrast.spec.ts's own order.

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

      const decoration = toRgba(getComputedStyle(el).textDecorationColor);
      return {
        fg: decoration
          ? `rgb(${decoration.r}, ${decoration.g}, ${decoration.b})`
          : null,
        bg: `rgb(${Math.round(composited.r)}, ${Math.round(composited.g)}, ${Math.round(composited.b)})`,
      };
    });

  const fgRgb = fg ? parseRgb(fg) : null;
  const bgRgb = parseRgb(bg);
  if (!fgRgb || !bgRgb) {
    throw new Error(`could not resolve squiggle colours: fg=${fg}, bg=${bg}`);
  }
  return {
    ratio: contrastRatio(fgRgb, bgRgb),
    foreground: fg!,
    background: bg,
  };
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

test.describe('the inline squiggle underlines the offending span (issue #9)', () => {
  test('underlines exactly the misspelled key, on the line it resolved to -- not the whole line', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    // Exactly one squiggle, matching the one located diagnostic.
    await expect(underline(page)).toHaveCount(1);
    // The span it wraps is the key itself -- "stpes", not "stpes:" (the
    // colon is a separate token `locateNode` never included) and not the
    // rest of the line.
    await expect(underline(page)).toHaveText('stpes');
    await expect(underline(page)).toHaveClass(
      /vce-diagnostic-underline--error/,
    );

    // On the same line the existing whole-line tint (issue #148) already
    // marks -- the two decorations agree about where the problem is.
    const onTintedLine = await underline(page).evaluate((el) =>
      el.closest('.cm-line')?.classList.contains('vce-diagnostic-line'),
    );
    expect(onTintedLine).toBe(true);
  });

  test('an unresolvable diagnostic gets no squiggle at all -- never a guessed span (issues #9, #163)', async ({
    page,
  }) => {
    await mockHostApi(page, {
      // Names an executor the fixture config never mentions: nothing in the
      // document to resolve it against, so `location` stays undefined.
      validate: invalidStub([
        "Error calling workflow: 'build_test_deploy'",
        "Error calling job: 'build'",
        'Cannot find a definition for executor named nope',
      ]),
    });
    await page.goto('/');

    await expect(strip(page).getByText('Location unknown')).toBeVisible();
    await expect(underline(page)).toHaveCount(0);
    // The whole-line tint declines the same way, for the same reason -- the
    // two mechanisms agree on "unplaced" as well as on "placed".
    await expect(page.locator('.vce-diagnostic-line')).toHaveCount(0);
  });

  test('a warning is a visibly different squiggle from an error, not just a different colour', async ({
    page,
  }) => {
    // No token: validation degrades to this app's own offline checks, whose
    // "workflow entry names an undefined job" finding is a *warning* (see
    // `buildGraph.ts`'s `!node.isDefined` branch) -- the one local check
    // that resolves to a location, which is what this test needs to get a
    // warning-severity squiggle onto the page at all.
    await mockHostApi(page, {
      hasToken: false,
      config: configWithUndefinedWorkflowJob(),
      validate: unavailableStub('This host has no CIRCLE_TOKEN configured.'),
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    await expect(underline(page)).toHaveCount(1);
    await expect(underline(page)).toHaveText('ghost');
    await expect(underline(page)).toHaveClass(
      /vce-diagnostic-underline--warning/,
    );

    // The non-colour signal issue #9's own accessibility requirement asks
    // for: an error's squiggle is wavy, a warning's is dashed, so the two
    // are still distinguishable under a colour-blindness/grayscale emulation
    // that flattens the hue difference to nothing.
    const style = await underline(page).evaluate(
      (el) => getComputedStyle(el).textDecorationStyle,
    );
    expect(style).toBe('dashed');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the squiggle clears the WCAG non-text contrast floor against its real (tinted) background in ${theme} mode`, async ({
      page,
    }) => {
      await mockHostApi(page, {
        config: configWithMisspelledSteps(),
        validate: invalidStub(SCHEMA_ERROR),
      });
      await page.goto('/');
      await setTheme(page, theme);
      await expect(underline(page)).toHaveCount(1);

      const { ratio, foreground, background } = await underlineContrast(page);
      expect(
        ratio,
        `squiggle ${foreground} against composited background ${background}: ` +
          `${ratio.toFixed(2)}:1 (needs ${AA_LARGE_TEXT}:1)`,
      ).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
    });
  }
});
