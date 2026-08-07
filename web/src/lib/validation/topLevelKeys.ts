/**
 * Issue #5: CircleCI's compiler does not check the config's *top-level*
 * keys against anything -- verified live against
 * `POST /api/v2/compile-config-with-defaults` (see this change's PR
 * description for the transcript): a `workflow:` in place of `workflows:`
 * compiles `valid: true` with an empty `errors` array, and the resulting
 * `output-yaml` is byte-for-byte identical to submitting the same config
 * with no workflow-shaped key at all. The misspelled block isn't reinterpreted
 * or partially honoured -- it is simply never looked at. (What actually runs
 * in that case is CircleCI's unrelated, decade-old fallback: a config with a
 * `jobs:` block, no `workflows:`, and a job literally named `build` gets an
 * implicit single-job workflow named "workflow" -- confirmed by testing a
 * config with *no* workflow-shaped key at all and finding the identical
 * output. Without a `build` job it is instead a real, separate error:
 * "There are no workflows or build jobs in the config." Neither path reads
 * anything the user wrote under the misspelled key.)
 *
 * This module answers "is an unrecognised top-level key almost certainly
 * this typo" so `lib/validation/build.ts` can raise its own warning about
 * it -- see that module's `localDiagnostics` for where the answer becomes a
 * `Diagnostic`, and `suggestions.ts`'s `suggestForTopLevelKeyTypo` for the
 * rename button built on the same list.
 *
 * ## Where `KNOWN_TOP_LEVEL_KEYS` comes from
 *
 * `internal/schema/schema.json`'s root `properties` -- the vendored
 * CircleCI-yaml-language-server schema this app already treats as its
 * source of truth for autocompletion (see that package's doc comment) --
 * lists `version`, `jobs`, `workflows`, `orbs`, `commands`, `executors`,
 * `parameters`, `job-groups`, `experimental`, `examples` and `display`.
 * `setup` is added on top of that: it is real and documented
 * (`configuration-reference.adoc`'s "setup" section, dynamic config), but is
 * missing from the vendored schema entirely -- confirmed by grepping
 * `schema.json` for the literal string rather than assumed, so this list is
 * knowingly wider than what that file alone would give.
 *
 * `experimental`, `examples` and `display` are orb-authoring metadata
 * (`display.home_url`/`source_url` for the orb registry listing, `examples`
 * for its usage docs) rather than anything a plain `.circleci/config.yml`
 * would carry, but there's no reason to leave them out: a wider known-key
 * set can only ever make `topLevelKeyTypos` decline to warn, never cause a
 * false one.
 *
 * ## Why a near-miss check, and not "warn on anything unrecognised"
 *
 * CircleCI's compiler accepts top-level keys this vendored schema doesn't
 * know about at all -- `setup` being the proof, missing from `schema.json`
 * yet definitely real -- so treating "not in `KNOWN_TOP_LEVEL_KEYS`" as
 * "wrong" would warn about exactly the kind of legitimate, forward-looking
 * key this app has no way to have heard of yet. `nearestUnique` (shared with
 * `suggestions.ts`, built for the identical `stpes` -> `steps` reasoning one
 * level down) narrows that down to a key within a typo's distance of
 * *exactly one* known key. `workflow` -> `workflows` -- the case issue #5
 * was filed over -- lands squarely inside that distance and inside nothing
 * else, which is exactly the asymmetry worth surfacing: a config that will
 * not run the workflow the user wrote gets a warning, and a config that adds
 * some key this app has never seen does not.
 */
import type { Document } from 'yaml';

import { listKeys } from '~/lib/yaml/documentUtils';

import { nearestUnique } from './editDistance';

export const KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'setup',
  'orbs',
  'commands',
  'parameters',
  'executors',
  'jobs',
  'workflows',
  'job-groups',
  'experimental',
  'examples',
  'display',
] as const;

export interface TopLevelKeyTypo {
  /** The unrecognised key exactly as written. */
  key: string;
  /** The one known top-level key it is within a typo's distance of. */
  replacement: string;
}

/**
 * Every top-level key in `doc` that isn't in `KNOWN_TOP_LEVEL_KEYS` but is a
 * near miss of exactly one member of it. A key that is neither known nor a
 * near miss of anything is left out entirely -- see this module's doc
 * comment on why that silence is the point, not an omission.
 */
export function topLevelKeyTypos(doc: Document): TopLevelKeyTypo[] {
  const known: readonly string[] = KNOWN_TOP_LEVEL_KEYS;
  const typos: TopLevelKeyTypo[] = [];
  for (const key of listKeys(doc, [])) {
    if (known.includes(key)) continue;
    const replacement = nearestUnique(key, KNOWN_TOP_LEVEL_KEYS);
    if (replacement) typos.push({ key, replacement });
  }
  return typos;
}
