import { describe, expect, it } from 'vitest';

import { parseCircleciSchema } from './circleciSchema';
import { FIXTURE_RAW_SCHEMA as FIXTURE_SCHEMA } from './testFixtures';

function labels(items: readonly { label: string }[]): string[] {
  return items.map((item) => item.label).sort();
}

/** Like `labels`, but for `StepFieldSchema[]`, whose identifying property is `name`, not `label`. */
function fieldNames(items: readonly { name: string }[]): string[] {
  return items.map((item) => item.name).sort();
}

describe('parseCircleciSchema', () => {
  it('extracts the document root keys', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.topLevelKeys)).toEqual(
      [
        'commands',
        'executors',
        'jobs',
        'orbs',
        'parameters',
        'version',
        'workflows',
      ].sort(),
    );
  });

  it("attaches each key's description", () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    const jobs = schema.topLevelKeys.find((item) => item.label === 'jobs');
    expect(jobs?.info).toBe('Collections of steps');
  });

  it("extracts job body keys from the build-job branch, merged with the invocation's own", () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.jobKeys)).toEqual(
      [
        'circleci_ip_ranges',
        'description',
        'docker',
        'environment',
        'executor',
        'machine',
        'macos',
        'parallelism',
        'parameters',
        'resource_class',
        'retention',
        'shell',
        'steps',
        'type',
        'working_directory',
      ].sort(),
    );
  });

  it('extracts the job type enum', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.jobTypeValues)).toEqual(
      ['approval', 'build', 'lock', 'no-op', 'release', 'unlock'].sort(),
    );
  });

  it('extracts the two parameter type enums, and they are not the same list', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    // Issue #250: the type control is a closed choice derived from here, so
    // the *difference* between the two scopes is the fact worth pinning --
    // offering `steps` for a pipeline parameter would offer a config that
    // cannot compile.
    expect(labels(schema.pipelineParameterTypeValues)).toEqual(
      ['boolean', 'string', 'enum', 'integer'].sort(),
    );
    expect(labels(schema.elementParameterTypeValues)).toEqual(
      [
        'boolean',
        'string',
        'steps',
        'enum',
        'executor',
        'integer',
        'env_var_name',
      ].sort(),
    );
    expect(labels(schema.pipelineParameterTypeValues)).not.toEqual(
      labels(schema.elementParameterTypeValues),
    );
  });

  it('extracts executor keys', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.executorKeys)).toEqual(
      [
        'description',
        'docker',
        'environment',
        'machine',
        'macos',
        'parameters',
        'resource_class',
        'shell',
        'working_directory',
      ].sort(),
    );
  });

  it('extracts the resource_class enum from the executor definition', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.resourceClassValues)).toEqual(
      ['large', 'medium', 'medium+', 'small', 'xlarge'].sort(),
    );
  });

  it('extracts per-workflow keys', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.workflowKeys)).toEqual(
      ['jobs', 'max_auto_reruns', 'triggers', 'unless', 'when'].sort(),
    );
  });

  it('extracts workflow job invocation option keys', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.workflowJobEntryKeys)).toEqual(
      [
        'context',
        'filters',
        'matrix',
        'override-with',
        'post-steps',
        'pre-steps',
        'requires',
        'serial-group',
        'type',
      ].sort(),
    );
    const requires = schema.workflowJobEntryKeys.find(
      (item) => item.label === 'requires',
    );
    expect(requires?.info).toBe('Jobs this one depends on');
  });

  it('extracts built-in step names', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.stepNames)).toEqual(
      [
        'add_ssh_keys',
        'attach_workspace',
        'checkout',
        'persist_to_workspace',
        'restore_cache',
        'run',
        'save_cache',
        'setup_remote_docker',
        'store_artifacts',
        'store_test_results',
      ].sort(),
    );
  });

  it('extracts docker image item keys', () => {
    const schema = parseCircleciSchema(FIXTURE_SCHEMA);
    expect(labels(schema.dockerImageKeys)).toEqual(
      ['command', 'entrypoint', 'environment', 'image', 'name', 'user'].sort(),
    );
  });

  describe('stepFieldSchemas (issue #48)', () => {
    it("extracts run's fields, merging its bare-string shorthand branch away and keeping the object branch's own required list", () => {
      const schema = parseCircleciSchema(FIXTURE_SCHEMA);
      const run = schema.stepFieldSchemas.run ?? [];
      expect(fieldNames(run)).toEqual(
        [
          'background',
          'command',
          'environment',
          'name',
          'no_output_timeout',
          'shell',
          'when',
          'working_directory',
        ].sort(),
      );
      expect(run.find((f) => f.name === 'command')).toMatchObject({
        type: 'string',
        required: true,
      });
      expect(run.find((f) => f.name === 'background')).toMatchObject({
        type: 'boolean',
      });
      expect(run.find((f) => f.name === 'environment')).toMatchObject({
        type: 'map',
      });
      expect(run.find((f) => f.name === 'when')).toMatchObject({
        type: 'enum',
        enumValues: ['always', 'on_success', 'on_fail'],
      });
    });

    it("extracts checkout's fields, including its method enum, with none required", () => {
      const schema = parseCircleciSchema(FIXTURE_SCHEMA);
      const checkout = schema.stepFieldSchemas.checkout ?? [];
      expect(fieldNames(checkout)).toEqual(['depth', 'method', 'path'].sort());
      expect(checkout.find((f) => f.name === 'method')).toMatchObject({
        type: 'enum',
        enumValues: ['blobless', 'full', 'shallow'],
      });
      expect(checkout.find((f) => f.name === 'depth')).toMatchObject({
        type: 'integer',
      });
      expect(checkout.every((f) => !f.required)).toBe(true);
    });

    it("extracts save_cache's array field and required list", () => {
      const schema = parseCircleciSchema(FIXTURE_SCHEMA);
      const saveCache = schema.stepFieldSchemas.save_cache ?? [];
      expect(fieldNames(saveCache)).toEqual(
        ['key', 'name', 'paths', 'when'].sort(),
      );
      expect(saveCache.find((f) => f.name === 'paths')).toMatchObject({
        type: 'array',
        required: true,
      });
      expect(saveCache.find((f) => f.name === 'key')).toMatchObject({
        type: 'string',
        required: true,
      });
      expect(
        saveCache.find((f) => f.name === 'name')?.required,
      ).toBeUndefined();
    });

    it("merges restore_cache's two oneOf branches (key vs keys) into one field list", () => {
      const schema = parseCircleciSchema(FIXTURE_SCHEMA);
      const restoreCache = schema.stepFieldSchemas.restore_cache ?? [];
      expect(fieldNames(restoreCache)).toEqual(['key', 'keys', 'name'].sort());
      expect(restoreCache.find((f) => f.name === 'keys')).toMatchObject({
        type: 'array',
      });
    });

    it('a keyword with no field-level detail in the fixture yields an empty field list rather than throwing', () => {
      const schema = parseCircleciSchema(FIXTURE_SCHEMA);
      expect(schema.stepFieldSchemas.store_artifacts).toEqual([]);
    });

    it('never throws for a malformed or missing schema, and yields an empty map', () => {
      for (const bad of [null, undefined, 'not an object', 42, [], {}]) {
        expect(parseCircleciSchema(bad).stepFieldSchemas).toEqual({});
      }
    });
  });

  it('never throws and returns all-empty lists for a malformed or missing schema', () => {
    for (const bad of [null, undefined, 'not an object', 42, [], {}]) {
      const schema = parseCircleciSchema(bad);
      expect(schema.topLevelKeys).toEqual([]);
      expect(schema.jobKeys).toEqual([]);
      expect(schema.stepNames).toEqual([]);
      expect(schema.resourceClassValues).toEqual([]);
      // A failed schema fetch must leave the parameter type control with no
      // options rather than a guessed list -- `ParametersEditor` renders that
      // as "can't add one right now" instead of inventing a type (issue #250).
      expect(schema.pipelineParameterTypeValues).toEqual([]);
      expect(schema.elementParameterTypeValues).toEqual([]);
    }
  });
});
