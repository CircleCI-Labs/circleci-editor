/**
 * Real `errors` arrays from CircleCI's
 * `POST /api/v2/compile-config-with-defaults`, captured by submitting the
 * config quoted above each one to the live API on 2026-07-29 (with a
 * `Circle-Token`, no `owner_id`).
 *
 * These are the ground truth every parsing rule in `diagnostics.ts` was
 * written against, and the reason this feature does not guess at the wire
 * format. Two facts about it are easy to get wrong from the endpoint's own
 * documentation and are worth stating plainly:
 *
 *  1. **One array entry is one *line*, not one error.** A single misspelled
 *     key produces twenty-four entries (see `SCHEMA_EXTRANEOUS_KEY`).
 *  2. **Almost nothing carries a position.** Only the `Unable to parse YAML`
 *     report quotes `line N, column M`; every other error names an entity and
 *     leaves placing it to the reader.
 *
 * Shared with the e2e fixtures (`e2e/fixtures.ts` imports the same configs
 * through its own stub builder) so unit tests and browser tests assert
 * against identical bytes rather than two hand-written approximations.
 */

/**
 * ```yaml
 * version: 2.1
 * orbs:
 *   slack: circleci/slack@99.99.99
 * ...
 * ```
 */
export const ORB_NOT_FOUND = [
  'Cannot find circleci/slack@99.99.99 in the orb registry. Check that the namespace, orb name and version are correct.',
];

/**
 * ```yaml
 * workflows:
 *   main:
 *     jobs:
 *       - build:
 *           requires:
 *             - nonexistent
 * ```
 */
export const UNKNOWN_REQUIRES = [
  "Job 'build' requires 'nonexistent', which is the name of 0 other jobs in workflow 'main'",
];

/**
 * ```yaml
 * jobs:
 *   build:
 *     executor: nope
 *     steps: [checkout]
 * ```
 *
 * Note the two `Error calling ...` lines: they are scope, not faults.
 */
export const UNKNOWN_EXECUTOR = [
  "Error calling workflow: 'main'",
  "Error calling job: 'build'",
  'Cannot find a definition for executor named nope',
];

/**
 * ```yaml
 * jobs:
 *   build:
 *     docker: [{image: cimg/base:stable}]
 *     steps:
 *       - chekcout
 * ```
 */
export const UNKNOWN_COMMAND = [
  "Error calling workflow: 'main'",
  "Error calling job: 'build'",
  'Cannot find a definition for command named chekcout',
];

/**
 * ```yaml
 * workflows:
 *   main:
 *     jobs:
 *       - notdefined
 * ```
 */
export const UNKNOWN_WORKFLOW_JOB = [
  "Error calling workflow: 'main'",
  'Cannot find a definition for job named notdefined',
];

/**
 * `stpes:` instead of `steps:` in `jobs.build`. The full twenty-four-entry
 * report, verbatim -- including the `oneOf` branches (`expected type: String`,
 * `required key [type] not found`) that describe a "string reference to
 * another job" interpretation the user never intended, and which
 * `suggestions.ts` therefore declines to act on.
 */
export const SCHEMA_EXTRANEOUS_KEY = [
  'ERROR IN CONFIG FILE:',
  '[#/jobs/build] 0 subschemas matched instead of one',
  '1. [#/jobs/build] only 1 subschema matches out of 2',
  '|   1. [#/jobs/build] 2 schema violations found',
  '|   |   1. [#/jobs/build] extraneous key [stpes] is not permitted',
  '|   |   |   Permitted keys:',
  '|   |   |     - description',
  '|   |   |     - parallelism',
  '|   |   |     - macos',
  '|   |   |     - resource_class',
  '|   |   |     - docker',
  '|   |   |     - steps',
  '|   |   |     - retention',
  '|   |   |     - working_directory',
  '|   |   |     - circleci_ip_ranges',
  '|   |   |     - machine',
  '|   |   |     - environment',
  '|   |   |     - executor',
  '|   |   |     - shell',
  '|   |   |     - parameters',
  '|   |   2. [#/jobs/build] required key [steps] not found',
  '2. [#/jobs/build] expected type: String, found: Mapping',
  '|   Job may be a string reference to another job',
  '3. [#/jobs/build] required key [type] not found',
];

/** `imag:` instead of `image:` in `jobs.build.docker[0]` -- the same shape, but with a path that includes a sequence index. */
export const SCHEMA_EXTRANEOUS_KEY_NESTED = [
  'ERROR IN CONFIG FILE:',
  '[#/jobs/build] 0 subschemas matched instead of one',
  '1. [#/jobs/build] only 1 subschema matches out of 2',
  '|   1. [#/jobs/build/docker/0] 2 schema violations found',
  '|   |   1. [#/jobs/build/docker/0] extraneous key [imag] is not permitted',
  '|   |   |   Permitted keys:',
  '|   |   |     - gcp_auth',
  '|   |   |     - name',
  '|   |   |     - command',
  '|   |   |     - auth',
  '|   |   |     - entrypoint',
  '|   |   |     - image',
  '|   |   |     - environment',
  '|   |   |     - aws_auth',
  '|   |   |     - user',
  '|   |   2. [#/jobs/build/docker/0] required key [image] not found',
  '2. [#/jobs/build] expected type: String, found: Mapping',
  '|   Job may be a string reference to another job',
  '3. [#/jobs/build] required key [type] not found',
];

/** Two mutually-requiring jobs. Two entries, no path, no name -- and, deliberately, no suggestion. */
export const CYCLE = [
  'At least one job in the workflow must have no dependencies.',
  'The following jobs are unreachable: a, b',
];

/** No `version:` key at all. */
export const MISSING_VERSION = [
  'Unsupported or missing workflows config version',
];

/**
 * A config `yaml` (this app's parser) would also reject. The only report that
 * carries a position -- and, because `appStore.revalidate` skips the API while
 * the local parse is failing, one a user will almost never see through this
 * path.
 */
export const UNPARSEABLE = [
  'Unable to parse YAML',
  'while parsing a block mapping',
  " in 'string', line 3, column 3:",
  '      build:',
  '      ^',
  "expected <block end>, but found '-'",
  " in 'string', line 5, column 3:",
  '      - image: x',
  '      ^',
];
