import { expect, test, type Page } from '@playwright/test';

import { mockHostApi, POLICY_HARD_FAIL_STUB } from './fixtures';

/**
 * Issue #215, redesigned by #247, against the real built app: the
 * config-policy decision, which has to be readable *beside* validation
 * without ever being confused with it.
 *
 * Every stubbed body here has the shape of a real decision from
 * `POST /api/v2/owner/<uuid>/context/config/decision` -- the wire fields were
 * captured live while establishing that a personal API token can call that
 * endpoint at all (see `internal/circleci/policy_test.go`).
 *
 * The things this spec exists to pin, for #247's redesign:
 *  1. evaluation runs automatically in the background -- there is no button,
 *     and the verdict is a badge beside `Valid`, not a strip;
 *  2. the verdict is its own axis, next to (never merged with) validation;
 *  3. the full rule, its `reason` message and the detail live in the
 *     reference pane's Policies tab (`PolicyRulesView`) -- not a strip, a
 *     modal or an expanding panel in the editor -- and a violation is
 *     located there, or honestly says it could not be;
 *  4. "Fix with AI" treats a violation as a first-class case exactly as a
 *     compile error already is, from that same tab;
 *  5. "could not check" never reads like "no violations".
 */

const policyBadge = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

/**
 * Opens the reference pane, switches it to the Project surface (issue #306:
 * Policies shares a slot with Reference, mutually exclusive -- see
 * `DocsPane.tsx`'s own doc comment) and selects its Policies tab, where every
 * violation's full detail now lives.
 */
async function openPoliciesTab(page: Page) {
  await page.getByRole('button', { name: /expand reference panel/i }).click();
  await page
    .getByRole('group', { name: 'Reference pane view' })
    .getByRole('button', { name: 'Project', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Policies' }).click();
  return page.getByTestId('policy-rules-view');
}

test.describe('a config-policy decision sits beside validation (issue #215/#247)', () => {
  test('checks automatically in the background, with no button to press', async ({
    page,
  }) => {
    const host = await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');

    // Reached with no click at all -- evaluation rides the same debounce as
    // compile validation.
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();
    const checks = host.getPolicyChecks();
    expect(checks.length).toBeGreaterThan(0);

    // There is no "Check policies" button left anywhere -- the owner's whole
    // ask was that this stop being something to go find.
    await expect(
      page.getByRole('button', { name: /check policies/i }),
    ).toHaveCount(0);
  });

  test('an edit is sent -- what left the browser is the text on screen, not the file on disk', async ({
    page,
  }) => {
    const host = await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();
    const before = host.getPolicyChecks().length;

    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n# an edit');

    // The badge demotes to "out of date" the instant the text changes...
    await expect(policyBadge(page, 'Policy check out of date')).toBeVisible();
    // ...and a fresh check follows automatically, without any click.
    await expect
      .poll(() => host.getPolicyChecks().length)
      .toBeGreaterThan(before);
    expect(host.getPolicyChecks().at(-1)).toContain('# an edit');
  });

  test('the badge is beside Valid, not a strip of its own', async ({
    page,
  }) => {
    await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');

    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();
    // #247's whole point: no strip under the editor carries the verdict or
    // the violation detail any more.
    await expect(page.getByTestId('policy-strip')).toHaveCount(0);
  });

  test('the reference pane names the rule, shows the full reason, and locates the violation', async ({
    page,
  }) => {
    await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();

    const policiesTab = await openPoliciesTab(page);
    // The rule, not just the verdict.
    await expect(policiesTab).toContainText('required_jobs_in_workflow');
    // The policy's own reason, in full. `POLICY_HARD_FAIL_STUB` carries both a
    // blocking and a non-blocking violation, so narrow to this one by text.
    const buildViolation = policiesTab
      .getByTestId('policy-violation-reason')
      .filter({ hasText: "Job 'build'" });
    await expect(buildViolation).toContainText(
      "Job 'build' must not run before the security scan",
    );
    await expect(policiesTab).toContainText('Blocking failure');

    // Located, because the reason quoted a job this config really declares --
    // #163's line-resolution machinery, reused unchanged.
    await expect(policiesTab).toContainText(/Location: line \d+/);

    // The graph marks the job the violation named, using the same node
    // marking a compile error gets -- and only that job. This does not
    // require the reference pane to be open: the editor's own line tint and
    // the DAG's node ring are a pointer, not the detail itself.
    const marked = page.locator('.vce-dag-node--diagnostic');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('build');
  });

  test('"Fix with AI" seeds the composer from the rule and its reason, from the reference pane', async ({
    page,
  }) => {
    await mockHostApi(page, {
      aiConfigured: true,
      policy: POLICY_HARD_FAIL_STUB,
    });
    await page.goto('/');
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();

    // `POLICY_HARD_FAIL_STUB` carries two violations, each with its own "Fix
    // with AI" button; click the one for the blocking rule this test is about.
    const policiesTab = await openPoliciesTab(page);
    await policiesTab
      .getByRole('button', { name: 'Fix with AI' })
      .first()
      .click();

    await expect(
      policiesTab.getByText(/including this rule's name and message/i).first(),
    ).toBeVisible();
    const composer = page.getByLabel('Message the AI assistant');
    await expect(composer).toHaveValue(/required_jobs_in_workflow/);
    await expect(composer).toHaveValue(
      /Job 'build' must not run before the security scan/,
    );
  });

  test('a soft fail is neither a pass nor a refusal, and an unplaceable violation says so', async ({
    page,
  }) => {
    const host = await mockHostApi(page);
    host.setPolicyResponse({
      ...POLICY_HARD_FAIL_STUB,
      status: 'SOFT_FAIL',
      hardFailures: [],
    });
    await page.goto('/');

    await expect(policyBadge(page, 'Policy soft fail')).toBeVisible();
    await expect(policyBadge(page, 'Policy pass')).toHaveCount(0);
    await expect(policyBadge(page, 'Policy hard fail')).toHaveCount(0);

    const policiesTab = await openPoliciesTab(page);
    await expect(policiesTab).toContainText('Non-blocking');
    // The only violation is prose about an image, naming no declaration --
    // so there is no line, and this view says exactly that rather than
    // pointing at a plausible one.
    await expect(policiesTab).toContainText('Location unknown');
  });

  test('the policy verdict and the validation verdict stay separate', async ({
    page,
  }) => {
    await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');

    // A config that compiles and hard-fails a policy: the app bar still says
    // Valid, and the policy badge still says hard fail. Neither overrides the
    // other, because they are answers to different questions.
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();
    await expect(
      page.getByText('Valid', { exact: true }).first(),
    ).toBeVisible();
    // And the compile-diagnostics strip is not showing at all: a policy
    // violation is not a compile error.
    await expect(page.getByTestId('diagnostics-strip')).toHaveCount(0);
  });

  test('a verdict goes out of date as soon as the config changes', async ({
    page,
  }) => {
    await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();

    const policiesTab = await openPoliciesTab(page);
    await expect(
      policiesTab.getByTestId('policy-violation-reason').first(),
    ).toBeVisible();

    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('\n# changed');

    await expect(policyBadge(page, 'Policy check out of date')).toBeVisible();
    await expect(policyBadge(page, 'Policy hard fail')).toHaveCount(0);
    // The stale violation is withdrawn rather than left pointing at a line
    // that may have moved.
    await expect(
      policiesTab.getByTestId('policy-violation-reason'),
    ).toHaveCount(0);
  });

  test('"could not check" never reads as "no violations"', async ({ page }) => {
    // No token: the host answers with a reason and no verdict.
    await mockHostApi(page, { hasToken: false });
    await page.goto('/');

    await expect(policyBadge(page, 'Policy: not checked')).toBeVisible();
    await expect(policyBadge(page, 'Policy pass')).toHaveCount(0);
  });

  test('a PASS with no enabled rules is not reported as a pass', async ({
    page,
  }) => {
    const host = await mockHostApi(page);
    host.setPolicyResponse({
      available: true,
      source: 'api',
      status: 'PASS',
      orgSlug: 'gh/example',
      policyContext: 'config',
    });
    await page.goto('/');

    await expect(policyBadge(page, 'No policies to check')).toBeVisible();
    await expect(policyBadge(page, 'Policy pass')).toHaveCount(0);
  });

  test('the reference pane lists the rules that ran, and says so before any have', async ({
    page,
  }) => {
    await mockHostApi(page, { hasToken: false });
    await page.goto('/');

    // The reference pane starts collapsed in every preset (see `presets.ts`).
    await expect(page.getByRole('heading', { name: 'Reference' })).toHaveCount(
      0,
    );
    const policiesTab = await openPoliciesTab(page);
    // Policies now lives on the Project surface (issue #306), which is what
    // the pane's own heading names once switched to.
    await expect(page.getByRole('heading', { name: 'Project' })).toBeVisible();
    await expect(policiesTab).toContainText(
      /does not mean your organization has no policies/i,
    );
    // Read-only, stated in the pane that browses them.
    await expect(policiesTab).toContainText(/policy push/);
    // The full policy source (Rego) is established as unavailable, and this
    // is where that has to be said honestly (#247 items 3/5), rather than
    // building a panel on `policy fetch` that would be empty for almost
    // everyone.
    await expect(policiesTab).toContainText(/organization admin/i);
    await expect(policiesTab).toContainText(/HTTP 403/);
  });

  test('with a token, the reference pane lists the rules the automatic check ran', async ({
    page,
  }) => {
    await mockHostApi(page, { policy: POLICY_HARD_FAIL_STUB });
    await page.goto('/');
    await expect(policyBadge(page, 'Policy hard fail')).toBeVisible();

    const policiesTab = await openPoliciesTab(page);
    await expect(policiesTab).toContainText('use_official_docker_image');
    await expect(policiesTab).toContainText('Did not fire');
  });
});
