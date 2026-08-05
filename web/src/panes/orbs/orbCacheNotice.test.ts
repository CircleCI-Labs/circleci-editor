import { describe, expect, it } from 'vitest';

import type { OrbSearchStatus } from '~/lib/rpc/client';

import { describeAge, describeOrbCacheNotice } from './orbCacheNotice';

const BASE: OrbSearchStatus = {
  ready: false,
  complete: false,
  count: 0,
  warming: false,
  certifiedCount: 0,
  privateCount: 0,
};

const FETCHED = '2026-07-30T09:00:00Z';
/** 2026-07-30T11:00:00Z -- two hours after FETCHED. */
const NOW = Date.parse('2026-07-30T11:00:00Z');

function notice(status: Partial<OrbSearchStatus>) {
  return describeOrbCacheNotice({ ...BASE, ...status }, NOW);
}

/** Everything a notice renders, joined -- for assertions about the message as a whole. */
function text(status: Partial<OrbSearchStatus>): string {
  const result = notice(status);
  if (!result) return '';
  return [result.headline, ...result.details].join(' ');
}

describe('describeOrbCacheNotice (issue #257)', () => {
  it('says nothing when the cache holds a current listing', () => {
    // The whole point of returning null: with a current listing, an empty
    // result list is about the query or the filter, and #151's messages own
    // that. A cache notice here would talk over them.
    expect(
      notice({ state: 'ready', ready: true, complete: true, count: 6400 }),
    ).toBeNull();
  });

  // The defect the issue was filed for: these two produce an identical empty
  // list, and must not produce an identical message.
  it('distinguishes a failed fetch from a genuinely empty registry', () => {
    const failed = text({
      state: 'failed',
      reason: 'the CircleCI API reported a server error (HTTP 500)',
    });
    const empty = text({ state: 'empty', ready: true, complete: true });

    expect(failed).not.toEqual(empty);
    expect(failed).toMatch(/could not be fetched/i);
    expect(empty).not.toMatch(/could not be fetched/i);
  });

  it('renders the host-supplied reason verbatim, only re-cased', () => {
    const result = notice({
      state: 'failed',
      reason: 'the CircleCI API rejected this token (HTTP 401)',
    });
    expect(result?.tone).toBe('error');
    expect(result?.details[0]).toBe(
      'The CircleCI API rejected this token (HTTP 401).',
    );
  });

  it('refuses to present a failed fetch as a report that there are no orbs', () => {
    // The claim a bare empty list makes, and the one this must contradict.
    expect(text({ state: 'failed', reason: 'a network error' })).toMatch(
      /not a report that there are no orbs/i,
    );
  });

  it('names the gap when the host reported a failure with no reason', () => {
    expect(text({ state: 'failed' })).toMatch(/did not report a reason/i);
  });

  it('tells the user to wait while a first fetch is running, and still surfaces an earlier failure', () => {
    const plain = notice({ state: 'fetching', warming: true });
    expect(plain?.tone).toBe('info');
    expect(plain?.details.join(' ')).not.toMatch(/earlier attempt/i);

    const afterFailure = text({
      state: 'fetching',
      warming: true,
      reason: 'the CircleCI API rate-limited this request (HTTP 429)',
    });
    expect(afterFailure).toMatch(/still being fetched/i);
    expect(afterFailure).toMatch(/earlier attempt failed/i);
    expect(afterFailure).toMatch(/HTTP 429/);
  });

  it('separates "never fetched" from "fetched and empty"', () => {
    expect(text({ state: 'never-fetched' })).toMatch(/has not been fetched/i);
    expect(text({ state: 'empty', ready: true, complete: true })).toMatch(
      /has no orbs in it/i,
    );
  });

  describe('an empty registry', () => {
    it('is reported as the ordinary state on a self-hosted installation, not a fault', () => {
      const result = text({
        state: 'empty',
        ready: true,
        complete: true,
        selfHosted: true,
      });
      expect(result).toMatch(/CircleCI Server/);
      expect(result).toMatch(/ordinary starting state/i);
      expect(result).not.toMatch(/circleci\.com/);
    });

    // Issue #256's fourth state: a Server admin token generated *before* the
    // account became an admin yields an empty registry rather than a 401. It is
    // offered as something to check, never asserted -- nothing observable from
    // here would establish it, and the honesty rule outranks being helpful.
    it('names the pre-admin-grant token possibility on Server without claiming it', () => {
      const result = text({
        state: 'empty',
        ready: true,
        complete: true,
        selfHosted: true,
      });
      expect(result).toMatch(/after your account became an admin/i);
      expect(result).toMatch(/cannot tell that apart/i);
    });

    it('does not raise the Server explanation on cloud, where it would be false', () => {
      const result = text({ state: 'empty', ready: true, complete: true });
      expect(result).not.toMatch(/CircleCI Server/);
      expect(result).toMatch(/circleci\.com/);
      expect(result).toMatch(/no further information about why/i);
    });
  });

  describe('a stale listing', () => {
    it('is shown, labelled, with its age and the window it is measured against', () => {
      const result = notice({
        state: 'stale',
        ready: true,
        complete: true,
        count: 6400,
        stale: true,
        fetchedAt: FETCHED,
        refreshWindowHours: 24,
      });
      expect(result?.tone).toBe('warning');
      expect(result?.headline).toMatch(/not current/i);
      const detail = result?.details.join(' ') ?? '';
      expect(detail).toMatch(/6400 orbs were fetched about 2 hours ago/);
      expect(detail).toMatch(/1 day refresh window/);
      expect(detail).toMatch(/real registry listing/i);
    });

    it('leads with the refresh failure when there is one', () => {
      const result = notice({
        state: 'stale',
        ready: true,
        complete: true,
        count: 12,
        fetchedAt: FETCHED,
        reason: 'this host could not reach the CircleCI API (network error)',
      });
      expect(result?.details[0]).toMatch(/most recent refresh failed/i);
      expect(result?.details[0]).toMatch(/network error/);
    });

    it('does not claim an age it was not given', () => {
      const detail =
        notice({ state: 'stale', count: 5, ready: true })?.details.join(' ') ??
        '';
      expect(detail).toMatch(/could not confirm when they were fetched/i);
      expect(detail).not.toMatch(/ago/);
    });

    it('names the window as unreported rather than inventing a number', () => {
      const detail =
        notice({
          state: 'stale',
          count: 5,
          ready: true,
          fetchedAt: FETCHED,
        })?.details.join(' ') ?? '';
      expect(detail).toMatch(/refresh window/);
      expect(detail).not.toMatch(/\d+ (hour|day)s? refresh window/);
    });
  });

  describe('when the host says nothing about the cache', () => {
    // The issue's own constraint: "if the cache genuinely does not know why it
    // is empty, say that -- an invented cause is worse than an acknowledged gap."
    it('admits the reason is unknown rather than picking one', () => {
      expect(describeOrbCacheNotice(null, NOW)?.details.join(' ')).toMatch(
        /not known from here/i,
      );
      expect(text({})).toMatch(/did not report why/i);
    });

    it('stays quiet when there are orbs to show anyway', () => {
      expect(notice({ count: 6400, ready: true, complete: true })).toBeNull();
    });

    it('treats an unrecognised state the same way', () => {
      // A newer host reporting a state this build has never heard of must not
      // fall through to silence when the list is empty.
      expect(
        text({ state: 'something-new' as OrbSearchStatus['state'] }),
      ).toMatch(/did not report why/i);
    });
  });
});

describe('describeAge', () => {
  it.each([
    ['2026-07-30T10:59:40Z', 'just now'],
    ['2026-07-30T10:59:00Z', 'about 1 minute ago'],
    ['2026-07-30T10:30:00Z', 'about 30 minutes ago'],
    ['2026-07-30T10:00:00Z', 'about 1 hour ago'],
    ['2026-07-29T11:00:00Z', 'about 1 day ago'],
    ['2026-07-01T11:00:00Z', 'about 29 days ago'],
  ])('renders %s as %s', (fetchedAt, expected) => {
    expect(describeAge(fetchedAt, NOW)).toBe(expected);
  });

  it('does not invent a duration from an unparseable timestamp', () => {
    expect(describeAge('not a date', NOW)).toBe('at an unknown time');
  });
});
