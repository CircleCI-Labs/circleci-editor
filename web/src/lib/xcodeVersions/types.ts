/**
 * The supported-Xcode model `GET /api/xcode-versions` serves, mirroring
 * `internal/guides/xcodeversions.go` (issue #211, closing issue #203). Keep the
 * two in sync; the host's own `xcodeversions_test.go` spells the JSON field names
 * out independently, so a rename on either side fails a test there.
 *
 * Read that Go file for *why* these are derived from CircleCI's vendored
 * supported-Xcode table rather than hardcoded here. The short version: there used
 * to be one hardcoded value, `15.3.0`, and it was not a version CircleCI ever
 * offered -- so the macOS card created jobs that could not run.
 */
import type { GuideProvenance } from '~/lib/guides/types';

/** One row of CircleCI's supported-Xcode table. */
export interface XcodeVersion {
  /**
   * The value to write as `xcode:`, verbatim from the table's "Config" column.
   *
   * Written to YAML as a *string*: `26.5` unquoted is a YAML float, and
   * `14.3.1` unquoted is not a number at all, so a config that round-tripped
   * through a numeric type would silently change meaning. See
   * `setJobXcodeVersion` in `configMutations.ts`.
   */
  version: string;
  /** CircleCI's own wording for the same row, including Apple's build number ("Xcode 26.5 (17F42)"). */
  label?: string;
  /** The table's remaining non-link columns ("macOS Version 26.3.1"), for a tooltip. */
  spec?: string;
  /** The resource classes the table says this image runs on. */
  resourceClasses?: string[];
  /**
   * Upstream's own row marks this version a beta or release candidate. False
   * means "the table does not say so", not "this is stable" -- nothing asserts
   * stability the table has not claimed.
   */
  prerelease?: boolean;
  /** `'beta'` or `'release candidate'`, in upstream's vocabulary, when `prerelease`. */
  prereleaseKind?: string;
}

/**
 * The JSON shape of `GET /api/xcode-versions`.
 *
 * Same stance as `ResourceClassesResponse`: no `available` flag, because "is
 * there anything to render?" is answered by `versions` being empty, and the flag
 * callers must branch on is `derived`.
 */
export interface XcodeVersionsResponse {
  versions: XcodeVersion[];
  /**
   * The version a newly created macOS job should start on -- the newest one
   * upstream does not mark a pre-release.
   *
   * Served rather than recomputed here so "what does a new macOS job get?" has
   * exactly one answer. Issue #203's defect was three copies of a literal (the
   * palette card, the mutation layer's fallback, and the docs' own example)
   * disagreeing with the table and with each other.
   */
  default: string;
  /**
   * False when the versions came from the snapshot embedded in the running
   * release rather than the documentation the host is currently serving. The
   * field must say so when this is false.
   */
  derived: boolean;
  /** Set when `derived` is false: a sentence to show the user. */
  reason?: string;
  /** Dates the underlying documentation, exactly as `GET /api/guides` reports it. */
  provenance?: GuideProvenance;
}
