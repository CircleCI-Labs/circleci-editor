import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Guide, GuidesResponse } from '~/lib/guides/types';
import type { CircleciSchema } from '~/lib/schema/circleciSchema';

// Both data sources are mocked at the *hook* level, not via a `fetch` stub:
// `DocsPane` only cares about the parsed shapes the hooks hand back, never
// about the RPC layer underneath them (that's each hook's and
// `~/lib/rpc/client`'s own test responsibility). Also keeps this file from
// importing `~/lib/schema/testFixtures`, which its own doc comment reserves
// for `~/lib/schema`'s tests specifically.
const mockUseCircleciSchema = vi.fn<() => CircleciSchema | null>();
vi.mock('~/lib/schema/useCircleciSchema', () => ({
  useCircleciSchema: () => mockUseCircleciSchema(),
}));

const mockUseGuides = vi.fn<() => GuidesResponse | undefined>();
// Issue #285: `useGuides` now returns `{ response, refresh }` rather than
// the bare response, but every existing test here only cares about the
// response half -- so that half keeps its original mock (`mockUseGuides`,
// unchanged below) and only the wrapping shape changes, here, in one place.
const mockRefreshGuides = vi.fn<() => void>();
vi.mock('~/lib/guides/useGuides', () => ({
  useGuides: () => ({ response: mockUseGuides(), refresh: mockRefreshGuides }),
}));

import { DocsPane } from './DocsPane';

/**
 * A schema fixture that reproduces the exact defect issue #104 was opened
 * about: `display` and `examples` are real top-level keys in the official
 * schema with **no description**, so the pane used to render them as bare,
 * unexplained words. `job-groups` is the control -- also undescribed by the
 * schema, but genuinely documented in the configuration reference, so it must
 * *not* be reclassified.
 */
const SAMPLE_SCHEMA: CircleciSchema = {
  topLevelKeys: [
    { label: 'version', info: 'Config version.' },
    { label: 'jobs' },
    { label: 'job-groups' },
    { label: 'display' },
    { label: 'examples' },
  ],
  jobKeys: [{ label: 'docker' }],
  executorKeys: [],
  workflowKeys: [],
  workflowJobEntryKeys: [],
  stepNames: [{ label: 'run', info: 'Run a command.' }],
  resourceClassValues: [],
  jobTypeValues: [],
  pipelineParameterTypeValues: [],
  elementParameterTypeValues: [],
  dockerImageKeys: [],
  stepFieldSchemas: {
    run: [{ name: 'command', type: 'string', required: true }],
  },
};

const EMPTY_SCHEMA: CircleciSchema = {
  topLevelKeys: [],
  jobKeys: [],
  executorKeys: [],
  workflowKeys: [],
  workflowJobEntryKeys: [],
  stepNames: [],
  resourceClassValues: [],
  jobTypeValues: [],
  pipelineParameterTypeValues: [],
  elementParameterTypeValues: [],
  dockerImageKeys: [],
  stepFieldSchemas: {},
};

/** A guide fixture in the shape `internal/guides` actually produces. */
const CONFIG_REFERENCE: Guide = {
  id: 'configuration-reference',
  origin: 'circleci',
  category: 'Configuration reference',
  title: 'Configuration reference',
  description: 'Reference for .circleci/config.yml',
  url: 'https://circleci.com/docs/reference/configuration-reference/',
  lead: [
    {
      kind: 'paragraph',
      spans: [{ kind: 'text', text: 'This document is a reference.' }],
    },
  ],
  anchors: { jobs: 'jobs', 'job-groups': 'job-groups' },
  sections: [
    {
      id: 'jobs',
      level: 2,
      title: 'jobs',
      titleSpans: [{ kind: 'code', text: 'jobs' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#jobs',
      keys: ['jobs'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'A job is a collection of steps.' }],
        },
        { kind: 'code', language: 'yaml', text: 'jobs:\n  build:\n' },
      ],
    },
    {
      id: 'job-groups',
      level: 2,
      title: 'job-groups',
      titleSpans: [{ kind: 'code', text: 'job-groups' }],
      url: 'https://circleci.com/docs/reference/configuration-reference/#job-groups',
      keys: ['job-groups'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            {
              kind: 'text',
              text: 'Group jobs so they can be managed together.',
            },
          ],
        },
      ],
    },
  ],
};

const DYNAMIC_CONFIG: Guide = {
  id: 'dynamic-config',
  origin: 'circleci',
  category: 'Dynamic config',
  title: 'Dynamic config overview',
  url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
  anchors: { quickstart: 'quickstart' },
  sections: [
    {
      id: 'quickstart',
      level: 2,
      title: 'Quickstart',
      titleSpans: [{ kind: 'text', text: 'Quickstart' }],
      url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/#quickstart',
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Set setup: true at the top.' }],
        },
      ],
    },
  ],
};

/**
 * A fixture for this project's *own* documentation about the editor (issue
 * #176): `origin: 'editor'`, and a URL in this repository rather than on
 * circleci.com, because no such circleci.com page exists.
 */
const EDITOR_DOC: Guide = {
  id: 'using-this-editor',
  origin: 'editor',
  category: 'This editor',
  title: 'Using this editor',
  url: 'https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor/using-this-editor.adoc',
  anchors: { 'the-panes': 'the-panes' },
  sections: [
    {
      id: 'the-panes',
      level: 2,
      title: 'The panes',
      titleSpans: [{ kind: 'text', text: 'The panes' }],
      url: 'https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor/using-this-editor.adoc#the-panes',
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Five panes, each movable.' }],
        },
      ],
    },
  ],
};

function guidesResponse(
  overrides: Partial<GuidesResponse> = {},
): GuidesResponse {
  return {
    available: true,
    guides: [CONFIG_REFERENCE, DYNAMIC_CONFIG],
    provenance: {
      repo: 'circleci/circleci-docs',
      ref: 'main',
      commit: 'abc1234def5678901234567890123456789abcde',
      committedAt: '2026-07-28T20:35:15Z',
      fetchedAt: '2026-07-29T00:00:00Z',
      source: 'vendored',
      refreshing: false,
    },
    links: [
      {
        id: 'configuration-reference',
        label: 'Configuration reference',
        url: 'https://circleci.com/docs/reference/configuration-reference/',
      },
      {
        id: 'reusing-config',
        label: 'Reusable config',
        url: 'https://circleci.com/docs/reference/reusing-config/',
      },
      {
        id: 'dynamic-config',
        label: 'Dynamic config',
        url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
      },
    ],
    ...overrides,
  };
}

function openGuidesTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Guides' }));
}

describe('DocsPane — the Keys view (issue #83)', () => {
  beforeEach(() => {
    mockUseCircleciSchema.mockReset();
    mockUseGuides.mockReset();
    mockUseGuides.mockReturnValue(guidesResponse());
  });

  it('shows a loading spinner while the schema is still resolving', () => {
    mockUseCircleciSchema.mockReturnValue(null);
    render(<DocsPane />);
    expect(
      screen.getByRole('status', { name: /loading reference/i }),
    ).toBeInTheDocument();
  });

  // `useCircleciSchema` never rejects -- a failed `/api/schema` fetch
  // resolves to the all-empty schema (see its own doc comment) -- so this
  // is the only way DocsPane can observe that failure, and it must say so
  // honestly rather than silently rendering "no matches" for every search.
  it('shows an honest "unavailable" state rather than a silently empty search when the schema resolved empty', () => {
    mockUseCircleciSchema.mockReturnValue(EMPTY_SCHEMA);
    render(<DocsPane />);
    expect(screen.getByText(/reference unavailable/i)).toBeInTheDocument();
  });

  it('lists entries grouped by section once the schema is loaded', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    expect(screen.getByText('Top-level keys')).toBeInTheDocument();
    expect(screen.getByText('Steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run' })).toBeInTheDocument();
  });

  it("selecting an entry shows the schema's own description in the detail pane", () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    fireEvent.click(screen.getByRole('button', { name: 'version' }));
    expect(screen.getByText('Config version.')).toBeInTheDocument();
  });

  it('selecting a step shows its field table -- the same StepFieldSchema data the inspector edits against', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    expect(screen.getByText('command')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument(); // required
  });

  it('typing in the search box filters the list down to matches by label', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    fireEvent.change(
      screen.getByLabelText(/search the configuration reference/i),
      { target: { value: 'run' } },
    );

    expect(screen.getByRole('button', { name: 'run' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'version' }),
    ).not.toBeInTheDocument();
  });

  it('clearing the search box restores every section', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    const search = screen.getByLabelText(/search the configuration reference/i);
    fireEvent.change(search, { target: { value: 'run' } });
    fireEvent.change(search, { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run' })).toBeInTheDocument();
  });

  it('renders the verified outbound links as real links opening in a new tab', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    const configRef = screen.getByRole('link', {
      name: /configuration reference/i,
    });
    expect(configRef).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/configuration-reference/',
    );
    expect(configRef).toHaveAttribute('target', '_blank');
    expect(configRef).toHaveAttribute('rel', 'noreferrer');

    const reusable = screen.getByRole('link', { name: /reusable config/i });
    expect(reusable).toHaveAttribute(
      'href',
      'https://circleci.com/docs/reference/reusing-config/',
    );
  });

  it('is keyboard reachable: the search box has an associated label and every entry is a real, focusable button', () => {
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    render(<DocsPane />);

    expect(
      screen.getByLabelText(/search the configuration reference/i),
    ).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('tabindex', '-1');
    }
  });
});

describe('DocsPane — composing the schema with the prose guides (issue #104)', () => {
  beforeEach(() => {
    mockUseCircleciSchema.mockReset();
    mockUseGuides.mockReset();
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
    mockUseGuides.mockReturnValue(guidesResponse());
  });

  // The exact defect the issue was opened about: "there's some things that
  // just don't make sense in the reference... like `display`. I don't ever see
  // that key; it doesn't even have a description."
  it('sections orb-authoring-only keys separately and explains what they are', () => {
    render(<DocsPane />);

    expect(screen.getByText('Orb authoring only')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'display' }));
    expect(screen.getByText(/an orb-authoring key/i)).toBeInTheDocument();
    expect(
      screen.getByText(/carries metadata for a published orb/i),
    ).toBeInTheDocument();
  });

  // The control for the test above. `job-groups` has no schema description
  // either, so a naive "no description means orb-only" rule would misclassify
  // it -- the classification has to consult the guides, not just the schema.
  it('does not reclassify an undescribed key that the configuration reference does document', () => {
    render(<DocsPane />);

    const topLevelButtons = screen
      .getByText('Top-level keys')
      .parentElement!.querySelectorAll('button');
    const labels = [...topLevelButtons].map((button) => button.textContent);
    expect(labels).toContain('job-groups');
    expect(labels).not.toContain('display');

    // ...and it borrows the guide's prose in place of the description the
    // schema doesn't have.
    fireEvent.click(screen.getByRole('button', { name: 'job-groups' }));
    expect(
      screen.getAllByText('Group jobs so they can be managed together.').length,
    ).toBeGreaterThan(0);
  });

  it("offers a key's matching guide section, and opening it switches to the Guides view at that section", () => {
    render(<DocsPane />);

    fireEvent.click(screen.getByRole('button', { name: 'jobs' }));
    expect(
      screen.getByText(/from the configuration reference/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /read the full "jobs" section/i }),
    );

    // Now in the Guides view, showing that section's own content -- including
    // its code sample verbatim.
    expect(screen.getByRole('tab', { name: 'Guides' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByText('A job is a collection of steps.'),
    ).toBeInTheDocument();
    // Verbatim, byte-for-byte -- checked against the whole `<pre>`'s text
    // rather than via `getByText`, because issue #291's syntax highlighting
    // splits this same text across several `<span>`s now.
    expect(
      screen.getByTestId('guide-content').querySelector('pre')?.textContent,
    ).toBe('jobs:\n  build:\n');
  });

  it('leaves the Keys view exactly as it was when the guides are unavailable', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        available: false,
        reason: 'the built-in guides could not be parsed',
        guides: undefined,
      }),
    );
    render(<DocsPane />);

    // Nothing is reclassified without evidence: `display` stays an ordinary
    // top-level key rather than being labelled on a guess.
    expect(screen.queryByText('Orb authoring only')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'display' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'display' }));
    expect(
      screen.getByText(/neither the schema nor the configuration reference/i),
    ).toBeInTheDocument();
  });
});

describe('DocsPane — the Guides view (issue #104)', () => {
  beforeEach(() => {
    mockUseCircleciSchema.mockReset();
    mockUseGuides.mockReset();
    mockUseCircleciSchema.mockReturnValue(SAMPLE_SCHEMA);
  });

  it('lists all three guides and browses a selected section', () => {
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    // The guide's own overview is shown before anything is selected -- never a
    // blank reading column.
    expect(
      screen.getByText('This document is a reference.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'job-groups' }));
    expect(
      screen.getByText('Group jobs so they can be managed together.'),
    ).toBeInTheDocument();
  });

  // The picker is a grouped <select>, not a row of buttons. That is deliberate
  // (issue #176): twenty-two guides in a wrapping button row is taller than the
  // content it introduces, and a scrollable rail would have added the second
  // scroll region issue #88 records users objecting to. A <select> is
  // constant height at any page count and needs no custom keyboard handling.
  it('switching guides through the picker shows the other page', () => {
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    fireEvent.change(screen.getByLabelText(/choose a guide/i), {
      target: { value: 'dynamic-config' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Quickstart' }));
    expect(screen.getByText('Set setup: true at the top.')).toBeInTheDocument();
  });

  it('groups the picker by category and adds no new scroll region', () => {
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    const select = screen.getByLabelText(/choose a guide/i);
    const groups = Array.from(select.querySelectorAll('optgroup')).map(
      (group) => group.getAttribute('label'),
    );
    expect(groups).toEqual(['Configuration reference', 'Dynamic config']);

    // Exactly two scrollable regions in the Guides view, the two that were
    // there before: the section nav and the reading column. The picker must not
    // have become a third.
    const scrollers = document.querySelectorAll(
      '[data-testid="guide-nav"], [data-testid="guide-content"]',
    );
    expect(scrollers).toHaveLength(2);
    expect(select.className).not.toMatch(/overflow/);
  });

  // Two of the pages in this picker are this project's own writing about this
  // editor, not CircleCI's. A reader must never have to guess which, so the
  // badge, the footer and the outbound link all change with the origin.
  it("marks this project's own pages as being about the editor, not CircleCI", () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({ guides: [CONFIG_REFERENCE, EDITOR_DOC] }),
    );
    render(<DocsPane />);
    openGuidesTab();

    // CircleCI's page: their attribution in the pane header, and a way out to
    // circleci.com.
    expect(screen.getByText('CircleCI docs · offline')).toBeInTheDocument();
    expect(
      screen.getByText(
        'circleci/circleci-docs@main · abc1234 · pinned 2026-07-28',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /read on circleci\.com/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/choose a guide/i), {
      target: { value: 'using-this-editor' },
    });

    // Ours: the header badge changes rather than continuing to say CircleCI
    // wrote it, and the upstream commit is *not* reported over it -- that
    // provenance describes CircleCI's bytes and says nothing about these.
    expect(
      screen.queryByText('CircleCI docs · offline'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('About this editor')).toBeInTheDocument();
    expect(
      screen.getByText('About this editor · ships with this build'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('circleci/circleci-docs@abc1234 (2026-07-28)'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /read on circleci\.com/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /view the source of this page/i }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('github.com/CircleCI-Labs/circleci-editor'),
    );
  });

  // A refresh failure is about the *vendored* pages. Reporting it while our own
  // page is on screen would blame CircleCI's network for text that is never
  // fetched.
  it('does not report refresh state over a page that is never refreshed', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        guides: [EDITOR_DOC],
        provenance: {
          repo: 'circleci/circleci-docs',
          commit: 'abc1234def5678901234567890123456789abcde',
          committedAt: '2026-07-28T20:35:15Z',
          fetchedAt: '2026-07-29T00:00:00Z',
          source: 'vendored',
          refreshing: true,
          error: 'fetch guides: connection refused',
        },
      }),
    );
    render(<DocsPane />);
    openGuidesTab();

    expect(screen.queryByText('Checking for updates')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Last update check failed'),
    ).not.toBeInTheDocument();
  });

  it('searches across every guide, not only the selected one', () => {
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    fireEvent.change(
      screen.getByLabelText(/search the documentation guides/i),
      { target: { value: 'setup: true' } },
    );

    // A hit in the *dynamic config* guide while the configuration reference is
    // the selected one.
    const hit = screen.getByRole('button', { name: /Quickstart/ });
    expect(hit).toBeInTheDocument();
    fireEvent.click(hit);
    expect(screen.getByText('Set setup: true at the top.')).toBeInTheDocument();
  });

  it('states where the text came from, which ref it was pinned from, and how old it is', () => {
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    // Repo, upstream ref, short commit and the upstream commit's own date --
    // so a reader can always date the content they are reading and know which
    // moving target it was pinned from (issue #286).
    expect(
      screen.getByText(
        /circleci\/circleci-docs@main · abc1234 · pinned 2026-07-28/,
      ),
    ).toBeInTheDocument();

    // A link to the actual commit, so the SHA is clickable, not decorative.
    expect(screen.getByRole('link', { name: /view commit/i })).toHaveAttribute(
      'href',
      'https://github.com/circleci/circleci-docs/commit/abc1234def5678901234567890123456789abcde',
    );

    // Never implies freshness this pane cannot verify (issue #286): "pinned"
    // and a date are honest, "latest"/"current" would not be.
    expect(screen.queryByText(/latest/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bcurrent\b/i)).not.toBeInTheDocument();
  });

  it('reports an in-flight update check without ever looking like a loading state', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        provenance: { ...guidesResponse().provenance, refreshing: true },
      }),
    );
    render(<DocsPane />);
    openGuidesTab();

    expect(screen.getByText(/checking for updates/i)).toBeInTheDocument();
    // ...and the content is right there regardless.
    expect(
      screen.getByText('This document is a reference.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: /loading guides/i }),
    ).not.toBeInTheDocument();
  });

  // Issue #285: the manual "check now" refresh button in the guide footer.
  it("the footer Refresh button calls the hook's refresh", () => {
    mockRefreshGuides.mockReset();
    mockUseGuides.mockReturnValue(guidesResponse());
    render(<DocsPane />);
    openGuidesTab();

    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(mockRefreshGuides).toHaveBeenCalledTimes(1);
  });

  it('the footer Refresh button is disabled while a check is already in flight', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        provenance: { ...guidesResponse().provenance, refreshing: true },
      }),
    );
    render(<DocsPane />);
    openGuidesTab();

    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
  });

  it('reports a failed update check while still showing the cached copy', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        provenance: {
          ...guidesResponse().provenance,
          error: 'fetch guides: no such host',
        },
      }),
    );
    render(<DocsPane />);
    openGuidesTab();

    expect(screen.getByText(/last update check failed/i)).toBeInTheDocument();
    expect(
      screen.getByText('This document is a reference.'),
    ).toBeInTheDocument();
  });

  it('shows a spinner only while the one fetch is genuinely in flight', () => {
    mockUseGuides.mockReturnValue(undefined);
    render(<DocsPane />);
    openGuidesTab();

    expect(
      screen.getByRole('status', { name: /loading guides/i }),
    ).toBeInTheDocument();
  });

  // The project-wide "degrade honestly" invariant: never a blank pane, never a
  // spinner forever. An explanation plus a way to read the real thing.
  it('explains itself and links out when the host could not supply the guides', () => {
    mockUseGuides.mockReturnValue(
      guidesResponse({
        available: false,
        reason: 'guides: snapshot is unreadable',
        guides: undefined,
      }),
    );
    render(<DocsPane />);
    openGuidesTab();

    expect(
      screen.getByText(/built-in guides unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/snapshot is unreadable/i)).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: /dynamic config/i })[0],
    ).toHaveAttribute(
      'href',
      'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
    );
  });
});
