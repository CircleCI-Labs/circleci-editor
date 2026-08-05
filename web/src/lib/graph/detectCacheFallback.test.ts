import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { findMissingCacheFallbacks } from './detectCacheFallback';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('findMissingCacheFallbacks', () => {
  it('flags a single `key:` with a checksum template and real prefix text', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
      - restore_cache:
          key: v1-deps-{{ checksum "package-lock.json" }}
      - run: npm ci
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([
      {
        jobName: 'build',
        stepIndex: 1,
        originalKey: 'v1-deps-{{ checksum "package-lock.json" }}',
        suggestedFallback: 'v1-deps-',
      },
    ]);
  });

  it('flags a single-element `keys:` the same way', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          keys:
            - v1-deps-{{ checksum "package-lock.json" }}
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([
      {
        jobName: 'build',
        stepIndex: 0,
        originalKey: 'v1-deps-{{ checksum "package-lock.json" }}',
        suggestedFallback: 'v1-deps-',
      },
    ]);
  });

  it('does not flag a restore_cache that already has a fallback key', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          keys:
            - v1-deps-{{ checksum "package-lock.json" }}
            - v1-deps-
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([]);
  });

  it('does not flag a key with no template -- there is no checksum portion to fall back from', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          key: static-key
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([]);
  });

  it('does not flag a key that is entirely a template -- no prefix text to suggest', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache:
          key: '{{ checksum "package-lock.json" }}'
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([]);
  });

  it('ignores the bare `- restore_cache` shorthand -- no key to read at all', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - restore_cache
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([]);
  });

  it('returns [] for a job with no restore_cache step', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - checkout
`);
    expect(findMissingCacheFallbacks(doc)).toEqual([]);
  });
});
