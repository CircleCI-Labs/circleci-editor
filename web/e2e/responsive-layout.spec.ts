import { expect, test, type Page } from '@playwright/test';

import { FIXTURE_CONFIG, FIXTURE_CONFIG_PATH, mockHostApi } from './fixtures';
import { expectActiveConfigFile, waitForSwitcherMeasured } from './switcher';

/**
 * Issue #154, measured against the real built app rather than eyeballed:
 * "when the window starts, it might be squished depending on the size of your
 * monitor. And when it was squished, the selector between files has a little
 * scroll bar... it should be dynamic in terms of resizing and handling
 * different window sizes, and taking use of the screen size if available."
 *
 * The audit-harness shape here follows `scroll-regions.spec.ts` (issue #88):
 * an in-page probe returning numbers, asserted as numbers, so a future change
 * that reintroduces the defect fails a specific named test instead of just
 * feeling worse again.
 *
 * Every width is checked in **both themes**, because the collapse ladder is
 * driven by measured element widths and a theme that changed any of them (a
 * different font stack, heavier borders, differently-padded badges) would move
 * the thresholds without anything else noticing.
 *
 * The fixture directory is deliberately the *worst realistic* case rather than
 * the default single-file one: six YAML files with names as long as a real
 * `.circleci` directory's, which is what issue #147 was reported against.
 */
const DIR = '/home/dev/widgets/.circleci';

const SIX_FILES = [
  'config.yml',
  'continue-config.yml',
  'setup.yml',
  'deploy-config.yml',
  'shared-jobs.yml',
  'goss.yaml',
];

/** Two files, i.e. an ordinary `.circleci` directory: the case where the row
 * of buttons should survive far more widths than the six-file one. */
const TWO_FILES = ['config.yml', 'continue-config.yml'];

/** Exactly what `e2e/config-switcher.spec.ts` stubs -- one config plus one
 * non-config, whose row (one button plus issue #135's reveal) measures 185px.
 * That is the width at which issue #166's stale tier-cost table went wrong at
 * 1280px, so it is the listing this file has to cover too. */
const ONE_CONFIG_ONE_NON_CONFIG = ['config.yml', 'goss.yaml'];

const WIDTHS = [1024, 1280, 1440, 1920] as const;
const THEMES = ['light', 'dark'] as const;

async function stubDirectory(page: Page, names: readonly string[]) {
  await page.route('**/api/config-files**', async (route) => {
    await route.fulfill({
      json: {
        dir: DIR,
        primaryPath: FIXTURE_CONFIG_PATH,
        files: names.map((relPath, index) => ({
          path: index === 0 ? FIXTURE_CONFIG_PATH : `${DIR}/${relPath}`,
          relPath,
          size: FIXTURE_CONFIG.length,
          isPrimary: index === 0,
          isConfig: !relPath.startsWith('goss'),
          configReason: relPath.startsWith('goss')
            ? 'No CircleCI structure: no top-level version: 2, 2.0 or 2.1.'
            : 'Declares version: 2.1.',
        })),
      },
    });
  });
}

/** Forces a theme before the app's own bootstrap script runs, the same key
 * `state/themeStore` persists to, so the app paints in it from the first
 * frame rather than being toggled after load. */
async function forceTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('vce.theme', value);
  }, theme);
}

interface OverflowReport {
  /** Widest horizontally-overflowing element's own description, or null. */
  pageOverflow: { scrollWidth: number; clientWidth: number } | null;
  /** The vertical counterpart of `pageOverflow` (issue #188):
   * `documentElement.scrollHeight` vs `clientHeight`. Reported for every
   * case, informationally -- **not** asserted at zero. Unlike the
   * horizontal axis (measured at zero delta everywhere, always: nothing in
   * this app ever scrolls sideways, even inside one pane), several
   * individual panes *correctly* scroll vertically inside their own bounds
   * (the palette's own list, a tall editor, the AI pane's settings panel --
   * this app's one-scroll-region-per-pane design). `documentElement`'s own
   * `scrollHeight` reflects that even though every one of those is properly
   * contained by its own `overflow-y: auto`, which is a real, measured
   * quirk (see `styles.css`'s own comment on `html`'s `overflow-y` rule) --
   * so this field exists to *see* the number, not to gate on it being zero. */
  pageOverflowY: { scrollHeight: number; clientHeight: number } | null;
  /** The actual guarantee #188 needs: is the window itself unable to scroll
   * past its content? Two independent signals -- the CSS mechanism
   * (`overflow-y: hidden` on whichever element `document.scrollingElement`
   * actually is, verified rather than assumed to be `<html>`) and a real
   * wheel gesture over a safe, non-canvas point in the app bar, which is
   * what a user's trackpad/mouse actually drives and which `overflow-y:
   * hidden` blocks even though a *programmatic* `scrollTop` write still
   * moves the root scroller in this app (verified separately -- Chromium's
   * own special-casing of the viewport scroller, not a bug in this check). */
  windowScrollLocked: boolean;
  /** Elements whose computed overflow lets them scroll *and* whose content
   * exceeds their box, anywhere in the app bar. */
  appBarScrollRegions: string[];
  /** The same, for the whole document -- described, so a failure names the
   * culprit instead of just counting it. */
  documentScrollRegions: string[];
  appBarTier: string | null;
  appBarClipped: boolean;
  switcherCompact: string | null;
  /** The space the app bar left the switcher, and the width its row of buttons
   * wants -- the two numbers the collapse decision is made from, reported so a
   * failure says *why* rather than only that the form was wrong. */
  switcherSlotPx: number;
  switcherRowPx: number;
  paneWidths: Record<string, number>;
  paneHeights: Record<string, number>;
  /** How many elements expose `role=group` named "Open config file" and are
   * actually visible/exposed -- must be exactly one, never both forms. */
  exposedSwitchers: number;
}

async function audit(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    function describe(element: Element): string {
      const testId = element.getAttribute('data-testid');
      const label = element.getAttribute('aria-label');
      const cls = element.className.toString().slice(0, 70);
      return `${element.tagName}${testId ? `[${testId}]` : ''}${label ? `{${label}}` : ''}.${cls}`;
    }

    function scrollRegionsIn(root: Element): string[] {
      const found: string[] = [];
      for (const element of root.querySelectorAll('*')) {
        const cs = getComputedStyle(element);
        const scrollsY =
          /auto|scroll/.test(cs.overflowY) &&
          element.scrollHeight > element.clientHeight + 2;
        const scrollsX =
          /auto|scroll/.test(cs.overflowX) &&
          element.scrollWidth > element.clientWidth + 2;
        if (scrollsX || scrollsY) {
          found.push(
            `${scrollsX ? 'x' : ''}${scrollsY ? 'y' : ''} ${describe(element)}`,
          );
        }
      }
      return found;
    }

    const header = document.querySelector('header');
    const paneWidths: Record<string, number> = {};
    const paneHeights: Record<string, number> = {};
    for (const id of ['yaml', 'dag', 'ai', 'palette', 'docs']) {
      const element = document.querySelector(`[data-testid="pane-${id}"]`);
      const rect = element?.getBoundingClientRect();
      paneWidths[id] = rect ? Math.round(rect.width) : -1;
      paneHeights[id] = rect ? Math.round(rect.height) : -1;
    }

    const switchers = Array.from(
      document.querySelectorAll(
        '[role="group"][aria-label="Open config file"]',
      ),
    ).filter((element) => {
      if (element.closest('[aria-hidden="true"]')) return false;
      return getComputedStyle(element).visibility !== 'hidden';
    });

    const root = document.documentElement;
    return {
      pageOverflow:
        root.scrollWidth > root.clientWidth
          ? { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
          : null,
      pageOverflowY:
        root.scrollHeight > root.clientHeight
          ? { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight }
          : null,
      windowScrollLocked:
        getComputedStyle(document.scrollingElement ?? root).overflowY ===
        'hidden',
      appBarScrollRegions: header ? scrollRegionsIn(header) : [],
      documentScrollRegions: scrollRegionsIn(document.body),
      appBarTier: header?.getAttribute('data-app-bar-tier') ?? null,
      appBarClipped: header
        ? header.scrollWidth > header.clientWidth + 1
        : false,
      switcherCompact:
        document
          .querySelector('[data-testid="config-file-switcher"]')
          ?.getAttribute('data-compact') ?? null,
      switcherSlotPx:
        document.querySelector('[data-testid="config-file-switcher"]')
          ?.clientWidth ?? -1,
      switcherRowPx: Math.ceil(
        document
          .querySelector('[data-testid="config-file-switcher"] [role="group"]')
          ?.getBoundingClientRect().width ?? -1,
      ),
      paneWidths,
      paneHeights,
      exposedSwitchers: switchers.length,
    };
  });
}

/**
 * Waits for a viewport change to work all the way through the layout: a
 * `ResizeObserver` delivery, the React re-render it triggers, and the second
 * delivery any nested split's own container change produces. Three animation
 * frames is empirically enough for the deepest nesting any preset has (four
 * split levels) and is bounded, unlike a fixed sleep tuned to one machine.
 */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }),
  );
}

async function resizeTo(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  // Two settles: the first lets the resize reach the tier probe, the second
  // lets any demotion the switcher's report triggers be applied.
  await settle(page);
  await settle(page);
}

/** Picks a layout preset whichever form the preset switcher is currently in
 * -- a pill at the `full`/`compact` tiers, a menu item at `tight`. */
async function selectPreset(page: Page, label: string) {
  const group = page.getByRole('group', { name: 'Pane layout' });
  const pill = group.getByRole('button', { name: label, exact: true });
  if (await pill.count()) {
    await pill.click();
    return;
  }
  await group.getByRole('button').click();
  await page
    .getByRole('menu', { name: 'Pane layout' })
    .getByRole('menuitemradio', { name: label, exact: true })
    .click();
}

async function loadApp(
  page: Page,
  {
    width,
    height = 800,
    theme,
    files,
  }: {
    width: number;
    /** Issue #188: defaults to this file's existing 800, but every caller
     * checking the vertical axis specifically needs a real, varied height --
     * "short and wide" is the shape #188 says was never covered at all. */
    height?: number;
    theme: 'light' | 'dark';
    files: readonly string[];
  },
) {
  await page.setViewportSize({ width, height });
  await forceTheme(page, theme);
  await mockHostApi(page);
  await stubDirectory(page, files);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await waitForAppBarSettled(page);
}

/**
 * Waits for the app bar to reach its *final* arrangement.
 *
 * Issue #166: the previous wait here was `data-compact` matching `/true|false/`,
 * which was no wait at all -- that attribute is present from the first render,
 * so every measurement in this file was taken during the app's first second.
 * That is precisely when the bar is still changing shape: `ValidationBadge`
 * renders nothing at all until validation resolves (~1s in), at which point the
 * right-hand group grows and the space left for the file switcher shrinks with
 * it. Asserting before that landed is what let this whole spec pass while
 * `config-switcher.spec.ts` failed on a loaded machine.
 *
 * So this waits for the things that actually settle: validation resolved out of
 * its transient states, a real switcher measurement, and the bar's tier probe
 * finished walking the ladder. All three are product-level signals, so this is
 * deterministic on any machine rather than a frame count that is usually long
 * enough.
 */
async function waitForAppBarSettled(page: Page) {
  await expect(
    page
      .getByRole('banner')
      .getByText(
        /^(Valid|Invalid|Not independently valid|Validation unavailable|Validation error)$/,
      ),
  ).toBeVisible();
  await waitForSwitcherMeasured(page);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`at ${width}px in ${theme} mode: no page-level horizontal scroll and no scroll region in the app bar`, async ({
      page,
    }) => {
      await loadApp(page, { width, theme, files: SIX_FILES });
      const report = await audit(page);

      // The headline guarantee. `body` has `overflow-x: hidden` (see
      // `styles.css`), which *masks* a horizontal overflow rather than
      // preventing one, so this is measured on `documentElement` -- the box
      // that actually reports it.
      expect(report.pageOverflow).toBeNull();

      // The reported symptom: the file switcher's own inner scrollbar. It was
      // the only `overflow-x-auto` in the app bar and it is gone -- nothing in
      // the bar scrolls at any width now, in either theme.
      expect(report.appBarScrollRegions).toEqual([]);

      // And the bar itself fits, so `overflow-hidden` on it is only ever the
      // backstop it's documented as, never load-bearing.
      expect(report.appBarClipped).toBe(false);

      // Exactly one switcher is exposed -- the row form or the menu form,
      // never both. The unused one is kept in the DOM purely to stay
      // measurable, `aria-hidden` and `visibility: hidden`, and this is what
      // proves it isn't reachable.
      expect(report.exposedSwitchers).toBe(1);
    });
  }
}

/**
 * Issue #188: "sometimes we get a vertical scroll bar up and down that lets
 * me scroll well past where our content is... I'm talking about the whole
 * window itself." Symmetric with the horizontal loop above, and deliberately
 * varying *height* as well as width -- short-and-wide was never covered by
 * anything in this file (or `scroll-regions.spec.ts`, which only ever sets
 * `height: 800`), and it's the shape the issue itself calls out as the
 * interesting one.
 *
 * Diagnosed before writing this, not just wrapped in `overflow-y: hidden`
 * and asserted at zero: at 1280x800 (this file's own default), the real
 * built app measures `documentElement.scrollHeight` at 1243 against a
 * `clientHeight` of 800 -- 443px of scrollable page -- **whether or not**
 * `styles.css`'s fix is applied, because `overflow-y: hidden` changes
 * whether that space is reachable, not the `scrollHeight` number (that
 * number reflects layout, not the `overflow` property, on any browser).
 * So unlike `pageOverflow`'s horizontal counterpart -- measured at zero
 * delta everywhere, meaning nothing ever genuinely overflows sideways, even
 * inside one pane -- `pageOverflowY` can *never* usefully be asserted at
 * zero here, and this suite doesn't pretend otherwise (see that field's own
 * comment above).
 *
 * What actually got diagnosed: walking every element on the page for one
 * whose content genuinely exceeds its own box *and* isn't already contained
 * by a real internal scroll region (the same containment check
 * `scroll-regions.spec.ts` uses) found legitimate, working, `overflow-y:
 * auto` scrollers -- the palette's own list, the editor, the AI pane's
 * settings panel, each properly containing real content that belongs
 * scrolling right there -- and, separately, **zero** elements whose content
 * escapes uncontained. Forcing `document.documentElement.scrollTop` past 0
 * confirmed what that implies: the app visually slides up as a whole and the
 * space revealed underneath it is blank, not a clipped control. So the
 * window's own scrollability was real but pointed at nothing -- exactly what
 * `overflow-y: hidden` on `html` (verified as where `document.
 * scrollingElement` actually lives in this app -- `body`'s own `overflow-y`
 * alone left it unaffected) removes, with nothing behind it to lose.
 */
const HEIGHT_CASES: { width: number; height: number }[] = [
  { width: 1280, height: 800 }, // this file's own baseline
  { width: 1440, height: 700 }, // named directly in the issue
  { width: 1280, height: 600 }, // named directly in the issue
  { width: 1920, height: 1080 },
  // Narrow *and* short at once, at the width #158/#225 measured the app bar's
  // own furniture against -- proves the fix doesn't trade a vertical scroll
  // for a clipped app bar (the failure mode the issue explicitly warns is
  // "not a fix").
  { width: 900, height: 700 },
];

for (const theme of THEMES) {
  for (const { width, height } of HEIGHT_CASES) {
    test(`at ${width}x${height} in ${theme} mode: the window itself cannot be scrolled, and the app bar is not clipped`, async ({
      page,
    }) => {
      await loadApp(page, { width, height, theme, files: TWO_FILES });
      const report = await audit(page);

      // The mechanism: `overflow-y: hidden` on whichever element is really
      // in charge of the viewport's scroll, verified rather than assumed.
      expect(report.windowScrollLocked).toBe(true);

      // The behaviour a user actually triggers: a wheel gesture over a
      // point that has no scroll/zoom handling of its own (the app bar,
      // never the DAG canvas -- React Flow captures wheel there for
      // pan/zoom, which would make this assert the wrong thing). Confirms
      // `windowScrollLocked` isn't just a CSS property nobody acts on.
      const before = await page.evaluate(
        () => document.documentElement.scrollTop,
      );
      await page.mouse.move(20, 20); // over the app bar, never the DAG canvas
      await page.mouse.wheel(0, 400);
      const after = await page.evaluate(
        () => document.documentElement.scrollTop,
      );
      expect(after).toBe(before);

      // The #158/#225 constraint: a fix that stops the window from
      // scrolling by clipping the app bar's own furniture instead is not a
      // fix. Checked at every one of these sizes, not just the narrow one --
      // a short window is exactly where a naive `overflow-y: hidden` could
      // have clipped something that genuinely needed the room.
      expect(report.appBarClipped).toBe(false);

      // And the horizontal guarantee still holds at every one of these --
      // #188's own fix must not reintroduce #154's.
      expect(report.pageOverflow).toBeNull();
    });
  }
}

test.describe('the file switcher collapses to a menu instead of scrolling', () => {
  test('a six-file directory collapses to a keyboard-reachable menu at 1024px, and every file is still reachable from it', async ({
    page,
  }) => {
    await loadApp(page, { width: 1024, theme: 'dark', files: SIX_FILES });

    // Measured on the real running app: the row of six buttons wants 689px and
    // the app bar has 451px left for it at this width, so the menu form wins.
    expect(await audit(page)).toMatchObject({ switcherCompact: 'true' });

    const switcher = page.getByRole('group', { name: 'Open config file' });
    const trigger = switcher.getByRole('button');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Reached by keyboard, not just by click: this is the accessibility
    // requirement that makes "collapses to a menu" acceptable at all.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Open config file' });
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Every *config* is listed, with the open one marked; issue #135's
    // non-config stays behind its own reveal, exactly as in the row form.
    await expect(
      menu.getByRole('menuitemradio', { name: 'config.yml', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    for (const name of [
      'continue-config.yml',
      'setup.yml',
      'shared-jobs.yml',
    ]) {
      await expect(
        menu.getByRole('menuitemradio', { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      menu.getByRole('menuitem', { name: 'Show 1 other YAML file' }),
    ).toBeVisible();

    // Escape closes it and hands focus back -- otherwise a keyboard user who
    // opens it is stranded.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // And choosing a file actually switches to it.
    await trigger.click();
    await menu
      .getByRole('menuitemradio', { name: 'setup.yml', exact: true })
      .click();
    await expect(
      page.getByRole('group', { name: 'Open config file' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="config-file-switcher"]'),
    ).toContainText('setup.yml');
  });

  test('an ordinary two-file directory still shows the row of buttons at 1024px -- collapse is a response to real crowding, not a width', async ({
    page,
  }) => {
    await loadApp(page, { width: 1024, theme: 'light', files: TWO_FILES });

    // Measured on the real running app: two buttons want 249px and the bar
    // leaves 451px at this width, so nothing needs to collapse. This is the
    // property a viewport breakpoint could not have delivered -- the same
    // width behaves differently because the *content* differs.
    expect(await audit(page)).toMatchObject({ switcherCompact: 'false' });
    const switcher = page.getByRole('group', { name: 'Open config file' });
    await expect(
      switcher.getByRole('button', { name: 'config.yml', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      switcher.getByRole('button', {
        name: 'continue-config.yml',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('a six-file directory shows its full row of buttons at 1920px -- the extra space is used', async ({
    page,
  }) => {
    await loadApp(page, { width: 1920, theme: 'dark', files: SIX_FILES });
    // Only the switcher's own form is asserted, deliberately not the tier.
    // Which tier a given width settles on is a consequence of what the bar's
    // furniture happens to cost, and *every* future app-bar item changes that --
    // issue #149's org/project display already moved it once. Pinning it here
    // would rebuild exactly the hand-maintained arithmetic issue #166 removed.
    // Measured for the record: the row wants 689px and gets 1179px at `tight`.
    expect(await audit(page)).toMatchObject({ switcherCompact: 'false' });
    const switcher = page.getByRole('group', { name: 'Open config file' });
    for (const name of ['config.yml', 'continue-config.yml', 'setup.yml']) {
      await expect(
        switcher.getByRole('button', { name, exact: true }),
      ).toBeVisible();
    }
  });

  test('a six-file directory still reaches the fullest tier once the window can afford both', async ({
    page,
  }) => {
    // The other half of the test above: a window wide enough for the fullest
    // furniture *and* the row does reach `full`, rather than the bar staying
    // terse forever once it has stepped down. Measured: `full`'s own furniture
    // is 1341px and this row wants 689px, and 2200px is the first width sampled
    // where the ladder settles there (2048 still lands on `compact`).
    await loadApp(page, { width: 2200, theme: 'dark', files: SIX_FILES });
    expect(await audit(page)).toMatchObject({
      switcherCompact: 'false',
      appBarTier: 'full',
    });
  });
});

test.describe('the app bar collapses its bounded furniture by tier', () => {
  test('collapses the preset switcher to a keyboard-reachable menu at 1024px, and keeps the row at 1280px', async ({
    page,
  }) => {
    await loadApp(page, { width: 1024, theme: 'dark', files: SIX_FILES });
    expect(await audit(page)).toMatchObject({ appBarTier: 'tight' });

    const group = page.getByRole('group', { name: 'Pane layout' });
    const trigger = group.getByRole('button');
    await expect(trigger).toHaveText('Graph focus');

    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Pane layout' });
    await expect(
      menu.getByRole('menuitemradio', { name: 'Graph focus' }),
    ).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'Columns' }).click();
    await expect(trigger).toHaveText('Columns');
    await expect(trigger).toBeFocused();
  });

  test('keeps the preset pills for an ordinary single-file directory at 1280px', async ({
    page,
  }) => {
    // The default listing from `mockHostApi` -- one file, so the switcher
    // renders nothing and costs the tier budget nothing. 1280 is Playwright's
    // default viewport and the specs that click preset pills by name
    // (`layout.spec.ts`, `docs-pane.spec.ts`) all use this same fixture, so
    // this pins the tier those specs actually run at.
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockHostApi(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // `compact` since the bar gained issue #149's org/project display: the
    // fullest tier now needs 1324px with no switcher at all. What this test is
    // about is unaffected -- `compact` keeps the preset pills, and only the
    // config path gives ground.
    expect(await audit(page)).toMatchObject({ appBarTier: 'compact' });
    await expect(
      page.getByRole('button', { name: 'Graph focus' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('shortens the config path to its last two segments at the compact tier, keeping the full path in its tooltip', async ({
    page,
  }) => {
    // Two files at 1600: measured to land on `compact`, the one tier where the
    // path is neither absolute nor a bare basename. (1440 before issue #149's
    // org/project display; 1500 before issue #166 replaced the predicted budget
    // with a measured walk, which lands one step terser here.)
    await loadApp(page, { width: 1600, theme: 'light', files: TWO_FILES });
    expect(await audit(page)).toMatchObject({ appBarTier: 'compact' });

    // The path gave ground rather than the switcher shrinking -- issue #147's
    // own recommended ordering -- and its full form stays one hover away.
    const path = page.locator('header span[title]', {
      hasText: '.circleci/config.yml',
    });
    await expect(path).toHaveAttribute('title', FIXTURE_CONFIG_PATH);
    await expect(path).not.toHaveText(FIXTURE_CONFIG_PATH);
  });

  /**
   * Issue #166's actual defect, in the exact shape it was reported.
   *
   * The app bar's own furniture is not static after load: `ValidationBadge`
   * renders **nothing** until validation resolves, so the right-hand group grows
   * about a second in. #154 chose the tier from a *hardcoded* table of what each
   * tier's furniture costs, and those numbers had been taken in the pre-badge
   * state -- 59px light. So at 1280px the bar upgraded to `compact` believing it
   * had room for this listing's 185px row when it really had 161px, and the
   * switcher, doing its job correctly, collapsed at a width where the next tier
   * down had 460px to spare.
   *
   * That also produced the confusing symptom: `config-switcher.spec.ts` asserts
   * inside the ~700ms window *before* validation resolves, so it passed on a fast
   * machine and failed on a loaded one, which looks exactly like a measurement
   * race and is not one.
   *
   * The bar no longer predicts its own cost at all: it starts from an optimistic
   * width threshold and steps down whenever the switcher reports that its row did
   * not fit. This asserts the outcome at the point of failure -- the same
   * listing, the same viewport, measured only after the badge has landed.
   */
  test('a late-arriving badge does not leave the switcher collapsed when a terser tier would fit it (issue #166)', async ({
    page,
  }) => {
    await loadApp(page, {
      width: 1280,
      theme: 'dark',
      files: ONE_CONFIG_ONE_NON_CONFIG,
    });

    // The bar has settled with the validation badge present...
    await expect(
      page.getByRole('banner').getByText('Valid', { exact: true }),
    ).toBeVisible();
    // ...and the row of buttons is what shows, at whichever tier the bar stepped
    // down to in order to make room for it. The tier itself is not asserted: it
    // is a consequence of the bar's furniture widths, which every future app-bar
    // item changes, and pinning it here would recreate the hand-maintained
    // arithmetic this issue removed. What must hold is that the row fits.
    const report = await audit(page);
    expect(report).toMatchObject({ switcherCompact: 'false' });
    expect(report.switcherSlotPx).toBeGreaterThan(report.switcherRowPx);

    await expectActiveConfigFile(page, 'config.yml');
  });

  /**
   * The second bug found while fixing the first, and the reason the demotion
   * walk carries a report id rather than a bare boolean.
   *
   * The walk is driven by the switcher reporting that its row did not fit. After
   * the bar demotes one tier the switcher re-measures and, if the row still
   * doesn't fit, reports the *same* verdict -- so a boolean-valued report never
   * changes, nothing re-runs, and the walk stalls one tier short. Measured while
   * building this: at 1600px and 1680px with a six-file directory the walk
   * stopped at `compact` and left the row collapsed, when `tight` had 968px
   * available for a 689px row. Two demotions were needed and only one happened.
   */
  for (const width of [1600, 1680]) {
    test(`walks down more than one tier when one is not enough, at ${width}px (issue #166)`, async ({
      page,
    }) => {
      await loadApp(page, { width, theme: 'dark', files: SIX_FILES });
      const report = await audit(page);
      expect(report).toMatchObject({
        switcherCompact: 'false',
        appBarTier: 'tight',
      });
      expect(report.switcherSlotPx).toBeGreaterThan(report.switcherRowPx);
    });
  }

  /**
   * The arrangement has to be *stable*, not merely eventually-correct: a probe
   * that kept demoting and re-promoting would satisfy every assertion above
   * while flickering forever. Samples the tier and the switcher's form across a
   * second of real time once settled, and requires exactly one distinct state.
   */
  test('holds still once settled, rather than oscillating between tiers', async ({
    page,
  }) => {
    await loadApp(page, { width: 1280, theme: 'dark', files: SIX_FILES });

    const states = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const seen: string[] = [];
          const deadline = Date.now() + 1000;
          const sample = () => {
            const header = document.querySelector('header');
            const slot = document.querySelector(
              '[data-testid="config-file-switcher"]',
            ) as HTMLElement | null;
            const state = `${header?.getAttribute('data-app-bar-tier')}/${slot?.dataset.compact}`;
            if (seen[seen.length - 1] !== state) seen.push(state);
            if (Date.now() < deadline) requestAnimationFrame(sample);
            else resolve(seen);
          };
          requestAnimationFrame(sample);
        }),
    );
    expect(states).toHaveLength(1);
  });

  /**
   * The wart this budget exists to remove, found by measuring rather than by
   * reasoning. A tier upgrade *spends* more space than a modest widening gains
   * (a 120px preset menu becomes a 404px row of pills, and the path lengthens),
   * so tiering on width alone left a band just above the threshold where the
   * app bar had *less* room for the file switcher than it had on a narrower
   * window: measured at 451px of switcher room at 1024 and 221px at 1280, i.e.
   * widening the window collapsed a switcher that had been showing its buttons.
   *
   * `appBarTier` costs the switcher's own measured need into the decision, so
   * this sweep asserts the property directly: across the whole range, widening
   * never takes the row of buttons away.
   */
  test('widening the window never collapses a file switcher that was showing its buttons', async ({
    page,
  }) => {
    await loadApp(page, { width: 1024, theme: 'dark', files: SIX_FILES });

    let sawRow = false;
    for (const width of [1024, 1152, 1280, 1366, 1440, 1600, 1680, 1920]) {
      await resizeTo(page, width);
      const { switcherCompact } = await audit(page);
      if (switcherCompact === 'false') sawRow = true;
      expect(
        { width, switcherCompact },
        `once the row of buttons fits it must keep fitting as the window grows`,
      ).toEqual({
        width,
        switcherCompact: sawRow ? 'false' : 'true',
      });
    }
    // Sanity: the sweep really did cross the boundary rather than trivially
    // passing by staying collapsed the whole way.
    expect(sawRow).toBe(true);
  });

  test('shows the full config path at the fullest tier', async ({ page }) => {
    // 2200 rather than 1920: with six files and issue #149's org/project display
    // in the bar, `full` is the tier the ladder settles on from 2200 up (see the
    // sibling test).
    await loadApp(page, { width: 2200, theme: 'light', files: SIX_FILES });
    // `.first()`: every pane has its own `<header>` too (`Panel`), and the app
    // bar is the document's first.
    await expect(page.locator('header').first()).toContainText(
      FIXTURE_CONFIG_PATH,
    );
  });
});

test.describe('every pane keeps a minimum usable size', () => {
  /**
   * The single most recurring complaint in this project is the graph canvas
   * being squeezed (#88, and #154's own "the graph in particular can't
   * be squeezed into uselessness"). Before this change the layout engine's
   * only floor was `MIN_REGION_PX` applied during a *splitter drag* -- a
   * preset's own default ratio was never checked against the window at all, so
   * at 1024px `graph-focus` rendered the palette at 171px purely because 0.72
   * of the space left happened to work out that way.
   *
   * `MIN_PANE_PX` in `layout/constants.ts` now gives each pane its own floor
   * and `renderRatio` clamps a split's rendered ratio against the sum of
   * whichever panes actually sit on each side. Asserted here against the
   * *rendered* pixels rather than the ratios, since the ratios were never the
   * thing that was wrong.
   */
  for (const width of WIDTHS) {
    test(`no visible pane is below its minimum usable width at ${width}px`, async ({
      page,
    }) => {
      await loadApp(page, { width, theme: 'dark', files: SIX_FILES });
      const { paneWidths, paneHeights } = await audit(page);

      // `graph-focus` (the default preset) with `docs` collapsed to its 32px
      // strip. Floors from `MIN_PANE_PX`; the graph's own 360 is the binding
      // one, being the largest.
      expect(paneWidths.dag).toBeGreaterThanOrEqual(360);
      expect(paneWidths.palette).toBeGreaterThanOrEqual(200);
      expect(paneWidths.yaml).toBeGreaterThanOrEqual(300);
      expect(paneWidths.ai).toBeGreaterThanOrEqual(320);
      expect(paneHeights.dag).toBeGreaterThanOrEqual(220);
      expect(paneHeights.ai).toBeGreaterThanOrEqual(160);
      // `docs` is collapsed by default in every preset, so it is a strip
      // here, not a pane below its floor.
      expect(paneWidths.docs).toBeLessThanOrEqual(40);
    });
  }

  test('the graph pane grows with the window rather than assuming a fixed size', async ({
    page,
  }) => {
    await loadApp(page, { width: 1024, theme: 'dark', files: SIX_FILES });
    const narrow = (await audit(page)).paneWidths;

    for (const width of [1280, 1440, 1920]) {
      await resizeTo(page, width);
      const wider = (await audit(page)).paneWidths;
      expect(wider.dag).toBeGreaterThan(narrow.dag!);
      expect(wider.yaml).toBeGreaterThan(narrow.yaml!);
    }
  });

  test('collapsing the palette still hands 100% of its width to the graph (issue #80) with the minimums in place', async ({
    page,
  }) => {
    await loadApp(page, { width: 1280, theme: 'dark', files: SIX_FILES });
    const before = (await audit(page)).paneWidths;

    await page.getByRole('button', { name: /collapse palette panel/i }).click();
    const after = (await audit(page)).paneWidths;

    // The palette's whole width, minus the strip it leaves behind and the
    // splitter that no longer renders, must land on the graph -- nothing may
    // be left as dead space. This is #80's guarantee, restated in pixels
    // against the pane the minimums now clamp.
    expect(after.dag! - before.dag!).toBeGreaterThan(
      before.palette! - 40 - 12 - 2,
    );
    expect(await audit(page)).toMatchObject({ pageOverflow: null });
  });

  test('a persisted arrangement from a wide window is honoured again when the window widens, not overwritten by the narrow clamp', async ({
    page,
  }) => {
    await loadApp(page, { width: 1920, theme: 'dark', files: SIX_FILES });
    const wide = (await audit(page)).paneWidths;

    // Narrow enough that `graph-focus`'s 0.72 dag/palette default has to be
    // clamped off to keep the palette at its 200px floor...
    await resizeTo(page, 1024);
    const narrow = (await audit(page)).paneWidths;
    expect(narrow.palette).toBeGreaterThanOrEqual(200);

    // ...and widening again restores the original proportions exactly, which
    // is only true because the clamp is applied per render and never written
    // back to the store (see `renderRatio`).
    await resizeTo(page, 1920);
    const again = (await audit(page)).paneWidths;
    expect(again.dag).toBe(wide.dag);
    expect(again.palette).toBe(wide.palette);
  });

  test('a layout persisted at one width survives a reload at another', async ({
    page,
  }) => {
    await loadApp(page, { width: 1440, theme: 'dark', files: SIX_FILES });
    await selectPreset(page, 'Columns');
    await page
      .getByRole('button', { name: /collapse ai assistant panel/i })
      .click();

    await resizeTo(page, 1024);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // Both choices came back, and the narrow window still has no page-level
    // horizontal scroll and no scroll region in the bar.
    await expect(
      page.getByRole('button', { name: /expand ai assistant panel/i }),
    ).toBeVisible();
    const report = await audit(page);
    expect(report.pageOverflow).toBeNull();
    expect(report.appBarScrollRegions).toEqual([]);
    // The preset switcher is a menu at this width, so "Columns" is now the
    // trigger's own label rather than a pressed pill.
    await expect(
      page.getByRole('group', { name: 'Pane layout' }).getByRole('button'),
    ).toHaveText('Columns');
  });
});
