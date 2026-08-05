/**
 * Builds the plain JS values that get inserted into a user's config when
 * they drag an orb element onto the canvas -- the `orbs:` entry for the orb
 * itself, and the `workflows.<wf>.jobs` / job `steps` / `executor` entries
 * for its elements.
 *
 * These are deliberately dumb value builders, not editors: they never touch
 * a `yaml.Document` or the zustand store. The later mutation layer is
 * responsible for calling `setIn`/an equivalent with the value one of these
 * functions returns, at whatever path the drop target implies. Keeping this
 * split means the "what does dropping this thing produce" logic can be unit
 * tested with plain `toEqual` assertions, independent of document surgery.
 */
import type { OrbElement, OrbParameter } from './types';
import { parseOrbRef } from './types';

/** The `orbs:` map entry an orb reference contributes. */
export interface OrbsEntry {
  alias: string;
  value: string;
}

/**
 * Builds the `orbs:` entry for `ref`, e.g. `circleci/node@5.2.0` ->
 * `{ alias: 'node', value: 'circleci/node@5.2.0' }`. `aliasOverride`, if
 * given, is used (sanitised) instead of the orb's own name -- callers need
 * this when the default alias collides with an orb already imported into
 * the config.
 */
export function orbsEntry(ref: string, aliasOverride?: string): OrbsEntry {
  const { orbName } = parseOrbRef(ref);
  return { alias: sanitizeAlias(aliasOverride ?? orbName), value: ref };
}

/**
 * Builds the value to append to `workflows.<wf>.jobs` for dropping the orb
 * job `jobName` (aliased as `orbAlias`) onto a workflow. Bare-string form
 * when there is nothing to configure, otherwise a single-key map so the
 * params/`requires` have somewhere to live -- matching how CircleCI config
 * itself distinguishes a plain job reference from a configured one.
 */
export function workflowJobEntry(
  orbAlias: string,
  jobName: string,
  params?: Record<string, unknown>,
  requires?: string[],
): string | Record<string, Record<string, unknown>> {
  const key = `${orbAlias}/${jobName}`;
  const hasParams = params !== undefined && Object.keys(params).length > 0;
  const hasRequires = requires !== undefined && requires.length > 0;
  if (!hasParams && !hasRequires) return key;

  const options: Record<string, unknown> = { ...params };
  if (hasRequires) options.requires = requires;
  return { [key]: options };
}

/**
 * Builds the value to append to a job's `steps` for dropping the orb
 * command `commandName` (aliased as `orbAlias`). Same bare-string-vs-map
 * shape as `workflowJobEntry`, minus `requires` (steps don't have one).
 */
export function stepEntry(
  orbAlias: string,
  commandName: string,
  params?: Record<string, unknown>,
): string | Record<string, Record<string, unknown>> {
  const key = `${orbAlias}/${commandName}`;
  if (params === undefined || Object.keys(params).length === 0) return key;
  return { [key]: { ...params } };
}

/** Builds the `executor:` value for assigning the orb executor `executorName`. */
export function executorRef(orbAlias: string, executorName: string): string {
  return `${orbAlias}/${executorName}`;
}

/**
 * Builds the initial parameter values for a freshly dropped element: every
 * *required* parameter gets a sensible empty value for its type (so the
 * dropped-in config is well-typed while the user hasn't filled anything in
 * yet); optional parameters are omitted entirely so we never write a
 * redundant copy of the orb's own default into the user's config.
 */
export function defaultParamValues(
  element: OrbElement,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const parameter of element.parameters) {
    if (!parameter.required) continue;
    values[parameter.name] = emptyValueFor(parameter);
  }
  return values;
}

function emptyValueFor(parameter: OrbParameter): unknown {
  switch (parameter.type) {
    case 'boolean':
      return false;
    case 'integer':
      return 0;
    case 'enum':
      return parameter.enumValues?.[0] ?? '';
    case 'steps':
      return [];
    case 'string':
    case 'executor':
    case 'env_var_name':
      return '';
    default:
      return '';
  }
}

/**
 * Sanitises a candidate orb alias down to a legal, unquoted YAML plain-
 * scalar map key: word characters and hyphens only, not leading with a
 * digit (which YAML would otherwise happily parse as a number). Falls back
 * to `orb` if nothing legal remains.
 */
function sanitizeAlias(candidate: string): string {
  const stripped = candidate.replace(/[^A-Za-z0-9_-]/g, '');
  if (stripped.length === 0) return 'orb';
  return /^[0-9]/.test(stripped) ? `_${stripped}` : stripped;
}
