import { describe, expect, it } from 'vitest';

import { getIn, parseConfig } from '~/lib/yaml/documentUtils';

import { addCacheFallbackKey } from './cacheFallbackMutations';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('addCacheFallbackKey', () => {
  it('converts a singular key: into keys: [original, fallback]', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - checkout
      - restore_cache:
          key: v1-deps-{{ checksum "package-lock.json" }}
      - run: npm ci
`);
    addCacheFallbackKey(doc, 'build', 1, 'v1-deps-');

    expect(getIn(doc, ['jobs', 'build', 'steps', 1, 'restore_cache'])).toEqual({
      keys: ['v1-deps-{{ checksum "package-lock.json" }}', 'v1-deps-'],
    });
    // The rest of the job is untouched.
    expect(getIn(doc, ['jobs', 'build', 'steps', 0])).toBe('checkout');
    expect(getIn(doc, ['jobs', 'build', 'steps', 2])).toEqual({
      run: 'npm ci',
    });
  });

  it('appends to a single-element keys: list', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          keys:
            - v1-deps-{{ checksum "package-lock.json" }}
`);
    addCacheFallbackKey(doc, 'build', 0, 'v1-deps-');

    expect(getIn(doc, ['jobs', 'build', 'steps', 0, 'restore_cache'])).toEqual({
      keys: ['v1-deps-{{ checksum "package-lock.json" }}', 'v1-deps-'],
    });
  });

  it('preserves a comment on the restore_cache step', () => {
    const doc = parse(`jobs:
  build:
    steps:
      # cache node_modules
      - restore_cache:
          key: v1-deps-{{ checksum "package-lock.json" }}
`);
    addCacheFallbackKey(doc, 'build', 0, 'v1-deps-');
    expect(doc.toString()).toContain('# cache node_modules');
  });

  it('refuses a step that is no longer a single-key restore_cache', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          keys:
            - v1-deps-{{ checksum "package-lock.json" }}
            - v1-deps-
`);
    const before = doc.toString();
    expect(() => addCacheFallbackKey(doc, 'build', 0, 'v1-deps-')).toThrow(
      /no longer a restore_cache step/,
    );
    expect(doc.toString()).toBe(before);
  });

  it('refuses an out-of-range step index', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - checkout
`);
    expect(() => addCacheFallbackKey(doc, 'build', 5, 'v1-')).toThrow(
      /no longer a restore_cache step/,
    );
  });
});
