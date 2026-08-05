import { describe, expect, it } from 'vitest';

import { classifyUrl, isAllowedHost, safeHref } from './safeUrl';

/**
 * Issue #187. The cases that matter here are the look-alikes: a host allowlist
 * is only worth anything if it cannot be talked past, and every one of these is
 * something a naive string check would wave through. Each test names the naive
 * check it defeats, so a future "simplification" back to `endsWith` or
 * `includes` fails a test that explains itself.
 */
describe('the host allowlist: look-alike domains', () => {
  it('rejects a suffix-shaped look-alike that a bare endsWith would accept', () => {
    // "evil-circleci.com".endsWith("circleci.com") === true. This is the
    // classic, and it is why the rule is `=== domain || endsWith('.' + domain)`.
    expect(isAllowedHost('evil-circleci.com')).toBe(false);
    expect(isAllowedHost('notcircleci.com')).toBe(false);
    expect(classifyUrl('https://evil-circleci.com/docs/')).toEqual({
      allowed: false,
      reason: 'host',
      hostname: 'evil-circleci.com',
    });
  });

  it('rejects the domain used as a prefix of somebody else’s, which an includes() would accept', () => {
    // The case #187 names explicitly.
    expect(isAllowedHost('circleci.com.evil.example')).toBe(false);
    expect(safeHref('https://circleci.com.evil.example/docs/guides/')).toBe(
      undefined,
    );
    // And with a plausible docs-looking path, which is how it would actually
    // arrive in a citation.
    expect(
      classifyUrl(
        'https://docs.circleci.com.evil.example/docs/reference/configuration-reference/',
      ),
    ).toEqual({
      allowed: false,
      reason: 'host',
      hostname: 'docs.circleci.com.evil.example',
    });
  });

  it('rejects a trusted name smuggled into the userinfo, which matching the whole URL string would accept', () => {
    // `"https://circleci.com@evil.example/docs".includes("circleci.com")` is
    // true; the host the browser would connect to is `evil.example`.
    const verdict = classifyUrl('https://circleci.com@evil.example/docs/');
    expect(verdict).toEqual({
      allowed: false,
      reason: 'host',
      hostname: 'evil.example',
    });
    expect(safeHref('https://circleci.com:x@evil.example/docs/')).toBe(
      undefined,
    );
  });

  it('rejects a homoglyph domain, which no character comparison of the displayed text would catch', () => {
    // U+0441 CYRILLIC SMALL LETTER ES in place of the leading `c`: identical on
    // screen, a different domain. The URL parser converts it to punycode, which
    // matches nothing in the allowlist.
    const verdict = classifyUrl('https://сircleci.com/docs/');
    expect(verdict).toEqual({
      allowed: false,
      reason: 'host',
      hostname: 'xn--ircleci-xjg.com',
    });
    expect(safeHref('https://сircleci.com/docs/')).toBe(undefined);
  });

  it('rejects a subdomain-shaped path or query that merely mentions the domain', () => {
    expect(safeHref('https://evil.example/circleci.com/docs/')).toBe(undefined);
    expect(
      safeHref('https://evil.example/?next=https://circleci.com/docs/'),
    ).toBe(undefined);
    expect(safeHref('https://evil.example/#circleci.com')).toBe(undefined);
  });

  it('still rejects every non-http scheme, including one smuggled past a regex with control characters', () => {
    // #168's property, moved here with the gate itself and re-asserted through
    // the combined check so adding the host rule cannot have loosened it. The
    // URL parser strips tabs and newlines *inside* a scheme, which is exactly
    // why parsing beats pattern-matching: every entry below is `javascript:` or
    // similar as far as a browser is concerned.
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'jAvAsCrIpT:alert(document.domain)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://circleci.com/abc',
      'about:blank',
      'ftp://circleci.com/x',
      // Relative and unparseable targets, which would resolve against this
      // app's own origin -- the localhost host API.
      '/api/ai/key',
      '../../etc/passwd',
      'circleci.com/docs/',
      'not a url',
      '',
      '   ',
    ]) {
      expect(`${raw} -> ${JSON.stringify(classifyUrl(raw))}`).toBe(
        `${raw} -> {"allowed":false,"reason":"scheme"}`,
      );
    }
  });

  it('returns the parser’s own serialization, not the model’s bytes', () => {
    expect(safeHref('  https://circleci.com/a b  ')).toBe(
      'https://circleci.com/a%20b',
    );
  });

  it('never reports a host rejection for something that was not a real http(s) URL', () => {
    // The distinction is load-bearing: a `host` rejection is rendered with its
    // hostname visible, and a `scheme` rejection must stay invisible (#168).
    const verdict = classifyUrl('javascript:location="https://circleci.com"');
    expect(verdict).toEqual({ allowed: false, reason: 'scheme' });
  });
});

describe('the host allowlist: what is allowed', () => {
  it('allows circleci.com and every host under it', () => {
    for (const host of [
      'circleci.com',
      'www.circleci.com',
      'docs.circleci.com',
      'app.circleci.com',
      'support.circleci.com',
      'discuss.circleci.com',
    ]) {
      expect(isAllowedHost(host)).toBe(true);
    }
    expect(
      safeHref('https://circleci.com/docs/reference/configuration-reference/'),
    ).toBe('https://circleci.com/docs/reference/configuration-reference/');
  });

  it('normalizes case and a trailing dot rather than rejecting a legal spelling', () => {
    expect(isAllowedHost('CircleCI.com')).toBe(true);
    expect(isAllowedHost('circleci.com.')).toBe(true);
    expect(safeHref('HTTPS://CIRCLECI.COM/docs/')).toBe(
      'https://circleci.com/docs/',
    );
    // Normalizing the trailing dot cannot widen the allowlist.
    expect(isAllowedHost('circleci.com.evil.example.')).toBe(false);
  });

  it('allows a non-default port on a trusted host, because the host is what is trusted', () => {
    expect(safeHref('https://circleci.com:8443/docs/')).toBe(
      'https://circleci.com:8443/docs/',
    );
  });

  it('allows GitHub only for CircleCI-owned accounts', () => {
    // The citation the owner explicitly called fine: the CircleCI-Public
    // slack-orb wiki.
    expect(safeHref('https://github.com/CircleCI-Public/slack-orb/wiki')).toBe(
      'https://github.com/CircleCI-Public/slack-orb/wiki',
    );
    expect(safeHref('https://github.com/circleci/circleci-docs')).toBeTruthy();
    expect(
      safeHref('https://github.com/CircleCI-Labs/circleci-editor'),
    ).toBeTruthy();
    // Case-insensitive, because a citation may spell the org either way.
    expect(
      safeHref('https://github.com/circleci-public/slack-orb'),
    ).toBeTruthy();
    // The docs source itself is cited as a raw path (issue #156).
    expect(
      safeHref(
        'https://raw.githubusercontent.com/circleci/circleci-docs/master/jekyll/_cci2/workflows.adoc',
      ),
    ).toBeTruthy();
  });

  it('rejects GitHub for anybody else, including a look-alike owner', () => {
    for (const raw of [
      'https://github.com/someone/anything',
      'https://github.com/circleci-evil/orb',
      'https://github.com/notcircleci/docs',
      // An owner-shaped decoy deeper in the path.
      'https://github.com/evil/circleci/wiki',
      // A gist is arbitrary user content under a GitHub host.
      'https://gist.github.com/circleci/deadbeef',
      // No owner segment at all.
      'https://github.com/',
      'https://raw.githubusercontent.com/evil/repo/main/x.yml',
    ]) {
      expect(safeHref(raw)).toBe(undefined);
    }
  });

  it('rejects the host from the report that started this, and other arbitrary sites', () => {
    for (const raw of [
      'https://app.slack.com/client/T00000000/C00000000',
      'https://stackoverflow.com/questions/1',
      'https://medium.com/@someone/circleci-tips',
      'https://evil.example/',
    ]) {
      expect(safeHref(raw)).toBe(undefined);
    }
    expect(
      classifyUrl('https://app.slack.com/client/T00000000/C00000000'),
    ).toEqual({
      allowed: false,
      reason: 'host',
      hostname: 'app.slack.com',
    });
  });
});
