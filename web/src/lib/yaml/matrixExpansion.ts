/**
 * Expands a workflow entry's `matrix:` stanza into the individual parameter
 * combinations CircleCI actually compiles it into (issue #284).
 *
 * Before this module existed, `matrix:` was read as a plain boolean
 * (`findPair(options, 'matrix') !== undefined`) everywhere in this app, so a
 * matrix entry became exactly *one* graph node whose id was the un-expanded
 * template string (e.g. `Deploy frontend to << matrix.region >>`). CircleCI
 * itself expands that into N real jobs (`Deploy frontend to NA`, `... to
 * EU`, ...), and a `requires:` elsewhere in the workflow names those real
 * jobs -- so the dangling-`requires:` check (`buildGraph.ts`) fired an
 * `error` on a config that `circleci config validate` accepts. That is the
 * worst class of defect this app can ship: it trains users to distrust the
 * one panel whose entire job is catching real mistakes.
 *
 * This is shared between `~/lib/graph/buildGraph` (which needs one
 * `GraphNode` per combination so the graph -- and its dangling check -- see
 * what CircleCI actually runs) and `~/lib/mutations/configMutations`
 * (`readEntries`, which must resolve every one of those N node ids back to
 * the *same* single YAML entry, or a mutation from an expanded node would
 * either fail to find its target or, worse, write N times). Both callers run
 * this same expansion over the same live document, so they necessarily agree
 * on every id -- there is no second place this logic could drift out of sync
 * with itself.
 *
 * **Default naming and parameter order are established from CircleCI's own
 * vendored docs, not guessed.** Two independent worked examples in
 * `internal/guides/snapshot/docs/`, from different doc pages, agree on the
 * rule:
 *
 *  - `guides/modules/orchestrate/pages/using-matrix-jobs.adoc`: parameters
 *    declared `os: [docker, linux, macos]` then `node-version: ["14.17.6",
 *    "16.9.0"]` expand `test` into `test-14.17.6-docker`, `test-16.9.0-docker`,
 *    `test-14.17.6-linux`, ... .
 *  - `reference/modules/ROOT/pages/configuration-reference.adoc`'s `[#matrix]`
 *    example: parameters declared `version: ["0.1", "0.2", "0.3"]` then
 *    `platform: ["macos", "windows", "linux"]` expand `build` into
 *    `build-macos-0.1`, `build-macos-0.2`, `build-macos-0.3`,
 *    `build-windows-0.1`, ... .
 *
 * In both, the default name is the job name followed by every parameter's
 * value for that combination, joined by `-`, in the *reverse* of the order
 * the parameters were declared in `matrix.parameters` (first example:
 * declared `os`, `node-version` -> named `<node-version>-<os>`; second:
 * declared `version`, `platform` -> named `<platform>-<version>`). See
 * `defaultMatrixName`.
 *
 * `configuration-reference.adoc`'s "Dependencies and matrix jobs" section
 * additionally documents that `requires:` can name a matrix's `alias:`
 * (defaulting to the bare job name) to mean "every job in this matrix", and
 * that a matrix job's own `name:`/`requires:` may contain `<< matrix.* >>`
 * tokens that resolve per-instance -- both handled here (`substituteMatrixTemplate`)
 * so `buildGraph.ts` doesn't have to re-derive either rule.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type YAMLMap,
} from 'yaml';

/** One parameter combination this matrix expands into: every declared parameter's own value for this instance. */
export type MatrixCombo = Record<string, unknown>;

export interface MatrixSpec {
  /** Parameter names, in the order `matrix.parameters` declared them -- see this module's doc comment on why that order (reversed) drives the default name. */
  paramNames: string[];
  /**
   * Every combination `matrix.parameters` produces, in nested-loop order
   * (first-declared parameter outermost/slowest), with every combination
   * `exclude:` lists already removed.
   */
  combos: MatrixCombo[];
  /**
   * `matrix.alias`, or `undefined` when the entry doesn't set one. Per
   * `configuration-reference.adoc`, a `requires:` elsewhere naming this (or,
   * absent an explicit alias, the bare job name) means "wait for every job in
   * this matrix" -- not a single instance. See `buildGraph.ts`'s
   * `matrixAliasToInstanceIds`.
   */
  alias?: string;
}

function findPair(map: YAMLMap, key: string) {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

/**
 * Dereferences `node` if it's a YAML alias (`*anchor`), otherwise returns it
 * unchanged. Matrix parameter *values* are exactly the shape issue #41 (a
 * `deleteJob` alias crash) warned this codebase about: a real config reuses
 * the same value list across several matrix entries via `&anchor`/`*anchor`
 * rather than repeating it, so every read in this module that could be
 * looking at a value someone aliased goes through this first instead of
 * assuming a live map/seq/scalar.
 */
function resolveMaybeAlias(doc: Document, node: unknown): unknown {
  return isAlias(node) ? node.resolve(doc) : node;
}

/** Reads one `matrix.parameters.<name>` value list to plain values, following an alias on the list itself or on any one item within it. */
function readParamValues(doc: Document, rawValue: unknown): unknown[] {
  const resolved = resolveMaybeAlias(doc, rawValue);
  if (isSeq(resolved)) {
    return resolved.items.map((item) => {
      const resolvedItem = resolveMaybeAlias(doc, item);
      return isScalar(resolvedItem) ? resolvedItem.value : undefined;
    });
  }
  // CircleCI's own spec always shows a list here, but a single bare scalar
  // isn't ambiguous -- treat it as the one-element list it would mean.
  if (isScalar(resolved)) return [resolved.value];
  return [];
}

/** Reads `matrix.exclude` to a list of plain `{ param: value }` maps, following aliases the same way `readParamValues` does. */
function readExcludeList(doc: Document, rawValue: unknown): MatrixCombo[] {
  const resolved = resolveMaybeAlias(doc, rawValue);
  if (!isSeq(resolved)) return [];

  const list: MatrixCombo[] = [];
  for (const item of resolved.items) {
    const resolvedItem = resolveMaybeAlias(doc, item);
    if (!isMap(resolvedItem)) continue;
    const entry: MatrixCombo = {};
    for (const pair of resolvedItem.items) {
      if (!isScalar(pair.key)) continue;
      const value = resolveMaybeAlias(doc, pair.value);
      entry[String(pair.key.value)] = isScalar(value) ? value.value : undefined;
    }
    list.push(entry);
  }
  return list;
}

/** The cross product of every parameter's values, nested-loop order with `paramNames[0]` outermost/slowest -- i.e. `paramNames[0]`'s value changes least often across the resulting list. */
function crossProduct(
  paramNames: string[],
  values: Record<string, unknown[]>,
): MatrixCombo[] {
  let combos: MatrixCombo[] = [{}];
  for (const name of paramNames) {
    const vals = values[name] ?? [];
    const next: MatrixCombo[] = [];
    for (const combo of combos) {
      for (const value of vals) next.push({ ...combo, [name]: value });
    }
    combos = next;
  }
  return combos;
}

/**
 * Whether `combo` matches one of `exclude`'s argument maps -- every key an
 * exclude entry specifies must equal `combo`'s value for that key (compared
 * as strings, since a matrix value may be a YAML string, number, or
 * boolean). An exclude entry with no keys at all matches nothing, rather than
 * excluding every combination.
 */
function isExcluded(combo: MatrixCombo, exclude: MatrixCombo[]): boolean {
  return exclude.some((entry) => {
    const keys = Object.keys(entry);
    if (keys.length === 0) return false;
    return keys.every((key) => String(combo[key]) === String(entry[key]));
  });
}

/**
 * Reads `optionsMap`'s `matrix:` stanza into a `MatrixSpec`, or `undefined`
 * when the entry has no `matrix:` key at all, or `matrix:`/`matrix.parameters`
 * isn't shaped the way CircleCI requires (a map). The latter is deliberately
 * not an error here -- a config that malformed can't be expanded
 * meaningfully, so the caller falls back to treating the entry as an
 * ordinary (unexpanded) node rather than guessing.
 */
export function readMatrixSpec(
  doc: Document,
  optionsMap: YAMLMap,
): MatrixSpec | undefined {
  const matrixPair = findPair(optionsMap, 'matrix');
  if (!matrixPair) return undefined;
  const matrixValue = resolveMaybeAlias(doc, matrixPair.value);
  if (!isMap(matrixValue)) return undefined;

  const parametersPair = findPair(matrixValue, 'parameters');
  const parametersValue = parametersPair
    ? resolveMaybeAlias(doc, parametersPair.value)
    : undefined;
  if (!isMap(parametersValue)) return undefined;

  const paramNames: string[] = [];
  const values: Record<string, unknown[]> = {};
  for (const pair of parametersValue.items) {
    if (!isScalar(pair.key)) continue;
    const name = String(pair.key.value);
    paramNames.push(name);
    values[name] = readParamValues(doc, pair.value);
  }
  if (paramNames.length === 0) return undefined;

  const excludePair = findPair(matrixValue, 'exclude');
  const exclude = excludePair ? readExcludeList(doc, excludePair.value) : [];

  const aliasPair = findPair(matrixValue, 'alias');
  const aliasValue = aliasPair
    ? resolveMaybeAlias(doc, aliasPair.value)
    : undefined;
  const alias = isScalar(aliasValue) ? String(aliasValue.value) : undefined;

  const combos = crossProduct(paramNames, values).filter(
    (combo) => !isExcluded(combo, exclude),
  );

  return { paramNames, combos, alias };
}

/** Matches a `<< matrix.PARAM >>` token; `PARAM` is capture group 1. */
const MATRIX_TEMPLATE_RE = /<<\s*matrix\.([A-Za-z0-9_-]+)\s*>>/g;

/**
 * Substitutes every `<< matrix.PARAM >>` token in `raw` with `combo[PARAM]`,
 * for one expanded matrix instance's own `name:` or `requires:` entry. A
 * token naming a parameter this combo doesn't have is left verbatim --
 * fabricating a value for it would be a guess, and leaving it untouched at
 * least fails visibly (as a literal, unresolved-looking id) rather than
 * silently.
 */
export function substituteMatrixTemplate(
  raw: string,
  combo: MatrixCombo,
): string {
  return raw.replace(MATRIX_TEMPLATE_RE, (whole: string, paramName: string) =>
    paramName in combo ? String(combo[paramName]) : whole,
  );
}

/**
 * CircleCI's default name for a matrix instance with no explicit `name:` --
 * see this module's doc comment for where the reverse-declaration-order rule
 * was established.
 */
export function defaultMatrixName(
  jobName: string,
  paramNames: string[],
  combo: MatrixCombo,
): string {
  const parts = [...paramNames].reverse().map((name) => String(combo[name]));
  return [jobName, ...parts].join('-');
}
