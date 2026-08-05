/**
 * Types modelling CircleCI's orb source schema: the elements (jobs,
 * commands, executors) an orb exposes and the parameters each one accepts.
 *
 * These mirror the *authoring* schema documented at
 * https://circleci.com/docs/reusable-config-reference/ -- not the resolved
 * JSON schema CircleCI's API returns for a compiled config. Orb sources are
 * hand-written YAML, so `parseOrb.ts` (which turns raw orb YAML into these
 * types) has to be tolerant of the many small ways real-world orbs deviate
 * from the spec; see its module doc for the recovery rules.
 */

/** The parameter types CircleCI's orb schema recognizes. */
export type OrbParameterType =
  | 'string'
  | 'boolean'
  | 'integer'
  | 'enum'
  | 'executor'
  | 'steps'
  | 'env_var_name';

/** One parameter declared on an orb job, command, executor, or the orb itself. */
export interface OrbParameter {
  name: string;
  type: OrbParameterType;
  description?: string;
  default?: string | number | boolean;
  /** `true` iff the parameter declaration had no `default` key. */
  required: boolean;
  /** Only populated for `type: 'enum'`. */
  enumValues?: string[];
}

/** A single job, command, or executor an orb exposes, with its parameters. */
export interface OrbElement {
  name: string;
  kind: 'job' | 'command' | 'executor';
  description?: string;
  parameters: OrbParameter[];
}

/** The result of parsing one orb's YAML source. */
export interface ParsedOrb {
  /** Full reference such as "circleci/node@5.2.0" when known. */
  ref?: string;
  namespace?: string;
  orbName?: string;
  version?: string;
  description?: string;
  /** `display.home_url`, when present. */
  homeUrl?: string;
  /** `display.source_url`, when present. */
  sourceUrl?: string;
  jobs: OrbElement[];
  commands: OrbElement[];
  executors: OrbElement[];
  /** Orb-level parameters (rare but legal). */
  parameters: OrbParameter[];
  /** Non-fatal problems encountered while parsing, e.g. an unrecognised parameter type. */
  problems: string[];
}

/** The parts of an orb reference, as split out by `parseOrbRef`. */
export interface OrbRefParts {
  namespace: string;
  orbName: string;
  /** Absent for a bare `namespace/orb` reference with no version pinned. */
  version?: string;
}

/**
 * Splits an orb reference into its namespace, name, and version.
 *
 * Handles every version form CircleCI accepts: a semver pin (`ns/orb@1.2.3`),
 * the floating `@volatile` tag, a development release (`ns/orb@dev:branch`
 * -- note the version itself contains a colon, so this must not split on
 * the *first* `@`-separated segment past the name), and a bare reference
 * with no version at all (`ns/orb`), which some orb-authoring contexts
 * allow (e.g. referring to the orb currently being edited).
 */
export function parseOrbRef(ref: string): OrbRefParts {
  const at = ref.indexOf('@');
  const namePart = at === -1 ? ref : ref.slice(0, at);
  const version = at === -1 ? undefined : ref.slice(at + 1);
  const slash = namePart.indexOf('/');
  const namespace = slash === -1 ? '' : namePart.slice(0, slash);
  const orbName = slash === -1 ? namePart : namePart.slice(slash + 1);
  return version === undefined
    ? { namespace, orbName }
    : { namespace, orbName, version };
}

/** Reassembles the parts produced by `parseOrbRef` back into a reference string. */
export function formatOrbRef(parts: OrbRefParts): string {
  const base = `${parts.namespace}/${parts.orbName}`;
  return parts.version ? `${base}@${parts.version}` : base;
}
