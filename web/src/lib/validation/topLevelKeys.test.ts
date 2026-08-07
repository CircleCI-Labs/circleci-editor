import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { KNOWN_TOP_LEVEL_KEYS, topLevelKeyTypos } from './topLevelKeys';

function typosIn(text: string) {
  const { doc } = parseConfig(text);
  if (!doc) throw new Error('fixture does not parse');
  return topLevelKeyTypos(doc);
}

describe('topLevelKeyTypos', () => {
  it('flags "workflow", the near miss issue #5 was filed over', () => {
    const typos = typosIn(`version: 2.1
workflow:
  main:
    jobs:
      - build
`);
    expect(typos).toEqual([{ key: 'workflow', replacement: 'workflows' }]);
  });

  it("stays silent on a key that is not within a typo's distance of anything known", () => {
    // A deliberate addition, not a typo -- issue #5 is explicit that this
    // must not be treated as a near miss just because it's unrecognised.
    expect(
      typosIn(`version: 2.1
notifications:
  webhook: https://example.com
jobs:
  build:
    steps: [checkout]
`),
    ).toEqual([]);
  });

  it('finds nothing in a config that only uses known top-level keys', () => {
    expect(
      typosIn(`version: 2.1
setup: true
orbs:
  node: circleci/node@5
commands:
  greet:
    steps: [checkout]
executors:
  default:
    docker:
      - image: cimg/base:stable
parameters:
  greeting:
    type: string
    default: hi
jobs:
  build:
    steps: [checkout]
workflows:
  main:
    jobs:
      - build
`),
    ).toEqual([]);
  });

  it('reports every unrecognised near-miss key, not just the first', () => {
    const typos = typosIn(`version: 2.1
workflow:
  main:
    jobs: [build]
executor:
  default:
    docker:
      - image: cimg/base:stable
jobs:
  build:
    steps: [checkout]
`);
    expect(typos).toEqual([
      { key: 'workflow', replacement: 'workflows' },
      { key: 'executor', replacement: 'executors' },
    ]);
  });

  it('does not flag a key that is already exactly one of the known ones', () => {
    // Sanity check on the membership test itself, not just on the distance
    // check downstream of it: every entry in `KNOWN_TOP_LEVEL_KEYS` must be
    // recognised as itself, or this module would warn on every real config.
    const text = KNOWN_TOP_LEVEL_KEYS.map((key) => `${key}: {}`).join('\n');
    expect(typosIn(text)).toEqual([]);
  });
});
