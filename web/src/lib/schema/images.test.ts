import { describe, expect, it } from 'vitest';

import { cimgImageCandidates, machineImageCandidates } from './images';

function labelsOf(items: ReturnType<typeof cimgImageCandidates>): string[] {
  return items.map((i) => i.label);
}

describe('cimgImageCandidates', () => {
  it('proposes cimg repos before a colon is typed', () => {
    const result = cimgImageCandidates('cimg/no');
    expect(labelsOf(result)).toContain('cimg/node');
    const node = result.find((i) => i.label === 'cimg/node');
    expect(node?.apply).toBe('cimg/node:');
  });

  it('proposes nothing before a colon for text that matches no cimg repo', () => {
    expect(cimgImageCandidates('ubuntu')).toEqual([]);
  });

  it('proposes variant suffixes once a tag has been started', () => {
    const result = cimgImageCandidates('cimg/node:20.11');
    expect(labelsOf(result)).toEqual(['20.11-browsers']);
    expect(result[0]?.apply).toBe('cimg/node:20.11-browsers');
  });

  it('proposes multiple variants for an image that supports several', () => {
    const result = cimgImageCandidates('cimg/python:3.12');
    expect(labelsOf(result).sort()).toEqual(
      ['3.12-browsers', '3.12-node'].sort(),
    );
  });

  it('re-completes a partially typed variant suffix without duplicating it', () => {
    const result = cimgImageCandidates('cimg/node:20.11-brow');
    expect(labelsOf(result)).toEqual(['20.11-browsers']);
    expect(result[0]?.apply).toBe('cimg/node:20.11-browsers');
  });

  it('does not repeat a variant that is already fully typed', () => {
    expect(cimgImageCandidates('cimg/node:20.11-browsers')).toEqual([]);
  });

  it('proposes nothing for an image with no known variants', () => {
    expect(cimgImageCandidates('cimg/postgres:16.1')).toEqual([
      {
        label: '16.1-postgis',
        apply: 'cimg/postgres:16.1-postgis',
        info: undefined,
      },
    ]);
    expect(cimgImageCandidates('cimg/redis:7.2')).toEqual([]);
  });

  it('proposes nothing with no tag started yet', () => {
    expect(cimgImageCandidates('cimg/node:')).toEqual([]);
  });

  it('proposes nothing for a repo name that is not a known cimg image', () => {
    expect(cimgImageCandidates('cimg/nonexistent:1.0')).toEqual([]);
  });

  it('proposes nothing for a bare (non-`cimg/`) image name, even if it matches by coincidence', () => {
    // A custom image happening to be named the same as a cimg repo (e.g. a
    // private `node:18` mirror) must not get silently rewritten to `cimg/node:...`.
    expect(cimgImageCandidates('node:18')).toEqual([]);
  });
});

describe('machineImageCandidates', () => {
  it('proposes machine image families before a colon is typed', () => {
    const result = machineImageCandidates('ubuntu');
    expect(labelsOf(result).sort()).toEqual(
      ['ubuntu-2204', 'ubuntu-2404', 'ubuntu-2604'].sort(),
    );
    const family = result.find((i) => i.label === 'ubuntu-2204');
    expect(family?.apply).toBe('ubuntu-2204:');
  });

  it("proposes that family's moving tags once a colon is typed", () => {
    const result = machineImageCandidates('ubuntu-2204:');
    expect(labelsOf(result).sort()).toEqual(
      ['ubuntu-2204:current', 'ubuntu-2204:edge'].sort(),
    );
  });

  it('filters tags by what has been typed so far', () => {
    const result = machineImageCandidates('ubuntu-2204:cur');
    expect(labelsOf(result)).toEqual(['ubuntu-2204:current']);
  });

  it('uses `default`/`edge` (not `current`) for the GPU and Android families', () => {
    expect(labelsOf(machineImageCandidates('android:')).sort()).toEqual([
      'android:default',
      'android:edge',
    ]);
    expect(labelsOf(machineImageCandidates('linux-cuda-12:')).sort()).toEqual([
      'linux-cuda-12:default',
      'linux-cuda-12:edge',
    ]);
  });

  it('includes the Windows-only `previous`/`stable` tags for Windows families', () => {
    expect(
      labelsOf(machineImageCandidates('windows-server-2022-gui:')).sort(),
    ).toEqual(
      [
        'windows-server-2022-gui:current',
        'windows-server-2022-gui:edge',
        'windows-server-2022-gui:previous',
        'windows-server-2022-gui:stable',
      ].sort(),
    );
  });

  it('proposes nothing for an unknown family', () => {
    expect(machineImageCandidates('macos-fusion:current')).toEqual([]);
  });
});
