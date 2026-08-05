/**
 * Extracts the handful of completion-relevant fact tables out of the
 * official CircleCI configuration JSON Schema (vendored server-side --
 * see `internal/schema` -- and served unmodified by `GET /api/schema`).
 *
 * This deliberately does *not* implement a general-purpose JSON Schema
 * resolver (walking every `$ref`/`oneOf`/`if`-`then`-`else` generically).
 * The upstream schema encodes CircleCI's actual validation rules, which are
 * deeply nested and branch heavily by job `type`; a fully generic walker
 * would need to replicate most of a JSON Schema validator to correctly
 * decide which branch applies at any given point, for marginal benefit over
 * just reading off the specific facts autocompletion actually needs.
 * Instead, each extractor below navigates one fixed, hand-verified path
 * into the schema -- verified empirically against the schema.json shipped
 * with circleci-yaml-language-server 0.36.1 by inspecting it directly, the
 * same way `yamlHighlight.ts` verified `@lezer/yaml`'s node names against a
 * real parse rather than guessing. Every path is commented with what it
 * reads and why. If a future schema release restructures one of these
 * branches, the corresponding extractor degrades to returning no items
 * (never throws) -- consistent with this feature's "under-report rather
 * than mislead" mandate -- rather than crashing the editor.
 */

export interface SchemaCompletionItem {
  /** The literal key or enum value to offer as a completion. */
  label: string;
  /** Prose from the schema's `markdownDescription`/`description`, shown in the completion popup's info panel. */
  info?: string;
}

export interface CircleciSchema {
  /** `version`, `orbs`, `jobs`, `workflows`, `executors`, `commands`, `parameters`, etc. -- the document root's own keys. */
  topLevelKeys: SchemaCompletionItem[];
  /** Keys valid inside a `jobs.<name>:` job definition (`docker`, `steps`, `resource_class`, ...). */
  jobKeys: SchemaCompletionItem[];
  /** Keys valid inside an `executors.<name>:` executor definition. */
  executorKeys: SchemaCompletionItem[];
  /** Keys valid directly under a `workflows.<name>:` workflow (`jobs`, `triggers`, `when`, ...). */
  workflowKeys: SchemaCompletionItem[];
  /** Keys valid inside one workflow job invocation's options map (`requires`, `context`, `filters`, ...). */
  workflowJobEntryKeys: SchemaCompletionItem[];
  /** The built-in step names (`run`, `checkout`, `save_cache`, ...). */
  stepNames: SchemaCompletionItem[];
  /** The `resource_class:` enum (`small`, `medium`, `large`, ...). */
  resourceClassValues: SchemaCompletionItem[];
  /** The job `type:` enum (`build`, `approval`, ...). */
  jobTypeValues: SchemaCompletionItem[];
  /**
   * The `type:` values a **pipeline** parameter may declare -- the document's
   * top-level `parameters:` (issue #250). Read off the schema rather than
   * written down here, because the set is closed and CircleCI owns it.
   *
   * Deliberately a *different* list from `elementParameterTypeValues` below,
   * and the schema is emphatic about it: the top-level block enumerates four
   * values (`boolean`, `string`, `enum`, `integer`) where an element's block
   * enumerates seven. `steps`, `executor` and `env_var_name` have no meaning
   * for a value an API trigger supplies, so offering them at pipeline scope
   * would be offering the user a config that cannot compile.
   */
  pipelineParameterTypeValues: SchemaCompletionItem[];
  /**
   * The `type:` values a job's/command's/executor's own parameter may declare
   * (issue #250) -- the pipeline four plus `steps`, `executor` and
   * `env_var_name`.
   */
  elementParameterTypeValues: SchemaCompletionItem[];
  /** Keys valid inside one `docker:` array entry (`image`, `name`, `environment`, ...). */
  dockerImageKeys: SchemaCompletionItem[];
  /**
   * Per-step-keyword field definitions (issue #48), keyed by the step's own
   * map key (`run`, `checkout`, `save_cache`, ...) -- everything the
   * inspector's step editors need to render a field: its value type, enum
   * values when it has them, and whether it's required. A keyword absent
   * from this map (an orb command, a locally-defined custom command, a
   * schema release that dropped a keyword this app still recognizes) simply
   * has no schema-derived fields; callers fall back to showing whatever the
   * step's own raw value already contains.
   */
  stepFieldSchemas: Record<string, StepFieldSchema[]>;
}

/** One field of a built-in step's own value map, as the vendored JSON Schema describes it -- drives `StepFieldsSection` in the inspector (issue #48). */
export interface StepFieldSchema {
  name: string;
  type: 'string' | 'boolean' | 'integer' | 'enum' | 'array' | 'map';
  /** Only set for `type: 'enum'`. */
  enumValues?: string[];
  info?: string;
  /** `true` iff this field is in the branch's own `required` list. */
  required?: boolean;
}

const EMPTY_SCHEMA: CircleciSchema = {
  topLevelKeys: [],
  jobKeys: [],
  executorKeys: [],
  workflowKeys: [],
  workflowJobEntryKeys: [],
  stepNames: [],
  resourceClassValues: [],
  jobTypeValues: [],
  pipelineParameterTypeValues: [],
  elementParameterTypeValues: [],
  dockerImageKeys: [],
  stepFieldSchemas: {},
};

type JSONDict = Record<string, unknown>;

function asDict(value: unknown): JSONDict | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JSONDict)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Walks a fixed sequence of object keys / array indices, stopping (and returning `undefined`) as soon as one segment doesn't resolve -- never throws. */
function at(node: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = node;
  for (const segment of path) {
    if (typeof segment === 'number') {
      cur = asArray(cur)?.[segment];
    } else {
      cur = asDict(cur)?.[segment];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

function describe(node: unknown): string | undefined {
  const dict = asDict(node);
  const markdown = dict?.markdownDescription;
  if (typeof markdown === 'string' && markdown.length > 0) return markdown;
  const plain = dict?.description;
  return typeof plain === 'string' && plain.length > 0 ? plain : undefined;
}

/** Reads `node.properties` as a sorted, deduplicated completion list, each item's `info` taken from that property's own description. */
function collectPropertyKeys(node: unknown): SchemaCompletionItem[] {
  const properties = asDict(at(node, 'properties'));
  if (!properties) return [];
  return Object.entries(properties)
    .map(([label, propertySchema]) => ({
      label,
      info: describe(propertySchema),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Merges several key lists, keeping the first `info` seen for a given `label` and sorting the result. */
function mergeKeyLists(
  ...lists: SchemaCompletionItem[][]
): SchemaCompletionItem[] {
  const byLabel = new Map<string, SchemaCompletionItem>();
  for (const list of lists) {
    for (const item of list) {
      if (!byLabel.has(item.label)) byLabel.set(item.label, item);
    }
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Reads a `{ enum: [...] }` (or `{ oneOf: [{ enum: [...] }] }`) node's string enum values as a completion list. `node` itself, and each `oneOf` branch, is checked in turn so callers don't need to know which shape the schema currently uses. */
function collectEnumValues(node: unknown): SchemaCompletionItem[] {
  const direct = asArray(at(node, 'enum'));
  if (direct) return stringEnumItems(direct);

  const branches = asArray(at(node, 'oneOf')) ?? [];
  for (const branch of branches) {
    const values = asArray(at(branch, 'enum'));
    if (values) return stringEnumItems(values);
  }
  return [];
}

function stringEnumItems(values: unknown[]): SchemaCompletionItem[] {
  return values
    .filter((v): v is string => typeof v === 'string')
    .map((label) => ({ label }));
}

/** `true` for `run.environment`'s `$ref: '#/definitions/environment'` -- the one "map of scalars" shape any step field uses. Checked by ref rather than by resolving it, since every environment field in the schema points at the exact same definition and the inspector only ever needs to know "render this as key/value pairs", not the definition's own (`oneOf`-of-string/array/object) internal shape. */
function isEnvironmentRef(node: unknown): boolean {
  return asDict(node)?.$ref === '#/definitions/environment';
}

/** Classifies one step field's own schema node into the value type `StepFieldsSection` renders a control for. */
function stepFieldType(propSchema: unknown): {
  type: StepFieldSchema['type'];
  enumValues?: string[];
} {
  if (isEnvironmentRef(propSchema)) return { type: 'map' };
  const enumValues = collectEnumValues(propSchema).map((item) => item.label);
  if (enumValues.length > 0) return { type: 'enum', enumValues };
  const type = asDict(propSchema)?.type;
  if (type === 'boolean') return { type: 'boolean' };
  if (type === 'integer' || type === 'number') return { type: 'integer' };
  if (type === 'array') return { type: 'array' };
  // Default, and deliberately so for `setup_remote_docker.version`'s
  // `anyOf: [{enum: [...]}, {type: 'string'}]` -- `collectEnumValues` only
  // follows `enum`/`oneOf`, not `anyOf`, so that one falls through to here.
  // That is in fact the more correct rendering: CircleCI accepts an
  // arbitrary custom Docker version there, not just the enumerated ones, so
  // a free-text field is the honest UI, not an accident of this function
  // not chasing one more JSON Schema combinator.
  return { type: 'string' };
}

/** Reads one object-shaped step-field branch's `properties` (+ its own `required` list) into `StepFieldSchema`s. */
function extractStepFields(branch: unknown): StepFieldSchema[] {
  const properties = asDict(at(branch, 'properties'));
  if (!properties) return [];
  const requiredNames = new Set(
    asArray(at(branch, 'required'))?.filter(
      (r): r is string => typeof r === 'string',
    ),
  );
  return Object.entries(properties).map(([name, propSchema]) => {
    const { type, enumValues } = stepFieldType(propSchema);
    return {
      name,
      type,
      enumValues,
      info: describe(propSchema),
      required: requiredNames.has(name) || undefined,
    };
  });
}

/**
 * The object-shaped `oneOf` branches of one step keyword's own schema node
 * -- i.e. every branch that isn't its bare-string shorthand (`{"type":
 * "string", "enum": [...]}` -- `checkout`/`setup_remote_docker`/
 * `add_ssh_keys` each have one). `restore_cache` is the one keyword with
 * two object branches (a `key` branch and a `keys` branch, `oneOf`-of); a
 * keyword with no `oneOf` at all (`save_cache`, `store_artifacts`, ...) is
 * already a single object schema, taken as-is.
 */
function objectBranchesOf(stepSchema: unknown): unknown[] {
  const oneOf = asArray(at(stepSchema, 'oneOf'));
  if (!oneOf) return asDict(at(stepSchema, 'properties')) ? [stepSchema] : [];
  return oneOf.filter(
    (branch) => asDict(at(branch, 'properties')) !== undefined,
  );
}

/** Merges several `StepFieldSchema` lists (e.g. `restore_cache`'s `key`/`keys` branches), keeping the first definition seen for a given field name. Mirrors `mergeKeyLists`, but over `StepFieldSchema`s rather than `SchemaCompletionItem`s -- the extra `type`/`enumValues`/`required` those carry is exactly what that function would have to grow to be reused here. */
function mergeStepFields(lists: StepFieldSchema[][]): StepFieldSchema[] {
  const byName = new Map<string, StepFieldSchema>();
  for (const list of lists) {
    for (const field of list) {
      if (!byName.has(field.name)) byName.set(field.name, field);
    }
  }
  return [...byName.values()];
}

/**
 * Reads every step keyword's field schema off `stepDef` (`definitions.step`'s
 * second `oneOf` branch -- see `stepNames` above, which reads the same
 * node for just its key names). Drives the inspector's per-step-type field
 * editors (issue #48) so `run`'s/`save_cache`'s/etc. fields, enums, and
 * required-ness come from the schema CircleCI itself validates against
 * rather than a hand-maintained duplicate of it.
 */
function extractStepFieldSchemas(
  stepDef: unknown,
): Record<string, StepFieldSchema[]> {
  const properties = asDict(at(stepDef, 'properties'));
  if (!properties) return {};
  const result: Record<string, StepFieldSchema[]> = {};
  for (const [key, schema] of Object.entries(properties)) {
    result[key] = mergeStepFields(
      objectBranchesOf(schema).map(extractStepFields),
    );
  }
  return result;
}

/**
 * Parses the raw JSON Schema document (as returned by `GET /api/schema`)
 * into the fact tables `createCircleciCompletionSource` needs. Never
 * throws: an unrecognized or malformed `raw` (e.g. a future incompatible
 * schema release, or a fetch that somehow returned something else) yields
 * `EMPTY_SCHEMA`, under which every completion source below simply proposes
 * nothing schema-derived rather than guessing.
 */
export function parseCircleciSchema(raw: unknown): CircleciSchema {
  if (asDict(raw) === undefined) return EMPTY_SCHEMA;

  // `definitions.jobInvocation`'s second `oneOf` branch (index 0 is the
  // bare-string "reference to a job defined elsewhere" form) is the inline
  // job-definition object. Its *own* `properties` only lists `type`; the
  // rest of a build job's keys (`docker`, `steps`, `resource_class`, ...)
  // live one `if`/`then`/`else` chain down, in the branch that applies when
  // `type` is absent or `"build"` -- the common case, and the one worth
  // completing against. `release`/`lock`/`unlock`/`approval`/`no-op` jobs
  // accept far fewer keys and are rare enough not to warrant their own
  // branch here.
  const jobInvocation = at(raw, 'definitions', 'jobInvocation', 'oneOf', 1);
  const buildJobBranch = at(jobInvocation, 'else', 'else', 'else', 'then');
  const jobKeys = mergeKeyLists(
    collectPropertyKeys(jobInvocation),
    collectPropertyKeys(buildJobBranch),
  );
  const jobTypeValues = collectEnumValues(
    at(jobInvocation, 'properties', 'type'),
  );

  // `properties.executors.additionalProperties`'s first `oneOf` branch is
  // the inline executor-definition object (the other branches are the
  // string/parameter-substitution forms an executor value can also take).
  const executorNode = at(
    raw,
    'properties',
    'executors',
    'additionalProperties',
    'oneOf',
    0,
  );
  const executorKeys = collectPropertyKeys(executorNode);
  // Only the top-level `executors.<name>.resource_class` carries the actual
  // enum (the docker resource classes); the same-named fields nested under
  // `macos`/`machine`, and every orb-scoped executor equivalent, are typed
  // as plain strings in the schema with no enum at all. Reusing this one
  // enum everywhere `resource_class:` appears (jobs, machine executors,
  // macos executors) is a deliberate approximation -- see the pass report.
  const resourceClassValues = collectEnumValues(
    at(executorNode, 'properties', 'resource_class'),
  );

  const workflowJobEntryKeys = collectPropertyKeys(
    at(
      raw,
      'definitions',
      'workflowJobInvocation',
      'oneOf',
      1,
      'additionalProperties',
    ),
  );

  // `definitions.step`'s second `oneOf` branch (index 0 is the bare-string
  // "reference to a command or built-in step" form) enumerates the actual
  // built-in steps as its own property names.
  const stepDef = at(raw, 'definitions', 'step', 'oneOf', 1);
  const stepNames = collectPropertyKeys(stepDef);
  const stepFieldSchemas = extractStepFieldSchemas(stepDef);

  const workflowKeys = collectPropertyKeys(
    at(raw, 'properties', 'workflows', 'additionalProperties'),
  );

  const dockerImageKeys = collectPropertyKeys(
    at(buildJobBranch, 'properties', 'docker', 'items'),
  );

  // Both `parameters:` blocks live at a fixed path and spell their type set as
  // a plain `enum`, so `collectEnumValues` reads each directly -- the same
  // one-hand-verified-path-per-fact approach as `resourceClassValues` above,
  // and the reason issue #250's type control can be a closed choice without a
  // literal in the web app to drift from the schema.
  //
  // `properties.parameters` is the pipeline block; the element block used here
  // is the build-job branch's, which is byte-identical to the `commands:`/
  // `executors:`/orb-scoped ones (verified: seven identical occurrences in the
  // vendored schema). Reading one rather than merging seven is deliberate --
  // a merge would quietly paper over a future release that made them differ,
  // which is exactly the sort of difference this editor should surface.
  const pipelineParameterTypeValues = collectEnumValues(
    at(
      raw,
      'properties',
      'parameters',
      'additionalProperties',
      'properties',
      'type',
    ),
  );
  const elementParameterTypeValues = collectEnumValues(
    at(
      buildJobBranch,
      'properties',
      'parameters',
      'additionalProperties',
      'properties',
      'type',
    ),
  );

  return {
    topLevelKeys: collectPropertyKeys(raw),
    jobKeys,
    executorKeys,
    workflowKeys,
    workflowJobEntryKeys,
    stepNames,
    resourceClassValues,
    jobTypeValues,
    pipelineParameterTypeValues,
    elementParameterTypeValues,
    dockerImageKeys,
    stepFieldSchemas,
  };
}
