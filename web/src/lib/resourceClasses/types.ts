/**
 * The resource-class model `GET /api/resource-classes` serves, mirroring
 * `internal/guides/resourceclasses.go` (issue #181). Keep the two in sync; the
 * host's own `resourceclasses_test.go` spells the JSON field names out
 * independently, so a rename on either side fails a test there.
 *
 * Read that Go file for *why* these are derived from CircleCI's vendored
 * resource tables rather than hardcoded here. The short version: they used to be
 * hardcoded, and they drifted -- Docker was offered no Arm classes at all, the
 * machine executor was missing the larger Arm sizes, no gen2 class appeared
 * anywhere, and macOS still offered classes upstream had stopped documenting.
 */
import type { GuideProvenance } from '~/lib/guides/types';

/** The architectures a resource class can be offered under, as the host spells them. */
export const ARCH_X86 = 'x86_64';
export const ARCH_ARM = 'arm64';
/**
 * An environment whose table states no architecture -- macOS today. Not a bug
 * and not an "unknown": `m4pro.medium` is Apple silicon, but the resource table
 * does not say so and the host refuses to assert what the tables do not carry.
 * The picker treats this as "always show", never as a third architecture.
 */
export const ARCH_UNSTATED = '';

/** One row of one upstream resource table. */
export interface ResourceClass {
  /** The value to write as `resource_class:`, verbatim from the table. */
  name: string;
  /** The table's own machine description ("vCPUs 2, RAM 8GB"), for a tooltip. */
  spec?: string;
  /** Upstream marks this class "(default)" for its environment. */
  default?: boolean;
  /** `ARCH_X86`, `ARCH_ARM` or `ARCH_UNSTATED`, derived from `name` by the host. */
  architecture: string;
  /** `'gen1'` or `'gen2'`, derived from `name` by the host. */
  generation: string;
}

/** One upstream resource table: an executor environment's classes, plus what a picker needs to group and filter them. */
export interface ResourceClassEnvironment {
  /** Upstream's own configuration-reference anchor -- the id `paletteExecutors.ts` names. */
  id: string;
  /** The upstream heading above the table, verbatim. Shown as an option-group label, so the wording is CircleCI's. */
  label: string;
  /** The executor key these classes belong to. */
  kind: 'docker' | 'machine' | 'macos';
  /** The architecture every class here shares, or `ARCH_UNSTATED`. */
  architecture: string;
  /** The generation every class here shares, or `''` when they differ. */
  generation: string;
  classes: ResourceClass[];
}

/**
 * The JSON shape of `GET /api/resource-classes`.
 *
 * There is deliberately no `available` flag: "is there anything to render?" is
 * answered by `environments` being empty, and the flag callers must actually
 * branch on is `derived`.
 */
export interface ResourceClassesResponse {
  environments: ResourceClassEnvironment[];
  /**
   * False when the classes came from the snapshot embedded in the running
   * release rather than from the documentation the host is currently serving.
   * The executor field must say so when this is false -- a stale list presented
   * as current is worse than an admitted one.
   */
  derived: boolean;
  /** Set when `derived` is false: a sentence to show the user. */
  reason?: string;
  /** Dates the underlying documentation, exactly as `GET /api/guides` reports it. */
  provenance?: GuideProvenance;
}
