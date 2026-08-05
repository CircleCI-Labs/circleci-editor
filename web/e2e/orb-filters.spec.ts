import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * Issue #151's registry-style orb filters, driven through the real built app.
 *
 * The unit tests mount `OrbBrowser` directly; they cannot show that the filter
 * reaches the host as a query parameter through the real `searchOrbs` client,
 * that the control is genuinely keyboard-operable in a browser, or that the
 * chips survive the palette's own `<details>` section being opened. That is
 * what this covers.
 *
 * Note what is deliberately *not* here: a Partner filter. The orb registry's
 * own control is a single dropdown (All / "Certified & Partner" / Popular)
 * served by the developer hub's Algolia index, and no CircleCI API this host
 * can call exposes partner status at all -- see `internal/orbs.Filter` for
 * exactly what was probed. The host rejects an unrecognised filter with a 400
 * rather than quietly answering an unfiltered search, so there is nothing to
 * approximate here.
 */

interface OrbStub {
  name: string;
  certified: boolean;
  private: boolean;
}

const ORBS: OrbStub[] = [
  { name: 'circleci/node', certified: true, private: false },
  { name: 'circleci/slack', certified: true, private: false },
  { name: 'acme/node-helpers', certified: false, private: false },
  { name: 'widgets-inc/node-internal', certified: false, private: true },
];

/**
 * Answers `GET /api/orbs/search` the way the Go host does: filtering and
 * counting server-side (see `internal/orbs.SearchFiltered`), so the counts the
 * UI renders are derived from the same relationship real ones are rather than
 * hand-written per case.
 *
 * `hasToken: false` reproduces the host's own no-token crawl (issue #160):
 * search itself still answers `available: true` -- the public registry
 * answers unauthenticated -- but an unauthenticated crawl never sees a
 * private namespace, so the private orb is simply absent from the set this
 * mock searches, exactly as it would be absent from a real anonymous crawl's
 * result. That absence is what this spec's last test exercises.
 */
async function mockOrbSearch(
  page: Page,
  { hasToken = true }: { hasToken?: boolean } = {},
): Promise<void> {
  await page.route('**/api/orbs/search**', async (route) => {
    const visibleOrbs = hasToken ? ORBS : ORBS.filter((orb) => !orb.private);

    const params = new URL(route.request().url()).searchParams;
    const q = (params.get('q') ?? '').toLowerCase();
    const filter = params.get('filter') ?? 'all';

    const inScope = (orb: OrbStub) =>
      filter === 'certified'
        ? orb.certified
        : filter === 'private'
          ? orb.private
          : true;
    // An empty query is the browse case; the host answers it with the
    // certified set for "all" and with the whole scope otherwise.
    const matches = (orb: OrbStub) =>
      q === ''
        ? filter === 'all'
          ? orb.certified
          : true
        : orb.name.includes(q);

    const scoped = visibleOrbs.filter((orb) => inScope(orb) && matches(orb));
    const unfiltered = visibleOrbs.filter(matches);

    await route.fulfill({
      json: {
        available: true,
        status: {
          ready: true,
          complete: true,
          count: visibleOrbs.length,
          warming: false,
          certifiedCount: visibleOrbs.filter((orb) => orb.certified).length,
          privateCount: visibleOrbs.filter((orb) => orb.private).length,
        },
        match: {
          filter,
          matched: scoped.length,
          matchedUnfiltered: unfiltered.length,
          scopeSize: visibleOrbs.filter(inScope).length,
        },
        results: scoped.map((orb) => ({
          name: orb.name,
          private: orb.private,
          certified: orb.certified,
          listed: true,
          latestVersion: '1.0.0',
          versions: ['1.0.0'],
          matchedOn: 'substring',
        })),
      },
    });
  });
}

/**
 * Opens the palette's Orbs section, which is closed by default (see
 * `Palette`).
 *
 * Targets the `<summary>` specifically rather than "the text `Orbs`": the
 * browser panel inside the section has its own `Orbs` heading, so a plain text
 * locator matches two elements and clicking the wrong one silently does
 * nothing.
 */
async function openOrbsSection(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Workflow Graph' }),
  ).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Orbs' }).click();
  await expect(page.getByLabel('Search orbs')).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: /filter orbs/i }),
  ).toBeVisible();
}

/**
 * Clicks one filter chip the way a user does -- on the visible chip, which is
 * the `<label>`'s own content. Scoped to the radiogroup because "Certified" and
 * "Private" are also result-row badge labels.
 */
async function selectFilter(page: Page, label: string): Promise<void> {
  await page
    .getByRole('radiogroup', { name: /filter orbs/i })
    .getByText(label, { exact: true })
    .click();
  await expect(page.getByRole('radio', { name: label })).toBeChecked();
}

test('filtering to certified scopes the results, says what it hid, and survives a query change', async ({
  page,
}) => {
  await mockHostApi(page);
  await mockOrbSearch(page);
  await page.goto('/');
  await openOrbsSection(page);

  const search = page.getByLabel('Search orbs');
  await search.fill('node');
  await expect(
    page.getByRole('button', { name: 'acme/node-helpers' }),
  ).toBeVisible();

  await selectFilter(page, 'Certified');

  // Scoped: the community and private "node" orbs are gone...
  await expect(
    page.getByRole('button', { name: 'circleci/node' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'acme/node-helpers' }),
  ).toHaveCount(0);
  // ...and the list says the filter is why, rather than leaving the user to
  // conclude those orbs do not exist.
  await expect(page.getByText(/1 certified orb/)).toBeVisible();
  await expect(page.getByText(/2 hidden by this filter/)).toBeVisible();

  // The filter must survive typing a different query (issue #151).
  await search.fill('slack');
  await expect(
    page.getByRole('button', { name: 'circleci/slack' }),
  ).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Certified' })).toBeChecked();

  // "Show all" is the way back out, in the same line that reported the loss.
  await search.fill('node');
  await page.getByRole('button', { name: /show all/i }).click();
  await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'acme/node-helpers' }),
  ).toBeVisible();
});

test('the private toggle finds private orbs, and is reachable by keyboard alone', async ({
  page,
}) => {
  await mockHostApi(page);
  await mockOrbSearch(page);
  await page.goto('/');
  await openOrbsSection(page);

  // Keyboard only: focus the group's current option, then arrow to Private.
  // Native radios give this for free, which is why the control is built from
  // them (see `OrbFilterBar`).
  await page.getByRole('radio', { name: 'All' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Certified' })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Private' })).toBeChecked();

  await expect(
    page.getByRole('button', { name: 'widgets-inc/node-internal' }),
  ).toBeVisible();
  // The public orbs are out of scope now.
  await expect(page.getByRole('button', { name: 'circleci/node' })).toHaveCount(
    0,
  );
});

// Issue #160: orb search itself no longer needs a token -- the public
// registry answers unauthenticated -- so a no-token host reaches the exact
// same Private-filter UI a token-present host does; what a missing token
// changes is specifically that this host cannot see *any* private
// namespace, which is a stronger, more certain statement than "your token
// found none" and gets its own distinct wording.
test('with no CircleCI token, the private filter explains itself instead of showing an empty list', async ({
  page,
}) => {
  await mockHostApi(page, { hasToken: false });
  await mockOrbSearch(page, { hasToken: false });
  await page.goto('/');
  await openOrbsSection(page);

  await selectFilter(page, 'Private');

  await expect(
    page.getByText(/no private orbs can be shown.*no circleci api token/i),
  ).toBeVisible();
  // The load-bearing sentence: an empty list here must never read as "you
  // have no private orbs".
  await expect(
    page.getByText(
      /not a report that your organizations have no private orbs/i,
    ),
  ).toBeVisible();
  // And never the wording used when a token *did* look and found nothing.
  await expect(
    page.getByText(/not the same as your organizations having none/i),
  ).toHaveCount(0);
  await expect(page.getByText(/No orbs matched/i)).toHaveCount(0);
});
