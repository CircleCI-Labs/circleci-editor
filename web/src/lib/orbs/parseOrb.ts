/**
 * Turns raw orb YAML source (as fetched from CircleCI's
 * `GET /api/v3/orb/versions/{id}/source`) into the `ParsedOrb` shape the
 * drag-and-drop UI reads.
 *
 * Unlike `lib/yaml/documentUtils.ts`, this module only ever *reads* orb
 * source -- there is no editing UI for an orb's own definition -- so it
 * parses to plain JS values (`yaml.parse`) rather than keeping a
 * comment-preserving `Document` around. That is a deliberate, narrower
 * contract than the config-editing layer, not an oversight.
 *
 * Orb source is third-party content: it can be hand-written, come from an
 * old orb-tools version, or simply be wrong. Every extraction step here is
 * therefore defensive -- a shape that doesn't match what we expect degrades
 * to an empty/omitted value plus a `problems` entry, and nothing throws.
 * The one exception is a YAML syntax error itself, which is caught and
 * reported the same way.
 */
import { parse } from 'yaml';

import type {
  OrbElement,
  OrbParameter,
  OrbParameterType,
  ParsedOrb,
} from './types';
import { parseOrbRef } from './types';

const PARAMETER_TYPES: ReadonlySet<string> = new Set([
  'string',
  'boolean',
  'integer',
  'enum',
  'executor',
  'steps',
  'env_var_name',
]);

/** A YAML mapping decoded to a plain object, with unknown-shaped values. */
type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Parses raw orb YAML into a `ParsedOrb`. `ref`, if known (e.g. the
 * `namespace/orb@version` the host used to fetch this source), is echoed
 * back and also split into `namespace`/`orbName`/`version` for convenience.
 */
export function parseOrbSource(source: string, ref?: string): ParsedOrb {
  const problems: string[] = [];
  const refParts = ref ? parseOrbRef(ref) : undefined;
  const base: Omit<ParsedOrb, 'problems'> = {
    ref,
    namespace: refParts?.namespace,
    orbName: refParts?.orbName,
    version: refParts?.version,
    jobs: [],
    commands: [],
    executors: [],
    parameters: [],
  };

  let root: unknown;
  try {
    root = parse(source);
  } catch (error) {
    problems.push(`Failed to parse orb YAML: ${errorMessage(error)}`);
    return { ...base, problems };
  }

  if (root === null || root === undefined) {
    // An empty document is unusual but not malformed -- e.g. an orb whose
    // source hasn't been written yet. Nothing to extract, no problem to
    // report.
    return { ...base, problems };
  }

  if (!isPlainRecord(root)) {
    problems.push('Orb source is not a YAML mapping at its top level.');
    return { ...base, problems };
  }

  const description = asOptionalString(root.description);
  const display = isPlainRecord(root.display) ? root.display : undefined;

  return {
    ...base,
    description,
    homeUrl: display ? asOptionalString(display.home_url) : undefined,
    sourceUrl: display ? asOptionalString(display.source_url) : undefined,
    jobs: readElementMap(root.jobs, 'job', 'jobs', problems),
    commands: readElementMap(root.commands, 'command', 'commands', problems),
    executors: readElementMap(
      root.executors,
      'executor',
      'executors',
      problems,
    ),
    parameters: readParameterMap(root.parameters, 'orb', problems),
    problems,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a top-level `jobs:`/`commands:`/`executors:` map into a sorted list
 * of `OrbElement`s. `key` is only used to name the offending field in a
 * `problems` entry when the value isn't a map.
 */
function readElementMap(
  value: unknown,
  kind: OrbElement['kind'],
  key: string,
  problems: string[],
): OrbElement[] {
  if (value === undefined || value === null) return [];
  if (!isPlainRecord(value)) {
    problems.push(
      `Expected "${key}" to be a mapping of names to definitions, but found ${describeType(value)}; ignoring it.`,
    );
    return [];
  }

  const elements: OrbElement[] = [];
  for (const [name, def] of Object.entries(value)) {
    if (!isPlainRecord(def)) {
      problems.push(
        `${capitalize(kind)} "${name}" is not a mapping; treating it as having no description or parameters.`,
      );
      elements.push({ name, kind, parameters: [] });
      continue;
    }
    elements.push({
      name,
      kind,
      description: asOptionalString(def.description),
      parameters: readParameterMap(
        def.parameters,
        `${kind} "${name}"`,
        problems,
      ),
    });
  }

  elements.sort((a, b) => a.name.localeCompare(b.name));
  return elements;
}

/**
 * Reads a `parameters:` map into an ordered list of `OrbParameter`s.
 * `context` names the owning job/command/executor/orb in `problems`
 * entries. Order is preserved (object key order, which for a map decoded
 * from YAML matches declaration order) since parameter forms should read
 * in the author's order, not alphabetically like the element lists.
 */
function readParameterMap(
  value: unknown,
  context: string,
  problems: string[],
): OrbParameter[] {
  if (value === undefined || value === null) return [];
  if (!isPlainRecord(value)) {
    problems.push(
      `Expected ${context}'s "parameters" to be a mapping, but found ${describeType(value)}; ignoring it.`,
    );
    return [];
  }

  const parameters: OrbParameter[] = [];
  for (const [name, def] of Object.entries(value)) {
    parameters.push(readParameter(name, def, context, problems));
  }
  return parameters;
}

function readParameter(
  name: string,
  def: unknown,
  context: string,
  problems: string[],
): OrbParameter {
  if (!isPlainRecord(def)) {
    problems.push(
      `Parameter "${name}" on ${context} is not a mapping; treating it as a required string.`,
    );
    return { name, type: 'string', required: true };
  }

  const required = !('default' in def);
  const defaultValue = readDefaultValue(def.default);
  const type = readParameterType(
    name,
    def.type,
    defaultValue,
    context,
    problems,
  );

  const parameter: OrbParameter = { name, type, required };
  const description = asOptionalString(def.description);
  if (description !== undefined) parameter.description = description;
  if (defaultValue !== undefined) parameter.default = defaultValue;
  if (type === 'enum') parameter.enumValues = readEnumValues(def.enum);
  return parameter;
}

/** Narrows a raw `default:` value to the primitive types `OrbParameter.default` allows. */
function readDefaultValue(
  value: unknown,
): string | number | boolean | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return undefined;
}

function readParameterType(
  name: string,
  rawType: unknown,
  defaultValue: string | number | boolean | undefined,
  context: string,
  problems: string[],
): OrbParameterType {
  if (rawType === undefined) {
    const inferred = inferTypeFromDefault(defaultValue);
    problems.push(
      `Parameter "${name}" on ${context} has no "type"; inferred "${inferred}" from its default value.`,
    );
    return inferred;
  }
  if (typeof rawType === 'string' && PARAMETER_TYPES.has(rawType)) {
    return rawType as OrbParameterType;
  }
  problems.push(
    `Parameter "${name}" on ${context} has unrecognised type "${String(rawType)}"; treating it as "string".`,
  );
  return 'string';
}

function inferTypeFromDefault(
  defaultValue: string | number | boolean | undefined,
): OrbParameterType {
  if (typeof defaultValue === 'boolean') return 'boolean';
  if (typeof defaultValue === 'number') return 'integer';
  return 'string';
}

function readEnumValues(rawEnum: unknown): string[] {
  if (!Array.isArray(rawEnum)) return [];
  return rawEnum.map((entry) => String(entry));
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'a sequence';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
