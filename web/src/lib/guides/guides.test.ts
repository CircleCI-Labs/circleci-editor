import { describe, expect, it } from 'vitest';

import {
  groupGuidesByCategory,
  blocksToText,
  documentedKeys,
  findGuide,
  findSectionForKey,
  resolveRef,
  searchGuides,
  sectionSummary,
  spansToText,
} from './guides';
import type { Guide, GuideSection } from './types';

function section(overrides: Partial<GuideSection>): GuideSection {
  return {
    id: 'id',
    level: 2,
    title: 'Title',
    titleSpans: [],
    url: 'https://circleci.com/docs/reference/configuration-reference/#id',
    blocks: [],
    ...overrides,
  };
}

/**
 * Reproduces the two heading collisions that actually exist in the vendored
 * configuration reference, because they are what `findSectionForKey`'s ranking
 * rules are for:
 *
 *  - `docker` is named both by the shared overview heading
 *    "Executor `docker` / `machine` / `macos`" and by its own `docker` section.
 *  - `jobs` is documented once at the top level and once inside `workflows`.
 */
const REFERENCE: Guide = {
  id: 'configuration-reference',
  origin: 'circleci',
  category: 'Configuration reference',
  title: 'Configuration reference',
  url: 'https://circleci.com/docs/reference/configuration-reference/',
  anchors: {
    version: 'version',
    jobs: 'jobs',
    'the-when-attribute': 'run',
  },
  sections: [
    section({
      id: 'version',
      title: 'version',
      keys: ['version'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'The version field.' }],
        },
      ],
    }),
    section({
      id: 'jobs',
      title: 'jobs',
      keys: ['jobs'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'A job is a collection of steps.' }],
        },
      ],
    }),
    section({
      id: 'executor-job',
      title: 'Executor docker / machine / macos',
      keys: ['docker', 'machine', 'macos'],
      blocks: [
        { kind: 'paragraph', spans: [{ kind: 'text', text: 'Pick one.' }] },
      ],
    }),
    section({
      id: 'docker',
      level: 3,
      title: 'docker',
      keys: ['docker'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Use the docker executor.' }],
        },
      ],
    }),
    section({
      id: 'workflow-jobs',
      title: 'jobs',
      keys: ['jobs'],
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Jobs in a workflow.' }],
        },
      ],
    }),
    section({
      id: 'run',
      level: 3,
      title: 'run',
      keys: ['run'],
      blocks: [
        {
          kind: 'admonition',
          admonition: 'NOTE',
          blocks: [
            {
              kind: 'paragraph',
              spans: [{ kind: 'text', text: 'Supported in 2.1 only.' }],
            },
          ],
        },
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', text: 'Used for invoking all commands.' }],
        },
      ],
    }),
  ],
};

const DYNAMIC: Guide = {
  id: 'dynamic-config',
  origin: 'circleci',
  category: 'Dynamic config',
  title: 'Dynamic config',
  url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
  sections: [
    section({
      id: 'path-filtering',
      title: 'Use path filtering for monorepos',
      url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/#path-filtering',
      blocks: [
        {
          kind: 'paragraph',
          spans: [
            { kind: 'text', text: 'Only build what changed in a monorepo.' },
          ],
        },
      ],
    }),
  ],
};

describe('spansToText / blocksToText', () => {
  it('flattens nested spans, keeping the text of every kind', () => {
    expect(
      spansToText([
        { kind: 'text', text: 'Use ' },
        {
          kind: 'strong',
          text: '',
          children: [{ kind: 'code', text: 'save_cache' }],
        },
        { kind: 'text', text: ' here.' },
      ]),
    ).toBe('Use save_cache here.');
  });

  it('reaches text inside admonitions, lists and tables', () => {
    expect(
      blocksToText([
        {
          kind: 'admonition',
          admonition: 'NOTE',
          blocks: [
            { kind: 'paragraph', spans: [{ kind: 'text', text: 'inside' }] },
          ],
        },
        {
          kind: 'list',
          items: [
            {
              blocks: [
                { kind: 'paragraph', spans: [{ kind: 'text', text: 'item' }] },
              ],
            },
          ],
        },
        {
          kind: 'table',
          table: {
            header: [{ spans: [{ kind: 'text', text: 'Key' }] }],
            rows: [[{ spans: [{ kind: 'text', text: 'cell' }] }]],
          },
        },
        { kind: 'code', text: 'version: 2.1' },
      ]),
    ).toBe('inside item Key cell version: 2.1');
  });

  it('tolerates an absent span or block list', () => {
    expect(spansToText(undefined)).toBe('');
    expect(blocksToText(undefined)).toBe('');
  });
});

describe('sectionSummary', () => {
  it('is the first paragraph', () => {
    expect(sectionSummary(REFERENCE.sections[0]!)).toBe('The version field.');
  });

  it('skips a leading version-support admonition, which is never the sentence that explains a key', () => {
    const run = REFERENCE.sections.find((s) => s.id === 'run')!;
    expect(sectionSummary(run)).toBe('Used for invoking all commands.');
  });

  it('falls back to an admonition when that is genuinely all there is', () => {
    expect(
      sectionSummary(
        section({
          blocks: [
            {
              kind: 'admonition',
              admonition: 'WARNING',
              blocks: [
                {
                  kind: 'paragraph',
                  spans: [{ kind: 'text', text: 'Deprecated.' }],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe('Deprecated.');
  });

  it('is empty rather than throwing for a section with no prose at all', () => {
    expect(sectionSummary(section({ blocks: [] }))).toBe('');
  });
});

describe('findSectionForKey', () => {
  it('prefers the section dedicated to the key over a shared overview heading', () => {
    // Rule 1: `docker` appears first (in document order) in the shared
    // "Executor docker / machine / macos" heading, but its own section is the
    // one a reader wants.
    expect(findSectionForKey(REFERENCE, 'docker')?.id).toBe('docker');
  });

  it('falls back to document order when no section title is exactly the key', () => {
    // `machine` is only ever named in the shared heading.
    expect(findSectionForKey(REFERENCE, 'machine')?.id).toBe('executor-job');
  });

  it('prefers the earlier of two sections whose titles are both exactly the key', () => {
    // Rule 2: `jobs` is documented at the top level and again under
    // `workflows`; a project-config author means the top-level one.
    expect(findSectionForKey(REFERENCE, 'jobs')?.id).toBe('jobs');
  });

  it('returns undefined for a key the guide does not document, rather than guessing', () => {
    expect(findSectionForKey(REFERENCE, 'display')).toBeUndefined();
    expect(findSectionForKey(REFERENCE, '')).toBeUndefined();
    expect(findSectionForKey(undefined, 'jobs')).toBeUndefined();
  });
});

describe('documentedKeys', () => {
  it('collects every key any section documents', () => {
    const keys = documentedKeys(REFERENCE);
    expect([...keys].sort()).toEqual([
      'docker',
      'jobs',
      'machine',
      'macos',
      'run',
      'version',
    ]);
  });

  // The evidence the pane uses to label orb-authoring-only keys. Its *absence*
  // is what carries the meaning, so an empty set has to mean "no evidence",
  // never "nothing is documented".
  it('is empty for an absent guide, so callers can tell "no evidence" from "documented nowhere"', () => {
    expect(documentedKeys(undefined).size).toBe(0);
  });
});

describe('searchGuides', () => {
  it('searches across every guide and ranks title matches first', () => {
    const results = searchGuides([REFERENCE, DYNAMIC], 'jobs');
    expect(results[0]!.titleMatch).toBe(true);
    expect(results.map((r) => r.section.id)).toContain('jobs');
  });

  it('finds a body-only match in a guide other than the first', () => {
    const results = searchGuides(
      [REFERENCE, DYNAMIC],
      'only build what changed',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.guideId).toBe('dynamic-config');
    expect(results[0]!.titleMatch).toBe(false);
  });

  it('is case-insensitive and returns nothing for an empty query', () => {
    expect(searchGuides([REFERENCE], 'VERSION')).toHaveLength(1);
    expect(searchGuides([REFERENCE], '   ')).toHaveLength(0);
  });

  it('bounds its result list, since a two-letter query legitimately matches most of a 3,900-line reference', () => {
    expect(searchGuides([REFERENCE, DYNAMIC], 'e', 2)).toHaveLength(2);
  });
});

describe('resolveRef', () => {
  it('resolves a block-level anchor to the section containing it', () => {
    // Upstream cross-references anchors attached to ordinary blocks, not just
    // to headings; without the anchor map those would be links to nothing.
    expect(resolveRef(REFERENCE, 'the-when-attribute')).toBe('run');
  });

  it('returns undefined for an anchor the guide does not define', () => {
    // Upstream ships three of these today (`expression-based-job-filters`),
    // and the renderer must show plain text rather than a dead control.
    expect(
      resolveRef(REFERENCE, 'expression-based-job-filters'),
    ).toBeUndefined();
    expect(resolveRef(REFERENCE, undefined)).toBeUndefined();
    expect(resolveRef(undefined, 'version')).toBeUndefined();
  });
});

describe('findGuide', () => {
  it('looks a guide up by its stable id', () => {
    expect(findGuide([REFERENCE, DYNAMIC], 'dynamic-config')?.title).toBe(
      'Dynamic config',
    );
    expect(findGuide([REFERENCE], 'nope')).toBeUndefined();
  });
});

describe('groupGuidesByCategory', () => {
  // The picker had to stop being a row of buttons at twenty-two guides (issue
  // #176), and grouping is what keeps the replacement scannable.
  it("groups by category, preserving the host's order within and between groups", () => {
    const groups = groupGuidesByCategory([
      { ...REFERENCE, id: 'a', category: 'Reference' },
      { ...REFERENCE, id: 'b', category: 'Reference' },
      { ...DYNAMIC, id: 'c', category: 'Dynamic config' },
    ]);

    expect(groups.map((group) => group.title)).toEqual([
      'Reference',
      'Dynamic config',
    ]);
    expect(groups.at(0)?.guides.map((guide) => guide.id)).toEqual(['a', 'b']);
    expect(groups.at(1)?.guides.map((guide) => guide.id)).toEqual(['c']);
  });

  // Not sorted here on purpose: `internal/guides.Sources` deliberately puts the
  // configuration reference first and this project's own pages last, and
  // re-sorting in the view would silently undo that.
  it('does not reorder', () => {
    const groups = groupGuidesByCategory([
      { ...DYNAMIC, id: 'z', category: 'Zebra' },
      { ...REFERENCE, id: 'a', category: 'Alpha' },
    ]);
    expect(groups.map((group) => group.title)).toEqual(['Zebra', 'Alpha']);
  });

  // A guide the host forgot to categorise must still be reachable in the
  // picker: it gets its own heading rather than being dropped or swept into an
  // "Other" bucket that hides the omission.
  it('falls back to the guide title when no category is set', () => {
    const { category: _dropped, ...uncategorised } = REFERENCE;
    const groups = groupGuidesByCategory([uncategorised]);
    expect(groups).toHaveLength(1);
    expect(groups.at(0)?.title).toBe('Configuration reference');
    expect(groups.at(0)?.guides).toHaveLength(1);
  });
});

describe('searchGuides at scale', () => {
  // Search flattens section bodies to text on every keystroke. At three guides
  // that was free; at twenty-two it is ~370 sections, so the body text is
  // memoised per section object (issue #176). This asserts the observable
  // consequence -- results are identical across repeated identical searches, and
  // a new object graph is not served stale text from the old one.
  it('returns identical results when repeated, and is not stale across a refresh', () => {
    const first = searchGuides([REFERENCE, DYNAMIC], 'changed in a monorepo');
    const second = searchGuides([REFERENCE, DYNAMIC], 'changed in a monorepo');
    expect(second.map((hit) => hit.section.id)).toEqual(
      first.map((hit) => hit.section.id),
    );

    // A refresh publishes an entirely new array of new objects, exactly as
    // `internal/guides.Cache.publish` does. The cache is keyed on the section
    // object, so the replacement is read afresh rather than inherited.
    const refreshed: Guide = {
      ...DYNAMIC,
      sections: DYNAMIC.sections.map((section) => ({
        ...section,
        blocks: [
          {
            kind: 'paragraph',
            spans: [{ kind: 'text', text: 'Completely rewritten upstream.' }],
          },
        ],
      })),
    };
    expect(searchGuides([refreshed], 'changed in a monorepo')).toHaveLength(0);
    expect(searchGuides([refreshed], 'rewritten upstream')).toHaveLength(1);
  });

  // The limit is what keeps a two-letter query from becoming the wall of
  // results issue #176 asked to avoid.
  it('caps the result list even when title matches alone would overflow it', () => {
    const many: Guide = {
      ...REFERENCE,
      sections: Array.from({ length: 60 }, (_unused, index) => ({
        id: `docker-${index}`,
        level: 2,
        title: `docker ${index}`,
        titleSpans: [{ kind: 'text' as const, text: `docker ${index}` }],
        url: 'https://circleci.com/docs/reference/configuration-reference/',
        blocks: [],
      })),
    };
    expect(searchGuides([many], 'docker')).toHaveLength(40);
    expect(searchGuides([many], 'docker', 5)).toHaveLength(5);
  });
});
