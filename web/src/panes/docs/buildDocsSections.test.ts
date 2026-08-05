import { describe, expect, it } from 'vitest';

import type { CircleciSchema } from '~/lib/schema/circleciSchema';

import {
  buildDocsSections,
  filterDocsSections,
  matchesQuery,
} from './buildDocsSections';

function schemaFixture(
  overrides: Partial<CircleciSchema> = {},
): CircleciSchema {
  return {
    topLevelKeys: [
      { label: 'version', info: 'The version field.' },
      { label: 'jobs' },
    ],
    jobKeys: [{ label: 'docker' }, { label: 'steps' }],
    executorKeys: [],
    workflowKeys: [{ label: 'jobs' }],
    workflowJobEntryKeys: [],
    stepNames: [{ label: 'run', info: 'Run a command.' }],
    resourceClassValues: [{ label: 'small' }, { label: 'large' }],
    jobTypeValues: [],
    pipelineParameterTypeValues: [],
    elementParameterTypeValues: [],
    dockerImageKeys: [],
    stepFieldSchemas: {
      run: [{ name: 'command', type: 'string', required: true }],
    },
    ...overrides,
  };
}

describe('buildDocsSections', () => {
  it('groups every non-empty fact table under its own section, in a fixed order', () => {
    const sections = buildDocsSections(schemaFixture());
    expect(sections.map((s) => s.id)).toEqual([
      'top-level',
      'job',
      'step',
      'workflow',
      'resource-class',
    ]);
  });

  it('omits a section entirely when its fact table is empty, rather than rendering it with zero entries', () => {
    const sections = buildDocsSections(schemaFixture());
    expect(sections.some((s) => s.id === 'executor')).toBe(false);
    expect(sections.some((s) => s.id === 'docker')).toBe(false);
    expect(sections.some((s) => s.id === 'job-type')).toBe(false);
  });

  it("carries each entry's description through unchanged", () => {
    const sections = buildDocsSections(schemaFixture());
    const version = sections
      .find((s) => s.id === 'top-level')!
      .entries.find((e) => e.label === 'version');
    expect(version?.info).toBe('The version field.');
  });

  it("attaches a step's own field schema only to the matching step entry", () => {
    const sections = buildDocsSections(schemaFixture());
    const run = sections
      .find((s) => s.id === 'step')!
      .entries.find((e) => e.label === 'run');
    expect(run?.fields).toEqual([
      { name: 'command', type: 'string', required: true },
    ]);

    const version = sections
      .find((s) => s.id === 'top-level')!
      .entries.find((e) => e.label === 'version');
    expect(version?.fields).toBeUndefined();
  });

  it('gives every entry a globally unique id scoped by section', () => {
    // 'jobs' is a label in both top-level keys and workflow keys.
    const sections = buildDocsSections(schemaFixture());
    const ids = sections.flatMap((s) => s.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('top-level:jobs');
    expect(ids).toContain('workflow:jobs');
  });
});

describe('matchesQuery', () => {
  it('matches everything for an empty (or whitespace-only) query', () => {
    expect(matchesQuery({ id: 'x', label: 'anything' }, '')).toBe(true);
    expect(matchesQuery({ id: 'x', label: 'anything' }, '   ')).toBe(true);
  });

  it('matches case-insensitively against the label', () => {
    expect(matchesQuery({ id: 'x', label: 'save_cache' }, 'CACHE')).toBe(true);
    expect(matchesQuery({ id: 'x', label: 'save_cache' }, 'checkout')).toBe(
      false,
    );
  });

  it('falls back to matching the description when the label does not match', () => {
    const entry = {
      id: 'x',
      label: 'run',
      info: 'Executes a cache-warming script.',
    };
    expect(matchesQuery(entry, 'cache')).toBe(true);
  });
});

describe('filterDocsSections', () => {
  it('drops a section entirely once none of its entries match', () => {
    const sections = buildDocsSections(schemaFixture());
    const filtered = filterDocsSections(sections, 'docker');
    // 'docker' matches the job key literally named "docker".
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe('job');
    expect(filtered[0]!.entries.map((e) => e.label)).toEqual(['docker']);
  });

  it('returns every section unfiltered for an empty query', () => {
    const sections = buildDocsSections(schemaFixture());
    expect(filterDocsSections(sections, '')).toEqual(sections);
  });
});
