/**
 * Editing a config's `parameters:` -- at the top level (pipeline parameters)
 * and inside a job (that job's own element parameters). Issue #250: the palette
 * had a section named after them and no way to change one.
 *
 * Same contract as `configMutations.ts`, which this module is a sibling of
 * rather than a part of purely for size: **every export mutates `doc` in place,
 * returns `void`, and signals refusal by throwing.** The store clones before
 * calling in and discards the clone if anything throws, so a refusal leaves the
 * document byte-identical.
 *
 * # Two rules this module exists to enforce
 *
 * 1. **Nothing is written that the user did not ask for.** There is no default
 *    type, no default `default:`, no synthesised `enum` value. `addParameter`
 *    takes exactly the fields it should write and writes exactly those; a field
 *    left unset is a key that does not appear. This is not fussiness: a
 *    `default:` the editor invented is a value that silently becomes what every
 *    un-supplied pipeline run uses, and the Save dialog's diff would show a
 *    line the user never typed.
 * 2. **A type change never destroys data.** Moving a parameter off `enum` keeps
 *    its `enum:` list -- the list becomes inert rather than deleted, and the UI
 *    says so and offers to remove it as a separate, separately-undoable action.
 *    Deleting it as a side effect of a dropdown change would be the silent data
 *    loss issue #250 explicitly rules out.
 *
 * # Renaming
 *
 * `renameParameter` is the whole reason `parameterReferences.ts` exists next
 * door. It reconciles, in one call and therefore in one undo step:
 *
 *  - the declaration key itself, via `renameKey` (so its position and its
 *    comment survive);
 *  - every `<< parameters.name >>` / `<< pipeline.parameters.name >>` inside
 *    the scope's own subtree, by rewriting the *string value of the existing
 *    scalar node* -- never by replacing the node, so an inline comment on that
 *    line stays on that line;
 *  - for a job parameter, every workflow-entry and job-group-entry key that
 *    supplies it by name.
 *
 * It refuses outright when `parameterReferences` reports a blocker, rather than
 * completing part of the rename: a half-reconciled rename leaves a
 * `<< parameters.x >>` resolving to nothing, which is the failure mode issue
 * #250 asks us to avoid even at the cost of saying no.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

import { collapseIfEmptyOptions } from '~/lib/mutations/configMutations';
import {
  findParameterReferences,
  parametersPath,
  referenceExpression,
  rewriteReferencesInText,
  type ParameterScope,
} from '~/lib/mutations/parameterReferences';
import {
  deleteIn,
  findAliasSites,
  getIn,
  getJobGroupNames,
  getJobNames,
  getNode,
  getWorkflowNames,
  listKeys,
  renameKey,
  setIn,
  type Path,
} from '~/lib/yaml/documentUtils';

/**
 * A parameter definition as this editor writes it. Every field except `type` is
 * optional *and absent when undefined* -- see rule 1 in the module doc. `type`
 * is required because CircleCI requires it and because the whole complaint in
 * issue #250 was not being able to say what type a parameter is.
 */
export interface ParameterDefinitionInput {
  type: string;
  /** Written verbatim. `undefined` means "no `default:` key", not "default to something". */
  default?: unknown;
  description?: string;
  /** Only meaningful for `type: enum`; written only when non-empty. */
  enumValues?: string[];
}

/** A parameter as read back out of the document, for rendering. */
export interface ParameterSummary {
  name: string;
  /**
   * The declared type, or `undefined` when the parameter has no `type:` key at
   * all. Deliberately not defaulted to `'string'` the way the old read-only
   * palette list did: an editor that shows `string` for a parameter whose type
   * is missing is telling the user their config says something it does not, and
   * "no type" is a real, reportable state (the schema requires `type`).
   */
  type?: string;
  hasDefault: boolean;
  default?: unknown;
  description?: string;
  /** The `enum:` list as written, whatever the declared type is -- so a list left behind by a type change is visible rather than silently ignored. */
  enumValues: string[];
  /** True when this parameter's definition is a YAML anchor or alias, which makes it un-editable here. */
  shared: boolean;
}

/**
 * What a parameter name may look like. CircleCI's own guide describes parameter
 * names as identifiers, and `<< parameters.NAME >>` is terminated by whitespace
 * or `>>`, so anything containing a space, a dot, or a `>` could not be
 * referenced at all. Kept deliberately permissive beyond that (uppercase and
 * leading underscores are accepted) so this never refuses a name a real config
 * already uses -- validation here exists to stop the editor writing something
 * unreferenceable, not to relitigate CircleCI's naming taste.
 */
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Human-readable reason `name` is unusable, or `null` when it is fine. */
export function validateParameterName(name: string): string | null {
  if (name.length === 0) return 'A parameter needs a name.';
  if (!PARAMETER_NAME_PATTERN.test(name)) {
    return (
      'A parameter name must start with a letter or underscore and contain ' +
      'only letters, digits, hyphens and underscores -- anything else cannot ' +
      'be written as << parameters.name >>.'
    );
  }
  return null;
}

function requireScopeExists(doc: Document, scope: ParameterScope): void {
  if (scope.kind === 'job' && !getJobNames(doc).includes(scope.jobName)) {
    throw new Error(`Job "${scope.jobName}" is not defined under jobs:`);
  }
}

function scopeDescription(scope: ParameterScope): string {
  return scope.kind === 'pipeline'
    ? 'the pipeline parameters'
    : `job "${scope.jobName}"`;
}

/** Throws unless `name` is declared in `scope`. */
function requireParameter(
  doc: Document,
  scope: ParameterScope,
  name: string,
): void {
  requireScopeExists(doc, scope);
  if (!listKeys(doc, parametersPath(scope)).includes(name)) {
    throw new Error(`${scopeDescription(scope)} has no parameter "${name}"`);
  }
}

/**
 * Reads `scope`'s `parameters:` in document order. Returns `[]` when the block
 * does not exist -- an absent `parameters:` and an empty one are the same thing
 * to a reader, and distinguishing them would only give the UI a state it has
 * nothing different to say about.
 */
export function listParameters(
  doc: Document,
  scope: ParameterScope,
): ParameterSummary[] {
  const path = parametersPath(scope);
  const map = getNode(doc, path);
  return listKeys(doc, path).map((name) => {
    const raw = getIn(doc, [...path, name]);
    const def =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const enumRaw = def.enum;
    let shared = findAliasSites(doc, [...path, name]).length > 0;
    if (!shared && isMap(map)) {
      const pair = map.items.find(
        (p) => isScalar(p.key) && String(p.key.value) === name,
      );
      if (pair && isAlias(pair.value)) shared = true;
    }
    return {
      name,
      type: typeof def.type === 'string' ? def.type : undefined,
      hasDefault: 'default' in def,
      default: def.default,
      description:
        typeof def.description === 'string' ? def.description : undefined,
      enumValues: Array.isArray(enumRaw) ? enumRaw.map((v) => String(v)) : [],
      shared,
    };
  });
}

/**
 * Adds `name` to `scope`'s `parameters:`, creating the block if it does not
 * exist yet.
 *
 * Written as a single `setIn` at `[...parameters, name]` rather than replacing
 * the `parameters:` map: `setIn` appends one `Pair` to whatever map is already
 * there, so every sibling parameter -- and every comment on one -- is untouched.
 */
export function addParameter(
  doc: Document,
  scope: ParameterScope,
  name: string,
  definition: ParameterDefinitionInput,
): void {
  requireScopeExists(doc, scope);
  const invalid = validateParameterName(name);
  if (invalid) throw new Error(invalid);
  const path = parametersPath(scope);
  if (listKeys(doc, path).includes(name)) {
    throw new Error(
      `${scopeDescription(scope)} already has a parameter "${name}"`,
    );
  }
  if (definition.type.length === 0) {
    throw new Error(`Choose a type for "${name}" -- CircleCI requires one.`);
  }

  // Insertion order here is the order the keys appear in the file, and it
  // matches how CircleCI's own docs write a parameter: type, then default, then
  // description, then the enum list. Only keys the caller actually supplied are
  // built into the object -- see rule 1 in the module doc.
  const body: Record<string, unknown> = { type: definition.type };
  if (definition.default !== undefined) body.default = definition.default;
  if (definition.description !== undefined && definition.description !== '') {
    body.description = definition.description;
  }
  if (definition.enumValues && definition.enumValues.length > 0) {
    body.enum = [...definition.enumValues];
  }
  setIn(doc, [...path, name], body);
}

/**
 * Removes `name` from `scope`'s `parameters:`, and removes every call site that
 * supplied it by name (a workflow or job-group entry key), so the config does
 * not keep passing an argument the job no longer declares -- which compiles to
 * `Unexpected argument(s)`.
 *
 * Deliberately does **not** touch `<< parameters.name >>` references. Rewriting
 * them with the parameter's own default would be inventing config; removing the
 * scalars that contain them would be deleting the user's steps. Both are the
 * class of guess already refused for a deleted job's `requires:`, and the same
 * answer applies: leave the breakage visible and say so (see
 * `describeParameterDeleteImpact`).
 *
 * Refuses when the definition is itself a YAML anchor something still aliases,
 * matching `configMutations`'s own refusal for a job in that state.
 */
export function removeParameter(
  doc: Document,
  scope: ParameterScope,
  name: string,
): void {
  requireParameter(doc, scope, name);
  const path = parametersPath(scope);
  const aliasSites = findAliasSites(doc, [...path, name]);
  if (aliasSites.length > 0) {
    throw new Error(
      `Cannot remove parameter "${name}": its definition is a YAML anchor still ` +
        `referenced by ${aliasSites.map((s) => `"${s}"`).join(', ')}. Remove or ` +
        `inline those references first.`,
    );
  }

  if (scope.kind === 'job') {
    forEachInvocationOptions(doc, scope.jobName, (options, seq, entryIndex) => {
      const index = options.items.findIndex(
        (p) => isScalar(p.key) && String(p.key.value) === name,
      );
      if (index === -1) return;
      options.items.splice(index, 1);
      // An entry whose only reason to be a map was this one parameter goes back
      // to a bare string, via `configMutations`'s own collapse rather than a
      // second copy of the rule -- `- build: {}` is legal YAML that no human
      // writes, and every other removal in this codebase already avoids it.
      collapseIfEmptyOptions(doc, seq, entryIndex);
    });
  }

  deleteIn(doc, [...path, name]);

  // An emptied `parameters:` map is not valid config (the schema requires at
  // least one entry for an element, and `parameters: {}` is noise at the top
  // level), so the block goes with its last member.
  if (listKeys(doc, path).length === 0) deleteIn(doc, path);
}

/**
 * Sets `name`'s `type:`.
 *
 * Leaves any existing `enum:` list in place, whatever the new type is. That is
 * the deliberate answer to issue #250's "a type change away from `enum` has to
 * do something sensible with them rather than silently dropping data": the
 * values stay in the file, where the user can see them, and
 * `removeParameterEnumValues` is the separate, explicit, separately-undoable
 * action that discards them. `enum:` alongside a non-enum type is accepted by
 * the config schema (it is a declared property of a parameter, not an
 * `additionalProperties` violation), so this never makes the document invalid
 * in the meantime.
 */
export function setParameterType(
  doc: Document,
  scope: ParameterScope,
  name: string,
  type: string,
): void {
  requireParameter(doc, scope, name);
  if (type.length === 0) {
    throw new Error(`Choose a type for "${name}" -- CircleCI requires one.`);
  }
  setIn(doc, [...parametersPath(scope), name, 'type'], type);
}

/**
 * Sets `name`'s `default:`, or removes the key when `value` is `undefined`.
 *
 * Removing it is a real thing a user may want and is offered as such, even
 * though the schema marks `default` required for a *pipeline* parameter -- the
 * editor's job is to write what was asked for and let validation report the
 * consequence, not to refuse an
 * edit because the result would need fixing.
 */
export function setParameterDefault(
  doc: Document,
  scope: ParameterScope,
  name: string,
  value: unknown,
): void {
  requireParameter(doc, scope, name);
  const path: Path = [...parametersPath(scope), name, 'default'];
  if (value === undefined) {
    deleteIn(doc, path);
    return;
  }
  setIn(doc, path, value);
}

/** Sets `name`'s `description:`, or removes the key when `text` is empty/undefined. */
export function setParameterDescription(
  doc: Document,
  scope: ParameterScope,
  name: string,
  text: string | undefined,
): void {
  requireParameter(doc, scope, name);
  const path: Path = [...parametersPath(scope), name, 'description'];
  if (text === undefined || text === '') {
    deleteIn(doc, path);
    return;
  }
  setIn(doc, path, text);
}

/**
 * Replaces `name`'s `enum:` list with `values`.
 *
 * The one place in this module that rewrites a whole container rather than one
 * scalar, and it is the right call here: the list is a single logical value the
 * editor owns end to end (there is no per-item field elsewhere that could hold
 * a comment worth preserving), and the alternative -- splicing individual items
 * -- would need an item-index API in the UI that buys nothing. Compare
 * `EnvironmentField`'s map-rewrite convention in the inspector.
 *
 * An empty `values` removes the key. That is not silent data loss: it is only
 * reachable from the explicit "remove the values" action or by the user clearing
 * every row one at a time.
 */
export function setParameterEnumValues(
  doc: Document,
  scope: ParameterScope,
  name: string,
  values: string[],
): void {
  requireParameter(doc, scope, name);
  const path: Path = [...parametersPath(scope), name, 'enum'];
  if (values.length === 0) {
    deleteIn(doc, path);
    return;
  }
  setIn(doc, path, [...values]);
}

/** Drops `name`'s `enum:` list entirely -- the explicit counterpart to `setParameterType` deliberately keeping it. */
export function removeParameterEnumValues(
  doc: Document,
  scope: ParameterScope,
  name: string,
): void {
  requireParameter(doc, scope, name);
  deleteIn(doc, [...parametersPath(scope), name, 'enum']);
}

/**
 * Renames `name` to `newName` in `scope`, reconciling every reference in one
 * pass -- and therefore, since the store gives each `mutate` call exactly one
 * undo entry, in one undo step however many sites it touched.
 *
 * Refuses (before changing anything) when the new name is unusable, when it is
 * already taken, or when `findParameterReferences` reports a blocker -- see
 * that module on the merge-key case, which is the one situation where neither
 * rewriting a reference nor leaving it is safe.
 */
export function renameParameter(
  doc: Document,
  scope: ParameterScope,
  name: string,
  newName: string,
): void {
  requireParameter(doc, scope, name);
  if (name === newName) return;
  const invalid = validateParameterName(newName);
  if (invalid) throw new Error(invalid);
  const path = parametersPath(scope);
  if (listKeys(doc, path).includes(newName)) {
    throw new Error(
      `${scopeDescription(scope)} already has a parameter "${newName}"`,
    );
  }

  const refs = findParameterReferences(doc, scope, name);
  if (refs.renameBlockers.length > 0) {
    throw new Error(
      `Cannot rename "${name}" to "${newName}" without leaving a reference ` +
        `dangling: ${refs.renameBlockers.join(' ')}`,
    );
  }

  const oldExpression = referenceExpression(scope, name);
  const newExpression = referenceExpression(scope, newName);

  // Interpolations first, while the paths `findParameterReferences` returned
  // still resolve. Renaming the declaration key does not move any of them (all
  // recorded sites are outside the `parameters:` block or, for a description
  // mentioning the parameter, under the key being renamed) -- but rewriting
  // before the rename removes the question entirely.
  for (const site of refs.interpolations) {
    const node = getNode(doc, site.path);
    if (!isScalar(node) || typeof node.value !== 'string') continue;
    // Mutating `.value` on the existing Scalar, rather than replacing the node:
    // that is what keeps the node's own comment, anchor and block style, and
    // what lets `serializeMinimalDiff` splice this one line.
    node.value = rewriteReferencesInText(
      node.value,
      oldExpression,
      newExpression,
    );
  }

  if (scope.kind === 'job') {
    forEachInvocationOptions(doc, scope.jobName, (options) => {
      const pair = options.items.find(
        (p) => isScalar(p.key) && String(p.key.value) === name,
      );
      if (pair && isScalar(pair.key)) pair.key.value = newName;
    });
  }

  renameKey(doc, path, name, newName);
}

/**
 * Calls `visit` with the live options map of every workflow entry and
 * job-group entry that invokes `jobName` in map form. A bare-string entry
 * (`- build`) has no options map and passes no parameters, so there is nothing
 * to visit and deliberately nothing created.
 *
 * A job's parameters are supplied as ordinary keys of that map, siblings of
 * `requires`/`context`/`filters` -- see `configMutations`'s
 * `RESERVED_ENTRY_OPTION_KEYS`, which is the same fact read from the other
 * direction. Job groups invoke jobs the same way (issue #220), so they get the
 * same treatment for the same reason `renameJob` gives them.
 */
function forEachInvocationOptions(
  doc: Document,
  jobName: string,
  visit: (options: YAMLMap, seq: YAMLSeq, index: number) => void,
): void {
  const owners: [container: string, names: string[]][] = [
    ['workflows', getWorkflowNames(doc)],
    ['job-groups', getJobGroupNames(doc)],
  ];
  for (const [container, names] of owners) {
    for (const ownerName of names) {
      const seq = getNode(doc, [container, ownerName, 'jobs']);
      if (!isSeq(seq)) continue;
      seq.items.forEach((item, index) => {
        if (!isMap(item) || item.items.length === 0) return;
        const pair = item.items[0] as Pair;
        if (!isScalar(pair.key) || String(pair.key.value) !== jobName) return;
        const options = getNode(doc, [
          container,
          ownerName,
          'jobs',
          index,
          jobName,
        ]);
        if (!isMap(options)) return;
        visit(options, seq, index);
      });
    }
  }
}
