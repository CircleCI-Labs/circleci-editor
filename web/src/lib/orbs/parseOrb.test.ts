import { describe, expect, it } from 'vitest';

import actYml from '../../fixtures/orbs/act.yml?raw';
import malformedYml from '../../fixtures/orbs/malformed.yml?raw';
import nodeYml from '../../fixtures/orbs/node.yml?raw';
import { parseOrbSource } from './parseOrb';
import type { OrbElement } from './types';

function findParam(element: OrbElement, name: string) {
  const param = element.parameters.find((p) => p.name === name);
  if (!param) throw new Error(`fixture missing parameter "${name}"`);
  return param;
}

describe('parseOrbSource - node.yml', () => {
  const orb = parseOrbSource(nodeYml, 'circleci/node@5.2.0');

  it('reports no problems for a well-formed orb', () => {
    expect(orb.problems).toEqual([]);
  });

  it('carries the ref and its parsed parts', () => {
    expect(orb.ref).toBe('circleci/node@5.2.0');
    expect(orb.namespace).toBe('circleci');
    expect(orb.orbName).toBe('node');
    expect(orb.version).toBe('5.2.0');
  });

  it('extracts the top-level description and display URLs', () => {
    expect(orb.description).toContain('circleci/node orb');
    expect(orb.homeUrl).toBe('https://github.com/CircleCI-Public/node-orb');
    expect(orb.sourceUrl).toBe('https://github.com/CircleCI-Public/node-orb');
  });

  it('extracts element counts for each collection', () => {
    expect(orb.executors).toHaveLength(1);
    expect(orb.commands).toHaveLength(1);
    expect(orb.jobs).toHaveLength(1);
  });

  it('extracts an executor and its parameter', () => {
    const [executor] = orb.executors;
    expect(executor?.name).toBe('default');
    expect(executor?.kind).toBe('executor');
    expect(executor?.description).toMatch(/Docker executor/);
    const tag = findParam(executor!, 'tag');
    expect(tag).toMatchObject({
      type: 'string',
      default: '20.11',
      required: false,
    });
  });

  it('preserves parameter declaration order on the command', () => {
    const [command] = orb.commands;
    expect(command?.parameters.map((p) => p.name)).toEqual([
      'pkg-manager',
      'cache-path',
      'include-branch-in-cache-key',
      'app-dir',
      'override-ci-command',
    ]);
  });

  it('extracts enum type and enum values', () => {
    const [command] = orb.commands;
    const pkgManager = findParam(command!, 'pkg-manager');
    expect(pkgManager.type).toBe('enum');
    expect(pkgManager.enumValues).toEqual([
      'npm',
      'yarn',
      'yarn-berry',
      'pnpm',
    ]);
    expect(pkgManager.required).toBe(false);
  });

  it('treats default: false as a real default, so the parameter is optional', () => {
    const [command] = orb.commands;
    const includeBranch = findParam(command!, 'include-branch-in-cache-key');
    expect(includeBranch).toMatchObject({
      type: 'boolean',
      default: false,
      required: false,
    });
  });

  it('treats default: "" as a real default, so the parameter is optional', () => {
    const [command] = orb.commands;
    const cachePath = findParam(command!, 'cache-path');
    expect(cachePath).toMatchObject({
      type: 'string',
      default: '',
      required: false,
    });
  });

  it('marks a parameter with no default key as required', () => {
    const [command] = orb.commands;
    const overrideCommand = findParam(command!, 'override-ci-command');
    expect(overrideCommand.required).toBe(true);
    expect(overrideCommand.default).toBeUndefined();
  });

  it('extracts a job and its parameter', () => {
    const [job] = orb.jobs;
    expect(job?.name).toBe('test');
    expect(job?.kind).toBe('job');
    const runCommand = findParam(job!, 'run-command');
    expect(runCommand).toMatchObject({
      type: 'string',
      default: 'npm test',
      required: false,
    });
  });
});

describe('parseOrbSource - act.yml', () => {
  const orb = parseOrbSource(actYml);

  it('reports no problems for a well-formed orb', () => {
    expect(orb.problems).toEqual([]);
  });

  it('preserves a multi-line block-scalar description', () => {
    const [command] = orb.commands;
    expect(command?.description).toContain(
      'Run a GitHub Actions workflow locally',
    );
    expect(command?.description).toContain('nektos/act');
  });

  it('treats default: true as a real default, so the parameter is optional', () => {
    const [command] = orb.commands;
    const pull = findParam(command!, 'pull');
    expect(pull).toMatchObject({
      type: 'boolean',
      default: true,
      required: false,
    });
  });

  it('leaves namespace/orbName/version undefined when no ref is given', () => {
    expect(orb.ref).toBeUndefined();
    expect(orb.namespace).toBeUndefined();
    expect(orb.orbName).toBeUndefined();
    expect(orb.version).toBeUndefined();
  });
});

describe('parseOrbSource - malformed.yml', () => {
  const orb = parseOrbSource(malformedYml);

  it('does not throw, and degrades jobs (a sequence, not a map) to an empty list', () => {
    expect(orb.jobs).toEqual([]);
    expect(orb.problems.some((p) => p.includes('jobs'))).toBe(true);
  });

  it('infers a missing type from a boolean default and records a problem', () => {
    const [command] = orb.commands;
    const shout = findParam(command!, 'shout');
    expect(shout).toMatchObject({
      type: 'boolean',
      default: true,
      required: false,
    });
    expect(
      orb.problems.some((p) => p.includes('shout') && p.includes('no "type"')),
    ).toBe(true);
  });

  it('falls back an unrecognised type to "string" and records a problem', () => {
    const [command] = orb.commands;
    const volume = findParam(command!, 'volume');
    expect(volume.type).toBe('string');
    expect(volume.default).toBe(11);
    expect(
      orb.problems.some(
        (p) => p.includes('volume') && p.includes('not-a-real-type'),
      ),
    ).toBe(true);
  });
});

describe('parseOrbSource - other malformed inputs', () => {
  it('never throws and reports a problem when the source is not a mapping at all', () => {
    const orb = parseOrbSource('- just\n- a\n- sequence\n');
    expect(orb.jobs).toEqual([]);
    expect(orb.commands).toEqual([]);
    expect(orb.executors).toEqual([]);
    expect(orb.problems.length).toBeGreaterThan(0);
  });

  it('never throws and reports a problem on invalid YAML syntax', () => {
    const orb = parseOrbSource('jobs: [1, 2\n');
    expect(orb.jobs).toEqual([]);
    expect(orb.problems.length).toBeGreaterThan(0);
  });

  it('treats an empty document as valid with no elements and no problems', () => {
    const orb = parseOrbSource('');
    expect(orb.jobs).toEqual([]);
    expect(orb.commands).toEqual([]);
    expect(orb.executors).toEqual([]);
    expect(orb.problems).toEqual([]);
  });
});
