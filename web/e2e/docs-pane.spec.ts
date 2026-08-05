import { expect, test, type Page } from '@playwright/test';

import { mockHostApi } from './fixtures';

/**
 * A minimal but real config-schema fixture, in the shape `GET /api/schema`
 * actually returns (a JSON Schema document) -- just enough for
 * `parseCircleciSchema` (`~/lib/schema/circleciSchema.ts`) to populate the
 * "Top-level keys" section via `collectPropertyKeys(raw)`, which only ever
 * reads `raw.properties`. Deliberately not the full fixture used by
 * `~/lib/schema`'s own unit tests (`testFixtures.ts`'s doc comment reserves
 * that file for `~/lib/schema` specifically) -- this is a real browser
 * end-to-end check of the pane wiring, not of `parseCircleciSchema`'s
 * extraction logic, which already has its own unit coverage.
 */
const MINIMAL_SCHEMA = {
  properties: {
    version: { description: 'Config version, e.g. 2.1.' },
    jobs: { markdownDescription: 'Collections of steps run in an executor.' },
    workflows: { description: 'Orchestrates one or more jobs.' },
  },
};

/** `mockHostApi` (`./fixtures`) doesn't stub `GET /api/schema` -- none of
 * this suite's other specs need real schema content, so it falls through
 * to `vite preview`'s 404 and every schema-driven feature (YAML
 * autocompletion, this pane) degrades to "no schema" in those tests, which
 * is what they want. This pane's own specs need the opposite: real content
 * to browse and search. */
async function mockSchema(page: Page, status = 200): Promise<void> {
  await page.route('**/api/schema', async (route) => {
    if (status !== 200) {
      await route.fulfill({ status, body: 'schema unavailable' });
      return;
    }
    await route.fulfill({ json: MINIMAL_SCHEMA });
  });
}

/**
 * The reference pane starts collapsed in every preset (see `presets.ts`: with
 * it open, four panes plus the DAG's palette and inspector squeezed the graph
 * canvas down to the narrowest useful region in its own preset). Every spec
 * below therefore has to open it first -- which is itself worth asserting, so
 * this doubles as a check that the collapsed strip's expand button works.
 */
async function openReference(page: Page): Promise<void> {
  await page.getByRole('button', { name: /expand reference panel/i }).click();
  await expect(page.getByRole('heading', { name: 'Reference' })).toBeVisible();
}

/**
 * Issue #306: Project, Policies and Caches moved out of the Reference pane's
 * own tab strip into a second surface sharing the same `PaneId` slot --
 * mutually exclusive with Reference, switched by the "Reference"/"Project"
 * toggle at the top of the pane, never a `layout/` concern (see
 * `DocsPane.tsx`'s own doc comment for why: no new `PaneId`, no
 * `LAYOUT_SCHEMA_VERSION` bump). Every spec that used to reach one of those
 * three tabs straight from `openReference` now goes through this first.
 */
async function openProjectSurface(page: Page): Promise<void> {
  await page
    .getByRole('group', { name: 'Reference pane view' })
    .getByRole('button', { name: 'Project', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Project' })).toBeVisible();
}

test.describe('Reference pane (issue #83)', () => {
  test('opens from its collapsed strip on the first-run preset, and is browsable', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');

    // graph-focus is DEFAULT_PRESET_ID. The pane is reachable in one click
    // from it without switching preset, which is the point of the sidebar
    // placement; it does not open itself, because that crowded out the graph.
    await openReference(page);
    await expect(page.getByRole('button', { name: 'version' })).toBeVisible();

    await page.getByRole('button', { name: 'version' }).click();
    await expect(page.getByText('Config version, e.g. 2.1.')).toBeVisible();
  });

  test('search filters the list down to matching keys', async ({ page }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');
    await openReference(page);

    await page
      .getByLabel(/search the configuration reference/i)
      .fill('workflows');
    await expect(page.getByRole('button', { name: 'workflows' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'version' })).toHaveCount(0);
  });

  test('starts collapsed and one click expands it without disturbing the other panes', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Columns' }).click();
    await expect(
      page.getByRole('button', { name: /expand reference panel/i }),
    ).toBeVisible();
    // The other three panes are unaffected by the reference pane existing.
    await expect(page.getByRole('heading', { name: 'Config' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'AI Assistant' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();

    await page.getByRole('button', { name: /expand reference panel/i }).click();
    await expect(
      page.getByRole('heading', { name: 'Reference' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'version' })).toBeVisible();
  });

  test('degrades honestly, without crashing the rest of the app, when the schema request fails', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page, 500);
    await page.goto('/');
    // Opened explicitly: the failure has to be visible *in* the pane, not
    // swallowed by it being collapsed.
    await page.getByRole('button', { name: /expand reference panel/i }).click();

    await expect(page.getByText(/reference unavailable/i)).toBeVisible();
    // The rest of the app -- which needs neither a token nor this
    // endpoint -- must still work: the config editor and workflow graph
    // are unaffected by the reference pane's own degraded state.
    await expect(
      page.getByRole('heading', { name: 'Workflow Graph' }),
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'build_test_deploy' }),
    ).toBeVisible();
  });

  test('the two outbound reference links are real links, not fetched automatically', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');
    await openReference(page);

    const link = page.getByRole('link', { name: /configuration reference/i });
    await expect(link).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/',
    );
    await expect(link).toHaveAttribute('target', '_blank');
  });
});

/**
 * The Project tab (issue #248, moved to the Project surface by #306): the
 * project record, its settings, its environment variable names, and the two
 * outbound links -- moved here from the palette's old Project section (issue
 * #105), which this replaces. `e2e/project-context.spec.ts` covers the
 * identity states (not a CircleCI project / unknown to CircleCI / unverified)
 * in depth; this covers the tab itself being reachable and showing the
 * happy-path content.
 */
test.describe('Reference pane Project tab (issue #248, #306)', () => {
  test('shows the project record, settings, environment variable names and both outbound links', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');
    await openReference(page);
    await openProjectSurface(page);

    await page.getByRole('tab', { name: 'Project' }).click();

    // Scoped to the tab's own container throughout: "main" and "example" are
    // common enough words that an unscoped query could pass against
    // something else on the page entirely.
    const tab = page.getByTestId('project-reference-view');

    // The record.
    await expect(tab.getByText('widgets', { exact: true })).toBeVisible();
    await expect(tab.getByText('gh/example/widgets')).toBeVisible();
    await expect(tab.getByText('example', { exact: true })).toBeVisible();
    await expect(tab.getByText('main', { exact: true })).toBeVisible();

    // The two outbound links (the owner's own ask, quoted in issues #226 and
    // #248): built host-side via `WebAppBaseURL`, never assembled here.
    const projectLink = tab.getByRole('link', { name: /open project/i });
    await expect(projectLink).toHaveAttribute(
      'href',
      'https://app.circleci.com/projects/gh/example/widgets',
    );
    await expect(projectLink).toHaveAttribute('target', '_blank');
    const settingsLink = tab.getByRole('link', { name: /open settings/i });
    await expect(settingsLink).toHaveAttribute(
      'href',
      'https://app.circleci.com/settings/project/gh/example/widgets',
    );

    // Settings.
    await expect(
      tab.getByText('Dynamic config', { exact: true }),
    ).toBeVisible();

    // Environment variable *names*, never values -- the same rule restated
    // for a tab that has no reason to show even a truncated preview.
    await expect(tab.getByText('DEPLOY_TARGET')).toBeVisible();
    await expect(tab.getByText('WIDGETS_API_URL')).toBeVisible();
    await expect(
      tab.getByText(/does not return project variable values/i),
    ).toBeVisible();

    // The palette's old Project section is gone, not just hidden -- issue
    // #248 asks for deletion "as part of this, not as a follow-up". The
    // palette is open by default on this preset (`graph-focus`), so
    // "Contexts" is already visible and "Project" is simply absent from it
    // -- not a second control with the same label as this tab.
    await expect(page.getByText('Contexts', { exact: true })).toBeVisible();
    await expect(
      page
        .locator('[data-testid="pane-palette"]')
        .getByRole('button', { name: 'Project', exact: true }),
    ).toHaveCount(0);
  });
});

/**
 * The Caches tab (issue #285, moved to the Project surface by #306): the
 * in-product answer to what this app caches, how fresh each cache is, and
 * what refreshes on its own -- see `CachesView`'s own doc comment for the
 * owner quotes this tab exists to answer.
 */
test.describe('Reference pane Caches tab (issue #285, #306)', () => {
  test('names every cache this app keeps, and explains what the machine-image catalog is fetched from and falls back to', async ({
    page,
  }) => {
    await mockHostApi(page);
    await mockSchema(page);
    await page.goto('/');
    await openReference(page);
    await openProjectSurface(page);

    await page.getByRole('tab', { name: 'Caches' }).click();
    const tab = page.getByTestId('caches-view');

    await expect(
      tab.getByText('Contexts & project settings', { exact: true }),
    ).toBeVisible();
    await expect(tab.getByText('Orb registry', { exact: true })).toBeVisible();
    await expect(
      tab.getByText('Documentation guides', { exact: true }),
    ).toBeVisible();
    await expect(
      tab.getByText('Docker Hub tags (cimg/* images)', { exact: true }),
    ).toBeVisible();
    await expect(
      tab.getByText('Machine images', { exact: true }),
    ).toBeVisible();
    await expect(
      tab.getByText('Usage (for resource-class suggestions)', {
        exact: true,
      }),
    ).toBeVisible();

    // Issue #305: this is now a live, fetched catalog with a manual refresh
    // like every other cache above -- the literal survives only as the
    // offline fallback, not as the reason there is no refresh button.
    await expect(
      tab.getByText(/GET \/api\/v3\/catalog\/offerings/i),
    ).toBeVisible();
  });
});

/**
 * The pane's own width budget, measured rather than assumed (this project's
 * own convention -- see #226, #217, #248, #285). The reference pane's floor
 * (`MIN_PANE_PX.docs`) is 260px and untouched by issue #306: the split moved
 * three tabs to a second, mutually-exclusive surface sharing the same
 * `PaneId` slot rather than adding a pane or growing the tab strip past five,
 * so the floor itself cannot have moved and no `LAYOUT_SCHEMA_VERSION` bump
 * follows (see `DocsPane.tsx`'s own doc comment). What a floor number alone
 * cannot answer is whether the new surface-switch row *plus* whichever
 * surface's own (now shorter, at most three labels) tab strip still fit at
 * that floor without wrapping -- which is what this measures, in a real
 * browser, in both themes, for both surfaces.
 */
test.describe('Reference pane width budget at its 260px floor (issue #306)', () => {
  /** Clamps the pane to its real floor and measures both header rows: the
   * "Reference"/"Project" surface switch (`role=group`) and whichever
   * surface's own tab strip (`role=tablist`) is currently showing. Real
   * Chromium flexbox/text layout does the measuring; only the container's
   * width is forced. */
  async function measure(page: Page) {
    return page.evaluate(() => {
      const paneEl = document.querySelector(
        '[data-testid="pane-docs"]',
      ) as HTMLElement | null;
      if (!paneEl) return null;
      paneEl.style.setProperty('width', '260px', 'important');
      paneEl.style.setProperty('flex', '0 0 260px', 'important');
      paneEl.style.setProperty('max-width', '260px', 'important');

      function rowWidths(el: Element | null) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const items = Array.from(el.querySelectorAll('button')).map(
          (button) => {
            const buttonRect = button.getBoundingClientRect();
            return {
              label: button.textContent,
              top: Math.round(buttonRect.top),
            };
          },
        );
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: Math.round(rect.width),
          tops: items.map((item) => item.top),
          labels: items.map((item) => item.label),
        };
      }

      const surfaceGroup = paneEl.querySelector(
        '[role="group"][aria-label="Reference pane view"]',
      );
      const tablist = paneEl.querySelector('[role="tablist"]');
      return {
        paneWidth: Math.round(paneEl.getBoundingClientRect().width),
        surfaceGroup: rowWidths(surfaceGroup),
        tablist: rowWidths(tablist),
      };
    });
  }

  function expectRowFits(
    row: { scrollWidth: number; clientWidth: number; tops: number[] } | null,
  ) {
    expect(row).not.toBeNull();
    // No horizontal overflow inside the row itself...
    expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth + 1);
    // ...and no wrapping to a second row: every button's top edge is the same.
    expect(new Set(row!.tops).size).toBe(1);
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`the surface switch and the Reference tab strip (Keys, Guides) both fit, in ${theme} mode`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('vce.theme', value);
      }, theme);
      await mockHostApi(page);
      await mockSchema(page);
      await page.goto('/');
      await openReference(page);

      const measurement = await measure(page);
      expect(measurement).not.toBeNull();
      // eslint-disable-next-line no-console -- deliberate: this project
      // measures rather than asserts blind, and the number is the point.
      console.log(
        `[docs-pane width budget, reference, ${theme}] pane=${measurement!.paneWidth}px ` +
          `surfaceGroup=${JSON.stringify(measurement!.surfaceGroup)} ` +
          `tablist=${JSON.stringify(measurement!.tablist)}`,
      );

      expect(measurement!.tablist!.labels).toEqual(['Keys', 'Guides']);
      expectRowFits(measurement!.surfaceGroup);
      expectRowFits(measurement!.tablist);
    });

    test(`the surface switch and the Project tab strip (Project, Policies, Caches) both fit, in ${theme} mode`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('vce.theme', value);
      }, theme);
      await mockHostApi(page);
      await mockSchema(page);
      await page.goto('/');
      await openReference(page);
      await openProjectSurface(page);

      const measurement = await measure(page);
      expect(measurement).not.toBeNull();
      // eslint-disable-next-line no-console -- deliberate: this project
      // measures rather than asserts blind, and the number is the point.
      console.log(
        `[docs-pane width budget, project, ${theme}] pane=${measurement!.paneWidth}px ` +
          `surfaceGroup=${JSON.stringify(measurement!.surfaceGroup)} ` +
          `tablist=${JSON.stringify(measurement!.tablist)}`,
      );

      expect(measurement!.tablist!.labels).toEqual([
        'Project',
        'Policies',
        'Caches',
      ]);
      expectRowFits(measurement!.surfaceGroup);
      expectRowFits(measurement!.tablist);
    });
  }
});
