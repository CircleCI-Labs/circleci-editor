import { describe, expect, it } from 'vitest';

import { xcodeVersionsFixture } from './testFixtures';
import {
  groupedVersionNames,
  resolveInitialXcodeVersion,
  xcodeVersionGroups,
  xcodeVersionTitle,
  xcodeVersionsMatching,
} from './xcodeVersionOptions';

/**
 * The grouping, ordering and default-resolution rules for the Xcode field (issue
 * #211), assertable without a render -- the same convention
 * `resourceClassOptions.test.ts` follows.
 *
 * What the *host* extracts from CircleCI's table is pinned in
 * `internal/guides/xcodeversions_test.go`; that the literals in this repository
 * agree with that table is pinned in `vendoredXcodeTable.test.ts`. These tests are
 * about this module's own logic.
 */
const RESPONSE = xcodeVersionsFixture();

describe('xcodeVersionGroups', () => {
  it('separates supported from pre-release, keeping upstream’s order inside each', () => {
    const groups = xcodeVersionGroups(RESPONSE.versions);
    expect(groups.map((group) => group.id)).toEqual([
      'supported',
      'prerelease',
    ]);
    expect(groups[0]?.versions.map((v) => v.version)).toEqual([
      '26.5',
      '26.4.1',
      '16.4.0',
    ]);
    expect(groups[1]?.versions.map((v) => v.version)).toEqual(['27.0', '26.6']);
  });

  it('puts supported first even though the table lists pre-releases at the top', () => {
    // Upstream's table is newest-first, so its top two rows are a beta and a
    // release candidate. Presenting them first would make the default-looking
    // option an image upstream says is not frozen.
    expect(groupedVersionNames(xcodeVersionGroups(RESPONSE.versions))).toEqual([
      '26.5',
      '26.4.1',
      '16.4.0',
      '27.0',
      '26.6',
    ]);
  });

  it('drops a group with nothing in it rather than rendering it empty', () => {
    const stableOnly = RESPONSE.versions.filter((v) => !v.prerelease);
    expect(xcodeVersionGroups(stableOnly).map((g) => g.id)).toEqual([
      'supported',
    ]);
    const betaOnly = RESPONSE.versions.filter((v) => v.prerelease);
    expect(xcodeVersionGroups(betaOnly).map((g) => g.id)).toEqual([
      'prerelease',
    ]);
    expect(xcodeVersionGroups([])).toEqual([]);
  });

  it('labels the pre-release group with what is actually risky about it', () => {
    // "Pre-release" alone is not the useful part; "not frozen -- may change" is.
    const groups = xcodeVersionGroups(RESPONSE.versions);
    expect(groups[1]?.label).toMatch(/not frozen/);
  });
});

describe('resolveInitialXcodeVersion', () => {
  it('uses the host’s own default when the offered list still contains it', () => {
    expect(resolveInitialXcodeVersion(RESPONSE)).toBe('26.5');
  });

  it('falls back to the newest supported version when the default has gone', () => {
    // The host and the list are read from the same table in the same response, so
    // this is defence against a mismatch rather than an expected state -- but the
    // fallback must never be a pre-release, and must never be invented.
    expect(
      resolveInitialXcodeVersion({
        versions: RESPONSE.versions,
        default: '99.0',
      }),
    ).toBe('26.5');
  });

  it('never starts a new job on a pre-release', () => {
    expect(
      resolveInitialXcodeVersion({
        versions: [
          { version: '99.0', prerelease: true },
          { version: '98.0', prerelease: true },
          { version: '97.0' },
        ],
        default: '',
      }),
    ).toBe('97.0');
  });

  it('takes the newest row when upstream marks every one a pre-release', () => {
    // Still a real, supported version -- better than nothing, and better than
    // inventing one.
    expect(
      resolveInitialXcodeVersion({
        versions: [{ version: '99.0', prerelease: true }],
        default: '',
      }),
    ).toBe('99.0');
  });

  it('returns nothing at all when nothing is offered', () => {
    // The host unreachable. Issue #203's whole lesson is that a literal here would
    // be worse than an empty field: the field shows what the config already says
    // plus free text, and `ConfigureJobDialog` refuses to submit without a version.
    expect(resolveInitialXcodeVersion(undefined)).toBe('');
    expect(resolveInitialXcodeVersion({ versions: [], default: '' })).toBe('');
    expect(
      resolveInitialXcodeVersion({ versions: [], default: '15.3.0' }),
    ).toBe('');
  });
});

describe('xcodeVersionsMatching', () => {
  it('matches by prefix, because a version number reads left to right', () => {
    // Someone who typed `26.` means the 26 line. A substring match would also offer
    // `16.4.0` (it contains "6."), which is not what they asked for. This is the
    // deliberate difference from the tag combobox -- see `matchesTagQuery`.
    expect(
      xcodeVersionsMatching(RESPONSE.versions, '26.').map((v) => v.version),
    ).toEqual(['26.6', '26.5', '26.4.1']);
    expect(
      xcodeVersionsMatching(RESPONSE.versions, '16').map((v) => v.version),
    ).toEqual(['16.4.0']);
  });

  it('offers the whole list for an empty prefix', () => {
    // Which is what opening the completion on an empty value does -- and what
    // deleting a whole value does, via `reopenCompletionOnDelete`.
    expect(xcodeVersionsMatching(RESPONSE.versions, '')).toHaveLength(
      RESPONSE.versions.length,
    );
    expect(xcodeVersionsMatching(RESPONSE.versions, '   ')).toHaveLength(
      RESPONSE.versions.length,
    );
  });

  it('offers nothing for a prefix no version starts with', () => {
    // Notably `15.3.0`, the version this editor used to write (issue #203): typing
    // it must not be completed into anything, because there is nothing to complete
    // it into.
    expect(xcodeVersionsMatching(RESPONSE.versions, '15.3')).toEqual([]);
  });
});

describe('xcodeVersionTitle', () => {
  it('assembles the table’s own columns, and nothing of our own', () => {
    const supported = RESPONSE.versions.find((v) => v.version === '26.5');
    expect(xcodeVersionTitle(supported!)).toBe(
      'Xcode 26.5 (17F42) -- macOS Version 26.3.1 -- Runs on m4pro.medium, m4pro.large',
    );
  });

  it('spells out what a pre-release means for the job, not just that it is one', () => {
    const beta = RESPONSE.versions.find((v) => v.version === '27.0');
    expect(xcodeVersionTitle(beta!)).toMatch(
      /CircleCI lists this as a beta: pre-release images are not frozen/,
    );
  });

  it('is undefined when the row carried nothing to say', () => {
    expect(xcodeVersionTitle({ version: '99.0' })).toBeUndefined();
  });
});
