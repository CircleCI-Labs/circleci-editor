/**
 * Resolves a `DiagnosticTarget` to a place in the *user's own text*, by
 * finding the exact node the message named in the parsed document and
 * reading its real `range` -- never by scanning the text for a substring,
 * and never by inferring a line from a message that didn't give one.
 *
 * The contract every function here upholds: **if the named entity is not
 * where the message says it is, return `undefined`.** A config can reference
 * a job through a YAML anchor, build a step name out of a parameter, or
 * inherit an executor through a merge key -- in all of those the compiler
 * still reports the resolved name, and there is no honest single line to
 * point at. `undefined` makes the UI say "location unknown", which is the
 * correct answer; a nearby-looking line would be a lie with a cursor on it.
 */
import { isMap, isScalar, isSeq, type Document, type Node } from 'yaml';

import { getNode, type PathSegment } from '~/lib/yaml/documentUtils';

import type { DiagnosticLocation, DiagnosticTarget } from './diagnostics';

/** Converts a character offset into the 1-based line/column pair every editor and error message uses. */
export function offsetToPosition(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: clamped - lastBreak };
}

/** The offset of the end of the line `from` sits on -- the newline itself, or EOF if there is none. */
function endOfLine(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

function locateNode(
  text: string,
  node: Node | undefined,
): DiagnosticLocation | undefined {
  const start = node?.range?.[0];
  // Narrowing on `start` alone doesn't tell TS `node` itself is defined
  // (optional chaining doesn't propagate that far), so `node` is re-checked
  // explicitly rather than accessed again through `?.` below.
  if (node === undefined || start === undefined) return undefined;
  const { line, column } = offsetToPosition(text, start);

  // `range[1]` is the end of the node's own content -- exactly the width
  // issue #9's underline needs, and not (per the `yaml` package's docs)
  // padded with the trailing whitespace/newline that `range[2]` includes.
  const end = node.range?.[1];
  if (end === undefined || end <= start)
    return { line, column, basis: 'resolved' };

  const endPosition = offsetToPosition(text, end);
  if (endPosition.line === line) {
    return {
      line,
      column,
      basis: 'resolved',
      endLine: line,
      endColumn: endPosition.column,
    };
  }
  // The node's range crosses a line break -- see `DiagnosticLocation.endLine`'s
  // own comment for why this clips to the start line rather than carrying the
  // real, multi-line end through.
  const clipped = offsetToPosition(text, endOfLine(text, start));
  return {
    line,
    column,
    basis: 'resolved',
    endLine: line,
    endColumn: clipped.column,
  };
}

/** The key node of `key` within the map at `path`, which is what an `extraneous key` finding is actually about. */
function keyNodeAt(
  doc: Document,
  path: PathSegment[],
  key: string,
): Node | undefined {
  const container = getNode(doc, path);
  if (!isMap(container)) return undefined;
  const pair = container.items.find(
    (item) => isScalar(item.key) && String(item.key.value) === key,
  );
  return isScalar(pair?.key) ? pair.key : undefined;
}

/** Every workflow name, or just `only` when the message named one. Keeps "search everywhere" and "search exactly here" on one code path. */
function workflowScope(doc: Document, only?: string): string[] {
  if (only !== undefined) return [only];
  const node = getNode(doc, ['workflows']);
  if (!isMap(node)) return [];
  return node.items
    .filter((pair) => isScalar(pair.key))
    .map((pair) => String((pair.key as { value: unknown }).value));
}

/** The alias a workflow job entry runs under: its `name:` override if it has one, else the job name it invokes. */
function entryAlias(jobName: string, options: unknown): string {
  if (!isMap(options)) return jobName;
  const namePair = options.items.find(
    (pair) => isScalar(pair.key) && String(pair.key.value) === 'name',
  );
  return isScalar(namePair?.value) ? String(namePair.value.value) : jobName;
}

export interface EntryHit {
  /** The `- name:` key scalar, or the bare `- name` scalar for a string entry. */
  keyNode: Node;
  /** The entry's options map, if it has one. */
  options: unknown;
  alias: string;
  jobName: string;
}

/** Walks one workflow's `jobs:` sequence, yielding the live key node of each entry -- shared with `suggestions.ts`, which mutates those very nodes in place so their comments survive. */
export function* workflowEntries(
  doc: Document,
  workflow: string,
): Generator<EntryHit> {
  const seq = getNode(doc, ['workflows', workflow, 'jobs']);
  if (!isSeq(seq)) return;
  for (const item of seq.items) {
    if (isScalar(item)) {
      const jobName = String(item.value);
      yield { keyNode: item, options: undefined, alias: jobName, jobName };
      continue;
    }
    if (!isMap(item) || item.items.length === 0) continue;
    const pair = item.items[0];
    if (!pair || !isScalar(pair.key)) continue;
    const jobName = String(pair.key.value);
    yield {
      keyNode: pair.key,
      options: pair.value,
      alias: entryAlias(jobName, pair.value),
      jobName,
    };
  }
}

/** The `- <name>` item within a step sequence, whether it was written as a bare scalar or as a single-key map. Returns the live scalar (the bare item, or the map's key) so callers can rename it in place. */
export function findStepNode(steps: unknown, name: string): Node | undefined {
  if (!isSeq(steps)) return undefined;
  for (const item of steps.items) {
    if (isScalar(item) && String(item.value) === name) return item;
    if (isMap(item) && item.items.length > 0) {
      const pair = item.items[0];
      if (pair && isScalar(pair.key) && String(pair.key.value) === name) {
        return pair.key;
      }
    }
  }
  return undefined;
}

/**
 * Every live scalar inside `fromAlias`'s `requires:` that names `id`, in
 * whichever workflows `workflow` scopes to. More than one hit means the id
 * is ambiguous and callers must decline to act; zero means the id isn't
 * written where the compiler said it was (a parameter, an alias) and there
 * is nothing to point at or rename.
 */
export function findRequiresItemNodes(
  doc: Document,
  workflow: string | undefined,
  fromAlias: string,
  id: string,
): Node[] {
  const hits: Node[] = [];
  for (const name of workflowScope(doc, workflow)) {
    for (const entry of workflowEntries(doc, name)) {
      if (entry.alias !== fromAlias) continue;
      if (!isMap(entry.options)) continue;
      const requiresPair = entry.options.items.find(
        (pair) => isScalar(pair.key) && String(pair.key.value) === 'requires',
      );
      const seq = requiresPair?.value;
      if (!isSeq(seq)) continue;
      for (const item of seq.items) {
        if (isScalar(item) && String(item.value) === id) {
          hits.push(item);
        } else if (isMap(item) && item.items.length > 0) {
          const pair = item.items[0];
          if (pair && isScalar(pair.key) && String(pair.key.value) === id) {
            hits.push(pair.key);
          }
        }
      }
    }
  }
  return hits;
}

/**
 * Resolves `target` against the parsed document, returning a location only
 * when the named entity is genuinely there. `text` must be the text `doc`
 * was parsed from -- ranges are offsets into it.
 */
export function locateTarget(
  doc: Document | null,
  text: string,
  target: DiagnosticTarget | undefined,
): DiagnosticLocation | undefined {
  if (!doc || !target) return undefined;

  switch (target.kind) {
    case 'orb': {
      const orbs = getNode(doc, ['orbs']);
      if (!isMap(orbs)) return undefined;
      // Match on the whole `namespace/orb@version` string: that is exactly
      // what the compiler echoed back, so an entry holding it is the entry
      // it failed on. An orb reference assembled from a parameter won't
      // match, and correctly yields no location.
      const pair = orbs.items.find(
        (item) =>
          isScalar(item.value) && String(item.value.value) === target.ref,
      );
      return locateNode(text, isScalar(pair?.value) ? pair.value : undefined);
    }

    case 'workflowJob': {
      const hits: Node[] = [];
      for (const workflow of workflowScope(doc, target.workflow)) {
        for (const entry of workflowEntries(doc, workflow)) {
          if (entry.jobName === target.jobName) hits.push(entry.keyNode);
        }
      }
      // Several entries can invoke the same undefined job. Pointing at one
      // arbitrarily would be a guess, so only an unambiguous single site
      // gets a location; the summary still shows the error either way.
      return hits.length === 1 ? locateNode(text, hits[0]) : undefined;
    }

    case 'requires': {
      const hits = findRequiresItemNodes(
        doc,
        target.workflow,
        target.fromAlias,
        target.missingId,
      );
      return hits.length === 1 ? locateNode(text, hits[0]) : undefined;
    }

    case 'executor': {
      if (target.job === undefined) return undefined;
      const executor = getNode(doc, ['jobs', target.job, 'executor']);
      if (isScalar(executor) && String(executor.value) === target.name) {
        return locateNode(text, executor);
      }
      // `executor: { name: x, ... }` -- the parameterised invocation form.
      if (isMap(executor)) {
        const namePair = executor.items.find(
          (pair) => isScalar(pair.key) && String(pair.key.value) === 'name',
        );
        if (
          isScalar(namePair?.value) &&
          String(namePair.value.value) === target.name
        ) {
          return locateNode(text, namePair.value);
        }
      }
      return undefined;
    }

    case 'command': {
      const owner: PathSegment[] | undefined =
        target.job !== undefined
          ? ['jobs', target.job, 'steps']
          : target.fromCommand !== undefined
            ? ['commands', target.fromCommand, 'steps']
            : undefined;
      if (!owner) return undefined;
      return locateNode(text, findStepNode(getNode(doc, owner), target.name));
    }

    case 'schemaPath': {
      if (target.key !== undefined) {
        const keyNode = keyNodeAt(doc, target.path, target.key);
        if (keyNode) return locateNode(text, keyNode);
        return undefined;
      }
      return locateNode(text, getNode(doc, target.path));
    }
  }
}
