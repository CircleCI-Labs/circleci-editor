import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  applyAction,
  describeAction,
  extractAction,
  stripActionBlock,
  validateAction,
} from './actions';

const BASE_CONFIG = `version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;

function doc() {
  const { doc: parsed, error } = parseConfig(BASE_CONFIG);
  if (error || !parsed)
    throw new Error(`fixture config failed to parse: ${error}`);
  return parsed;
}

describe('extractAction', () => {
  it('extracts a valid action block from a reply that also has prose', () => {
    const reply = [
      'Sure, I can add a lint job for you.',
      '',
      '```action',
      '{"type": "addJob", "name": "lint", "workflowName": "main"}',
      '```',
    ].join('\n');

    const action = extractAction(reply);
    expect(action).toEqual({
      type: 'addJob',
      name: 'lint',
      workflowName: 'main',
    });
  });

  it('returns undefined for a reply with no action block', () => {
    expect(
      extractAction('The build job checks out the repo and runs steps.'),
    ).toBeUndefined();
  });

  it('returns undefined for malformed JSON inside the block', () => {
    expect(extractAction('```action\n{not valid json\n```')).toBeUndefined();
  });

  it('returns undefined for well-formed JSON that does not match any action shape', () => {
    expect(
      extractAction('```action\n{"type": "deleteEverything"}\n```'),
    ).toBeUndefined();
  });

  it('returns undefined when a required field is missing', () => {
    expect(extractAction('```action\n{"type": "addJob"}\n```')).toBeUndefined();
  });
});

describe('stripActionBlock', () => {
  it('removes the action block, leaving only the prose', () => {
    const reply =
      'Here you go:\n\n```action\n{"type": "addJob", "name": "lint"}\n```';
    expect(stripActionBlock(reply)).toBe('Here you go:');
  });

  it('is a no-op on a reply with no action block', () => {
    expect(stripActionBlock('Just an answer, no action.')).toBe(
      'Just an answer, no action.',
    );
  });
});

describe('validateAction', () => {
  it('accepts every documented action type with its required fields', () => {
    const cases: unknown[] = [
      { type: 'addJob', name: 'lint' },
      { type: 'addWorkflow', name: 'nightly' },
      { type: 'addStep', job: 'build', step: 'checkout' },
      { type: 'addWorkflowJobEntry', workflow: 'main', job: 'lint' },
      {
        type: 'addRequire',
        workflow: 'main',
        target: 'deploy',
        source: 'test',
      },
      { type: 'addOrb', alias: 'node', ref: 'circleci/node@5.2.0' },
      { type: 'renameJob', from: 'build', to: 'build_app' },
      { type: 'deleteJob', name: 'lint' },
    ];
    for (const value of cases) {
      expect(validateAction(value)).toBeDefined();
    }
  });

  it('rejects a non-object value', () => {
    expect(validateAction('addJob')).toBeUndefined();
    expect(validateAction(null)).toBeUndefined();
    expect(validateAction([1, 2, 3])).toBeUndefined();
  });

  it('rejects wrong-typed fields', () => {
    expect(validateAction({ type: 'addJob', name: 42 })).toBeUndefined();
    expect(
      validateAction({
        type: 'addWorkflowJobEntry',
        workflow: 'main',
        job: 'lint',
        requires: 'build',
      }),
    ).toBeUndefined();
  });
});

describe('describeAction', () => {
  it('summarizes each action type in plain language', () => {
    expect(describeAction({ type: 'addJob', name: 'lint' })).toContain('lint');
    expect(describeAction({ type: 'deleteJob', name: 'flaky' })).toBe(
      'Delete job "flaky"',
    );
    expect(
      describeAction({
        type: 'addRequire',
        workflow: 'main',
        target: 'deploy',
        source: 'test',
      }),
    ).toContain('require');
  });
});

describe('applyAction', () => {
  it('addJob calls through to configMutations.addJob', () => {
    const d = doc();
    applyAction(d, { type: 'addJob', name: 'lint', workflowName: 'main' });
    expect(d.toString()).toContain('lint:');
  });

  it('addStep appends a step to the named job', () => {
    const d = doc();
    applyAction(d, { type: 'addStep', job: 'build', step: 'run: echo hi' });
    expect(d.toString()).toContain('echo hi');
  });

  it('addWorkflowJobEntry appends a job entry to the workflow', () => {
    const d = doc();
    applyAction(d, { type: 'addJob', name: 'lint' });
    applyAction(d, {
      type: 'addWorkflowJobEntry',
      workflow: 'main',
      job: 'lint',
      requires: ['build'],
    });
    expect(d.toString()).toMatch(/lint:\s*\n\s*requires:\s*\n\s*- build/);
  });

  it('addRequire wires up a dependency between two existing workflow entries', () => {
    const d = doc();
    applyAction(d, { type: 'addJob', name: 'test', workflowName: 'main' });
    applyAction(d, {
      type: 'addRequire',
      workflow: 'main',
      target: 'test',
      source: 'build',
    });
    expect(d.toString()).toMatch(/test:\s*\n\s*requires:\s*\n\s*- build/);
  });

  it('addOrb writes an orbs: entry', () => {
    const d = doc();
    applyAction(d, {
      type: 'addOrb',
      alias: 'node',
      ref: 'circleci/node@5.2.0',
    });
    expect(d.toString()).toContain('node: circleci/node@5.2.0');
  });

  it('renameJob renames the job and its workflow reference', () => {
    const d = doc();
    applyAction(d, { type: 'renameJob', from: 'build', to: 'build_app' });
    expect(d.toString()).toContain('build_app:');
    expect(d.toString()).toMatch(/jobs:\s*\n\s*- build_app/);
  });

  it('deleteJob throws (and this module does not catch it) when the job does not exist -- callers must handle the rejection', () => {
    const d = doc();
    expect(() =>
      applyAction(d, { type: 'deleteJob', name: 'does-not-exist' }),
    ).toThrow('Job "does-not-exist" does not exist');
  });

  it('addWorkflow creates a new empty workflow', () => {
    const d = doc();
    applyAction(d, { type: 'addWorkflow', name: 'nightly' });
    expect(d.toString()).toContain('nightly:');
  });
});
