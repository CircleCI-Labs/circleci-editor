import { describe, expect, it } from 'vitest';

import { getIn, parseConfig } from '~/lib/yaml/documentUtils';

import { setResourceClass } from './resourceClassMutations';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('setResourceClass', () => {
  it('rewrites resource_class in place', () => {
    const doc = parse(`jobs:
  build:
    resource_class: large
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
`);
    setResourceClass(doc, 'build', 'medium');
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium');
  });

  it('adds resource_class when the job has none (defaulted to medium)', () => {
    const doc = parse(`jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
`);
    setResourceClass(doc, 'build', 'small');
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('small');
  });

  it('refuses to shadow a resource_class supplied via a merge anchor', () => {
    const doc = parse(`jobs:
  base: &base
    resource_class: large
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
  build:
    <<: *base
`);
    expect(() => setResourceClass(doc, 'build', 'medium')).toThrow(/merge/i);
  });
});
