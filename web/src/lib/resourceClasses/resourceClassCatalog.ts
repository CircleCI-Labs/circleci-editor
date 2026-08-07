/**
 * Implements `detectResourceUtilization.ts`'s `ResourceClassCatalog` from
 * `GET /api/resource-classes`' own environments (issue #8), so a right-sizing
 * finding can finally name a target class instead of only observing one.
 *
 * # Why this exists instead of #305's offerings cache
 *
 * `detectResourceUtilization.ts`'s own doc comment used to say the offerings
 * cache (`useMachineOfferings`, issue #305) would eventually fill this role.
 * It cannot: verified against a live `GET /api/v3/catalog/offerings` payload,
 * that endpoint is purely resource-class-name -> image-list, with no `cpu`,
 * `ram`, `size`, `order` or `rank` field anywhere in it, and it excludes every
 * Docker class outright (see `internal/guides/resourceclasses.go`'s own doc
 * comment on why it was never retired in favour of that endpoint). It answers
 * "which classes exist and what can run on them", never "which is bigger".
 *
 * The resource-class tables already vendored for issue #181 answer the size
 * question directly: `rank`, on each `ResourceClass`, is the host's own
 * derivation from those tables' vCPU/RAM columns (see
 * `internal/guides/resourceclassrank.go`). This module's whole job is
 * translating that into the two methods `ResourceClassCatalog` needs --
 * nothing here re-derives an ordering, it only reads the one the host already
 * computed.
 *
 * # Why "platform" means `kind`, not an environment id
 *
 * `findResourceUtilizationFindings` calls `smallerClasses(job.executor,
 * job.resourceClass)`. `job.executor` is the Usage Export API's own EXECUTOR
 * column, which is one of exactly `internal/guides`' three native executor
 * keys ("docker", "machine", "macos") -- the same three values
 * `ResourceClassEnvironment.kind` already carries. A job's executor is never
 * "x86" or "arm" on its own; that split is a `resource_class` detail this
 * module resolves by finding *which* same-`kind` environment actually lists
 * the class named, then ranking only within that one table -- never across
 * the several environments one executor kind can have (Docker alone has
 * three), and never across kinds at all. That is what keeps a Docker
 * `large` from ever being treated as bigger or smaller than a macOS `large`.
 *
 * # Why a class name is looked up, not assumed unique per kind
 *
 * Class names *do* repeat across environments of the same kind in the
 * documented sense that "medium" exists in both Docker's x86 table and its
 * gen2 table's "medium.gen2" sibling -- but never as the exact same string
 * within one kind (gen2/arm classes always carry a suffix or prefix that
 * distinguishes them). So "the environment, of this kind, that lists this
 * exact name" is always at most one table, and this module trusts that
 * rather than re-asserting it -- if a future table shape broke that
 * invariant, the first (upstream document order) match wins, which is no
 * worse than what happened before this module existed (no suggestion at
 * all).
 */
import type { ResourceClassCatalog } from '~/lib/graph/detectResourceUtilization';

import type { ResourceClass, ResourceClassEnvironment } from './types';

/**
 * Locates the class named `name` within the environments of `kind`, and the
 * environment it was found in -- or `undefined` when no environment of that
 * kind lists it (a stale/renamed class, or a `kind` this response has no
 * environments for at all).
 */
function findClass(
  environments: readonly ResourceClassEnvironment[],
  kind: string,
  name: string,
):
  | { environment: ResourceClassEnvironment; resourceClass: ResourceClass }
  | undefined {
  for (const environment of environments) {
    if (environment.kind !== kind) continue;
    const resourceClass = environment.classes.find((c) => c.name === name);
    if (resourceClass) return { environment, resourceClass };
  }
  return undefined;
}

/**
 * The classes in `environment` whose `rank` is strictly smaller (direction
 * `'smaller'`) or strictly larger (`'larger'`) than `fromRank`, nearest-first.
 *
 * Classes with no `rank` at all (an unparseable row -- see `ResourceClass`'s
 * own doc comment) are excluded rather than sorted to either end: this module
 * does not know where they belong, and "excluded" is the only claim that
 * does not risk being wrong. Classes that *tie* with `fromRank` are also
 * excluded from both directions -- a tie is neither smaller nor larger, per
 * `assignRanks`' own reasoning on the host side.
 *
 * `environment.classes` is already in upstream document order, and
 * `Array.prototype.sort` is stable, so classes sharing one rank keep that
 * relative order rather than being shuffled by this function.
 */
function neighboursByRank(
  environment: ResourceClassEnvironment,
  fromRank: number,
  direction: 'smaller' | 'larger',
): string[] {
  const candidates = environment.classes.filter(
    (c): c is ResourceClass & { rank: number } =>
      c.rank != null &&
      (direction === 'smaller' ? c.rank < fromRank : c.rank > fromRank),
  );
  candidates.sort((a, b) =>
    direction === 'smaller' ? b.rank - a.rank : a.rank - b.rank,
  );
  return candidates.map((c) => c.name);
}

/**
 * Builds a `ResourceClassCatalog` backed by one `GET /api/resource-classes`
 * response's `environments` -- the argument `findResourceUtilizationFindings`
 * expects, unchanged since issue #307 first defined the interface it never
 * had an implementation for.
 */
export function createResourceClassCatalog(
  environments: readonly ResourceClassEnvironment[],
): ResourceClassCatalog {
  return {
    smallerClasses(platform, current) {
      const found = findClass(environments, platform, current);
      if (!found || found.resourceClass.rank == null) return [];
      return neighboursByRank(
        found.environment,
        found.resourceClass.rank,
        'smaller',
      );
    },
    largerClasses(platform, current) {
      const found = findClass(environments, platform, current);
      if (!found || found.resourceClass.rank == null) return [];
      return neighboursByRank(
        found.environment,
        found.resourceClass.rank,
        'larger',
      );
    },
  };
}
