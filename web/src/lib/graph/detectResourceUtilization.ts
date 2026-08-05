/**
 * Read-only detection of issue #307's resource-class right-sizing
 * suggestions, from the host's background-warmed Usage Export summary
 * (`~/state/usageStore.ts`, `GET /api/usage`).
 *
 * This reverses a rejection made twice in #292: right-sizing was declined
 * on the premise that it "needs Mode usage data this editor has no access
 * to." That premise was wrong -- the CircleCI Usage API is a public v2 API
 * this host can call directly, and its export already carries per-job
 * median/max CPU and RAM utilisation plus the resource class and credits
 * spent (see `internal/usage`'s package doc comment).
 *
 * **Never fetches.** Same rule `detectOutdatedOrbs.ts` follows for the
 * identical reason: this module takes the usage summary as a plain
 * argument rather than reaching into `useUsageStore` itself, so it stays
 * pure and testable without a network, and the caller stays in control of
 * when (and whether) that data is even asked for.
 *
 * **Under- and over-utilisation are different claims, kept as two
 * independent finding kinds rather than one "right-size" rule** (issue
 * #307's own explicit constraint): low CPU may mean an oversized class, or
 * it may mean an I/O-bound job that would be no faster on a smaller one --
 * this module says so in `kind: 'low-cpu'`'s own framing (left to the
 * caller's copy) rather than asserting a problem. High RAM near the
 * ceiling is the more urgent, more defensible direction (closer to an
 * outright job failure than to a cost question), and is never merged into
 * the same finding.
 *
 * **Sample size matters.** A job with fewer than `MIN_SAMPLE_RUNS` usable
 * runs in the window produces no finding at all -- one run at 20% CPU is
 * noise, not a pattern. Every finding carries
 * `runs` and `windowDays` so the caller's copy can (and must) say the
 * window and the count out loud, per issue #307's own requirement.
 *
 * **Never suggests a move to a resource class that does not exist.**
 * `catalog`, when supplied, is asked whether a smaller/larger class
 * actually exists for this job's platform before `suggestedClass` is ever
 * populated; when `catalog` is omitted (issue #305, which enumerates the
 * classes an organisation's platforms actually have, cannot answer this on its own when
 * this was written -- see this module's own module-level TODO below) every
 * finding still fires, just without ever naming a specific target class,
 * which trivially satisfies the same rule by asserting nothing that could
 * be wrong.
 *
 * **Never promises a specific saving.** No finding here carries, and no
 * caller may add, a credits-saved figure -- issue #292's rule ("Consider
 * doing X because Y which will lead to Z") stops at the *reason*, never a
 * number. `computeCredits`/`totalCredits` on `JobUtilizationSummary` exist
 * so a caller can state what a job *already cost* as a fact, not what
 * moving it would save.
 *
 * Pure and framework-free, same convention as `detectDuplication.ts`.
 */
import type { Document } from 'yaml';

import { getJobNames } from '~/lib/yaml/documentUtils';

/**
 * One job's rolled-up utilisation/credit summary over the cache's current
 * window -- the shape `UsageJobSummary` (`~/lib/rpc/client`) already is,
 * kept as this module's own type so it stays independent of the RPC
 * client's wire shape, the same rationale `OrbVersionCacheEntry` gives in
 * `detectOutdatedOrbs.ts`.
 */
export interface JobUtilizationSummary {
  jobName: string;
  resourceClass: string;
  executor: string;
  operatingSystem: string;
  runs: number;
  avgMedianCpuPct: number;
  avgMaxCpuPct: number;
  maxMaxCpuPct: number;
  avgMedianRamPct: number;
  avgMaxRamPct: number;
  maxMaxRamPct: number;
  computeCredits: number;
  totalCredits: number;
}

/**
 * A job needs at least this many usable (both CPU and RAM profiled) runs in
 * the window before either finding below will fire at all: one job at 20%
 * CPU is noise, a consistent pattern across a window is signal.
 */
export const MIN_SAMPLE_RUNS = 5;

/** A job averaging under this median CPU utilisation is a low-cpu candidate. */
export const LOW_CPU_THRESHOLD_PCT = 30;

/** A job whose single worst run's max RAM utilisation reaches this is a high-ram candidate -- the ceiling-proximity signal, not an average, because one OOM-adjacent run is the risk, not the mean. */
export const HIGH_RAM_THRESHOLD_PCT = 85;

/**
 * Enumerates which resource classes actually exist for a given platform, so
 * this module never suggests a move to one that doesn't -- the "other
 * half" issue #307 names explicitly, supplied by issue #305's offerings
 * cache (`GET /api/v3/catalog/offerings`).
 *
 * TODO(#305): wire a real implementation through once that cache lands.
 * Until then, every call site passes no `catalog` at all (see
 * `RecommendationsSection.tsx`), and every finding below fires without ever
 * populating `suggestedClass` -- deliberately the safe default, not a
 * placeholder implementation that could be wrong about what exists.
 */
export interface ResourceClassCatalog {
  /** Classes smaller than `current` for `platform`, nearest-first. Empty when `current` is already the smallest available (or none is known to be smaller). */
  smallerClasses(platform: string, current: string): string[];
  /** Classes larger than `current` for `platform`, nearest-first. Empty when `current` is already the largest available (or none is known to be larger). */
  largerClasses(platform: string, current: string): string[];
}

export type UtilizationFindingKind = 'low-cpu' | 'high-ram';

export interface UtilizationFinding {
  kind: UtilizationFindingKind;
  jobName: string;
  resourceClass: string;
  executor: string;
  runs: number;
  windowDays: number;
  /** The one statistic this finding is actually about: `avgMedianCpuPct` for `'low-cpu'`, `maxMaxRamPct` for `'high-ram'`. */
  metricPct: number;
  /** The nearest smaller (low-cpu) or larger (high-ram) class that `catalog` confirmed exists, absent when no `catalog` was supplied or none exists. */
  suggestedClass?: string;
}

/**
 * Finds resource-class right-sizing candidates among `jobs` that still
 * exist in `doc` (a job usage was observed for, then renamed or removed,
 * produces no finding -- there is nothing left to act on).
 */
export function findResourceUtilizationFindings(
  doc: Document,
  jobs: JobUtilizationSummary[],
  windowDays: number,
  catalog?: ResourceClassCatalog,
): UtilizationFinding[] {
  const jobNames = new Set(getJobNames(doc));
  const findings: UtilizationFinding[] = [];

  for (const job of jobs) {
    if (!jobNames.has(job.jobName)) continue;
    if (job.runs < MIN_SAMPLE_RUNS) continue;

    if (job.avgMedianCpuPct < LOW_CPU_THRESHOLD_PCT) {
      const smaller = catalog?.smallerClasses(job.executor, job.resourceClass);
      findings.push({
        kind: 'low-cpu',
        jobName: job.jobName,
        resourceClass: job.resourceClass,
        executor: job.executor,
        runs: job.runs,
        windowDays,
        metricPct: job.avgMedianCpuPct,
        suggestedClass: smaller?.[0],
      });
    }

    if (job.maxMaxRamPct >= HIGH_RAM_THRESHOLD_PCT) {
      const larger = catalog?.largerClasses(job.executor, job.resourceClass);
      findings.push({
        kind: 'high-ram',
        jobName: job.jobName,
        resourceClass: job.resourceClass,
        executor: job.executor,
        runs: job.runs,
        windowDays,
        metricPct: job.maxMaxRamPct,
        suggestedClass: larger?.[0],
      });
    }
  }

  return findings;
}
