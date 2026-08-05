import { describe, expect, it } from 'vitest';

import { AVATAR_TONES, avatarInitials, avatarTone } from './avatar';

describe('avatarTone', () => {
  it('is deterministic for the same orb name', () => {
    expect(avatarTone('circleci/slack')).toBe(avatarTone('circleci/slack'));
  });

  it('always returns one of the declared tones', () => {
    for (const name of [
      'circleci/slack',
      'cci-labs/act',
      'acme/internal-tool',
      'x',
      '',
    ]) {
      expect(AVATAR_TONES).toContain(avatarTone(name));
    }
  });

  it('varies across different names (not a constant)', () => {
    // Not a proof of good distribution, just a guard against a hashString
    // regression that collapses every input to the same bucket.
    const tones = new Set(
      [
        'circleci/node',
        'circleci/slack',
        'cci-labs/act',
        'hashicorp/terraform',
      ].map(avatarTone),
    );
    expect(tones.size).toBeGreaterThan(1);
  });
});

describe('avatarInitials', () => {
  it('takes the first letter of the namespace and the first letter of the name', () => {
    expect(avatarInitials('circleci/slack')).toBe('CS');
    expect(avatarInitials('cci-labs/act')).toBe('CA');
  });

  it('falls back to the first two letters when there is no namespace separator', () => {
    expect(avatarInitials('nodocker')).toBe('NO');
  });

  it('never returns an empty string, even for degenerate input', () => {
    expect(avatarInitials('')).toBe('?');
    expect(avatarInitials('/')).toBe('?');
  });
});
