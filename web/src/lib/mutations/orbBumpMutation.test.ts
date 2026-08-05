import { describe, expect, it } from 'vitest';

import { getIn, parseConfig } from '~/lib/yaml/documentUtils';

import { bumpOrbVersion } from './orbBumpMutation';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('bumpOrbVersion', () => {
  it('rewrites the orbs: alias to the new ref', () => {
    const doc = parse(`orbs:
  node: circleci/node@5.0.0
`);
    bumpOrbVersion(doc, 'node', 'circleci/node@5.0.0', 'circleci/node@5.2.1');
    expect(getIn(doc, ['orbs', 'node'])).toBe('circleci/node@5.2.1');
  });

  it('preserves a comment on the orbs: line', () => {
    const doc = parse(`orbs:
  node: circleci/node@5.0.0 # pinned deliberately
`);
    bumpOrbVersion(doc, 'node', 'circleci/node@5.0.0', 'circleci/node@5.2.1');
    expect(doc.toString()).toContain('# pinned deliberately');
  });

  it('refuses when the alias no longer holds the expected ref', () => {
    const doc = parse(`orbs:
  node: circleci/node@6.0.0
`);
    const before = doc.toString();
    expect(() =>
      bumpOrbVersion(doc, 'node', 'circleci/node@5.0.0', 'circleci/node@5.2.1'),
    ).toThrow(/changed since this suggestion/);
    expect(doc.toString()).toBe(before);
  });

  it('refuses when there is no orbs: block at all', () => {
    const doc = parse('jobs:\n  build: {}\n');
    expect(() =>
      bumpOrbVersion(doc, 'node', 'circleci/node@5.0.0', 'circleci/node@5.2.1'),
    ).toThrow(/changed since this suggestion/);
  });
});
