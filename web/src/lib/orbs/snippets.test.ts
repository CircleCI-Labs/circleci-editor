import { describe, expect, it } from 'vitest';

import {
  defaultParamValues,
  executorRef,
  orbsEntry,
  stepEntry,
  workflowJobEntry,
} from './snippets';
import type { OrbElement } from './types';

describe('orbsEntry', () => {
  it('derives the alias from the orb name by default', () => {
    expect(orbsEntry('circleci/node@5.2.0')).toEqual({
      alias: 'node',
      value: 'circleci/node@5.2.0',
    });
  });

  it('accepts an alias override', () => {
    expect(orbsEntry('circleci/node@5.2.0', 'my-node')).toEqual({
      alias: 'my-node',
      value: 'circleci/node@5.2.0',
    });
  });

  it('sanitises an alias override to a legal YAML key', () => {
    expect(orbsEntry('circleci/node@5.2.0', 'my node! 2').alias).toBe(
      'mynode2',
    );
  });

  it('prefixes a leading digit so the alias cannot be mistaken for a number', () => {
    expect(orbsEntry('circleci/node@5.2.0', '2fast').alias).toBe('_2fast');
  });
});

describe('workflowJobEntry', () => {
  it('produces a bare string when there are no params or requires', () => {
    expect(workflowJobEntry('node', 'test')).toBe('node/test');
  });

  it('produces a single-key map when params are given', () => {
    expect(
      workflowJobEntry('node', 'test', { 'run-command': 'npm run ci' }),
    ).toEqual({
      'node/test': { 'run-command': 'npm run ci' },
    });
  });

  it('produces a single-key map when requires is given, even with no params', () => {
    expect(workflowJobEntry('node', 'test', undefined, ['build'])).toEqual({
      'node/test': { requires: ['build'] },
    });
  });

  it('merges params and requires into the same map', () => {
    expect(
      workflowJobEntry('node', 'test', { 'run-command': 'npm run ci' }, [
        'build',
      ]),
    ).toEqual({
      'node/test': { 'run-command': 'npm run ci', requires: ['build'] },
    });
  });

  it('treats an empty params object the same as no params', () => {
    expect(workflowJobEntry('node', 'test', {})).toBe('node/test');
  });
});

describe('stepEntry', () => {
  it('produces a bare string when there are no params', () => {
    expect(stepEntry('node', 'install-packages')).toBe('node/install-packages');
  });

  it('produces a single-key map when params are given', () => {
    expect(stepEntry('node', 'install-packages', { 'app-dir': 'web' })).toEqual(
      {
        'node/install-packages': { 'app-dir': 'web' },
      },
    );
  });
});

describe('executorRef', () => {
  it('joins the alias and executor name', () => {
    expect(executorRef('node', 'default')).toBe('node/default');
  });
});

describe('defaultParamValues', () => {
  it('omits optional parameters entirely', () => {
    const element: OrbElement = {
      name: 'install-packages',
      kind: 'command',
      parameters: [
        {
          name: 'pkg-manager',
          type: 'enum',
          required: false,
          default: 'npm',
          enumValues: ['npm', 'yarn'],
        },
        { name: 'cache-path', type: 'string', required: false, default: '' },
      ],
    };
    expect(defaultParamValues(element)).toEqual({});
  });

  it('fills required parameters with a type-appropriate empty value', () => {
    const element: OrbElement = {
      name: 'greet',
      kind: 'command',
      parameters: [
        { name: 'name', type: 'string', required: true },
        { name: 'shout', type: 'boolean', required: true },
        { name: 'volume', type: 'integer', required: true },
        {
          name: 'tone',
          type: 'enum',
          required: true,
          enumValues: ['calm', 'excited'],
        },
        { name: 'steps-to-run', type: 'steps', required: true },
      ],
    };
    expect(defaultParamValues(element)).toEqual({
      name: '',
      shout: false,
      volume: 0,
      tone: 'calm',
      'steps-to-run': [],
    });
  });

  it('falls back to an empty string for an enum with no known choices', () => {
    const element: OrbElement = {
      name: 'greet',
      kind: 'command',
      parameters: [{ name: 'tone', type: 'enum', required: true }],
    };
    expect(defaultParamValues(element)).toEqual({ tone: '' });
  });
});
