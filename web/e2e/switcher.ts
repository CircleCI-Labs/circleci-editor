import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers for asserting against the `.circleci` file switcher **without
 * depending on which of its two presentations is currently showing**.
 *
 * Issue #154 gave the switcher a second form: when its row of buttons doesn't
 * fit the space the app bar has left it, it collapses to a single menu trigger
 * (see `src/layout/ConfigFileSwitcher.tsx`). Both forms express the same
 * user-visible facts, through different accessible markup:
 *
 * | fact | row form | menu form |
 * |---|---|---|
 * | which file is open | `aria-pressed` on its button | the trigger's accessible name; `aria-checked` on its `menuitemradio` |
 * | which files exist | one `button` each | one `menuitemradio` each, once opened |
 * | #135's reveal | a `button` | a `menuitem` |
 *
 * Issue #166: `config-switcher.spec.ts` asserted the first of those through
 * `aria-pressed` alone, which is the row form's *implementation detail* rather
 * than the fact itself. So when the switcher legitimately collapsed, a spec
 * about issue #135's config classification failed with a confusing
 * `aria-pressed` mismatch on an element it never meant to select -- turning a
 * layout decision into a spurious failure in an unrelated spec. Asserting
 * through whichever presentation is live keeps that from recurring, whatever
 * future app-bar content does to the available widths.
 *
 * Lives in its own module rather than in `fixtures.ts` deliberately: that file
 * is edited by nearly every branch, and a shared helper landing in it is a
 * merge conflict waiting to happen.
 */

/**
 * Resolves once the app bar has reached its **final** arrangement: the switcher
 * has a real measurement (`data-measured`), and the bar's tier probe has
 * finished stepping down the ladder looking for one where the row fits
 * (`data-app-bar-settled`).
 *
 * Issue #166: waiting on a frame count instead is what made this whole area
 * look load-dependent. Both attributes are product-level signals, so a spec that
 * waits on them is deterministic on any machine -- rather than passing on a fast
 * one because it happened to assert before the app bar finished changing shape.
 */
export async function waitForSwitcherMeasured(page: Page): Promise<void> {
  await expect(
    page.locator('[data-testid="config-file-switcher"]'),
  ).toHaveAttribute('data-measured', 'true');
  await expect(page.locator('header').first()).toHaveAttribute(
    'data-app-bar-settled',
    'true',
  );
}

/** True when the switcher is currently in its collapsed (menu) form. */
export async function switcherIsCollapsed(page: Page): Promise<boolean> {
  await waitForSwitcherMeasured(page);
  const value = await page
    .locator('[data-testid="config-file-switcher"]')
    .getAttribute('data-compact');
  return value === 'true';
}

/** The switcher's own labelled group, whichever form it is in. Exactly one is
 * ever exposed -- the unused form is `aria-hidden` and `visibility: hidden`. */
export function switcherGroup(page: Page): Locator {
  return page.getByRole('group', { name: 'Open config file' });
}

/** The switcher's menu panel (collapsed form only). */
export function switcherMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'Open config file' });
}

/**
 * The element holding one entry per file, plus the role those entries have.
 * Opens the menu first when the switcher is collapsed, so a caller can query
 * entries the same way in both forms. Leaves the menu open -- every caller here
 * either asserts on an entry or activates one, and both want it open.
 */
async function entries(
  page: Page,
): Promise<{ container: Locator; fileRole: 'button' | 'menuitemradio' }> {
  if (!(await switcherIsCollapsed(page))) {
    return { container: switcherGroup(page), fileRole: 'button' };
  }
  const menu = switcherMenu(page);
  if (!(await menu.isVisible())) {
    await switcherGroup(page).getByRole('button').click();
    await expect(menu).toBeVisible();
  }
  return { container: menu, fileRole: 'menuitemradio' };
}

/**
 * One file's entry, in whichever form is live.
 *
 * A plain string is anchored (see `nameStartingWith`) rather than used as
 * Playwright's default substring match, which would make `config.yml` ambiguous
 * the moment the directory also holds `continue-config.yml` or
 * `deploy-config.yml`. Pass a `RegExp` to match on your own terms.
 */
export async function activeSwitcherEntry(
  page: Page,
  relPath: string | RegExp,
): Promise<Locator> {
  const { container, fileRole } = await entries(page);
  return container.getByRole(fileRole, {
    name: typeof relPath === 'string' ? nameStartingWith(relPath) : relPath,
  });
}

/**
 * Asserts that `relPath` is the file currently open, through whichever
 * presentation is live: `aria-pressed="true"` on its button in the row form, or
 * the trigger's own accessible name in the menu form -- which starts with the
 * open file's name, so this reads the closed trigger and never has to open the
 * menu (see `ConfigFileSwitcher`'s `triggerLabel`).
 */
export async function expectActiveConfigFile(
  page: Page,
  relPath: string,
): Promise<void> {
  // A *prefix* match, not an exact one, because neither form's accessible name
  // is always just the file name -- and in both forms the extra text is a
  // suffix, because every label here is built to keep the visible name as its
  // prefix ("label in name"). A non-config's button carries the host's
  // classification reason (`goss.yaml — not a CircleCI config. …`, issue #135)
  // and the collapsed trigger carries the file count and what activating it
  // does (`config.yml +1 — open a different config file`).
  const name = nameStartingWith(relPath);
  if (await switcherIsCollapsed(page)) {
    await expect(switcherGroup(page).getByRole('button')).toHaveAccessibleName(
      name,
    );
    return;
  }
  await expect(
    switcherGroup(page).getByRole('button', { name }),
  ).toHaveAttribute('aria-pressed', 'true');
}

/** Matches an accessible name that *is* `relPath`, or begins with it followed by
 * a space. Anchored and space-delimited so `config.yml` can't match
 * `continue-config.yml` (different prefix) or a hypothetical `config.yml.bak`
 * (no delimiter). */
function nameStartingWith(relPath: string): RegExp {
  return new RegExp(`^${escapeForRegExp(relPath)}(?:$| )`);
}

/** Asserts `relPath` is offered by the switcher, in whichever form is live. */
export async function expectConfigFileOffered(
  page: Page,
  relPath: string | RegExp,
): Promise<void> {
  await expect(await activeSwitcherEntry(page, relPath)).toBeVisible();
}

/** Asserts `relPath` is *not* offered -- issue #135's own defect assertion. */
export async function expectConfigFileNotOffered(
  page: Page,
  relPath: string | RegExp,
): Promise<void> {
  await expect(await activeSwitcherEntry(page, relPath)).toHaveCount(0);
}

/** Opens `relPath` through whichever presentation is live. */
export async function openConfigFile(
  page: Page,
  relPath: string | RegExp,
): Promise<void> {
  await (await activeSwitcherEntry(page, relPath)).click();
}

/**
 * Activates issue #135's "Show N other YAML files" reveal through whichever
 * presentation is live. The accessible name is identical in both forms; only
 * the role differs -- a plain `button` in the row, a `menuitem` in the menu.
 */
export async function revealOtherYamlFiles(
  page: Page,
  accessibleName: string,
): Promise<void> {
  if (await switcherIsCollapsed(page)) {
    const menu = switcherMenu(page);
    if (!(await menu.isVisible())) {
      await switcherGroup(page).getByRole('button').click();
    }
    await menu.getByRole('menuitem', { name: accessibleName }).click();
    return;
  }
  await switcherGroup(page)
    .getByRole('button', { name: accessibleName })
    .click();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
