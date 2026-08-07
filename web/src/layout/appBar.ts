/**
 * How much of the app bar's furniture is shown at a given window width
 * (issues #154, #166).
 *
 * The bar's items fall into two kinds:
 *
 * - **Bounded** -- the app name, the config path, the preset switcher. Each has
 *   a fullest form and one or more terser ones, and which one shows is decided
 *   here.
 * - **One unbounded item** -- the `.circleci` file switcher, which is N files
 *   with arbitrary names. It decides its own form by measuring its row against
 *   the space this bar actually left it, and collapses to a menu rather than to
 *   a scroll region (the #154 defect). See `ConfigFileSwitcher`.
 *
 * The two have to be coordinated, because **a tier upgrade spends more
 * furniture than a modest widening gains**: `tight` -> `compact` swaps a ~120px
 * preset menu for 404px of pills and lengthens the config path, roughly 480px
 * of new furniture for 256px of new window. Upgrade naively on width alone and
 * there is a band just above each threshold where the bar has *less* room for
 * the file switcher than it had on a narrower window -- measured on the real app
 * during #154: 451px of switcher room at 1024px and 221px at 1280px, i.e.
 * widening the window collapsed a switcher that had been showing its buttons.
 *
 * ## How #154 coordinated them, and why #166 had to change it
 *
 * #154 costed the switcher's measured need into the tier decision, against a
 * table of each tier's own *predicted* fixed cost (`APP_BAR_FIXED_PX`, measured
 * by hand at four widths). That table was wrong within days, and the way it was
 * wrong is worth recording, because it is the trap any such table falls into:
 *
 * The numbers were taken while `validation.state` was `idle`, when
 * `ValidationBadge` renders **nothing at all**. About a second after load
 * validation resolves and the badge appears -- measured on the real app, the
 * right-hand group goes 648px -> 745px ("Checking...") -> 708px ("Valid"). So
 * the `compact` tier's real cost is 1119px, not the 1060px in the table. At
 * 1280px with a 185px switcher row (the `.circleci` listing `#144`'s spec uses)
 * the budget concluded `compact` fitted -- 1060 + 185 + 24 = 1269 <= 1280 --
 * when in truth 1119 + 185 = 1304 > 1280. The bar upgraded into a tier with no
 * room, and the switcher then collapsed *correctly*, doing exactly its job, at
 * a width where the next tier down had 460px to spare.
 *
 * It also presented as a mystery. `e2e/config-switcher.spec.ts` asserts inside
 * the ~700ms window before validation resolves, so it passed on a fast machine
 * and failed on a loaded one -- which looks exactly like a measurement race and
 * is not one.
 *
 * ## What this module does now
 *
 * No cost table, and no prediction. Instead:
 *
 * 1. `baseAppBarTier` picks a tier from the bar's measured width alone -- two
 *    plain thresholds, nothing about the switcher. Deliberately *optimistic*:
 *    each threshold is just above what that tier's own furniture costs, i.e. the
 *    narrowest bar it fits in if the switcher needed no room at all.
 * 2. If the switcher reports it actually had to collapse, the bar **steps down**
 *    one tier and lets it try again. A terser tier strictly frees space, so this
 *    converges in at most two steps, and it is driven by a *measured fact* ("the
 *    row did not fit") rather than by an estimate of what would fit.
 * 3. If the switcher still cannot fit its row even at the tersest tier, the
 *    demotions bought nothing -- so the width is handed back and the base tier
 *    is restored, with the switcher in its menu form. That is the right outcome:
 *    the row was never going to fit, so there is no reason to also give up the
 *    config path.
 *
 * The upshot is that being wrong about a width is now self-correcting rather
 * than a wrong collapse, so the bar gaining items it doesn't have yet (a
 * late-arriving badge, issue #149's org/project display) can no longer produce
 * one. What guarantees nothing *scrolls* and nothing overflows the page remains
 * structural, as it was in #154: a clipping header, `min-w-0` throughout, and a
 * switcher slot that is `overflow-hidden` and never `auto`.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

import { useElementSize } from './useElementSize';

/**
 * `tight` -- app name shortened, config path down to its basename, preset
 *   switcher collapsed to a menu.
 * `compact` -- config path down to its last two segments; preset pills kept.
 * `full` -- everything in its fullest form.
 *
 * Ordered tersest-first: this array *is* the ladder, and a demotion is one step
 * towards index 0. There is no tier at which a control becomes unreachable --
 * every step down is to a terser label or to a keyboard-accessible menu, never
 * to nothing.
 */
export const APP_BAR_TIERS = ['tight', 'compact', 'full'] as const;

export type AppBarTier = (typeof APP_BAR_TIERS)[number];

/**
 * What each tier's own furniture costs, with the file switcher rendering nothing
 * at all -- **measured** on the real running app in both themes (identical;
 * nothing in the bar changes size with the theme), with validation settled so
 * the `ValidationBadge` is present, and at a width wide enough that the identity
 * group is not being squeezed (a clamped measurement reads as the viewport
 * width, not as the cost):
 *
 * | tier | app name | config path | branch + repo | preset switcher | total |
 * |---|---|---|---|---|---|
 * | `tight` | short | basename | one 26px link | menu | **751** |
 * | `compact` | **short** | last two segments | two cells | pills | **1189** |
 * | `full` | full | absolute | two cells | pills | **1421** |
 *
 * (Before issue #214: 725 / 1212 / 1341.)
 *
 * #214 moved these in both directions at once, and that is the whole of how its
 * new items were *paid for* rather than simply added:
 *
 * - the branch cell plus the repository link (`layout/CheckoutIdentity`) cost a
 *   measured **+81px**;
 * - at `tight` they fold into a single 26px link and the identity group's gaps
 *   tighten from 12px to 8px, so `tight` pays **+26** rather than +81;
 * - at `compact` the app name drops to its short form, freeing **109px**
 *   (205px -> 96px at 14px semibold).
 *
 * So `compact` gets *cheaper* than it was (1212 -> 1189), which is what keeps
 * 1280px -- a very ordinary laptop width, and Playwright's default viewport --
 * on `compact` with its preset pills and two-segment path instead of demoting it
 * to `tight`. Demoting it would have recreated exactly the band #154 exists to
 * remove.
 *
 * The demotion at `tight` is not decoration either: at the full +81 an ordinary
 * *two-file* `.circleci` directory (a 249px row) lost its buttons at 1024px,
 * which `e2e/responsive-layout.spec.ts` catches by name -- collapse must be a
 * response to real crowding, not to a width. At +26 it keeps them.
 *
 * `full` pays the whole +81, because it keeps the long app name by definition.
 * Its measured consequence, recorded rather than discovered later: the absolute
 * config path now needs a 1436px window instead of 1356px.
 *
 * The remaining cost, stated plainly rather than left to be rediscovered: a
 * six-file directory's 689px row of buttons now needs a ~1510px window instead
 * of ~1430px. An ordinary two-file directory is unaffected at every width this
 * app targets, and the property #154 cares about -- widening never takes away a
 * row of buttons that was showing -- still holds across the whole sweep
 * (`e2e/responsive-layout.spec.ts`). See #225 for the candidates for buying that
 * 80px back, none of which is obviously right, which is why none was taken here.
 *
 * Recorded so the thresholds below are auditable arithmetic, and *only* for
 * that. Read this module's doc comment before trusting them for anything more:
 * #154 used a table like this as a **budget**, deciding a tier by predicting
 * whether the switcher's row would also fit, and being wrong then produced a
 * wrong collapse.
 *
 * Issue #149 is the concrete demonstration of why that had to change. It added
 * the org/project display to the identity group, which costs ~108px -- so it had
 * to hand-bump every entry of #154's table by 110 to avoid recreating the exact
 * band the responsive work exists to remove. Under the current design a stale
 * table cannot do that: it costs a starting guess that is one tier too terse,
 * which the ladder then simply never demotes from. These numbers are re-measured
 * here because a good starting guess avoids a frame of settling, not because
 * anything depends on them being right.
 */
export const APP_BAR_FURNITURE_PX: Record<AppBarTier, number> = {
  tight: 751,
  compact: 1189,
  full: 1421,
};

/*
 * These were measured while the app was called "CircleCI Visual Config Editor"
 * (short form "Config Editor"). It is now "CircleCI Editor" (short form
 * "Editor"), so every entry above over-states the furniture by roughly the
 * width the removed words occupied.
 *
 * Left as measured rather than adjusted by arithmetic on a font's advance
 * widths, because a guessed number here is worth less than a stale measured
 * one: per this module's contract these are only a *starting* tier, and being
 * pessimistic costs a bar that begins one tier terser than it needed to --
 * nothing that can collapse wrongly. The whole responsive sweep in
 * `e2e/responsive-layout.spec.ts` passes unchanged after the rename, which is
 * the property that actually matters.
 *
 * Worth re-measuring the next time someone is in here with the app running.
 */

/**
 * At or above this measured bar width the config path shows its last two
 * segments and the preset switcher keeps its row of pills.
 *
 * This and `APP_BAR_FULL_PX` are deliberately **optimistic**: each is barely
 * above the tier's own measured furniture cost, i.e. the narrowest bar in which
 * that tier could fit *if the file switcher needed no room at all*. That is the
 * right kind of wrong. Too optimistic and the demotion walk measures the
 * shortfall and steps back down -- no wrong collapse, just a couple of frames of
 * settling on load. Too pessimistic and the bar merely looks terser than it had
 * to, which nothing can detect but a screenshot. #154's numbers tried to be
 * *accurate* instead, which meant being wrong produced a wrong collapse.
 */
export const APP_BAR_COMPACT_PX = APP_BAR_FURNITURE_PX.compact + 17;

/** At or above this measured bar width the config path shows in full. See
 * `APP_BAR_COMPACT_PX` for why this sits just above the measured cost. */
export const APP_BAR_FULL_PX = APP_BAR_FURNITURE_PX.full + 15;

/**
 * The tier the bar's width alone asks for, before any demotion.
 *
 * An *optimistic* starting point: the richest tier whose own furniture fits,
 * assuming the file switcher needs no room. When that assumption is wrong the
 * switcher says so and `useAppBarTier` walks back down -- which is where
 * correctness actually comes from. Nothing here predicts the switcher's needs,
 * deliberately; see this module's doc comment for what happened when #154 did.
 */
export function baseAppBarTier(widthPx: number): AppBarTier {
  // 0 means "not measured yet" (see `useElementSize`), and the first paint
  // should not be the *widest* guess -- an over-wide first render is the one
  // that overflows and then visibly reflows. `tight` fits everywhere.
  if (widthPx <= 0) return 'tight';
  if (widthPx >= APP_BAR_FULL_PX) return 'full';
  if (widthPx >= APP_BAR_COMPACT_PX) return 'compact';
  return 'tight';
}

/** Applies `demotions` steps down the ladder from whatever `widthPx` asks for,
 * clamped at the tersest tier. */
export function resolveAppBarTier(
  widthPx: number,
  demotions: number,
): AppBarTier {
  const base = APP_BAR_TIERS.indexOf(baseAppBarTier(widthPx));
  const index = Math.max(0, base - Math.max(0, demotions));
  // Non-null: `index` is clamped into this array's own range.
  return APP_BAR_TIERS[index]!;
}

/** How many steps down the ladder `widthPx`'s own tier leaves available. */
export function availableDemotions(widthPx: number): number {
  return APP_BAR_TIERS.indexOf(baseAppBarTier(widthPx));
}

/**
 * The file switcher's report of whether its row fitted.
 *
 * `reportId` exists because the demotion walk cannot be driven by a boolean
 * alone. After the bar demotes one tier the switcher re-measures and, if the
 * row still doesn't fit, reports `collapsed: true` *again* -- an unchanged
 * value, so nothing re-runs and the walk stalls one tier short. Measured on the
 * real app while building this: at 1600px and 1680px with a six-file directory
 * the walk stopped at `compact` and left the row collapsed, when `tight` had
 * 968px available for a 689px row. Incrementing an id on every measurement
 * makes each report distinguishable from the last, so the walk advances until
 * the row fits or the ladder runs out.
 */
export interface SwitcherFitReport {
  collapsed: boolean;
  reportId: number;
}

export const INITIAL_SWITCHER_FIT: SwitcherFitReport = {
  collapsed: false,
  reportId: 0,
};

/** Folds a fresh measurement into the previous report, advancing `reportId`. */
export function nextSwitcherFit(
  previous: SwitcherFitReport,
  collapsed: boolean,
): SwitcherFitReport {
  return { collapsed, reportId: previous.reportId + 1 };
}

interface TierProbe {
  /** The bar width these demotions were decided for. A width change restarts
   * the probe from the top, and is the only thing that does -- which is what
   * makes the ladder unable to oscillate: within one width, `demotions` only
   * ever increases, and then settles. */
  forWidth: number;
  demotions: number;
  /** Set once no further demotion could help, so the probe stops reacting to
   * the switcher's reports and the bar holds still. */
  settled: boolean;
}

const INITIAL_PROBE: TierProbe = {
  forWidth: -1,
  demotions: 0,
  settled: false,
};

/**
 * Tracks the tier for the app bar element `ref` points at.
 *
 * Measures the header itself rather than reading `window.innerWidth`, so the
 * bar adapts to the space it is actually given -- the two are the same today,
 * and this stays correct if the app is ever embedded in something narrower.
 *
 * `fit` is the file switcher's own report of whether it had to fall back to its
 * menu form. It is a *measured outcome*, not a prediction, and it is the only
 * thing that drives a demotion -- see this module's doc comment for why #154's
 * predicted cost table had to go.
 *
 * Returns `settled` alongside the tier: `true` once the arrangement will not
 * change again at this width, either because the row fits or because no further
 * demotion could help. The app bar publishes it as a DOM attribute so e2e specs
 * can wait for the *final* arrangement instead of a frame count -- which is what
 * makes this deterministic under CI load rather than merely usually-right.
 */
export function useAppBarTier(
  ref: RefObject<HTMLElement | null>,
  fit: SwitcherFitReport,
): { tier: AppBarTier; settled: boolean } {
  const width = useElementSize(ref).width;
  const [probe, setProbe] = useState<TierProbe>(INITIAL_PROBE);

  // A width change resets the probe *for this render*, rather than via a state
  // update and a second pass -- so a resize never paints one frame at the
  // previous width's demotions.
  const current: TierProbe =
    probe.forWidth === width
      ? probe
      : { forWidth: width, demotions: 0, settled: false };

  useLayoutEffect(() => {
    setProbe((previous) => {
      const base: TierProbe =
        previous.forWidth === width
          ? previous
          : { forWidth: width, demotions: 0, settled: false };

      if (base.settled) return base;
      // The row fits at this tier: nothing to do, and deliberately *no* reset
      // of `demotions` -- undoing the demotion that is the very reason the row
      // fits is how this would oscillate.
      if (!fit.collapsed) return base;

      if (base.demotions >= availableDemotions(width)) {
        // Even the tersest tier can't fit the row, so the demotions bought
        // nothing. Hand the width back to the config path and accept the
        // switcher's menu form -- the row was never going to fit.
        return { forWidth: width, demotions: 0, settled: true };
      }
      return { forWidth: width, demotions: base.demotions + 1, settled: false };
    });
    // `fit.reportId`, not `fit.collapsed`: every measurement has to advance the
    // walk, including one that repeats the previous verdict. See
    // `SwitcherFitReport`.
  }, [width, fit.collapsed, fit.reportId]);

  return {
    tier: resolveAppBarTier(width, current.demotions),
    // `reportId > 0` matters as much as the rest: without it this reads `true`
    // on the very first render, because `INITIAL_SWITCHER_FIT.collapsed` is
    // `false` and "not collapsed" otherwise means "nothing left to do". A spec
    // waiting on this would then be free to assert before the switcher had
    // measured anything at all -- reintroducing exactly the assert-too-early
    // hazard that made #166's cause look like a timing race. The switcher
    // reports unconditionally once mounted, including when it renders nothing at
    // all, so this always becomes true shortly after load.
    settled: fit.reportId > 0 && (current.settled || !fit.collapsed),
  };
}
