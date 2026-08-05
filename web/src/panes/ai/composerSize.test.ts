import { afterEach, describe, expect, it, vi } from 'vitest';

import { MIN_PANE_PX } from '~/layout/constants';

import {
  COMPOSER_CHROME_PX,
  COMPOSER_HINT_PX,
  COMPOSER_MIN_PX,
  COMPOSER_SCHEMA_VERSION,
  COMPOSER_STORAGE_KEY,
  TRANSCRIPT_RESERVE_PX,
  UNMEASURED_MAX_PX,
  clampComposerPx,
  draftLineCount,
  maxComposerPx,
  readPersistedComposerHeight,
  resolveComposerHeight,
  writePersistedComposerHeight,
} from './composerSize';

/** Everything the box can never have: its own chrome, its hint line, and one line of conversation. */
const RESERVED = COMPOSER_CHROME_PX + COMPOSER_HINT_PX + TRANSCRIPT_RESERVE_PX;

/**
 * Issues #186 and #209. The composer's height is a pure function precisely so the
 * behaviour the issues ask for can be pinned without a layout engine: jsdom has
 * none, and "does it grow, and does it stop growing before it eats the
 * transcript" is exactly the kind of claim that otherwise only gets checked by
 * eye.
 */
describe('resolveComposerHeight', () => {
  const PANE = 500;

  it('is at its minimum with nothing typed', () => {
    expect(
      resolveComposerHeight({
        contentPx: 0,
        preferredPx: null,
        availablePx: PANE,
      }),
    ).toMatchObject({ heightPx: COMPOSER_MIN_PX, overflowing: false });
  });

  it('grows with its content, with no user action at all', () => {
    // The seeded-prompt case: the box must be readable the moment the prompt
    // lands, not after the user discovers a resize handle.
    const { heightPx } = resolveComposerHeight({
      contentPx: 180,
      preferredPx: null,
      availablePx: PANE,
    });
    expect(heightPx).toBe(180);
  });

  it('grows into the whole range for a draft it cannot show, and reports that it is scrolling', () => {
    // Issue #209 inverted #186's half-the-range cap. That cap existed because
    // `DraftPreview` was judged a better use of the other half; with the preview
    // deleted the box is the *only* thing that shows an unsent draft, so it takes
    // the room.
    const { heightPx, maxPx, overflowing } = resolveComposerHeight({
      contentPx: 900,
      preferredPx: null,
      availablePx: PANE,
    });
    expect(heightPx).toBe(maxPx);
    expect(maxPx).toBe(PANE - RESERVED);
    // ...and it says so, which is what replaced the second surface.
    expect(overflowing).toBe(true);
  });

  it('always leaves a line of conversation, whatever the pane size', () => {
    // The transcript can be short. It can never be nothing -- a pane that looked
    // as though it had lost the conversation is what `TRANSCRIPT_RESERVE_PX` is
    // for. Asserted across real pane heights rather than at one convenient
    // number.
    for (const availablePx of [200, 260, 340, 500, 900]) {
      const { heightPx } = resolveComposerHeight({
        contentPx: 5_000,
        preferredPx: null,
        availablePx,
      });
      expect(
        availablePx - heightPx - COMPOSER_CHROME_PX - COMPOSER_HINT_PX,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('treats the user’s size as a floor, not a fixed height', () => {
    // At rest it is what they chose...
    expect(
      resolveComposerHeight({
        contentPx: 40,
        preferredPx: 200,
        availablePx: PANE,
      }).heightPx,
    ).toBe(200);
    // ...and content still grows it from there, up to the automatic cap, which is
    // why there is no "auto vs manual" mode to get out of sync.
    expect(
      resolveComposerHeight({
        contentPx: 210,
        preferredPx: 200,
        availablePx: PANE,
      }).heightPx,
    ).toBe(210);
    // Past the ceiling it stops, exactly as it would with no preference at all --
    // the preference raised the floor, not the ceiling.
    const { heightPx, maxPx } = resolveComposerHeight({
      contentPx: 900,
      preferredPx: 200,
      availablePx: PANE,
    });
    expect(heightPx).toBe(maxPx);
  });

  it('reports whether there is any range to resize through at all', () => {
    // `Composer` hides the handle when there is not, rather than offering a
    // control that cannot move -- and hands its 12px to the text area on exactly
    // the panes that are short of them.
    expect(
      resolveComposerHeight({
        contentPx: 0,
        preferredPx: null,
        availablePx: PANE,
      }).resizable,
    ).toBe(true);
    expect(
      resolveComposerHeight({
        contentPx: 0,
        preferredPx: null,
        availablePx: COMPOSER_MIN_PX + 10,
      }).resizable,
    ).toBe(false);
  });

  it('never leaves the transcript with nothing, however tall the content or the preference', () => {
    for (const preferredPx of [null, 10_000]) {
      const { heightPx } = resolveComposerHeight({
        contentPx: 10_000,
        preferredPx,
        availablePx: PANE,
      });
      expect(heightPx).toBeLessThanOrEqual(PANE - RESERVED);
      expect(PANE - heightPx).toBeGreaterThanOrEqual(RESERVED);
    }
  });

  it('hands the space straight back when the draft is sent', () => {
    // `contentPx` collapses with the draft, and with no stored preference the
    // box returns to its minimum -- growing is never permanent.
    expect(
      resolveComposerHeight({
        contentPx: 0,
        preferredPx: null,
        availablePx: PANE,
      }).heightPx,
    ).toBe(COMPOSER_MIN_PX);
  });

  it('has no range at all on the default preset, and says the draft is scrolling instead', () => {
    // Measured on the running app, and the numbers matter more than a round
    // guess: on 1280x720 with `graph-focus`, the AI pane is 178px, which leaves a
    // 99px column. Since #253 deleted the transparency line that used to take
    // ~25px of it, the composer and the transcript share all 99px -- and the
    // verdict below is *unchanged* by that, which is the point of pinning it:
    // reclaiming a row does not buy this pane a range.
    //
    // The box stays at its minimum however long the draft, and a preference stored
    // on a bigger window is clamped rather than honoured into a crushed transcript.
    // That is honest for a pane this small and it is *not* a fix for #209's
    // requirement: a thirty-line prompt is ~600px of text, and no arrangement of a
    // 99px region shows it. What #209 delivers here is `overflowing: true` -- the
    // box says it is holding more than it shows -- plus a composer that is no
    // longer the row pushed below the pane's own fold. The pane's default *share*
    // is #205's, still open; see this module's header.
    const DEFAULT_PRESET_REGION_PX = 99;
    expect(maxComposerPx(DEFAULT_PRESET_REGION_PX)).toBe(COMPOSER_MIN_PX);
    expect(
      resolveComposerHeight({
        contentPx: 900,
        preferredPx: 400,
        availablePx: DEFAULT_PRESET_REGION_PX,
      }),
    ).toMatchObject({
      heightPx: COMPOSER_MIN_PX,
      overflowing: true,
      resizable: false,
    });

    // The pane's own declared minimum (#154/#175) is barely better: a couple of
    // lines, still nothing like a seeded prompt.
    expect(maxComposerPx(MIN_PANE_PX.ai.height)).toBeLessThan(100);
  });

  it('falls back to a size-independent ceiling when the pane has not been measured', () => {
    // Before the first layout effect, and permanently in jsdom. Returning the
    // input unclamped would make a keyboard resize silently do nothing there --
    // the same reasoning as `clampRatio` in `layout/constants.ts`.
    expect(maxComposerPx(0)).toBe(UNMEASURED_MAX_PX);
    expect(maxComposerPx(Number.NaN)).toBe(UNMEASURED_MAX_PX);
    expect(
      resolveComposerHeight({
        contentPx: 900,
        preferredPx: null,
        availablePx: 0,
      }).heightPx,
    ).toBe(UNMEASURED_MAX_PX);
  });

  it('clamps a gesture into the range and rounds it', () => {
    expect(clampComposerPx(1, PANE)).toBe(COMPOSER_MIN_PX);
    expect(clampComposerPx(10_000, PANE)).toBe(PANE - RESERVED);
    expect(clampComposerPx(120.6, PANE)).toBe(121);
    expect(clampComposerPx(Number.NaN, PANE)).toBe(COMPOSER_MIN_PX);
  });
});

describe('the persisted composer height', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is absent on a first run', () => {
    expect(readPersistedComposerHeight()).toBeNull();
  });

  it('round-trips through one versioned key', () => {
    writePersistedComposerHeight(232.4);
    expect(window.localStorage.getItem(COMPOSER_STORAGE_KEY)).toBe(
      JSON.stringify({ schemaVersion: COMPOSER_SCHEMA_VERSION, heightPx: 232 }),
    );
    expect(readPersistedComposerHeight()).toBe(232);
  });

  it('ignores a value from another schema version, or any shape it does not recognise', () => {
    for (const raw of [
      JSON.stringify({ schemaVersion: 99, heightPx: 300 }),
      JSON.stringify({ schemaVersion: COMPOSER_SCHEMA_VERSION }),
      JSON.stringify({
        schemaVersion: COMPOSER_SCHEMA_VERSION,
        heightPx: 'tall',
      }),
      JSON.stringify({
        schemaVersion: COMPOSER_SCHEMA_VERSION,
        heightPx: Number.NaN,
      }),
      'not json',
      '[]',
      'null',
    ]) {
      window.localStorage.setItem(COMPOSER_STORAGE_KEY, raw);
      expect(readPersistedComposerHeight()).toBeNull();
    }
  });

  it('never throws when storage itself does', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readPersistedComposerHeight()).toBeNull();
    expect(() => writePersistedComposerHeight(200)).not.toThrow();
  });

  it('returns the stored value unclamped, so a narrow window cannot overwrite an intent', () => {
    // Same rule as a persisted split ratio (`renderRatio`): the stored number is
    // what the user asked for on whatever window they asked for it on, and it is
    // clamped per render rather than rewritten.
    writePersistedComposerHeight(900);
    expect(readPersistedComposerHeight()).toBe(900);
    expect(
      resolveComposerHeight({
        contentPx: 0,
        preferredPx: 900,
        availablePx: 400,
      }).heightPx,
    ).toBe(400 - RESERVED);
  });
});

describe('draftLineCount', () => {
  it('counts the lines the box is holding, which is what the overflow notice quotes', () => {
    expect(draftLineCount('')).toBe(0);
    expect(draftLineCount('one')).toBe(1);
    expect(draftLineCount('one\ntwo\nthree')).toBe(3);
    // A trailing newline is a line the user can put a caret on, so it counts.
    expect(draftLineCount('one\n')).toBe(2);
  });
});
