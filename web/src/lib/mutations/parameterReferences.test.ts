import { describe, expect, it } from 'vitest';
import type { Document } from 'yaml';

import { cloneDocument, getIn, parseConfig } from '~/lib/yaml/documentUtils';

import { renameParameter } from './parameterMutations';
import {
  countParameterSites,
  countReferencesInText,
  describeParameterDeleteImpact,
  describeParameterRenameImpact,
  findParameterReferences,
  parameterRenameNeedsConfirmation,
  parametersPath,
  referenceExpression,
  rewriteReferencesInText,
  type ParameterScope,
} from './parameterReferences';

import parametersFixture from '~/fixtures/parameters.yml?raw';

const PIPELINE: ParameterScope = { kind: 'pipeline' };
const BUILD: ParameterScope = { kind: 'job', jobName: 'build' };

function parse(text: string): Document {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('reference syntax helpers', () => {
  it('spells each scope\u2019s reference expression', () => {
    expect(referenceExpression(PIPELINE, 'x')).toBe('pipeline.parameters.x');
    expect(referenceExpression(BUILD, 'x')).toBe('parameters.x');
    expect(parametersPath(PIPELINE)).toEqual(['parameters']);
    expect(parametersPath(BUILD)).toEqual(['jobs', 'build', 'parameters']);
  });

  it('counts only whole references, anchored on << and >>', () => {
    expect(
      countReferencesInText('a << parameters.x >> b', 'parameters.x'),
    ).toBe(1);
    expect(countReferencesInText('<<parameters.x>>', 'parameters.x')).toBe(1);
    // Two in one scalar is two places a reader has to check.
    expect(
      countReferencesInText(
        '<< parameters.x >>-<< parameters.x >>',
        'parameters.x',
      ),
    ).toBe(2);
    // The element form must not match inside the pipeline form...
    expect(
      countReferencesInText('<< pipeline.parameters.x >>', 'parameters.x'),
    ).toBe(0);
    // ...nor may a name match a prefix of a longer one.
    expect(countReferencesInText('<< parameters.xy >>', 'parameters.x')).toBe(
      0,
    );
    // Bare text that merely mentions the name is not a reference.
    expect(countReferencesInText('parameters.x', 'parameters.x')).toBe(0);
  });

  it('rewrites while preserving each occurrence\u2019s own spacing', () => {
    expect(
      rewriteReferencesInText(
        '<<parameters.x>> and << parameters.x >>',
        'parameters.x',
        'parameters.y',
      ),
    ).toBe('<<parameters.y>> and << parameters.y >>');
  });
});

describe('findParameterReferences -- pipeline scope', () => {
  it('finds every site across the whole document, wherever it is written', () => {
    const doc = parse(parametersFixture);
    const refs = findParameterReferences(doc, PIPELINE, 'image-tag');
    expect(refs.declared).toBe(true);
    expect(refs.interpolations.map((site) => site.path)).toEqual([
      ['jobs', 'build', 'docker', 0, 'image'],
      ['jobs', 'test', 'docker', 0, 'image'],
    ]);
    // Pipeline parameters are supplied from outside the config, so there are no
    // in-config invocation sites to reconcile.
    expect(refs.invocations).toEqual([]);
    expect(refs.foreign).toEqual([]);
    expect(countParameterSites(refs)).toBe(3);
  });

  it('finds a reference used as a workflow-level when: condition', () => {
    const doc = parse(parametersFixture);
    const refs = findParameterReferences(
      doc,
      PIPELINE,
      'run-integration-tests',
    );
    expect(refs.interpolations.map((site) => site.path)).toEqual([
      ['workflows', 'integration', 'when'],
    ]);
  });

  it('reports an undeclared name it still finds references to', () => {
    const doc = parse(`jobs:
  build:
    steps:
      - run: echo << pipeline.parameters.ghost >>
`);
    const refs = findParameterReferences(doc, PIPELINE, 'ghost');
    expect(refs.declared).toBe(false);
    expect(refs.interpolations).toHaveLength(1);
  });

  it('counts two occurrences in one scalar as two, and notes a key-position reference', () => {
    const doc = parse(`parameters:
  x:
    type: string
    default: a
jobs:
  build:
    steps:
      - run: echo << pipeline.parameters.x >> << pipeline.parameters.x >>
    environment:
      << pipeline.parameters.x >>: "1"
`);
    const refs = findParameterReferences(doc, PIPELINE, 'x');
    const byOccurrences = refs.interpolations.map((site) => site.occurrences);
    expect(byOccurrences).toContain(2);
    expect(refs.interpolations.some((site) => site.inKey)).toBe(true);
  });
});

describe('findParameterReferences -- job scope', () => {
  it('confines interpolations to the declaring job and reports the rest as foreign', () => {
    const doc = parse(`jobs:
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
`);
    const refs = findParameterReferences(doc, BUILD, 'target');
    expect(refs.interpolations.map((site) => site.path)).toEqual([
      ['jobs', 'build', 'steps', 0, 'run'],
    ]);
    expect(refs.foreign.map((site) => site.path)).toEqual([
      ['jobs', 'test', 'steps', 0, 'run'],
    ]);
    // And it says *why* the foreign one is nothing to worry about.
    expect(refs.alsoDeclaredBy).toEqual(['jobs.test']);
    expect(refs.renameBlockers).toEqual([]);
  });

  it('finds invocation sites in workflows and job groups, but only where the key is present', () => {
    const doc = parse(parametersFixture);
    const refs = findParameterReferences(doc, BUILD, 'target');
    expect(refs.invocations).toEqual([
      {
        container: 'workflows',
        ownerName: 'main',
        index: 0,
        entryId: 'build',
      },
      {
        container: 'workflows',
        ownerName: 'integration',
        index: 0,
        entryId: 'build',
      },
    ]);
    // `verbose` is declared and referenced, but never passed at a call site.
    expect(findParameterReferences(doc, BUILD, 'verbose').invocations).toEqual(
      [],
    );
  });

  it('blocks a rename when the job merges an anchor and a reference lives outside it', () => {
    const doc = parse(`x-common: &common
  steps:
    - run: echo << parameters.target >>
jobs:
  build:
    <<: *common
    parameters:
      target:
        type: string
        default: a
`);
    const refs = findParameterReferences(doc, BUILD, 'target');
    expect(refs.renameBlockers).toHaveLength(1);
    expect(refs.renameBlockers[0]).toMatch(/merge key or alias/);
    expect(parameterRenameNeedsConfirmation(refs)).toBe(true);
  });

  it('does not block when the foreign site belongs to something that declares the name itself', () => {
    const doc = parse(`x-common: &common
  working_directory: ~/p
jobs:
  build:
    <<: *common
    parameters:
      target:
        type: string
        default: a
    steps:
      - run: echo << parameters.target >>
commands:
  helper:
    parameters:
      target:
        type: string
        default: b
    steps:
      - run: echo << parameters.target >>
`);
    const refs = findParameterReferences(doc, BUILD, 'target');
    expect(refs.foreign).toHaveLength(1);
    expect(refs.renameBlockers).toEqual([]);
  });
});

describe('parameterRenameNeedsConfirmation', () => {
  it('is false for a declared parameter nothing references, and true otherwise', () => {
    const unused = parse(
      'parameters:\n  x:\n    type: string\n    default: a\n',
    );
    expect(
      parameterRenameNeedsConfirmation(
        findParameterReferences(unused, PIPELINE, 'x'),
      ),
    ).toBe(false);

    const used = parse(parametersFixture);
    expect(
      parameterRenameNeedsConfirmation(
        findParameterReferences(used, PIPELINE, 'image-tag'),
      ),
    ).toBe(true);
  });
});

describe('describeParameterRenameImpact', () => {
  it('names every site it will rewrite, and the headline counts them', () => {
    const doc = parse(parametersFixture);
    const impact = describeParameterRenameImpact(
      doc,
      BUILD,
      'target',
      'flavour',
    );
    expect(impact.blockers).toEqual([]);
    expect(impact.headline).toBe(
      'Renaming the parameter of job "build" target to flavour rewrites 5 places.',
    );
    expect(impact.lines).toEqual([
      'the declaration: jobs.build.parameters.target becomes flavour',
      'jobs.build.steps.1.run.name: << parameters.target >> becomes << parameters.flavour >>',
      'jobs.build.steps.1.run.command: << parameters.target >> becomes << parameters.flavour >>',
      'workflow "main": "build" passes this parameter -- that key becomes flavour',
      'workflow "integration": "build" passes this parameter -- that key becomes flavour',
    ]);
  });

  it('promises exactly what the mutation performs -- or the prompt is lying', () => {
    // The cross-layer agreement test `jobReferences.test.ts` established for
    // jobs: enumerate the sites, apply the rename, then check each promised site
    // really did change and each foreign one really did not.
    const text = parametersFixture;
    const doc = parse(text);
    const refs = findParameterReferences(doc, BUILD, 'target');
    const clone = cloneDocument(doc);
    renameParameter(clone, BUILD, 'target', 'flavour');

    for (const site of refs.interpolations) {
      expect(String(getIn(clone, site.path))).toContain(
        '<< parameters.flavour >>',
      );
      expect(String(getIn(clone, site.path))).not.toContain(
        '<< parameters.target >>',
      );
    }
    for (const site of refs.invocations) {
      const entryPath = [
        site.container,
        site.ownerName,
        'jobs',
        site.index,
        'build',
      ];
      expect(getIn(clone, [...entryPath, 'flavour'])).toBeDefined();
      expect(getIn(clone, [...entryPath, 'target'])).toBeUndefined();
    }
  });

  it('warns that callers outside this file are not updated, for a pipeline parameter', () => {
    const doc = parse(parametersFixture);
    const impact = describeParameterRenameImpact(
      doc,
      PIPELINE,
      'image-tag',
      'node-tag',
    );
    expect(impact.notes.join(' ')).toMatch(/API triggers, schedules/);
  });

  it('carries the blocker through, so the prompt can refuse instead of half-doing it', () => {
    const doc = parse(`x-common: &common
  steps:
    - run: echo << parameters.target >>
jobs:
  build:
    <<: *common
    parameters:
      target:
        type: string
        default: a
`);
    const impact = describeParameterRenameImpact(
      doc,
      BUILD,
      'target',
      'flavour',
    );
    expect(impact.blockers).toHaveLength(1);
  });
});

describe('describeParameterDeleteImpact', () => {
  it('says what goes, and says the references are deliberately left dangling', () => {
    const doc = parse(parametersFixture);
    const impact = describeParameterDeleteImpact(doc, BUILD, 'target');
    expect(impact.headline).toBe(
      'Removing the parameter of job "build" target changes 3 places, and leaves 2 references pointing at nothing.',
    );
    expect(impact.lines).toEqual([
      'the declaration: jobs.build.parameters.target',
      'workflow "main": "build" stops passing target',
      'workflow "integration": "build" stops passing target',
    ]);
    expect(impact.notes.join(' ')).toMatch(
      /Substituting the default there would be writing config you never asked for/,
    );
    expect(impact.blockers).toEqual([]);
  });

  it('has nothing to warn about for an unreferenced parameter', () => {
    const doc = parse('parameters:\n  x:\n    type: string\n    default: a\n');
    const impact = describeParameterDeleteImpact(doc, PIPELINE, 'x');
    expect(impact.headline).toBe(
      'Removing the pipeline parameter x changes 1 place.',
    );
    expect(impact.notes).toEqual([]);
  });
});
