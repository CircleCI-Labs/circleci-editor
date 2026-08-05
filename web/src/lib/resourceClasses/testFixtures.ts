/**
 * Test-only fixture for `GET /api/resource-classes`, shared by the two
 * components that render `ResourceClassField` (issue #181). Not itself a test
 * file (no `.test.` in the name) so vitest doesn't collect it.
 *
 * It is a realistic *sample* of the ten environments the host serves, not a copy
 * of all of them, and deliberately so: what the host actually extracts from
 * CircleCI's vendored resource tables is pinned in
 * `internal/guides/resourceclasses_test.go` against the tables themselves. A
 * second full copy here would be exactly the retyped literal this whole change
 * removes -- and it would drift the first time upstream added a class.
 *
 * What it does preserve is every structural property the components branch on:
 * more than one architecture within one executor kind (so the architecture
 * filter appears), a gen2 table beside its gen1 one (so the two are
 * distinguishable only by their group labels), a single-architecture kind (so
 * the filter is correctly absent), and macOS's architecture-less table.
 */
import type { ResourceClassesResponse } from './types';

export const FIXTURE_RESOURCE_CLASSES: ResourceClassesResponse = {
  derived: true,
  environments: [
    {
      id: 'x86',
      label: 'x86',
      kind: 'docker',
      architecture: 'x86_64',
      generation: 'gen1',
      classes: [
        { name: 'small', architecture: 'x86_64', generation: 'gen1' },
        {
          name: 'medium',
          spec: 'vCPUs 2, RAM 4GB',
          architecture: 'x86_64',
          generation: 'gen1',
        },
        { name: 'large', architecture: 'x86_64', generation: 'gen1' },
        { name: 'xlarge', architecture: 'x86_64', generation: 'gen1' },
      ],
    },
    {
      id: 'x86-gen2',
      label: 'x86 (gen2)',
      kind: 'docker',
      architecture: 'x86_64',
      generation: 'gen2',
      classes: [
        { name: 'medium.gen2', architecture: 'x86_64', generation: 'gen2' },
        { name: 'xlarge.gen2', architecture: 'x86_64', generation: 'gen2' },
      ],
    },
    {
      id: 'arm',
      label: 'Arm',
      kind: 'docker',
      architecture: 'arm64',
      generation: 'gen1',
      classes: [
        { name: 'arm.medium', architecture: 'arm64', generation: 'gen1' },
        { name: 'arm.large', architecture: 'arm64', generation: 'gen1' },
        { name: 'arm.2xlarge', architecture: 'arm64', generation: 'gen1' },
      ],
    },
    {
      id: 'linuxvm-execution-environment',
      label: 'LinuxVM execution environment',
      kind: 'machine',
      architecture: 'x86_64',
      generation: 'gen1',
      classes: [
        { name: 'medium', architecture: 'x86_64', generation: 'gen1' },
        { name: 'large', architecture: 'x86_64', generation: 'gen1' },
        { name: 'xlarge', architecture: 'x86_64', generation: 'gen1' },
      ],
    },
    {
      id: 'linuxvm-gen2-execution-environment',
      label: 'LinuxVM (gen2) execution environment',
      kind: 'machine',
      architecture: 'x86_64',
      generation: 'gen2',
      classes: [
        { name: 'large.gen2', architecture: 'x86_64', generation: 'gen2' },
      ],
    },
    {
      id: 'arm-execution-environment-linux',
      label: 'Arm VM execution environment',
      kind: 'machine',
      architecture: 'arm64',
      generation: 'gen1',
      classes: [
        {
          name: 'arm.medium',
          architecture: 'arm64',
          generation: 'gen1',
          default: true,
        },
        { name: 'arm.xlarge', architecture: 'arm64', generation: 'gen1' },
      ],
    },
    {
      id: 'windows-execution-environment',
      label: 'Windows execution environment',
      kind: 'machine',
      architecture: 'x86_64',
      generation: 'gen1',
      classes: [
        {
          name: 'windows.medium',
          architecture: 'x86_64',
          generation: 'gen1',
          default: true,
        },
        { name: 'windows.large', architecture: 'x86_64', generation: 'gen1' },
      ],
    },
    {
      id: 'gpu-execution-environment-linux',
      label: 'GPU execution environment (Linux)',
      kind: 'machine',
      architecture: 'x86_64',
      generation: '',
      classes: [
        {
          name: 'gpu.nvidia.small',
          architecture: 'x86_64',
          generation: 'gen1',
        },
        {
          name: 'gpu.nvidia.small.gen2',
          architecture: 'x86_64',
          generation: 'gen2',
        },
      ],
    },
    {
      id: 'gpu-execution-environment-windows',
      label: 'GPU execution environment (Windows)',
      kind: 'machine',
      architecture: 'x86_64',
      generation: 'gen1',
      classes: [
        {
          name: 'windows.gpu.nvidia.medium',
          architecture: 'x86_64',
          generation: 'gen1',
        },
      ],
    },
    {
      id: 'macos-execution-environment',
      label: 'macOS execution environment',
      kind: 'macos',
      architecture: '',
      generation: 'gen1',
      classes: [
        { name: 'm4pro.medium', architecture: '', generation: 'gen1' },
        { name: 'm4pro.large', architecture: '', generation: 'gen1' },
      ],
    },
  ],
};

/**
 * A `fetch` implementation that answers `/api/resource-classes` with `response`
 * (the fixture by default) and every other URL with `fallback`.
 *
 * URL-aware because the components under test make two requests in one render --
 * `/api/schema` and this -- and a single-body stub would hand one of them an
 * already-consumed `Response`. Builds a fresh `Response` per call for the same
 * reason `Inspector.test.tsx`'s own `jsonFetchStub` does.
 */
export function resourceClassesFetchStub(
  fallback: unknown = {},
  response: ResourceClassesResponse = FIXTURE_RESOURCE_CLASSES,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.includes('/api/resource-classes') ? response : fallback;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}
