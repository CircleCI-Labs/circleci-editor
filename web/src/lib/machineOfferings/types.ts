/**
 * The machine-image catalog model `GET /api/machine-offerings` serves,
 * mirroring `internal/host/offerings.go` and `internal/offerings.Result`
 * (issue #305). Keep the two in sync.
 *
 * Read that Go package's doc comment for *why* this exists: CircleCI
 * publishes a live, unauthenticated catalog (`GET /api/v3/catalog/offerings`,
 * found in `CircleCI-Public/circleci-yaml-language-server`) of which machine
 * images are offered for which resource class, plus which images it has
 * deprecated. Fetched data supersedes `images.ts`'s hand-curated
 * `MACHINE_IMAGES` literal; a fetch failure falls back to it and says so.
 */

/**
 * The JSON shape of `GET /api/machine-offerings`.
 *
 * `available: false` means there is nothing here at all -- no catalog has
 * ever been fetched, in this process or (via the host's disk cache) a
 * previous one, and `reason` says why. It is never false merely because
 * this host has no `CIRCLE_TOKEN`: the upstream endpoint answers
 * unauthenticated (issue #305, consistent with #160 making orb browsing
 * tokenless).
 *
 * `available: true` alongside a non-empty `reason` is the
 * "stale-but-labelled" state: the most recent refresh attempt failed, but an
 * earlier one is still being served -- `stale` says how confidently to trust
 * it (see `stale`'s own doc comment), and `reason` explains why it did not
 * just get fresher.
 */
export interface MachineOfferingsResponse {
  available: boolean;
  /**
   * Set whenever `available` is false (nothing to show), or when it is true
   * but the most recent refresh attempt failed and this is an older catalog
   * being served instead (see `stale`).
   */
  reason?: string;
  /** Resource class -> offered image names, for the `machine:` executor's Linux families. */
  linux?: Record<string, string[]>;
  /** Resource class -> offered image names, for the `machine:` executor's Windows families. */
  windows?: Record<string, string[]>;
  /** Resource class -> offered image names (`xcode:<version>`), for the `macos:` executor. */
  macos?: Record<string, string[]>;
  /**
   * Executor ("linux"/"windows"/"macos") -> deprecated image names. Unlike
   * `linux`/`windows`/`macos` above, this is keyed by executor, not resource
   * class, and excludes images already listed there -- CircleCI's own
   * response shape, not a transform this app applies.
   */
  deprecated?: Record<string, string[]>;
  /** ISO 8601; when the served catalog was actually fetched -- may be well in the past for a cache hit or a stale-but-labelled response. */
  fetchedAt?: string;
  /** True iff this response required a live fetch just now, false for a cache hit. */
  live?: boolean;
  /**
   * True iff `fetchedAt` is older than the host's own refresh window
   * (`internal/offerings`' `cacheTTL`, 24h) -- the picker should say so
   * rather than presenting an old catalog as current.
   */
  stale?: boolean;
}
