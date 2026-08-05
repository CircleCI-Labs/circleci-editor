/**
 * The one gate between a URL that came out of model output and anything this
 * app makes clickable — scheme *and* host (issues #168, #187).
 *
 * # Why a host allowlist exists at all
 *
 * A "Sources" list is an implicit endorsement: the app is telling the user
 * *these are the references for this answer*. Those URLs come from a model and
 * from third-party documentation content reached through an MCP server, so
 * without a host rule **an untrusted input decides what this tool recommends
 * the user click** — the owner's report for #187 was a citation to
 * `app.slack.com` sitting alongside real CircleCI docs. That is a phishing and
 * misdirection surface, and not one a user can be expected to police in an
 * editor they opened to edit YAML.
 *
 * #168 already allowlisted *schemes* here. #187 adds *hosts* in the same
 * function deliberately: one gate, one place to read, one place a future change
 * has to get right. `parseMarkdown` (every link in a reply body) and
 * `~/lib/ai/sources` (the Sources footer) both go through `classifyUrl`.
 *
 * # Parse the host; never string-match it
 *
 * Every check below runs against `URL`'s own parsed `hostname`, for the same
 * reason #168 parsed the scheme rather than pattern-matching it. A naive string
 * test fails in at least four ways this module's tests pin:
 *
 *  - `evil-circleci.com` passes `endsWith('circleci.com')`.
 *  - `circleci.com.evil.example` passes `includes('circleci.com')`.
 *  - `https://circleci.com@evil.example/docs` puts the trusted name in the
 *    *userinfo*; the host is `evil.example`.
 *  - `https://сircleci.com/` (Cyrillic `с`) looks identical and is a different
 *    domain; the URL parser turns it into its punycode form, which matches
 *    nothing.
 *
 * So the rule is exact-equality against a registrable domain, or a `.`-prefixed
 * suffix — never a bare suffix or a substring.
 *
 * # What is allowed, and why
 *
 *  - **`circleci.com` and every host under it.** The whole registrable domain
 *    is CircleCI's: the docs (`circleci.com/docs/…`), the orb registry
 *    (`circleci.com/developer/orbs/…`), the app, `support.circleci.com`,
 *    `discuss.circleci.com`. Accepted knowingly: `discuss.circleci.com` is
 *    user-written content on a CircleCI-owned, CircleCI-moderated host. The
 *    host boundary is the thing we can actually verify, and drawing the line
 *    per-subdomain would mean maintaining a list that goes stale the first time
 *    CircleCI adds one.
 *  - **GitHub, narrowed to CircleCI-owned orgs.** `github.com` and
 *    `raw.githubusercontent.com`, but only when the first path segment is
 *    `circleci`, `CircleCI-Public` or `CircleCI-Labs`. This is #187's own
 *    suggested narrowing and it is the right call: on GitHub the trust boundary
 *    is the *repository owner*, not the host — `github.com/someone/anything` is
 *    exactly as untrusted as any other site on the internet, and anybody can
 *    create it. Narrowing still covers the citation the owner explicitly called
 *    fine ("a wiki which is GitHub CircleCI-Public slack-orb"), which is the
 *    class of GitHub link a config editor legitimately needs: orb source, orb
 *    wikis, and the docs source itself.
 *  - **Nothing else.** `app.slack.com` (the reported case), Stack Overflow,
 *    blogs, `gist.github.com` (arbitrary user content under a GitHub host).
 *
 * A rejected URL is never silently dropped — see `parseMarkdown`'s
 * `blockedLink` inline and `~/lib/ai/sources`' `linkable: false` rows.
 */

/**
 * The URL schemes a rendered link may use, and — with the host rules below —
 * the only place this app decides what is linkable.
 *
 * Allowlisted, not denylisted: a denylist of `javascript:`/`data:`/`vbscript:`
 * is a guess about which schemes browsers will execute, and it has been wrong
 * before. `http:`/`https:` is everything a docs citation or a model-written
 * reference legitimately needs.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/** Every host under this registrable domain is CircleCI's own. */
const CIRCLECI_DOMAIN = 'circleci.com';

/**
 * Hosts where being on the host proves nothing, because anybody can publish
 * there — so the owner (the first path segment) is checked instead. See
 * `CIRCLECI_GITHUB_OWNERS`.
 */
const OWNER_SCOPED_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);

/**
 * The GitHub accounts CircleCI publishes from, lowercased for comparison
 * (GitHub owners are case-insensitive, and a citation may spell one either
 * way): `circleci` (the company org), `CircleCI-Public` (orbs, including the
 * `slack-orb` wiki the owner named) and `CircleCI-Labs` (this repository's own
 * org).
 */
const CIRCLECI_GITHUB_OWNERS = new Set([
  'circleci',
  'circleci-public',
  'circleci-labs',
]);

/** Why a URL is not linkable. `scheme` also covers unparseable and relative targets. */
export type UrlRejection = 'scheme' | 'host';

/**
 * The verdict on one URL.
 *
 * A `host` rejection deliberately carries the `hostname` (and nothing else that
 * could reach an attribute) so a caller can *say* where a link would have gone
 * without offering the click. A `scheme` rejection carries nothing: a
 * `javascript:` or `data:` target is not information worth reprinting, and #168
 * already settled that it never appears in the DOM.
 */
export type UrlVerdict =
  | { allowed: true; href: string; hostname: string }
  | { allowed: false; reason: 'scheme' }
  | { allowed: false; reason: 'host'; hostname: string };

/**
 * Classifies `raw` against the scheme and host allowlists.
 *
 * Parsing with the URL constructor rather than pattern-matching the string is
 * the point at both layers. For the scheme, the WHATWG parser strips the tab
 * and newline characters that `java\tscript:alert(1)` uses to smuggle one past
 * a regex, and lowercases it, so `JavaScript:` and `jAvAsCrIpT:` collapse to
 * the one thing the allowlist sees. It also rejects a relative URL outright (no
 * base is supplied), which is correct here: a relative link in an AI reply
 * would resolve against this app's own origin — the localhost host API.
 *
 * For the host, the parser is what strips userinfo (`https://circleci.com@evil.
 * example/` has hostname `evil.example`), drops the port, lowercases, and
 * converts a homoglyph domain to punycode.
 *
 * `href` is the parser's own serialization, so what can ever reach an
 * attribute is a URL the browser already agreed on rather than the model's
 * original bytes.
 */
export function classifyUrl(raw: string): UrlVerdict {
  const trimmed = raw.trim();
  if (trimmed === '') return { allowed: false, reason: 'scheme' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: 'scheme' };
  }
  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: 'scheme' };
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!isAllowedHost(hostname, parsed.pathname)) {
    return { allowed: false, reason: 'host', hostname };
  }
  return { allowed: true, href: parsed.href, hostname };
}

/**
 * Returns a normalized, safe `href` for `raw`, or `undefined` when `raw` must
 * not become a link. The thin wrapper `parseMarkdown` used before #187 added a
 * host rule; kept because most callers only need the yes/no.
 */
export function safeHref(raw: string): string | undefined {
  const verdict = classifyUrl(raw);
  return verdict.allowed ? verdict.href : undefined;
}

/**
 * DNS treats `circleci.com.` and `circleci.com` as the same name, and the URL
 * parser preserves the trailing dot in `hostname`. Stripping it keeps a legal
 * spelling of a trusted host from being rejected; it can never *widen* the
 * allowlist, because removing a trailing dot from `circleci.com.evil.example`
 * still leaves `circleci.com.evil.example`.
 */
function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') && lower.length > 1 ? lower.slice(0, -1) : lower;
}

/**
 * Whether `hostname` (already parsed out of a URL, never a raw string from
 * model output) is allowed — consulting `pathname` only for the owner-scoped
 * hosts, where the host alone does not establish who published the page.
 *
 * Exported for the tests, which assert the hostile cases directly against this
 * rather than only through a full URL.
 */
export function isAllowedHost(hostname: string, pathname = '/'): boolean {
  const host = normalizeHostname(hostname);
  // Exact match or a dot-prefixed suffix -- never a bare `endsWith`, which
  // `evil-circleci.com` would satisfy.
  if (host === CIRCLECI_DOMAIN || host.endsWith(`.${CIRCLECI_DOMAIN}`)) {
    return true;
  }
  if (OWNER_SCOPED_HOSTS.has(host)) {
    return isCircleCiOwnedPath(pathname);
  }
  return false;
}

/** Whether a `github.com`/`raw.githubusercontent.com` path's owner segment is one of CircleCI's own accounts. */
function isCircleCiOwnedPath(pathname: string): boolean {
  const first = pathname.split('/').find((segment) => segment !== '');
  if (first === undefined) return false;
  let owner = first;
  try {
    owner = decodeURIComponent(first);
  } catch {
    // A malformed percent-escape can only fail the comparison below, which is
    // the safe direction.
  }
  return CIRCLECI_GITHUB_OWNERS.has(owner.toLowerCase());
}

/**
 * A one-line description of what this app will and won't link to, for the UI to
 * show next to a citation it declined to link. Kept here so the copy cannot
 * drift from the rule it describes.
 */
export const TRUSTED_HOSTS_SUMMARY =
  'Only circleci.com and CircleCI-owned GitHub repositories are linked.';
