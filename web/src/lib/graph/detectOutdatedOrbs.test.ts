import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  findOutdatedOrbs,
  type OrbVersionCacheEntry,
} from './detectOutdatedOrbs';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('findOutdatedOrbs', () => {
  it('flags an orb pinned behind the cache-reported latest', () => {
    const doc = parse(`orbs:
  node: circleci/node@5.0.0
`);
    const cache: Record<string, OrbVersionCacheEntry> = {
      'circleci/node': {
        versions: ['5.0.0', '5.1.0', '5.2.1'],
        latestVersion: '5.2.1',
      },
    };
    expect(findOutdatedOrbs(doc, cache)).toEqual([
      {
        alias: 'node',
        orbName: 'circleci/node',
        pinnedVersion: '5.0.0',
        latestVersion: '5.2.1',
      },
    ]);
  });

  it('does not flag an orb already on the cached latest', () => {
    const doc = parse(`orbs:
  node: circleci/node@5.2.1
`);
    const cache: Record<string, OrbVersionCacheEntry> = {
      'circleci/node': { versions: ['5.2.1'], latestVersion: '5.2.1' },
    };
    expect(findOutdatedOrbs(doc, cache)).toEqual([]);
  });

  it('does not fetch or guess -- an orb with no cache entry produces nothing', () => {
    const doc = parse(`orbs:
  node: circleci/node@5.0.0
`);
    expect(findOutdatedOrbs(doc, {})).toEqual([]);
  });

  it('ignores a volatile/dev tag -- it never appears in a published versions list', () => {
    const doc = parse(`orbs:
  node: circleci/node@volatile
`);
    const cache: Record<string, OrbVersionCacheEntry> = {
      'circleci/node': { versions: ['5.0.0', '5.2.1'], latestVersion: '5.2.1' },
    };
    expect(findOutdatedOrbs(doc, cache)).toEqual([]);
  });

  it('ignores a version the registry no longer lists -- a diagnostic owns that case, not this one', () => {
    const doc = parse(`orbs:
  node: circleci/node@0.0.1
`);
    const cache: Record<string, OrbVersionCacheEntry> = {
      'circleci/node': { versions: ['5.0.0', '5.2.1'], latestVersion: '5.2.1' },
    };
    expect(findOutdatedOrbs(doc, cache)).toEqual([]);
  });

  it('ignores an inline orb body and a bare unversioned reference', () => {
    const doc = parse(`orbs:
  bare: circleci/node
  inline:
    version: 2.1
    commands:
      hi:
        steps:
          - run: echo hi
`);
    const cache: Record<string, OrbVersionCacheEntry> = {
      'circleci/node': { versions: ['5.2.1'], latestVersion: '5.2.1' },
    };
    expect(findOutdatedOrbs(doc, cache)).toEqual([]);
  });

  it('returns [] when there is no orbs: block', () => {
    expect(findOutdatedOrbs(parse('jobs:\n  build: {}\n'), {})).toEqual([]);
  });
});
