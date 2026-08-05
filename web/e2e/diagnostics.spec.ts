import { expect, test, type Page } from '@playwright/test';

import {
  FIXTURE_COMMENT,
  invalidStub,
  mockHostApi,
  unavailableStub,
  VALID_STUB,
} from './fixtures';

/**
 * Issue #148, against the real built app: "when the config is invalid, it
 * doesn't give me any indication of, hey, this went wrong... that's the only
 * area I see, and I have to come over to the compiler view."
 *
 * Every error message stubbed here is a verbatim response from CircleCI's
 * `compile-config-with-defaults` (captured live -- see
 * `src/lib/validation/apiFixtures.ts`, which holds the same strings for the
 * unit tests). Nothing here asserts against an invented error format.
 *
 * The four things the issue asks for, each pinned below:
 *  1. the error is visible without leaving the source view;
 *  2. the failing node is marked in the graph;
 *  3. a reliable suggestion applies as a surgical, undoable edit;
 *  4. "Fix with AI" seeds the chat and never sends -- and says so plainly
 *     when there is no key.
 */

/** `stpes:` for `steps:` in the fixture's `build` job -- the misspelled-key case. */
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

const UNKNOWN_COMMAND_IN_TEST = [
  "Error calling workflow: 'build_test_deploy'",
  "Error calling job: 'test'",
  'Cannot find a definition for command named chekcout',
];

/** The fixture config with `steps:` misspelled inside `build`, so the schema error above is genuinely about it. */
function configWithMisspelledSteps(): string {
  return `${FIXTURE_COMMENT}
version: 2.1

jobs:
  # The build job.
  build:
    docker:
      - image: cimg/node:20.0 # pinned
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
      - test:
          requires:
            - build
`;
}

const strip = (page: Page) => page.getByTestId('diagnostics-strip');

test.describe('an invalid config announces itself next to the source (issue #148)', () => {
  test('the error, its location and a fix are all visible in the source view -- no pane switch', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');

    // Source view is the default and stays selected throughout.
    await expect(page.getByRole('button', { name: 'Source' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await expect(strip(page)).toBeVisible();
    await expect(page.getByTestId('diagnostic-title')).toHaveText(
      'Key "stpes" is not allowed in jobs.build',
    );
    // Labelled with who said it.
    await expect(
      strip(page).getByText('CircleCI compiler', { exact: true }),
    ).toBeVisible();
    // And the line it resolved to, offered as a real button.
    await expect(
      strip(page).getByRole('button', { name: /^line 9/ }),
    ).toBeVisible();
  });

  test('the resolved line is highlighted in the editor and reachable from the keyboard', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    // The tint lands on the offending line, and only on it.
    const marked = page.locator('.vce-diagnostic-line');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('stpes:');

    // Focus the jump button with the keyboard alone and activate it: the
    // cursor must move to that line. (Issue #148: "error navigation must be
    // keyboard reachable, not hover-only".)
    const jump = strip(page).getByRole('button', { name: /^line 9/ });
    await jump.focus();
    await expect(jump).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-activeLine')).toContainText('stpes:');
  });

  test('applying the suggested fix is one surgical, undoable edit that keeps every comment', async ({
    page,
  }) => {
    const hostApi = await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    await expect(
      strip(page).getByText(/CircleCI listed the keys permitted here/),
    ).toBeVisible();
    await strip(page)
      .getByRole('button', { name: 'Rename "stpes" to "steps"' })
      .click();

    const editorText = await page.locator('.cm-content').innerText();
    expect(editorText).not.toContain('stpes');
    // The comments the fix must not disturb -- the guarantee this whole
    // editor rests on (docs/ARCHITECTURE.md), asserted on an *applied
    // suggestion* rather than only on typing.
    expect(editorText).toContain('The build job.');
    expect(editorText).toContain('# pinned');

    // One undo step puts it back exactly.
    await page.getByRole('button', { name: 'Undo last change' }).click();
    await expect(page.locator('.cm-content')).toContainText('stpes:');

    // And redoing then saving writes the fix, comments intact, to the host.
    await page.getByRole('button', { name: 'Redo last undone change' }).click();
    await page.getByRole('button', { name: 'Review and save config' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);
    const saved = hostApi.getSavedConfig() ?? '';
    expect(saved).toContain('    steps:');
    expect(saved).not.toContain('stpes');
    expect(saved).toContain(FIXTURE_COMMENT);
    expect(saved).toContain('  # The build job.');
    expect(saved).toContain('# pinned');
  });

  test('a valid config gets no strip at all', async ({ page }) => {
    await mockHostApi(page, { validate: VALID_STUB });
    await page.goto('/');
    await expect(
      page.getByText('Valid', { exact: true }).first(),
    ).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
  });

  test('an error with no resolvable location says so instead of pointing at a guessed line', async ({
    page,
  }) => {
    await mockHostApi(page, {
      // A real message about an executor the fixture config never mentions:
      // there is nothing in the document to resolve it against.
      validate: invalidStub([
        "Error calling workflow: 'build_test_deploy'",
        "Error calling job: 'build'",
        'Cannot find a definition for executor named nope',
      ]),
    });
    await page.goto('/');

    await expect(strip(page).getByText('Location unknown')).toBeVisible();
    await expect(
      strip(page).getByRole('button', { name: /^line \d/ }),
    ).toHaveCount(0);
    // The error is still shown in full -- not dropped for being unplaceable.
    await expect(page.getByTestId('diagnostic-title')).toHaveText(
      'Cannot find a definition for executor named nope',
    );
    await expect(page.locator('.vce-diagnostic-line')).toHaveCount(0);
  });

  test('steps through several problems one at a time rather than listing them all', async ({
    page,
  }) => {
    await mockHostApi(page, {
      validate: invalidStub([
        'At least one job in the workflow must have no dependencies.',
        'The following jobs are unreachable: build, test',
      ]),
    });
    await page.goto('/');

    await expect(strip(page).getByText('1 / 2')).toBeVisible();
    await expect(
      strip(page).getByText('The following jobs are unreachable: build, test'),
    ).toHaveCount(0);
    await strip(page).getByRole('button', { name: 'Next problem' }).click();
    await expect(page.getByTestId('diagnostic-title')).toHaveText(
      'The following jobs are unreachable: build, test',
    );
    // And this pair is exactly the case where no fix is offered.
    await expect(
      strip(page).getByText(/No automatic fix offered/),
    ).toBeVisible();
  });

  test('adds no scrolling region to the YAML pane', async ({ page }) => {
    // #88: "there's 5 different scroll bars there". The strip shows one
    // problem at a time precisely so it needs none.
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    const scrollables = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="pane-yaml"]');
      if (!container) throw new Error('no yaml pane');
      let count = 0;
      for (const element of container.querySelectorAll('*')) {
        const cs = getComputedStyle(element);
        if (
          (/auto|scroll/.test(cs.overflowY) &&
            element.scrollHeight > element.clientHeight + 2) ||
          (/auto|scroll/.test(cs.overflowX) &&
            element.scrollWidth > element.clientWidth + 2)
        ) {
          count += 1;
        }
      }
      return count;
    });
    // CodeMirror's own scroller is the one legitimate region in this pane.
    expect(scrollables).toBeLessThanOrEqual(1);
  });
});

test.describe('the graph marks the failing node (issue #148)', () => {
  test('rings the job the compile error names, and only that one', async ({
    page,
  }) => {
    await mockHostApi(page, {
      validate: invalidStub(UNKNOWN_COMMAND_IN_TEST),
    });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    const errored = page.locator('.vce-dag-node--diagnostic');
    await expect(errored).toHaveCount(1);
    await expect(errored).toContainText('test');
    // The badge, not just the ring -- the ring alone is invisible to a
    // screen reader.
    await expect(errored.locator('.vce-dag-error-label')).toHaveText('error');
  });

  test('the banner entry selects the job it names, from the keyboard', async ({
    page,
  }) => {
    await mockHostApi(page, {
      validate: invalidStub(UNKNOWN_COMMAND_IN_TEST),
    });
    await page.goto('/');

    const entry = page.getByRole('button', {
      name: /Cannot find a definition for command named chekcout/,
    });
    await entry.focus();
    await page.keyboard.press('Enter');
    // Selecting a node mounts the inspector for it.
    await expect(
      page.getByRole('heading', { name: 'Steps', exact: true }),
    ).toBeVisible();
  });

  test('rings the job a schema error points into, though the error names no workflow', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
    });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    const errored = page.locator('.vce-dag-node--diagnostic');
    await expect(errored).toHaveCount(1);
    await expect(errored).toContainText('build');
  });

  test('marks nothing when the config compiles', async ({ page }) => {
    await mockHostApi(page, { validate: VALID_STUB });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
    await expect(page.locator('.vce-dag-node--diagnostic')).toHaveCount(0);
    await expect(page.locator('.vce-dag-error-label')).toHaveCount(0);
  });
});

test.describe('validation with no token degrades to local checks (issue #148)', () => {
  test('shows local findings, labelled as local, and never claims CircleCI said them', async ({
    page,
  }) => {
    const brokenRequires = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          requires:
            - gone
`;
    await mockHostApi(page, {
      hasToken: false,
      config: brokenRequires,
      validate: unavailableStub('This host has no CIRCLE_TOKEN configured.'),
    });
    await page.goto('/');

    await expect(strip(page)).toBeVisible();
    await expect(
      strip(page).getByText('Local check', { exact: true }),
    ).toBeVisible();
    await expect(
      strip(page).getByText('CircleCI compiler', { exact: true }),
    ).toHaveCount(0);
    await expect(
      strip(page).getByText(/has not been compiled by CircleCI/),
    ).toBeVisible();
    // And the finding is still placed, from the document alone.
    await expect(
      strip(page).getByRole('button', { name: /^line 13/ }),
    ).toBeVisible();
  });
});

test.describe('"Fix with AI" seeds the chat (issue #148)', () => {
  test('with a key: fills the composer, sends nothing, applies nothing', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
      aiConfigured: true,
    });
    let chatRequests = 0;
    await page.route('**/api/ai/chat', async (route) => {
      chatRequests += 1;
      await route.fulfill({ json: { available: true, content: 'hi' } });
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    const before = await page.locator('.cm-content').innerText();
    await strip(page).getByRole('button', { name: 'Fix with AI' }).click();

    await expect(
      strip(page).getByText(/Prompt added to the AI pane's message box/),
    ).toBeVisible();

    const composer = page.getByLabel('Message the AI assistant');
    await expect(composer).toHaveValue(
      /extraneous key \[stpes\] is not permitted/,
    );
    await expect(composer).toHaveValue(/Reported by: CircleCI compiler/);

    // Issue #210: the prompt now says what *kind* of problem this is, so a docs
    // search runs over the class of error rather than over whatever product name
    // happens to appear in it.
    await expect(composer).toHaveValue(/Problem type:/);

    // Issues #186/#209: and it is actually *readable*. The seeded prompt is ~30
    // lines and the AI pane's default share of a 720px window leaves the box at
    // its minimum, so the box says how much it is holding and that the rest is a
    // scroll away. #186's separate draft-preview card is gone (#209) -- the owner
    // found it confusing -- and the input is what tells the truth now.
    await expect(page.getByTestId('ai-draft-preview')).toHaveCount(0);
    const overflow = page.getByTestId('ai-composer-overflow');
    await expect(overflow).toBeVisible();
    await expect(overflow).toContainText('scroll');
    // The whole prompt really is in the box, not truncated into it.
    await expect(composer).toHaveValue(
      /extraneous key \[stpes\] is not permitted/,
    );

    // Nothing sent, nothing changed.
    expect(chatRequests).toBe(0);
    expect(await page.locator('.cm-content').innerText()).toBe(before);
  });

  test('with no key: explains why, rather than looking broken', async ({
    page,
  }) => {
    await mockHostApi(page, {
      config: configWithMisspelledSteps(),
      validate: invalidStub(SCHEMA_ERROR),
      aiConfigured: false,
    });
    await page.goto('/');
    await expect(strip(page)).toBeVisible();

    await strip(page).getByRole('button', { name: 'Fix with AI' }).click();
    await expect(
      strip(page).getByText(/No AI provider key is configured/),
    ).toBeVisible();
    // The rest of the strip is unaffected -- the fix is still one click away
    // with no key, no token and no network.
    await expect(
      strip(page).getByRole('button', { name: 'Rename "stpes" to "steps"' }),
    ).toBeEnabled();
  });
});
