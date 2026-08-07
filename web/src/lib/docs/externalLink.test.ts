import { describe, expect, it } from 'vitest';

import { isExternalUrl } from './externalLink';

const APP_ORIGIN = 'http://localhost:5173';

describe('isExternalUrl (issue #10)', () => {
  it('flags a circleci.com docs URL as external', () => {
    expect(
      isExternalUrl(
        'https://circleci.com/docs/reference/configuration-reference/#version',
        APP_ORIGIN,
      ),
    ).toBe(true);
  });

  it('flags a mailto: link as external -- it hands off to another program entirely', () => {
    expect(isExternalUrl('mailto:support@circleci.com', APP_ORIGIN)).toBe(true);
  });

  it('flags a GitHub commit URL as external', () => {
    expect(
      isExternalUrl(
        'https://github.com/circleci/circleci-docs/commit/abc123',
        APP_ORIGIN,
      ),
    ).toBe(true);
  });

  it('does not flag a same-origin URL', () => {
    expect(isExternalUrl(`${APP_ORIGIN}/some/path`, APP_ORIGIN)).toBe(false);
  });

  it('does not flag the absence of a URL -- there is nowhere for a click to go', () => {
    expect(isExternalUrl(undefined, APP_ORIGIN)).toBe(false);
    expect(isExternalUrl('', APP_ORIGIN)).toBe(false);
  });

  // A target that "cannot be resolved" -- malformed even once resolved
  // against a base, not merely relative -- must still produce an answer
  // rather than throw, and the answer must be the honest-degradation
  // direction: assume it leaves. (A merely-relative string like "not a url
  // at all" *is* resolvable against appOrigin, per WHATWG URL's own relative
  // resolution -- this needs something the constructor genuinely rejects.)
  it('flags an unparseable URL as external rather than throwing', () => {
    const malformed = 'http://[::1';
    expect(() => isExternalUrl(malformed, APP_ORIGIN)).not.toThrow();
    expect(isExternalUrl(malformed, APP_ORIGIN)).toBe(true);
  });

  it('defaults appOrigin to window.location.origin', () => {
    // jsdom's default location origin -- this pins that the parameter is
    // genuinely optional, not that any particular origin is "the" app's.
    expect(isExternalUrl('https://circleci.com/docs/')).toBe(true);
    expect(isExternalUrl(window.location.href)).toBe(false);
  });
});
