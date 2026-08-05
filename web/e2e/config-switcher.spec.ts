import { expect, test } from '@playwright/test';

import { FIXTURE_CONFIG, FIXTURE_CONFIG_PATH, mockHostApi } from './fixtures';
import {
  activeSwitcherEntry,
  switcherIsCollapsed,
  expectActiveConfigFile,
  expectConfigFileNotOffered,
  expectConfigFileOffered,
  openConfigFile,
  revealOtherYamlFiles,
} from './switcher';

/**
 * Issue #135, in a real browser: the `.circleci` file switcher used to list
 * *any* `.yml`/`.yaml` as a CircleCI config, so the owner's own `goss.yaml`
 * showed up as one. The host now classifies each file structurally and this
 * spec drives what the user actually sees -- hidden by default, revealable
 * in one click, and explained rather than shown as an empty graph.
 *
 * The listing is stubbed here (per `fixtures.ts`' own note that
 * switcher/multi-file specs bring their own), with the same `isConfig` /
 * `configReason` fields the Go host puts on `GET /api/config-files`; the
 * classification rule itself is covered by `internal/host`'s tests against
 * a realistic goss fixture.
 */
const GOSS_PATH = '/home/dev/widgets/.circleci/goss.yaml';
const GOSS_REASON =
  'No CircleCI structure: no top-level version: 2, 2.0 or 2.1, and none of jobs, workflows, orbs, executors, commands, setup.';
const GOSS_YAML = `file:
  /etc/passwd:
    exists: true
command:
  echo hello:
    exit-status: 0
`;

/**
 * Extra configs used only to make the switcher's row too wide to fit, so the
 * *same* assertions below run against its collapsed (menu) presentation too --
 * see the `PRESENTATIONS` table. Realistic `.circleci` names, since the row's
 * width is a function of them.
 */
const CROWDING_CONFIGS = [
  'continue-config.yml',
  'setup.yml',
  'deploy-config.yml',
  'shared-jobs.yml',
];

/**
 * Issue #166: this spec's subject is issue #135's *classification*, which is
 * true of the switcher in either presentation -- so it runs against both, rather
 * than against whichever one the app bar happens to pick at Playwright's default
 * viewport. That is what stops a future layout change from breaking a spec that
 * has nothing to do with layout, which is exactly what happened here.
 */
const PRESENTATIONS = [
  { name: 'row form', width: 1280, extraConfigs: [] as string[] },
  { name: 'menu form', width: 1024, extraConfigs: CROWDING_CONFIGS },
];

for (const { name, width, extraConfigs } of PRESENTATIONS) {
  test(`hides YAML that is not a CircleCI config, reveals it on request, and explains it when opened (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await mockHostApi(page);

    await page.route('**/api/config-files**', async (route) => {
      await route.fulfill({
        json: {
          dir: '/home/dev/widgets/.circleci',
          primaryPath: FIXTURE_CONFIG_PATH,
          files: [
            {
              path: FIXTURE_CONFIG_PATH,
              relPath: 'config.yml',
              size: FIXTURE_CONFIG.length,
              isPrimary: true,
              isConfig: true,
              configReason: 'Declares version: 2.1.',
            },
            ...extraConfigs.map((relPath) => ({
              path: `/home/dev/widgets/.circleci/${relPath}`,
              relPath,
              size: FIXTURE_CONFIG.length,
              isPrimary: false,
              isConfig: true,
              configReason: 'Declares version: 2.1.',
            })),
            {
              path: GOSS_PATH,
              relPath: 'goss.yaml',
              size: GOSS_YAML.length,
              isPrimary: false,
              isConfig: false,
              configReason: GOSS_REASON,
            },
          ],
        },
      });
    });

    // Only requests that carry a `?path=` (i.e. the switcher opening a
    // sibling file) are handled here; `route.fallback()` hands the app's
    // initial, unparameterized `GET /api/config` back to the fixture.
    await page.route('**/api/config?*', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (path !== GOSS_PATH) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: { path: GOSS_PATH, contents: GOSS_YAML, exists: true },
      });
    });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    // Pin that this run really is exercising the presentation it claims to --
    // otherwise a width change elsewhere could quietly turn this into a second
    // copy of the other case.
    expect(await switcherIsCollapsed(page)).toBe(name === 'menu form');

    // Asserted through `e2e/switcher.ts` rather than against `aria-pressed`
    // directly: the switcher has two presentations since issue #154 (a row of
    // buttons, or a menu when the row doesn't fit the app bar's remaining space),
    // and "which file is open" is expressed differently by each. Issue #166: this
    // spec previously asserted the row form's markup, so a legitimate collapse
    // failed a spec about issue #135's classification with a confusing
    // `aria-pressed` mismatch on an element it never meant to select.
    await expectActiveConfigFile(page, 'config.yml');

    // The defect itself: goss.yaml must not be offered as a config. Checked in
    // whichever form is live -- and in the menu form that means opening it, so
    // this deliberately runs before the reveal below.
    await expectConfigFileNotOffered(page, /^goss\.yaml/);

    // ...but a false negative has to stay one click from recoverable.
    await revealOtherYamlFiles(page, 'Show 1 other YAML file');
    await expectConfigFileOffered(page, /^goss\.yaml/);
    await expect(
      await activeSwitcherEntry(page, /^goss\.yaml/),
    ).toHaveAccessibleName(/not a CircleCI config/);

    await openConfigFile(page, /^goss\.yaml/);

    // Opened deliberately, it explains itself with the host's own reason
    // instead of rendering an empty DAG or advising a `workflows:` block.
    await expect(
      page.getByText(/goss\.yaml is not a CircleCI config/),
    ).toBeVisible();
    await expect(page.getByText(/No CircleCI structure/)).toBeVisible();
    await expect(page.getByText(/no workflows: block/i)).toHaveCount(0);

    // The open non-config stays in the switcher as the active file, so there is a
    // way back to it (and to config.yml) without re-revealing anything.
    await expectActiveConfigFile(page, 'goss.yaml');
    await expectConfigFileOffered(page, 'config.yml');
  });
}
