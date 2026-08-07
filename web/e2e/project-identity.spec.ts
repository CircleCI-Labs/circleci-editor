import { expect, test } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #149's top-bar indicator, and issue #152's context field, driven
 * through the real built app.
 *
 * The unit tests mount both components directly with a stubbed store; neither
 * can prove the indicator is actually wired into the app bar, nor that the
 * inspector's combobox reaches a real saved document. That is what this covers.
 */

test('the top bar names the organization and project, and links to the CircleCI web UI', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  const identity = page.getByTestId('project-identity');
  await expect(identity).toBeVisible();

  // Issue #20: the organization and the project are two independent links,
  // not one label. CircleCI's own organization name, once the lookup lands.
  const orgLink = identity.getByRole('link', { name: 'example' });
  await expect(orgLink).toHaveAttribute(
    'href',
    'https://app.circleci.com/pipelines/gh/example',
  );
  await expect(orgLink).toHaveAttribute('target', '_blank');

  const repoLink = identity.getByRole('link', { name: 'widgets' });
  await expect(repoLink).toHaveAttribute(
    'href',
    'https://app.circleci.com/projects/gh/example/widgets',
  );
  await expect(repoLink).toHaveAttribute('target', '_blank');

  // A confirmed project carries no caveat badge.
  await expect(identity.getByText('Unverified')).toHaveCount(0);
  await expect(identity.getByText('Unknown to CircleCI')).toHaveCount(0);

  // Keyboard-reachable, like every other affordance here.
  await orgLink.focus();
  await expect(orgLink).toBeFocused();
  await repoLink.focus();
  await expect(repoLink).toBeFocused();
});

test('a config outside a CircleCI project says exactly that, not that CircleCI is unreachable', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectSlug: '',
    projectContext: {
      available: false,
      reason:
        'This config is not associated with a CircleCI project, so there is no project whose contexts, environment variables or settings could be listed.',
      contexts: [],
      projectVariables: [],
    },
  });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  await expect(identity).toHaveText('Not a CircleCI project');
  await expect(identity.getByRole('link')).toHaveCount(0);
  await expect(identity.getByText('Unverified')).toHaveCount(0);
});

test('a project CircleCI does not recognise is badged differently from one it could not confirm', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectContext: {
      available: true,
      projectSlug: 'gh/example/widgets',
      contexts: [],
      projectVariables: [],
      warnings: [
        {
          kind: 'project',
          headline: 'No CircleCI project matches gh/example/widgets.',
          detail:
            'The CircleCI API returned HTTP 404 for that project slug. Most often that means this repository has not been set up on CircleCI.',
          consequences: ["This project's settings are not shown."],
        },
      ],
    },
  });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  await expect(identity.getByText('Unknown to CircleCI')).toBeVisible();
  await expect(identity.getByText('Unverified')).toHaveCount(0);
  // The identity is still shown: it remains what this checkout claims to be,
  // as two independently-linked halves (issue #20).
  await expect(identity.getByRole('link', { name: 'example' })).toBeVisible();
  await expect(identity.getByRole('link', { name: 'widgets' })).toBeVisible();
});

/**
 * Issue #20's third item, end to end: a 404'd lookup carrying a near-miss
 * candidate names it in the badge's tooltip -- the reported case, a checkout
 * of `some-org/flakey-widgets` against a CircleCI project actually called
 * `flaky-widgets`.
 */
test('a 404 with a near-miss candidate names it in the badge’s tooltip', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectSlug: 'gh/some-org/flakey-widgets',
    projectContext: {
      available: true,
      projectSlug: 'gh/some-org/flakey-widgets',
      contexts: [],
      projectVariables: [],
      warnings: [
        {
          kind: 'project',
          headline: 'No CircleCI project matches gh/some-org/flakey-widgets.',
          detail:
            'The CircleCI API returned HTTP 404 for that project slug. Most often that means this repository has not been set up on CircleCI.',
          consequences: ["This project's settings are not shown."],
          candidates: ['flaky-widgets'],
        },
      ],
    },
  });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  const badge = identity.getByText('Unknown to CircleCI');
  await expect(badge).toBeVisible();

  await badge.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('some-org/flaky-widgets');
  await expect(tooltip).toContainText('did you mean that one?');
});

/**
 * Issue #182, still true after issue #20: a GitLab *OAuth* project's route was
 * never verified against a live one (unlike a *standalone* project's -- see
 * the test below), so the host sends no `project.webUrl` or
 * `project.organizationWebUrl` for it. `GET /api/meta` still carries the URLs
 * it derived from the injected environment, and the top bar must ignore both:
 * a confident link to a page shaped for a different kind of project is the
 * wrong-path defect the owner reported.
 */
test('a project this host has no verified page for is shown as plain text, not linked from the environment', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectContext: {
      available: true,
      projectSlug: 'gl/example/widgets',
      project: {
        name: 'widgets',
        slug: 'gl/example/widgets',
        organizationName: 'example',
        organizationSlug: 'gl/example',
        vcsProvider: 'GitLab',
        defaultBranch: 'main',
        // No webUrl, no organizationWebUrl: this route's shape has never
        // been checked against a live GitLab OAuth project.
      },
      contexts: [],
      projectVariables: [],
    },
  });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  await expect(identity).toContainText('example/widgets');
  await expect(identity.getByRole('link')).toHaveCount(0);
  // Confirmed, not degraded: there is a project, it is just not linkable.
  await expect(identity.getByText('Unverified')).toHaveCount(0);
  await expect(identity.getByText('Unknown to CircleCI')).toHaveCount(0);
});

/**
 * Issue #20's second item, the positive case: a standalone (GitLab / GitHub
 * App) project's opaque-ID slug now gets both links, because
 * `Environment.ProjectWebURLForSlug` and `Environment.OrgWebURLForSlug` were
 * verified live against a real standalone project and organization (see
 * `overviewRouteVCS` on the host side). Before this issue, a `circleci/...`
 * slug never got a link at all -- this is the test the one above used to be.
 */
test('a standalone project’s ID-addressed slug is linked, both organization and project', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectContext: {
      available: true,
      projectSlug: 'circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
      project: {
        name: 'widgets',
        slug: 'circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
        organizationName: 'example',
        organizationSlug: 'circleci/PBz3EbdyZmZ4jNfLQCdXhs',
        vcsProvider: 'GitLab',
        defaultBranch: 'main',
        webUrl:
          'https://app.circleci.com/projects/circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
        organizationWebUrl:
          'https://app.circleci.com/pipelines/circleci/PBz3EbdyZmZ4jNfLQCdXhs',
      },
      contexts: [],
      projectVariables: [],
    },
  });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  await expect(identity.getByRole('link', { name: 'example' })).toHaveAttribute(
    'href',
    'https://app.circleci.com/pipelines/circleci/PBz3EbdyZmZ4jNfLQCdXhs',
  );
  await expect(identity.getByRole('link', { name: 'widgets' })).toHaveAttribute(
    'href',
    'https://app.circleci.com/projects/circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF',
  );
  await expect(identity.getByText('Unverified')).toHaveCount(0);
  await expect(identity.getByText('Unknown to CircleCI')).toHaveCount(0);
});

test('with no token the project is shown but marked unverified', async ({
  page,
}) => {
  await mockHostApi(page, { hasToken: false });
  await page.goto('/');

  const identity = page.getByTestId('project-identity');
  await expect(identity.getByText('Unverified')).toBeVisible();
  await expect(identity.getByRole('link', { name: 'example' })).toBeVisible();
  await expect(identity.getByRole('link', { name: 'widgets' })).toBeVisible();
  await expect(identity.getByText('Not a CircleCI project')).toHaveCount(0);
});

/**
 * Issue #152, end to end: the combobox on the inspector's `context:` field
 * offers the organization's real contexts, still accepts a free-typed name, and
 * writes a surgical edit -- the fixture's comment must survive, since a
 * whole-list rewrite is exactly what this replaced.
 */
test('the inspector’s context field offers the real list, accepts free text, and saves a minimal edit', async ({
  page,
}) => {
  const hostApi = await mockHostApi(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  await page.locator('[data-testid="rf__node-build"] .vce-dag-node').click();

  // Issue #219: the Context section is collapsible, and since this fixture's
  // `build` entry has no `context:` yet the content rule starts it closed -- so
  // this test opens it first. That extra click is the trade #219 makes
  // deliberately (one click to reach a section holding nothing), and it is
  // exactly why the rule is paired with a count on the summary row of any
  // section that *does* hold something: a section's existence is never hidden,
  // only its contents, and never its contents without a signal.
  await expect(
    page.getByRole('heading', { name: 'Context', exact: true }),
  ).toBeVisible();
  await page.getByRole('heading', { name: 'Context', exact: true }).click();

  const field = page.getByRole('combobox', { name: 'Contexts' });
  await expect(field).toBeVisible();
  // The field says how much it knows, so an empty suggestion list is never
  // mistaken for "this organization has no contexts".
  await expect(
    page.getByText(/2 contexts found in this organization/i),
  ).toBeVisible();

  // Type-to-filter over the fetched list, chosen with the keyboard alone.
  await field.fill('depl');
  const listbox = page.getByRole('listbox', {
    name: 'Contexts in this organization',
  });
  await expect(
    listbox.getByRole('option', { name: 'deploy-prod' }),
  ).toBeVisible();
  await expect(
    listbox.getByRole('option', { name: 'build-secrets' }),
  ).toHaveCount(0);
  await field.press('ArrowDown');
  await field.press('Enter');

  // Free text is still possible: a context that does not exist yet.
  await field.fill('not-created-yet');
  await field.press('Enter');

  // The name we invented is flagged as unrecognised -- not as wrong.
  await expect(
    page.getByLabel(
      'not-created-yet was not found in the fetched context list',
    ),
  ).toBeVisible();

  const saveButton = page.getByRole('button', {
    name: 'Review and save config',
  });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => hostApi.getSaveCount()).toBeGreaterThan(0);

  const saved = hostApi.getSavedConfig();
  expect(saved).not.toBeNull();
  expect(saved).toContain('deploy-prod');
  expect(saved).toContain('not-created-yet');
  // The whole point of a surgical mutation: nothing else moved.
  expect(saved).toContain(
    '# Managed by the platform team -- do not edit by hand.',
  );
  expect(saved).toContain('- run: pnpm install');
});

/**
 * Issue #214's two additions to the same group, driven through the real built
 * app: the branch, and the link to the repository on its VCS host.
 *
 * Wide enough for the two-cell form -- `CheckoutIdentity` folds them into one
 * link at the `tight` tier, which the sibling test below covers.
 */
test('the top bar shows the checkout’s branch and links to the repository', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await mockHostApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  const checkout = page.getByTestId('checkout-identity');
  await expect(checkout.getByTestId('checkout-branch')).toHaveText('main');

  const repo = checkout.getByTestId('checkout-repo-link');
  await expect(repo).toHaveText('GitHub');
  await expect(repo).toHaveAttribute(
    'href',
    'https://github.com/example/widgets',
  );
  await expect(repo).toHaveAttribute('target', '_blank');
  await expect(repo).toHaveAttribute('rel', 'noreferrer noopener');

  // Keyboard-reachable, and the branch cell is focusable so its tooltip (which
  // is where "checkout HEAD, not CIRCLE_BRANCH" is explained) can be read
  // without a pointer.
  await checkout.getByTestId('checkout-branch').focus();
  await expect(checkout.getByTestId('checkout-branch')).toBeFocused();
  await repo.focus();
  await expect(repo).toBeFocused();
});

/**
 * The `tight` demotion. Two cells cost 81px of app-bar furniture, which at the
 * tersest tier was enough to collapse the file switcher for an ordinary
 * two-file directory -- so they fold into one 26px link there. What must not
 * change is that the repository stays reachable.
 */
test('the branch and repository fold into one link at the tightest tier, still reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await mockHostApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await expect(page.locator('header').first()).toHaveAttribute(
    'data-app-bar-tier',
    'tight',
  );

  const folded = page.getByTestId('checkout-branch-link');
  await expect(folded).toHaveText('main');
  await expect(folded).toHaveAttribute(
    'href',
    'https://github.com/example/widgets',
  );
  await expect(page.getByTestId('checkout-repo-link')).toHaveCount(0);
});

/** Editing a config outside a checkout is ordinary: nothing renders, and the
 * app bar costs nothing extra. */
test('a config outside a git checkout shows no branch and no repository link', async ({
  page,
}) => {
  await mockHostApi(page, { git: {} });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  await expect(page.getByTestId('checkout-identity')).toHaveCount(0);
});

/**
 * Issue #214's third item, and the reason it is an observed-failure notice
 * rather than a status poll: it says nothing at all until one of this app's own
 * CircleCI calls has been seen to fail, so it costs the measured app-bar
 * furniture budget nothing in the healthy case.
 */
test('the top bar says nothing about CircleCI’s health until a call actually fails', async ({
  page,
}) => {
  await mockHostApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await expect(page.getByRole('banner').getByText('Valid')).toBeVisible();

  // Silence, and deliberately not an implied "up".
  await expect(page.getByTestId('circleci-reachability')).toHaveCount(0);
  await expect(page.getByRole('banner')).not.toContainText('CircleCI');
});

test('a project lookup this app watched fail surfaces as "CircleCI unreachable", linked to the status page', async ({
  page,
}) => {
  await mockHostApi(page, {
    projectContext: {
      available: false,
      reason: 'network error talking to the CircleCI API',
      contexts: [],
      projectVariables: [],
    },
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();

  const notice = page.getByTestId('circleci-reachability');
  await expect(notice).toHaveText('CircleCI unreachable');
  // Linked, never fetched -- the whole difference between this and a poll.
  await expect(notice).toHaveAttribute('href', 'https://status.circleci.com');
  await expect(notice).toHaveAttribute('target', '_blank');
});
