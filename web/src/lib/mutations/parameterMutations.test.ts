import { describe, expect, it } from 'vitest';
import type { Document } from 'yaml';

import { countChangedLines, unifiedDiff } from '~/lib/yaml/diff';
import {
  cloneDocument,
  getIn,
  listKeys,
  parseConfig,
} from '~/lib/yaml/documentUtils';
import { serializeMinimalDiff } from '~/lib/yaml/spliceSerialize';

import {
  addParameter,
  listParameters,
  removeParameter,
  removeParameterEnumValues,
  renameParameter,
  setParameterDefault,
  setParameterDescription,
  setParameterEnumValues,
  setParameterType,
  validateParameterName,
} from './parameterMutations';
import type { ParameterScope } from './parameterReferences';

import parametersFixture from '~/fixtures/parameters.yml?raw';

const PIPELINE: ParameterScope = { kind: 'pipeline' };
const BUILD: ParameterScope = { kind: 'job', jobName: 'build' };

function parse(text: string): Document {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

/**
 * Applies `edit` through exactly the path `appStore.mutate` uses -- clone,
 * mutate the clone, then `serializeMinimalDiff` against the original text --
 * rather than the raw `doc.toString()`. Copied deliberately from
 * `configMutations.test.ts`: the splice path is the one users actually get, and
 * the whole point of the round-trip assertions below is that untouched regions
 * survive it byte for byte.
 */
function applyLikeTheStore(
  text: string,
  edit: (doc: Document) => void,
): string {
  const doc = parse(text);
  const clone = cloneDocument(doc);
  edit(clone);
  return serializeMinimalDiff(text, doc, clone);
}

/** Every `#`-comment substring in `text`, in order -- same shape `roundtrip.test.ts` asserts on. */
function comments(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const match = /#.*$/.exec(line);
    if (match) found.push(match[0]);
  }
  return found;
}

/** Asserts every line except those numbered in `changedLines` is byte-identical. */
function assertOnlyLinesDiffer(
  before: string,
  after: string,
  changedLines: number[],
): void {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  const changed = new Set(changedLines);
  for (let i = 0; i < beforeLines.length; i++) {
    if (changed.has(i + 1)) continue;
    expect(afterLines[i]).toBe(beforeLines[i]);
  }
}

/** 1-based line numbers whose text differs between the two strings. */
function changedLineNumbers(before: string, after: string): number[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const changed: number[] = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i + 1);
  }
  return changed;
}

describe('listParameters', () => {
  it('reads both scopes, and does not default a missing type to string', () => {
    const doc = parse(`parameters:
  typed:
    type: integer
    default: 3
  untyped:
    default: hello
jobs:
  build:
    parameters:
      target:
        type: enum
        enum: [debug, release]
        description: What to build
    steps:
      - checkout
`);
    expect(listParameters(doc, PIPELINE)).toEqual([
      {
        name: 'typed',
        type: 'integer',
        hasDefault: true,
        default: 3,
        description: undefined,
        enumValues: [],
        shared: false,
      },
      {
        name: 'untyped',
        // The old read-only palette list showed `string` here. That was a lie
        // about the config, and the editor needs the truth to be able to say
        // "no type set" and to make choosing one the only move.
        type: undefined,
        hasDefault: true,
        default: 'hello',
        description: undefined,
        enumValues: [],
        shared: false,
      },
    ]);
    expect(listParameters(doc, BUILD)).toEqual([
      {
        name: 'target',
        type: 'enum',
        hasDefault: false,
        default: undefined,
        description: 'What to build',
        enumValues: ['debug', 'release'],
        shared: false,
      },
    ]);
  });

  it('returns [] for a scope with no parameters: block, and for an unknown job', () => {
    const doc = parse('jobs:\n  build:\n    steps:\n      - checkout\n');
    expect(listParameters(doc, PIPELINE)).toEqual([]);
    expect(listParameters(doc, BUILD)).toEqual([]);
    expect(listParameters(doc, { kind: 'job', jobName: 'nope' })).toEqual([]);
  });

  it('flags a definition that is a YAML anchor or alias as shared', () => {
    const doc = parse(`parameters:
  base: &base
    type: string
    default: a
  copy: *base
`);
    const [base, copy] = listParameters(doc, PIPELINE);
    expect(base?.shared).toBe(true);
    expect(copy?.shared).toBe(true);
  });
});

describe('validateParameterName', () => {
  it('accepts what can be written as << parameters.name >> and rejects what cannot', () => {
    expect(validateParameterName('deploy-env')).toBeNull();
    expect(validateParameterName('_private')).toBeNull();
    expect(validateParameterName('Target2')).toBeNull();
    expect(validateParameterName('')).toMatch(/needs a name/i);
    expect(validateParameterName('has space')).toMatch(/must start with/i);
    expect(validateParameterName('has.dot')).toMatch(/must start with/i);
    expect(validateParameterName('2legit')).toMatch(/must start with/i);
  });
});

describe('addParameter', () => {
  it('writes exactly the fields given and no others', () => {
    const doc = parse('version: 2.1\n');
    addParameter(doc, PIPELINE, 'image-tag', { type: 'string' });
    expect(getIn(doc, ['parameters', 'image-tag'])).toEqual({ type: 'string' });

    addParameter(doc, PIPELINE, 'env', {
      type: 'enum',
      default: 'staging',
      description: 'Where to deploy',
      enumValues: ['staging', 'production'],
    });
    expect(getIn(doc, ['parameters', 'env'])).toEqual({
      type: 'enum',
      default: 'staging',
      description: 'Where to deploy',
      enum: ['staging', 'production'],
    });
  });

  it('appends to an existing block without disturbing a sibling or its comment', () => {
    const before = `parameters:
  # keep me exactly here
  first:
    type: string
    default: a
`;
    const after = applyLikeTheStore(before, (d) =>
      addParameter(d, PIPELINE, 'second', { type: 'boolean' }),
    );
    expect(after).toBe(`${before}  second:
    type: boolean
`);
  });

  it('creates a job block, and refuses an unknown job or a duplicate name', () => {
    const doc = parse('jobs:\n  build:\n    steps:\n      - checkout\n');
    addParameter(doc, BUILD, 'target', { type: 'string' });
    expect(listKeys(doc, ['jobs', 'build', 'parameters'])).toEqual(['target']);

    expect(() =>
      addParameter(doc, BUILD, 'target', { type: 'string' }),
    ).toThrow(/already has a parameter "target"/);
    expect(() =>
      addParameter(doc, { kind: 'job', jobName: 'nope' }, 'x', {
        type: 'string',
      }),
    ).toThrow(/not defined under jobs:/);
    expect(() =>
      addParameter(doc, BUILD, 'bad name', { type: 'string' }),
    ).toThrow(/must start with/);
  });
});

describe('setParameterType', () => {
  it('keeps the enum: list when the type moves away from enum -- never a silent drop', () => {
    const before = `parameters:
  env:
    type: enum
    enum:
      - staging
      - production
    default: staging
`;
    const after = applyLikeTheStore(before, (d) =>
      setParameterType(d, PIPELINE, 'env', 'string'),
    );
    // Exactly one line changed: the type. The values are still there, visible
    // and recoverable, which is the whole point (issue #250).
    assertOnlyLinesDiffer(before, after, [3]);
    expect(after).toContain('type: string');
    expect(after).toContain('- staging');
    expect(after).toContain('- production');
  });

  it('removeParameterEnumValues is the separate, explicit way to drop them', () => {
    const doc = parse(`parameters:
  env:
    type: string
    enum: [staging, production]
`);
    removeParameterEnumValues(doc, PIPELINE, 'env');
    expect(getIn(doc, ['parameters', 'env'])).toEqual({ type: 'string' });
  });
});

describe('setParameterDefault / Description / EnumValues', () => {
  it('writes a typed default, and removes the key when given undefined', () => {
    const doc = parse('parameters:\n  n:\n    type: integer\n');
    setParameterDefault(doc, PIPELINE, 'n', 7);
    expect(getIn(doc, ['parameters', 'n', 'default'])).toBe(7);
    setParameterDefault(doc, PIPELINE, 'n', undefined);
    expect(getIn(doc, ['parameters', 'n'])).toEqual({ type: 'integer' });
  });

  it('keeps an inline comment on the line whose value it changes', () => {
    const before = `parameters:
  n:
    type: integer
    default: 1 # bump this when the fleet grows
`;
    const after = applyLikeTheStore(before, (d) =>
      setParameterDefault(d, PIPELINE, 'n', 4),
    );
    expect(after).toBe(`parameters:
  n:
    type: integer
    default: 4 # bump this when the fleet grows
`);
  });

  it('sets and clears a description, and replaces an enum list', () => {
    const doc = parse('parameters:\n  e:\n    type: enum\n');
    setParameterDescription(doc, PIPELINE, 'e', 'Pick one');
    expect(getIn(doc, ['parameters', 'e', 'description'])).toBe('Pick one');
    setParameterDescription(doc, PIPELINE, 'e', '');
    expect(getIn(doc, ['parameters', 'e'])).toEqual({ type: 'enum' });

    setParameterEnumValues(doc, PIPELINE, 'e', ['a', 'b']);
    expect(getIn(doc, ['parameters', 'e', 'enum'])).toEqual(['a', 'b']);
    setParameterEnumValues(doc, PIPELINE, 'e', []);
    expect(getIn(doc, ['parameters', 'e'])).toEqual({ type: 'enum' });
  });
});

describe('removeParameter', () => {
  it('removes the declaration and every call site that passed it, and nothing else', () => {
    const doc = parse(parametersFixture);
    removeParameter(doc, BUILD, 'target');
    expect(listKeys(doc, ['jobs', 'build', 'parameters'])).toEqual(['verbose']);
    // Both workflows passed `target:` and passed nothing else, so each entry
    // collapses back to the bare string form rather than becoming `- build: {}`.
    expect(getIn(doc, ['workflows', 'main', 'jobs', 0])).toBe('build');
    expect(getIn(doc, ['workflows', 'integration', 'jobs', 0])).toBe('build');
    // The references are deliberately left dangling -- substituting the default
    // would be authoring, the same call already made for jobs, applied to parameters.
    expect(doc.toString()).toContain('<< parameters.target >>');
  });

  it('drops the whole parameters: block with its last member', () => {
    const doc = parse(
      'parameters:\n  only:\n    type: string\n    default: a\nversion: 2.1\n',
    );
    removeParameter(doc, PIPELINE, 'only');
    expect(doc.toString()).toBe('version: 2.1\n');
  });

  it('refuses when the definition is an anchor something still aliases', () => {
    const doc = parse(`parameters:
  base: &base
    type: string
    default: a
  copy: *base
`);
    expect(() => removeParameter(doc, PIPELINE, 'base')).toThrow(
      /YAML anchor still referenced by "parameters.copy"/,
    );
  });

  it('refuses an unknown parameter without touching the document', () => {
    const text = 'parameters:\n  a:\n    type: string\n';
    const doc = parse(text);
    expect(() => removeParameter(doc, PIPELINE, 'b')).toThrow(
      /has no parameter "b"/,
    );
    expect(doc.toString()).toBe(text);
  });
});

describe('renameParameter -- pipeline scope', () => {
  it('rewrites the declaration and every << pipeline.parameters.x >> in the file', () => {
    const before = parametersFixture;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, PIPELINE, 'image-tag', 'node-tag'),
    );

    expect(after).toContain('  node-tag:');
    expect(after).not.toContain('image-tag');
    // Both jobs' image fields, rewritten.
    expect(
      (after.match(/<< pipeline\.parameters\.node-tag >>/g) ?? []).length,
    ).toBe(2);
    // Every comment survives, in order -- including the two riding on lines
    // this rename rewrote.
    expect(comments(after)).toEqual(comments(before));
  });

  it('touches exactly the three lines that hold the name, and no others', () => {
    const before = parametersFixture;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, PIPELINE, 'image-tag', 'node-tag'),
    );
    const diff = unifiedDiff(before, after, 'config.yml');
    const { additions, deletions } = countChangedLines(diff);
    // The declaration key, plus one image line in each of the two jobs.
    expect(additions).toBe(3);
    expect(deletions).toBe(3);
    assertOnlyLinesDiffer(before, after, changedLineNumbers(before, after));
    expect(changedLineNumbers(before, after)).toHaveLength(3);
  });

  it('rewrites a reference inside a workflow-level when:, not just inside jobs', () => {
    const after = applyLikeTheStore(parametersFixture, (d) =>
      renameParameter(d, PIPELINE, 'run-integration-tests', 'run-integration'),
    );
    expect(after).toContain('when: << pipeline.parameters.run-integration >>');
  });

  it('preserves each occurrence\u2019s own interior spacing', () => {
    const before = `parameters:
  x:
    type: string
    default: a
jobs:
  build:
    steps:
      - run: echo "<<pipeline.parameters.x>> << pipeline.parameters.x >>"
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, PIPELINE, 'x', 'y'),
    );
    // Tight stays tight, spaced stays spaced -- a normalising rewrite would show
    // up in the Save dialog as a change the user did not ask for.
    expect(after).toContain(
      '"<<pipeline.parameters.y>> << pipeline.parameters.y >>"',
    );
  });

  it('does not confuse a longer name that starts with the same characters', () => {
    const before = `parameters:
  tag:
    type: string
    default: a
  tag-suffix:
    type: string
    default: b
jobs:
  build:
    steps:
      - run: echo << pipeline.parameters.tag-suffix >> << pipeline.parameters.tag >>
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, PIPELINE, 'tag', 'label'),
    );
    expect(after).toContain(
      '<< pipeline.parameters.tag-suffix >> << pipeline.parameters.label >>',
    );
  });

  it('refuses a duplicate name, an invalid name, and an unknown parameter, changing nothing', () => {
    const text = parametersFixture;
    const doc = parse(text);
    expect(() =>
      renameParameter(doc, PIPELINE, 'image-tag', 'deploy-env'),
    ).toThrow(/already has a parameter "deploy-env"/);
    expect(() =>
      renameParameter(doc, PIPELINE, 'image-tag', 'no spaces'),
    ).toThrow(/must start with/);
    expect(() => renameParameter(doc, PIPELINE, 'nope', 'x')).toThrow(
      /has no parameter "nope"/,
    );
    expect(doc.toString()).toBe(text);
  });
});

describe('renameParameter -- job scope', () => {
  it('rewrites the declaration, every in-job reference, and every invocation key', () => {
    const before = parametersFixture;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );

    expect(after).toContain('      flavour:');
    // Two interpolation sites inside the job (the step's `name:` and its
    // `command:`), plus two workflow invocation keys in two different workflows.
    expect((after.match(/<< parameters\.flavour >>/g) ?? []).length).toBe(2);
    expect(after).toContain('flavour: release # invocation site');
    expect(after).toContain('flavour: debug');
    expect(comments(after)).toEqual(comments(before));

    // The only surviving `target` is inside a *comment*, and deliberately so: a
    // comment is prose, not config, and rewriting a user's prose is not this
    // editor's business (the mutation layer never touches a comment's text).
    // It does go stale, which is exactly why the rename prompt enumerates what
    // *is* rewritten rather than claiming to have fixed everything.
    const survivingLines = after
      .split('\n')
      .filter((line) => line.includes('target'));
    expect(
      survivingLines.map((line) => line.trimStart().startsWith('#')),
    ).toEqual(survivingLines.map(() => true));
    expect(after).toContain(
      "# The job's *own* scope: written << parameters.target >> below, and",
    );
  });

  it('leaves another job\u2019s identically-named parameter completely alone', () => {
    const before = `jobs:
  build:
    parameters:
      target:
        type: string
        default: a
    steps:
      - run: echo << parameters.target >>
  test:
    parameters:
      target:
        type: string
        default: b
    steps:
      - run: echo << parameters.target >>
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );
    expect(after).toContain('      flavour:');
    expect(after).toContain('echo << parameters.flavour >>');
    // `test` keeps both its declaration and its reference.
    expect(after).toContain('      target:');
    expect(after).toContain('echo << parameters.target >>');
    expect((after.match(/<< parameters\.target >>/g) ?? []).length).toBe(1);
  });

  it('never rewrites a << pipeline.parameters.x >> when renaming a job parameter of the same name', () => {
    const before = `parameters:
  target:
    type: string
    default: p
jobs:
  build:
    parameters:
      target:
        type: string
        default: j
    steps:
      - run: echo << parameters.target >> << pipeline.parameters.target >>
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );
    expect(after).toContain(
      'echo << parameters.flavour >> << pipeline.parameters.target >>',
    );
  });

  it('renames a job-group invocation key as well as a workflow one', () => {
    const before = `jobs:
  build:
    parameters:
      target:
        type: string
        default: a
    steps:
      - run: echo << parameters.target >>
job-groups:
  nightly:
    jobs:
      - build:
          target: release
workflows:
  main:
    jobs:
      - build:
          target: debug
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );
    expect(after).toContain('          flavour: release');
    expect(after).toContain('          flavour: debug');
    expect(after).not.toContain('target');
  });

  it('does not invent an invocation key for an entry that never passed the parameter', () => {
    const before = `jobs:
  build:
    parameters:
      target:
        type: string
        default: a
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );
    // The bare-string entry stays a bare string: it relied on the default, and
    // writing `flavour: a` there would be inventing a value.
    expect(after).toContain('      - build\n');
    expect(after).not.toContain('flavour:  ');
  });
});

describe('renameParameter -- refusing rather than half-reconciling', () => {
  it('refuses when the job merges an anchor and a reference lives outside it', () => {
    const text = `x-common: &common
  steps:
    - run: echo << parameters.target >>
jobs:
  build:
    <<: *common
    parameters:
      target:
        type: string
        default: a
`;
    const doc = parse(text);
    expect(() => renameParameter(doc, BUILD, 'target', 'flavour')).toThrow(
      /without leaving a reference dangling/,
    );
    // A refusal leaves the document byte-identical.
    expect(doc.toString()).toBe(text);
  });

  it('does not refuse when the job is self-contained, even if a stray reference exists elsewhere', () => {
    const before = `commands:
  helper:
    steps:
      - run: echo << parameters.target >>
jobs:
  build:
    parameters:
      target:
        type: string
        default: a
    steps:
      - run: echo << parameters.target >>
`;
    const after = applyLikeTheStore(before, (d) =>
      renameParameter(d, BUILD, 'target', 'flavour'),
    );
    // The job's own reference moves; the command's -- which cannot be this
    // job's, since nothing merges anything -- is untouched and still broken,
    // exactly as it was before.
    expect(after).toContain('  build:');
    expect(after).toContain('echo << parameters.flavour >>');
    expect(after).toContain(`  helper:
    steps:
      - run: echo << parameters.target >>`);
  });
});
