import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  findDuplicateExecutors,
  findDuplicateStepSequences,
} from './detectDuplication';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('findDuplicateExecutors', () => {
  it('groups two jobs with byte-for-byte identical inline docker executors', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.10
    resource_class: medium
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.10
    resource_class: medium
    steps:
      - checkout
`);
    const groups = findDuplicateExecutors(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      jobNames: ['build', 'test'],
      kind: 'docker',
      image: 'cimg/node:20.10',
    });
  });

  it('does not group jobs whose images differ', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:18.0
    steps:
      - checkout
`);
    expect(findDuplicateExecutors(doc)).toEqual([]);
  });

  it('does not group jobs whose resource_class differs, even with the same image', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.10
    resource_class: medium
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.10
    resource_class: large
    steps:
      - checkout
`);
    expect(findDuplicateExecutors(doc)).toEqual([]);
  });

  it('excludes a job that already references a named executor -- it is already reusable, not a candidate', () => {
    const doc = parse(`executors:
  node-executor:
    docker:
      - image: cimg/node:20.10
jobs:
  build:
    executor: node-executor
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
`);
    // "build" is on a named executor already; "test" alone can't form a
    // group of two, so nothing is reported even though the effective image
    // is the same for both.
    expect(findDuplicateExecutors(doc)).toEqual([]);
  });

  it('groups three or more jobs together as one group, not pairwise', () => {
    const doc = parse(`jobs:
  a:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  b:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  c:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
`);
    const groups = findDuplicateExecutors(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.jobNames).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for a config with no jobs, or no duplication', () => {
    expect(findDuplicateExecutors(parse('jobs:\n'))).toEqual([]);
    expect(
      findDuplicateExecutors(
        parse(
          'jobs:\n  build:\n    docker:\n      - image: cimg/base:current\n    steps:\n      - checkout\n',
        ),
      ),
    ).toEqual([]);
  });
});

describe('findDuplicateStepSequences', () => {
  it('groups jobs with an identical whole steps array', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
      - run: npm ci
      - run: npm test
  test:
    docker:
      - image: cimg/python:3.12
    steps:
      - checkout
      - run: npm ci
      - run: npm test
`);
    const groups = findDuplicateStepSequences(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ jobNames: ['build', 'test'], stepCount: 3 });
  });

  it('does not group when steps differ in content, order, or length', () => {
    const doc = parse(`jobs:
  a:
    steps:
      - checkout
      - run: npm test
  b:
    steps:
      - run: npm test
      - checkout
  c:
    steps:
      - checkout
      - run: npm test
      - run: npm build
`);
    expect(findDuplicateStepSequences(doc)).toEqual([]);
  });

  it('excludes a lone "- checkout" job even when several jobs share it', () => {
    const doc = parse(`jobs:
  a:
    steps:
      - checkout
  b:
    steps:
      - checkout
`);
    expect(findDuplicateStepSequences(doc)).toEqual([]);
  });

  it('does group a shared multi-step sequence that happens to start with checkout', () => {
    const doc = parse(`jobs:
  a:
    steps:
      - checkout
      - run: echo hi
  b:
    steps:
      - checkout
      - run: echo hi
`);
    expect(findDuplicateStepSequences(doc)).toEqual([
      { jobNames: ['a', 'b'], stepCount: 2 },
    ]);
  });
});
