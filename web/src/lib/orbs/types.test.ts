import { describe, expect, it } from 'vitest';

import { formatOrbRef, parseOrbRef } from './types';

describe('parseOrbRef', () => {
  it('parses a semver-pinned reference', () => {
    expect(parseOrbRef('circleci/node@5.2.0')).toEqual({
      namespace: 'circleci',
      orbName: 'node',
      version: '5.2.0',
    });
  });

  it('parses a @volatile reference', () => {
    expect(parseOrbRef('circleci/node@volatile')).toEqual({
      namespace: 'circleci',
      orbName: 'node',
      version: 'volatile',
    });
  });

  it('parses a dev-release reference, keeping the colon in the version', () => {
    expect(parseOrbRef('circleci/node@dev:mybranch')).toEqual({
      namespace: 'circleci',
      orbName: 'node',
      version: 'dev:mybranch',
    });
  });

  it('parses a bare reference with no version', () => {
    expect(parseOrbRef('circleci/node')).toEqual({
      namespace: 'circleci',
      orbName: 'node',
    });
  });
});

describe('formatOrbRef', () => {
  it('is the inverse of parseOrbRef for a versioned ref', () => {
    const ref = 'circleci/node@5.2.0';
    expect(formatOrbRef(parseOrbRef(ref))).toBe(ref);
  });

  it('is the inverse of parseOrbRef for a dev-release ref', () => {
    const ref = 'circleci/node@dev:mybranch';
    expect(formatOrbRef(parseOrbRef(ref))).toBe(ref);
  });

  it('is the inverse of parseOrbRef for a bare ref', () => {
    const ref = 'circleci/node';
    expect(formatOrbRef(parseOrbRef(ref))).toBe(ref);
  });
});
