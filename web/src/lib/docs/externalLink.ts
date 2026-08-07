/**
 * One question, asked the same way everywhere a URL is about to be rendered
 * as a link: does following it leave this app? (issue #10)
 *
 * The reference pane renders two kinds of clickable thing side by side in the
 * same prose -- an in-pane cross-reference (`SpanRef`/`resolveRef`, a
 * `<button>` that calls back into this app's own navigation) and an outbound
 * link (`SpanLink`, an `<a href>`). Before this module existed they were
 * styled identically, so a reader could not tell which was which without
 * clicking. `ProvenanceFooter`'s "Read on circleci.com" already carried a
 * visible external marker; this is that same treatment, generalised.
 *
 * The rule is deliberately computed from the URL itself -- its origin versus
 * this app's own -- rather than from *which span kind carried it* or *which
 * component is rendering it*. Two reasons:
 *
 *  1. Every link this app renders today happens to be off-app in practice
 *     (`circleci.com`, `mailto:`, a GitHub commit URL) because this SPA has
 *     no URL-addressable views of its own -- every one of its "pages" is a
 *     pane state, not a route. A rule keyed on span kind would happen to
 *     agree with this one today, but it would be encoding "a `link` span is
 *     external" as a fact about the *renderer*, not about the *target* --
 *     exactly the drift issue #10 warns about ("so a link added later is
 *     marked correctly without anyone remembering to"). A future span kind,
 *     or a future in-app route, must not require finding and updating every
 *     call site that hardcoded the old assumption.
 *  2. It composes. `GuideBlocks.tsx` is the first caller, but any future
 *     surface that renders a URL from data it did not author (an AI
 *     citation, a orb-registry link) can ask the same question the same way.
 */

/**
 * `true` when `url` resolves to somewhere other than `appOrigin` -- i.e.
 * following it leaves the app, opens a new tab/window, or hands off to
 * another program (a mail client for `mailto:`).
 *
 * `appOrigin` defaults to `window.location.origin` (this app's own running
 * origin) rather than being hardcoded, so a test can assert the classifier's
 * *logic* against a fixed origin without depending on jsdom's default one.
 *
 * A URL that cannot be parsed as absolute, or carries a scheme with no
 * origin concept at all (`mailto:`, `tel:` -- `URL.origin` is the literal
 * string `"null"` for these per the URL spec), is treated as external. Both
 * are "cannot be shown to stay in this app," and overclaiming "leaves" is the
 * safe direction to be wrong in here: the cost of a spurious arrow next to a
 * link that happens to be harmless is a minor visual tell; the cost of the
 * opposite mistake is a reader trusting a link to keep them in the app when
 * it does not.
 */
export function isExternalUrl(
  url: string | undefined,
  appOrigin: string = window.location.origin,
): boolean {
  // No URL at all is not "leaves the app" -- there is nowhere to leave *to*,
  // and a marker promising a new tab that a click cannot actually open would
  // be its own kind of dishonest link.
  if (!url) return false;
  try {
    return new URL(url, appOrigin).origin !== appOrigin;
  } catch {
    return true;
  }
}
