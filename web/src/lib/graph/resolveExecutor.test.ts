import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import reusableExecutorsConfig from '~/fixtures/reusable-executors.yml?raw';

import { listExecutorNames, resolveJobExecutor } from './resolveExecutor';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('listExecutorNames', () => {
  it('lists executors in document order', () => {
    const doc = parse(`
executors:
  small-exec:
    docker:
      - image: cimg/base:current
  big-exec:
    docker:
      - image: cimg/base:current
`);
    expect(listExecutorNames(doc)).toEqual(['small-exec', 'big-exec']);
  });

  it('returns [] when there is no executors: block', () => {
    const doc = parse('jobs:\n  build:\n    docker: []\n');
    expect(listExecutorNames(doc)).toEqual([]);
  });
});

describe('resolveJobExecutor', () => {
  it('resolves a job with an inline docker executor (source: job)', () => {
    const doc = parse(`
jobs:
  build:
    docker:
      - image: cimg/node:20.0
    resource_class: medium
    working_directory: ~/project
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'job',
      kind: 'docker',
      image: 'cimg/node:20.0',
      serviceImages: [],
      resourceClass: 'medium',
      workingDirectory: '~/project',
      jobOverrides: [],
    });
  });

  it('resolves an inline multi-image docker executor, reporting service images', () => {
    const doc = parse(`
jobs:
  test:
    docker:
      - image: cimg/python:3.11
      - image: cimg/postgres:15.8
      - image: cimg/redis:7.0
    steps: [checkout]
`);
    const resolved = resolveJobExecutor(doc, 'test');
    expect(resolved.image).toBe('cimg/python:3.11');
    expect(resolved.serviceImages).toEqual([
      'cimg/postgres:15.8',
      'cimg/redis:7.0',
    ]);
  });

  it('resolves an inline machine executor, including docker_layer_caching', () => {
    const doc = parse(`
jobs:
  build:
    machine:
      image: ubuntu-2404:current
      docker_layer_caching: true
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'job',
      kind: 'machine',
      image: 'ubuntu-2404:current',
      serviceImages: [],
      jobOverrides: [],
      dockerLayerCaching: true,
    });
  });

  it('resolves a bare `machine: true` shorthand', () => {
    const doc = parse(`
jobs:
  build:
    machine: true
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toMatchObject({
      source: 'job',
      kind: 'machine',
    });
  });

  it('resolves an inline macos executor via xcode', () => {
    const doc = parse(`
jobs:
  build:
    macos:
      xcode: 15.3.0
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'job',
      kind: 'macos',
      image: '15.3.0',
      serviceImages: [],
      jobOverrides: [],
    });
  });

  it('resolves a string-form executor: reference to its executors: definition', () => {
    const doc = parse(`
executors:
  node-medium:
    docker:
      - image: cimg/node:20.0
    resource_class: medium
    working_directory: ~/project
jobs:
  build:
    executor: node-medium
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'executor',
      name: 'node-medium',
      kind: 'docker',
      image: 'cimg/node:20.0',
      serviceImages: [],
      resourceClass: 'medium',
      workingDirectory: '~/project',
      jobOverrides: [],
    });
  });

  it('resolves a map-form executor: { name, ... } reference (parameter-passing form)', () => {
    const doc = parse(`
executors:
  node-medium:
    docker:
      - image: cimg/node:20.0
jobs:
  build:
    executor:
      name: node-medium
      some-param: value
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toMatchObject({
      source: 'executor',
      name: 'node-medium',
      image: 'cimg/node:20.0',
    });
  });

  it("records a job-level resource_class as an override, and it wins over the executor's own value", () => {
    const doc = parse(`
executors:
  node-medium:
    docker:
      - image: cimg/node:20.0
    resource_class: medium
jobs:
  build:
    executor: node-medium
    resource_class: large
    steps: [checkout]
`);
    const resolved = resolveJobExecutor(doc, 'build');
    expect(resolved.resourceClass).toBe('large');
    expect(resolved.jobOverrides).toEqual(['resource_class']);
    // The image still comes from the executor -- only resource_class was overridden.
    expect(resolved.image).toBe('cimg/node:20.0');
  });

  it('records a job-level working_directory override alongside resource_class', () => {
    const doc = parse(`
executors:
  node-medium:
    docker:
      - image: cimg/node:20.0
    working_directory: ~/project
jobs:
  build:
    executor: node-medium
    working_directory: ~/custom
    steps: [checkout]
`);
    const resolved = resolveJobExecutor(doc, 'build');
    expect(resolved.workingDirectory).toBe('~/custom');
    expect(resolved.jobOverrides).toEqual(['working_directory']);
  });

  it('resolves an orb-provided executor as unresolvable, without guessing values', () => {
    const doc = parse(`
jobs:
  build:
    executor: python/default
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'orb',
      name: 'python/default',
      kind: 'unknown',
      serviceImages: [],
      jobOverrides: [],
      unresolvable: true,
    });
  });

  it('still surfaces a job-level override on top of an orb executor', () => {
    const doc = parse(`
jobs:
  build:
    executor: python/default
    resource_class: large
    steps: [checkout]
`);
    const resolved = resolveJobExecutor(doc, 'build');
    expect(resolved.source).toBe('orb');
    expect(resolved.unresolvable).toBe(true);
    expect(resolved.resourceClass).toBe('large');
    expect(resolved.jobOverrides).toEqual(['resource_class']);
    expect(resolved.image).toBeUndefined();
  });

  it('resolves source: none, retaining the name, when executor: names something undefined', () => {
    const doc = parse(`
jobs:
  build:
    executor: does-not-exist
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'none',
      name: 'does-not-exist',
      kind: 'unknown',
      serviceImages: [],
      jobOverrides: [],
    });
  });

  it('resolves source: none for a job with no executor information at all', () => {
    const doc = parse('jobs:\n  build:\n    steps: [checkout]\n');
    expect(resolveJobExecutor(doc, 'build')).toEqual({
      source: 'none',
      kind: 'unknown',
      serviceImages: [],
      jobOverrides: [],
    });
  });

  it('resolves source: none for an unknown job name, without throwing', () => {
    const doc = parse('jobs:\n  build:\n    docker: []\n');
    expect(resolveJobExecutor(doc, 'nope')).toEqual({
      source: 'none',
      kind: 'unknown',
      serviceImages: [],
      jobOverrides: [],
    });
  });

  it("prefers the job's own inline executor over a same-named executor: field (defensive, malformed input)", () => {
    const doc = parse(`
executors:
  node-medium:
    docker:
      - image: cimg/node:99.0
jobs:
  build:
    executor: node-medium
    docker:
      - image: cimg/node:20.0
    steps: [checkout]
`);
    expect(resolveJobExecutor(doc, 'build')).toMatchObject({
      source: 'job',
      image: 'cimg/node:20.0',
    });
  });

  describe('against the real-world reusable-executors fixture (#27)', () => {
    const doc = parse(reusableExecutorsConfig);

    it('resolves lint-backend to python-lint-executor', () => {
      expect(resolveJobExecutor(doc, 'lint-backend')).toEqual({
        source: 'executor',
        name: 'python-lint-executor',
        kind: 'docker',
        image: 'cimg/python:3.11.13',
        serviceImages: [],
        resourceClass: 'large',
        workingDirectory: '~/project',
        jobOverrides: [],
      });
    });

    it('resolves test-integration to the multi-image python-db-executor, reporting the postgres service image', () => {
      const resolved = resolveJobExecutor(doc, 'test-integration');
      expect(resolved).toMatchObject({
        source: 'executor',
        name: 'python-db-executor',
        kind: 'docker',
        image: 'cimg/python:3.11.13',
        resourceClass: 'medium+',
        workingDirectory: '~/project',
      });
      expect(resolved.serviceImages).toEqual(['cimg/postgres:15.8']);
    });

    it('resolves build-backend to the machine docker-executor with docker_layer_caching: true', () => {
      expect(resolveJobExecutor(doc, 'build-backend')).toEqual({
        source: 'executor',
        name: 'docker-executor',
        kind: 'machine',
        image: 'ubuntu-2404:current',
        serviceImages: [],
        resourceClass: 'large',
        workingDirectory: '~/project',
        jobOverrides: [],
        dockerLayerCaching: true,
      });
    });

    it('resolves test-e2e to the machine docker-executor-no-dlc with docker_layer_caching: false', () => {
      const resolved = resolveJobExecutor(doc, 'test-e2e');
      expect(resolved.name).toBe('docker-executor-no-dlc');
      expect(resolved.dockerLayerCaching).toBe(false);
    });

    it('lists every top-level executor', () => {
      expect(listExecutorNames(doc)).toEqual([
        'python-lint-executor',
        'python-db-executor',
        'node-executor',
        'docker-executor',
        'docker-executor-no-dlc',
      ]);
    });
  });
});
