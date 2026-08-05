import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { findRepeatedImageTags } from './detectRepeatedImageTags';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('findRepeatedImageTags', () => {
  it('groups two jobs with a different resource_class that happen to pin the same image', () => {
    // Deliberately NOT a `findDuplicateExecutors` group (resource_class
    // differs), so this is the case this recommendation exists for.
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
    resource_class: medium
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.9
    resource_class: large
    steps:
      - checkout
`);
    const groups = findRepeatedImageTags(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.image).toBe('cimg/node:20.9');
    expect(groups[0]!.locations).toHaveLength(2);
    expect(groups[0]!.locations.map((l) => l.owner).sort()).toEqual([
      'job "build"',
      'job "test"',
    ]);
  });

  it('does not repeat a group already fully covered by findDuplicateExecutors', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
`);
    expect(findRepeatedImageTags(doc)).toEqual([]);
  });

  it('finds the same tag repeated across a job and a named executor', () => {
    const doc = parse(`executors:
  node-executor:
    docker:
      - image: cimg/node:20.9
jobs:
  build:
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
`);
    const groups = findRepeatedImageTags(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.locations.map((l) => l.owner).sort()).toEqual([
      'executor "node-executor"',
      'job "build"',
    ]);
  });

  it("finds a service image tag matching another job's primary image", () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
      - image: redis:7
    steps:
      - checkout
  cache:
    docker:
      - image: redis:7
    steps:
      - checkout
`);
    const groups = findRepeatedImageTags(doc);
    expect(groups.map((g) => g.image)).toContain('redis:7');
  });

  it('does not group an image appearing only once', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.9
    steps:
      - checkout
`);
    expect(findRepeatedImageTags(doc)).toEqual([]);
  });
});
