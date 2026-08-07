import { describe, expect, it } from 'vitest';

import { createResourceClassCatalog } from './resourceClassCatalog';
import type { ResourceClassEnvironment } from './types';

/**
 * `createResourceClassCatalog`'s own tests (issue #8). `rank` values below
 * mirror what `internal/guides/resourceclassrank.go` actually derives from
 * the vendored tables (see `internal/guides/resourceclassrank_test.go`), not
 * arbitrary integers -- this module's whole job is reading that field
 * correctly, and the shapes here are the ones that matter: several
 * environments for one `kind` (Docker really does have three), the same class
 * name repeated across two `kind`s, a class with no `rank` at all, and a
 * genuine tie.
 */
const DOCKER_X86: ResourceClassEnvironment = {
  id: 'x86',
  label: 'x86',
  kind: 'docker',
  architecture: 'x86_64',
  generation: 'gen1',
  classes: [
    { name: 'small', architecture: 'x86_64', generation: 'gen1', rank: 0 },
    { name: 'medium', architecture: 'x86_64', generation: 'gen1', rank: 1 },
    { name: 'medium+', architecture: 'x86_64', generation: 'gen1', rank: 2 },
    { name: 'large', architecture: 'x86_64', generation: 'gen1', rank: 3 },
    { name: 'xlarge', architecture: 'x86_64', generation: 'gen1', rank: 4 },
    { name: '2xlarge', architecture: 'x86_64', generation: 'gen1', rank: 5 },
    { name: '2xlarge+', architecture: 'x86_64', generation: 'gen1', rank: 6 },
  ],
};

const DOCKER_ARM: ResourceClassEnvironment = {
  id: 'arm',
  label: 'Arm',
  kind: 'docker',
  architecture: 'arm64',
  generation: 'gen1',
  classes: [
    { name: 'arm.medium', architecture: 'arm64', generation: 'gen1', rank: 0 },
    { name: 'arm.large', architecture: 'arm64', generation: 'gen1', rank: 1 },
    { name: 'arm.xlarge', architecture: 'arm64', generation: 'gen1', rank: 2 },
  ],
};

// Same "medium" name as DOCKER_X86's, deliberately: a different kind, a
// different machine (7.5 GB RAM vs. Docker's 4 GB), and its own independent
// rank numbering.
const MACHINE_LINUXVM: ResourceClassEnvironment = {
  id: 'linuxvm-execution-environment',
  label: 'LinuxVM execution environment',
  kind: 'machine',
  architecture: 'x86_64',
  generation: 'gen1',
  classes: [
    { name: 'medium', architecture: 'x86_64', generation: 'gen1', rank: 0 },
    { name: 'large', architecture: 'x86_64', generation: 'gen1', rank: 1 },
    { name: 'xlarge', architecture: 'x86_64', generation: 'gen1', rank: 2 },
  ],
};

// Mirrors gpu-execution-environment-linux's own real shape (see
// resourceclassrank_test.go): a class with no parseable Rank at all, and a
// genuine three-way tie.
const GPU_LINUX: ResourceClassEnvironment = {
  id: 'gpu-execution-environment-linux',
  label: 'GPU execution environment (Linux)',
  kind: 'machine',
  architecture: 'x86_64',
  generation: '',
  classes: [
    {
      name: 'gpu.nvidia.small.multi',
      architecture: 'x86_64',
      generation: 'gen1',
      rank: 0,
    },
    {
      name: 'gpu.nvidia.small',
      architecture: 'x86_64',
      generation: 'gen1',
      rank: 1,
    },
    {
      name: 'gpu.nvidia.small.gen2',
      architecture: 'x86_64',
      generation: 'gen2',
      rank: 1,
    },
    {
      name: 'gpu.nvidia.medium.multi',
      architecture: 'x86_64',
      generation: 'gen1',
      rank: 2,
    },
    {
      name: 'gpu.nvidia.medium',
      architecture: 'x86_64',
      generation: 'gen1',
      rank: 2,
    },
    // No `rank` at all: this class's vCPU/RAM row failed to parse on the host.
    { name: 'gpu.nvidia.large', architecture: 'x86_64', generation: 'gen1' },
  ],
};

const ENVIRONMENTS = [DOCKER_X86, DOCKER_ARM, MACHINE_LINUXVM, GPU_LINUX];

describe('createResourceClassCatalog', () => {
  it('names the nearest smaller and larger classes within one table', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    expect(catalog.smallerClasses('docker', 'large')).toEqual([
      'medium+',
      'medium',
      'small',
    ]);
    expect(catalog.largerClasses('docker', 'large')).toEqual([
      'xlarge',
      '2xlarge',
      '2xlarge+',
    ]);
  });

  it('returns an empty list at the floor or the ceiling of a table', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    expect(catalog.smallerClasses('docker', 'small')).toEqual([]);
    expect(catalog.largerClasses('docker', '2xlarge+')).toEqual([]);
  });

  it('never compares across executors, even when the class name repeats', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    // Docker's own "medium" (rank 1 of 7) has two smaller classes.
    expect(catalog.smallerClasses('docker', 'medium')).toEqual(['small']);
    // The LinuxVM "machine" table's own "medium" (rank 0 of 3, a different
    // machine entirely) has none -- if this leaked into Docker's numbering,
    // it would wrongly inherit Docker's "small" as a smaller neighbour.
    expect(catalog.smallerClasses('machine', 'medium')).toEqual([]);
    expect(catalog.largerClasses('machine', 'medium')).toEqual([
      'large',
      'xlarge',
    ]);
  });

  it('never compares across environments of the same kind', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    // "arm.large" lives in Docker's own Arm table, entirely separate from the
    // x86 table above it even though both are `kind: 'docker'`.
    expect(catalog.smallerClasses('docker', 'arm.large')).toEqual([
      'arm.medium',
    ]);
    expect(catalog.largerClasses('docker', 'arm.large')).toEqual([
      'arm.xlarge',
    ]);
  });

  it('excludes classes tied with the current one in both directions', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    // gpu.nvidia.small and gpu.nvidia.small.gen2 tie at rank 1 -- neither is
    // "smaller" or "larger" than the other, so asking from either one must
    // never name its own tie partner.
    expect(catalog.smallerClasses('machine', 'gpu.nvidia.small')).toEqual([
      'gpu.nvidia.small.multi',
    ]);
    expect(catalog.largerClasses('machine', 'gpu.nvidia.small')).not.toContain(
      'gpu.nvidia.small.gen2',
    );
    expect(catalog.largerClasses('machine', 'gpu.nvidia.small')).toEqual([
      'gpu.nvidia.medium.multi',
      'gpu.nvidia.medium',
    ]);
  });

  it('returns nothing for a class whose own rank could not be derived', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    // gpu.nvidia.large has no rank at all (its row failed to parse on the
    // host) -- asking about its own neighbours must not guess.
    expect(catalog.smallerClasses('machine', 'gpu.nvidia.large')).toEqual([]);
    expect(catalog.largerClasses('machine', 'gpu.nvidia.large')).toEqual([]);
  });

  it('never places a rank-less class as a neighbour of a ranked one', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    // gpu.nvidia.medium (rank 2) is the largest ranked class in its table;
    // gpu.nvidia.large has no rank and must never be offered as "the next
    // one up" just because it is the last row.
    expect(catalog.largerClasses('machine', 'gpu.nvidia.medium')).toEqual([]);
  });

  it('returns nothing for a class no environment of that platform lists', () => {
    const catalog = createResourceClassCatalog(ENVIRONMENTS);
    expect(catalog.smallerClasses('docker', 'does-not-exist')).toEqual([]);
    expect(catalog.largerClasses('docker', 'does-not-exist')).toEqual([]);
    // Nor a real class under the wrong platform -- "medium" is a machine
    // class too, but asking for it under "macos" (which has none of these
    // environments at all) must not fall through to a different kind.
    expect(catalog.smallerClasses('macos', 'medium')).toEqual([]);
  });
});
