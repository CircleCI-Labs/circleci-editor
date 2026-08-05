import { describe, expect, it } from 'vitest';

import {
  BUILTIN_EXECUTORS,
  findBuiltinExecutor,
  isDraggingPaletteExecutor,
  readPaletteExecutorDragPayload,
  setPaletteExecutorDragPayload,
} from './paletteExecutors';

/** A minimal fake `DataTransfer` good enough for these helpers: they only read `types`, `setData`, and `getData`. */
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    get types() {
      return Array.from(store.keys());
    },
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

describe('BUILTIN_EXECUTORS', () => {
  it('has exactly the five cards issue #71 calls for, each mapping to one of the three real CircleCI executor kinds', () => {
    expect(BUILTIN_EXECUTORS.map((d) => d.id)).toEqual([
      'docker',
      'machine',
      'macos',
      'windows',
      'gpu',
    ]);
    for (const def of BUILTIN_EXECUTORS) {
      expect(['docker', 'machine', 'macos']).toContain(def.mutationKind);
      expect(def.resourceEnvironmentIds.length).toBeGreaterThan(0);
      expect(def.defaultResourceClass).not.toBe('');
    }
  });

  it('carries no Xcode version of its own, and no unsupported one anywhere', () => {
    // Issue #203: the macOS card's `defaultImage` was `15.3.0`, a version that
    // appears nowhere in CircleCI's supported-Xcode table -- not stale, invented. The
    // fix is structural rather than a fresher literal: the card now says nothing, and
    // the version is resolved from `GET /api/xcode-versions`, which the host derives
    // from the vendored table.
    //
    // `vendoredXcodeTable.test.ts` is what checks this against the table itself; this
    // pins the shape, so a literal cannot quietly come back.
    const macos = BUILTIN_EXECUTORS.find((def) => def.id === 'macos');
    expect(macos?.defaultImage).toBe('');
    for (const def of BUILTIN_EXECUTORS) {
      expect(def.defaultImage).not.toBe('15.3.0');
    }
  });

  it('gives every other card an image default, since only macOS defers to the host', () => {
    // The four remaining literals are product choices ("start somewhere
    // general-purpose"), not claims about which images CircleCI supports -- so they
    // stay, and are checked against the vendored docs' own examples in
    // `vendoredXcodeTable.test.ts`.
    for (const def of BUILTIN_EXECUTORS) {
      if (def.mutationKind === 'macos') continue;
      expect(def.defaultImage).not.toBe('');
    }
  });

  /**
   * Issue #181: the cards name *upstream resource tables*, not resource
   * classes. This pins that every id a card names is one the host really
   * publishes -- checked against the anchors `internal/guides`'
   * `resourceEnvironments` declares, which its own tests in turn check against
   * the vendored configuration reference. A card naming a table nobody serves
   * would silently lose a whole option group.
   */
  it('every card names resource tables the host actually serves, with no table offered twice', () => {
    // The ten environment ids `GET /api/resource-classes` serves, as pinned by
    // internal/guides/resourceclasses_test.go's
    // TestResourceClassEnvironmentOrderIsUpstreamDocumentOrder.
    const HOST_ENVIRONMENT_IDS = [
      'x86',
      'x86-gen2',
      'arm',
      'linuxvm-execution-environment',
      'linuxvm-gen2-execution-environment',
      'arm-execution-environment-linux',
      'windows-execution-environment',
      'gpu-execution-environment-linux',
      'gpu-execution-environment-windows',
      'macos-execution-environment',
    ];

    const named = BUILTIN_EXECUTORS.flatMap(
      (def) => def.resourceEnvironmentIds,
    );
    for (const id of named) {
      expect(HOST_ENVIRONMENT_IDS).toContain(id);
    }
    // Every table reaches a card, and none reaches two: a class offered under
    // two cards would let the same job be created two ways, and a table offered
    // under none would be unreachable in the palette entirely.
    expect([...named].sort()).toEqual([...HOST_ENVIRONMENT_IDS].sort());
  });

  it('Docker offers the Arm table -- the defect issue #181 was filed for', () => {
    expect(findBuiltinExecutor('docker')?.resourceEnvironmentIds).toContain(
      'arm',
    );
    expect(findBuiltinExecutor('machine')?.resourceEnvironmentIds).toContain(
      'arm-execution-environment-linux',
    );
  });

  it('both gen2 tables are offered, because gen2 is a writable resource_class suffix', () => {
    expect(findBuiltinExecutor('docker')?.resourceEnvironmentIds).toContain(
      'x86-gen2',
    );
    expect(findBuiltinExecutor('machine')?.resourceEnvironmentIds).toContain(
      'linuxvm-gen2-execution-environment',
    );
  });

  it('"Windows" and "GPU" are `machine` under the hood -- CircleCI has no separate top-level executor key for either', () => {
    expect(findBuiltinExecutor('windows')?.mutationKind).toBe('machine');
    expect(findBuiltinExecutor('gpu')?.mutationKind).toBe('machine');
  });

  it('findBuiltinExecutor returns undefined for an unknown id', () => {
    expect(findBuiltinExecutor('nope')).toBeUndefined();
  });
});

describe('palette executor drag payload', () => {
  it('round-trips a builtin payload', () => {
    const dt = fakeDataTransfer();
    setPaletteExecutorDragPayload(dt, {
      source: 'builtin',
      builtinId: 'docker',
    });
    expect(isDraggingPaletteExecutor(dt)).toBe(true);
    expect(readPaletteExecutorDragPayload(dt)).toEqual({
      source: 'builtin',
      builtinId: 'docker',
    });
  });

  it('round-trips a local-executor payload', () => {
    const dt = fakeDataTransfer();
    setPaletteExecutorDragPayload(dt, {
      source: 'local',
      executorName: 'py-executor',
    });
    expect(readPaletteExecutorDragPayload(dt)).toEqual({
      source: 'local',
      executorName: 'py-executor',
    });
  });

  it('is not dragging when nothing was written', () => {
    const dt = fakeDataTransfer();
    expect(isDraggingPaletteExecutor(dt)).toBe(false);
    expect(readPaletteExecutorDragPayload(dt)).toBeUndefined();
  });

  it('returns undefined for malformed JSON under the same MIME type', () => {
    const dt = fakeDataTransfer();
    dt.setData('application/x-vce-palette-executor', '{not json');
    expect(readPaletteExecutorDragPayload(dt)).toBeUndefined();
  });
});
