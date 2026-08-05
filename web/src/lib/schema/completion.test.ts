import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as rpcClient from '~/lib/rpc/client';
import { xcodeVersionsFixture } from '~/lib/xcodeVersions/testFixtures';
import {
  __resetXcodeVersionsCacheForTests,
  __setLoadedXcodeVersionsForTests,
} from '~/lib/xcodeVersions/useXcodeVersions';

import { parseCircleciSchema } from './circleciSchema';
import { createCircleciCompletionSource } from './completion';
import { _resetCimgTagsCacheForTests } from './imageTags';
import { _resetOrbSearchCacheForTests } from './orbSearch';
import { FIXTURE_RAW_SCHEMA, generateLargeConfig } from './testFixtures';

vi.mock('~/lib/rpc/client', () => ({
  getDockerTags: vi.fn<() => void>(),
  searchOrbs: vi.fn<() => void>(),
}));

/** Splits `template` at its `‸` cursor marker, returning the marker-free text and the offset it sat at -- see yamlPath.test.ts for why this marker. */
function withCursor(template: string): { text: string; pos: number } {
  const pos = template.indexOf('‸');
  if (pos === -1)
    throw new Error('withCursor: template is missing its ‸ marker');
  return { text: template.slice(0, pos) + template.slice(pos + 1), pos };
}

/**
 * A minimal duck-typed stand-in for `@codemirror/autocomplete`'s real
 * `CompletionContext`: `createCircleciCompletionSource`'s returned source
 * only ever reads `.state.doc.toString()` and `.pos`, so that's all this
 * needs to provide. Constructing a *real* `CompletionContext` would need a
 * real `EditorState`, which would need `@codemirror/state` as a further
 * direct dependency purely for test scaffolding -- not worth it when the
 * function under test doesn't touch anything else on the real object.
 */
function fakeContext(text: string, pos: number): CompletionContext {
  return {
    state: { doc: { toString: () => text } },
    pos,
  } as unknown as CompletionContext;
}

const schema = parseCircleciSchema(FIXTURE_RAW_SCHEMA);
const source = createCircleciCompletionSource(schema);

/**
 * What the popup actually *shows* for each option -- `displayLabel` when
 * set (image completions use it: `label` there is the full match target
 * CodeMirror's own fuzzy filter needs, which can differ from what's
 * rendered -- see completion.ts's `fromImageCandidates`), else `label`.
 */
function labelsOf(result: CompletionResult | null): string[] {
  return result ? result.options.map((o) => o.displayLabel ?? o.label) : [];
}

/**
 * Every position `source` resolves synchronously except one -- a `cimg/*`
 * image's tag stage (see completion.ts's own doc comment on
 * `createCircleciCompletionSource`) -- so every test below that isn't
 * exercising that specific branch calls `source` and uses the result
 * immediately, never awaiting. This asserts that assumption held (rather
 * than silently comparing a `Promise` object against expectations) and
 * narrows the type back to a plain `CompletionResult | null` for the rest
 * of the test to use.
 */
function runSync(result: ReturnType<typeof source>): CompletionResult | null {
  if (result instanceof Promise) {
    throw new Error(
      'runSync: completion source unexpectedly returned a Promise',
    );
  }
  return result;
}

describe('createCircleciCompletionSource', () => {
  it('proposes top-level keys, appending ": " to each', () => {
    const { text, pos } = withCursor(
      'version: 2.1\n\njobs:\n  build:\n    steps:\n      - checkout\n\nwork‸\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result)).toContain('workflows');
    const workflows = result?.options.find((o) => o.label === 'workflows');
    expect(workflows?.apply).toBe('workflows: ');
    expect(result?.from).toBe(text.indexOf('work'));
  });

  it('proposes job-body keys inside a job definition', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:20.1\n    reso‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result)).toEqual(
      expect.arrayContaining(['resource_class', 'executor', 'parallelism']),
    );
    expect(labelsOf(result)).not.toContain('requires'); // a workflow-entry-only key
  });

  it('proposes workflow-job-entry keys inside a workflow job invocation', () => {
    const { text, pos } = withCursor(
      'workflows:\n  main:\n    jobs:\n      - build\n      - deploy:\n          req‸\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result)).toEqual(
      expect.arrayContaining(['requires', 'filters', 'context']),
    );
    expect(labelsOf(result)).not.toContain('resource_class'); // a job-body-only key
  });

  it("proposes built-in step names, the document's own commands, and orb aliases inside steps", () => {
    const { text, pos } = withCursor(
      [
        'orbs:',
        '  node: circleci/node@5.2.0',
        'commands:',
        '  greet:',
        '    steps:',
        '      - run: echo hi',
        'jobs:',
        '  build:',
        '    steps:',
        '      - che‸',
        '',
      ].join('\n'),
    );
    const result = runSync(source(fakeContext(text, pos)));
    const found = labelsOf(result);
    expect(found).toContain('checkout'); // built-in step
    expect(found).toContain('greet'); // this document's own command
    expect(found).toContain('node'); // this document's own orb alias
  });

  it('proposes the resource_class enum for a resource_class value', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    resource_class: med‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result).sort()).toEqual(
      ['large', 'medium', 'medium+', 'small', 'xlarge'].sort(),
    );
  });

  it("proposes the document's own job names for requires:", () => {
    const { text, pos } = withCursor(
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - checkout',
        '  deploy:',
        '    steps:',
        '      - checkout',
        'workflows:',
        '  main:',
        '    jobs:',
        '      - build',
        '      - deploy:',
        '          requires:',
        '            - b‸',
        '',
      ].join('\n'),
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result).sort()).toEqual(['build', 'deploy'].sort());
  });

  it('proposes an orb alias for an executor: value once orbs: declares it', () => {
    const { text, pos } = withCursor(
      [
        'orbs:',
        '  node: circleci/node@5.2.0',
        'executors:',
        '  my-exec:',
        '    docker:',
        '      - image: cimg/base:2024.01',
        'jobs:',
        '  build:',
        '    executor: ‸',
        '    steps:',
        '      - checkout',
        '',
      ].join('\n'),
    );
    const result = runSync(source(fakeContext(text, pos)));
    const found = labelsOf(result);
    expect(found).toContain('node'); // orb alias
    expect(found).toContain('my-exec'); // this document's own executor
  });

  it('proposes cimg images for a docker image: value', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/no‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result)).toContain('cimg/node');
    expect(labelsOf(result)).not.toEqual(
      expect.arrayContaining(['ubuntu-2204', 'android']), // machine images must not leak into a docker context
    );
  });

  it('proposes machine images for a machine image: value, not docker images', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    machine:\n      image: ubuntu‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result).sort()).toEqual(
      ['ubuntu-2204', 'ubuntu-2404', 'ubuntu-2604'].sort(),
    );
    expect(labelsOf(result)).not.toContain('cimg/node');
  });

  it('proposes machine images inside an executors: machine definition too', () => {
    const { text, pos } = withCursor(
      'executors:\n  my-exec:\n    machine:\n      image: android:‸\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result).sort()).toEqual([
      'android:default',
      'android:edge',
    ]);
  });

  it('does not propose machine images for an unrelated image: key (e.g. a bare docker image, no cimg match)', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: ubuntu‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    // "ubuntu" isn't a cimg repo, so there's nothing to propose here -- and
    // machine images (ubuntu-2204 etc.) must not leak into a docker context
    // just because the label happens to start the same way.
    expect(result).toBeNull();
  });

  it('returns null (no completions) inside a comment', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    # still typing a comm‸\n    steps:\n      - checkout\n',
    );
    expect(source(fakeContext(text, pos))).toBeNull();
  });

  it('returns null (no completions) inside a quoted string value', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: "cimg/node:20‸"\n    steps:\n      - checkout\n',
    );
    expect(source(fakeContext(text, pos))).toBeNull();
  });

  it("returns null (no completions) inside a run command's block-literal body", () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    steps:\n      - run: |\n          echo one‸\n          echo two\n',
    );
    expect(source(fakeContext(text, pos))).toBeNull();
  });

  it('returns null when nothing applies (an unrecognized position)', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    steps:\n      - run:\n          und‸: x\n',
    );
    expect(source(fakeContext(text, pos))).toBeNull();
  });
});

// Issue #77's follow-up user feedback: the completion source, not just the
// image picker, must offer live cimg/* version tags once a tag has started
// -- these cover that async branch specifically (see
// `cimgLiveTagRepoName`/`resolveCimgTagCompletions` in completion.ts).
describe('createCircleciCompletionSource live cimg version tags', () => {
  beforeEach(() => {
    _resetCimgTagsCacheForTests();
    vi.mocked(rpcClient.getDockerTags).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Promise (not a plain result) once a cimg tag has started', () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0'],
      live: true,
    });
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:‸\n    steps:\n      - checkout\n',
    );

    const result = source(fakeContext(text, pos));
    expect(result).toBeInstanceOf(Promise);
  });

  it('ranks live version tags ahead of the offline variant suggestions', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0', '20.10.0'],
      fetchedAt: '2026-07-20T00:00:00Z',
      live: true,
    });
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:‸\n    steps:\n      - checkout\n',
    );

    const result = await source(fakeContext(text, pos));
    const labels = labelsOf(result);
    expect(labels).toEqual(expect.arrayContaining(['20.11.0', '20.10.0']));
    expect(result?.options[0]?.apply).toBe('cimg/node:20.11.0');
  });

  it('filters live tags by whatever has already been typed after the colon', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: true,
      tags: ['20.11.0', '19.9.0'],
      live: true,
    });
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:20‸\n    steps:\n      - checkout\n',
    );

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toContain('20.11.0');
    expect(labelsOf(result)).not.toContain('19.9.0');
  });

  it('falls back to offline variant suggestions alone when the live fetch is unavailable', async () => {
    vi.mocked(rpcClient.getDockerTags).mockResolvedValue({
      available: false,
      reason: 'offline',
    });
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:20.11.0-brow‸\n    steps:\n      - checkout\n',
    );

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toContain('20.11.0-browsers');
  });

  it('falls back to offline variant suggestions alone when the live fetch rejects', async () => {
    vi.mocked(rpcClient.getDockerTags).mockRejectedValue(
      new Error('network error'),
    );
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:20.11.0-brow‸\n    steps:\n      - checkout\n',
    );

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toContain('20.11.0-browsers');
  });

  it('stays synchronous (no live lookup) for the repo-name stage, before any tag has been typed', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/no‸\n    steps:\n      - checkout\n',
    );

    const result = source(fakeContext(text, pos));
    expect(result).not.toBeInstanceOf(Promise);
    expect(rpcClient.getDockerTags).not.toHaveBeenCalled();
  });

  it('stays synchronous for a machine image value even though it also has a colon', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    machine:\n      image: ubuntu-2204:‸\n    steps:\n      - checkout\n',
    );

    const result = source(fakeContext(text, pos));
    expect(result).not.toBeInstanceOf(Promise);
    expect(rpcClient.getDockerTags).not.toHaveBeenCalled();
  });

  it('stays synchronous for a non-cimg docker image with a colon (a custom image:tag)', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: ubuntu:22.04‸\n    steps:\n      - checkout\n',
    );

    const result = source(fakeContext(text, pos));
    expect(result).not.toBeInstanceOf(Promise);
    expect(rpcClient.getDockerTags).not.toHaveBeenCalled();
  });
});

// Issue #108: tab-complete orb references (`<alias>: <namespace>/<orb>@<version>`)
// inside the `orbs:` block. These cover the async branch specifically (see
// `isOrbsBlock`/`resolveOrbNameCompletions`/`resolveOrbVersionCompletions` in
// completion.ts), mirroring the live-cimg-tags suite above.
describe('createCircleciCompletionSource orb references', () => {
  const SLACK: rpcClient.OrbSearchResult = {
    name: 'circleci/slack',
    private: false,
    certified: true,
    listed: true,
    latestVersion: '4.12.0',
    versions: ['4.12.0', '4.11.3', '4.10.1'],
    matchedOn: 'exact-name',
  };
  const ACT: rpcClient.OrbSearchResult = {
    name: 'cci-labs/act',
    private: false,
    certified: false,
    listed: true,
    latestVersion: '2.1.0',
    versions: ['2.1.0', '2.0.0'],
    matchedOn: 'exact-name',
  };
  // A reserved orb name with nothing published -- must never be offered,
  // since there's no version to complete a full reference with.
  const RESERVED: rpcClient.OrbSearchResult = {
    name: 'someone/reserved',
    private: false,
    certified: false,
    listed: false,
    latestVersion: '',
    versions: [],
    matchedOn: 'prefix-name',
  };

  beforeEach(() => {
    _resetOrbSearchCacheForTests();
    vi.mocked(rpcClient.searchOrbs).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Promise (not a plain result) for a fresh alias key under orbs:', () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  sl‸\n');

    const result = source(fakeContext(text, pos));
    expect(result).toBeInstanceOf(Promise);
  });

  it('finds an orb by its bare name without the namespace typed first (the orb browser already has this property)', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  slack‸\n');

    const result = await source(fakeContext(text, pos));
    expect(rpcClient.searchOrbs).toHaveBeenCalledWith('slack', 20);
    expect(labelsOf(result)).toContain('circleci/slack');
  });

  it('resolves "act" to cci-labs/act, matching the orb browser\'s no-namespace-required search', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [ACT],
    });
    const { text, pos } = withCursor('orbs:\n  act‸\n');

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toContain('cci-labs/act');
  });

  it('inserts a full "<alias>: <namespace>/<orb>@<version>" line for a fresh alias key, deriving the alias from the orb\'s bare name (reusing orbsEntry\'s sanitizeAlias)', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  slack‸\n');

    const result = await source(fakeContext(text, pos));
    const option = result?.options.find((o) => o.label === 'circleci/slack');
    expect(option?.apply).toBe('slack: circleci/slack@4.12.0');
  });

  // Issue #59 was a P1: a bare "slack@6.1.3" (no namespace) reached a real
  // user's config and made it uncompilable. This asserts the fix can never
  // regress, for every stage this completion source offers.
  describe('never inserts an unnamespaced orb reference (regression for #59)', () => {
    it('the fresh-alias-key completion always carries a full namespace/orb@version', async () => {
      vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
        available: true,
        results: [SLACK],
      });
      const { text, pos } = withCursor('orbs:\n  slack‸\n');

      const result = await source(fakeContext(text, pos));
      for (const option of result?.options ?? []) {
        expect(option.apply).toMatch(/^[\w-]+: [\w-]+\/[\w-]+@\S+$/);
      }
      expect(result?.options.length).toBeGreaterThan(0);
    });

    it('the existing-alias value completion always carries a full namespace/orb@version', async () => {
      vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
        available: true,
        results: [SLACK],
      });
      const { text, pos } = withCursor('orbs:\n  my-slack: slack‸\n');

      const result = await source(fakeContext(text, pos));
      for (const option of result?.options ?? []) {
        expect(option.apply).toMatch(/^[\w-]+\/[\w-]+@\S+$/);
      }
      expect(result?.options.length).toBeGreaterThan(0);
    });

    it('a bare "slack@" (no namespace typed) still resolves to a fully-qualified version completion, never echoing the bare name back', async () => {
      vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
        available: true,
        results: [SLACK], // "slack" is an exact-name hit on circleci/slack
      });
      const { text, pos } = withCursor('orbs:\n  my-slack: slack@‸\n');

      const result = await source(fakeContext(text, pos));
      expect(rpcClient.searchOrbs).toHaveBeenCalledWith('slack', 20);
      expect(labelsOf(result)).toContain('4.12.0');
      const latest = result?.options.find((o) => o.label === '4.12.0');
      expect(latest?.apply).toBe('circleci/slack@4.12.0');
      // Never the bare form -- the whole point of this test.
      expect(latest?.apply).not.toBe('slack@4.12.0');
    });
  });

  it('filters out a reserved orb name with no published version -- there is no version to complete a full reference with', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [RESERVED, SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  s‸\n');

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toEqual(['circleci/slack']);
  });

  it("preserves the host's own ranking order and disables CodeMirror's own re-filtering/re-sorting", async () => {
    // Deliberately not alphabetical and not certified-first -- if this
    // module (or CodeMirror) re-sorted, the assertion below would catch it.
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [ACT, SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  s‸\n');

    const result = await source(fakeContext(text, pos));
    expect(result?.filter).toBe(false);
    expect(result?.options.map((o) => o.label)).toEqual([
      'cci-labs/act',
      'circleci/slack',
    ]);
  });

  it('completes a full reference directly in the value slot when the alias is already written, without re-inserting the alias', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  my-slack: circleci/sl‸\n');

    const result = await source(fakeContext(text, pos));
    const option = result?.options.find((o) => o.label === 'circleci/slack');
    expect(option?.apply).toBe('circleci/slack@4.12.0');
  });

  it('offers versions after "@", marking the latest', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  slack: circleci/slack@‸\n');

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toEqual(['4.12.0', '4.11.3', '4.10.1']);
    const latest = result?.options.find((o) => o.label === '4.12.0');
    expect(latest?.detail).toBe('latest version');
    expect(latest?.apply).toBe('circleci/slack@4.12.0');
    const older = result?.options.find((o) => o.label === '4.11.3');
    expect(older?.detail).toBe('version');
  });

  it('filters versions by whatever has already been typed after the "@"', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  slack: circleci/slack@4.11‸\n');

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toEqual(['4.11.3']);
    expect(labelsOf(result)).not.toContain('4.12.0');
  });

  it('re-offers the full version list (latest included) when the version has been deleted back to just "@" -- the same shape reopenCompletionOnDelete (#107) re-queries after backspacing a cimg tag', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor('orbs:\n  slack: circleci/slack@‸\n');

    const result = await source(fakeContext(text, pos));
    expect(labelsOf(result)).toEqual(['4.12.0', '4.11.3', '4.10.1']);
  });

  it('does not offer versions when the text before "@" is not an exact match to exactly one orb (an ambiguous/fuzzy guess)', async () => {
    const FUZZY_MATCH: rpcClient.OrbSearchResult = {
      ...SLACK,
      matchedOn: 'fuzzy', // "slck" is a subsequence of "slack", not an exact match
    };
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [FUZZY_MATCH],
    });
    const { text, pos } = withCursor('orbs:\n  my-slack: slck@4‸\n');

    const result = await source(fakeContext(text, pos));
    expect(result).toBeNull();
  });

  it('degrades to no completions (never rejects, never blocks typing) when the host has no token', async () => {
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: false,
      reason: 'no CircleCI API token available; orb search requires a token',
    });
    const { text, pos } = withCursor('orbs:\n  slack‸\n');

    const result = await source(fakeContext(text, pos));
    expect(result).toBeNull();
  });

  it('degrades to no completions (never rejects) when the request itself throws', async () => {
    vi.mocked(rpcClient.searchOrbs).mockRejectedValue(
      new Error('network error'),
    );
    const { text, pos } = withCursor('orbs:\n  slack‸\n');

    const result = await source(fakeContext(text, pos));
    expect(result).toBeNull();
  });

  it('does not treat an orb alias inside steps: as the orbs: block itself', () => {
    // Sanity check against the containerPath check being too loose --
    // `orbAliasCompletions` (a different, synchronous, existing feature)
    // must still be what answers this position, not the new async path.
    vi.mocked(rpcClient.searchOrbs).mockResolvedValue({
      available: true,
      results: [SLACK],
    });
    const { text, pos } = withCursor(
      [
        'orbs:',
        '  node: circleci/node@5.2.0',
        'jobs:',
        '  build:',
        '    steps:',
        '      - n‸',
        '',
      ].join('\n'),
    );

    const result = source(fakeContext(text, pos));
    expect(result).not.toBeInstanceOf(Promise);
    expect(rpcClient.searchOrbs).not.toHaveBeenCalled();
  });
});

/**
 * One unit of trivial, non-optimizable synchronous work: short-lived object
 * and string allocation, structurally the same *kind* of cost
 * createCircleciCompletionSource pays while walking the document and
 * building its option list, without trying to model it exactly. Returns a
 * value that depends on the work done, so V8 cannot prove the loop calling
 * this is dead code and elide it.
 */
function calibrationOp(i: number): number {
  const obj = { i, tag: `job-${i}`, options: [i, i + 1, i + 2] };
  return JSON.stringify(obj).length;
}

// A generous hang backstop, not a budget -- same principle as the
// orbs.Cache WarmDone fix (#266): the test below intentionally does 50
// iterations of real synchronous work (a completion call plus a
// calibration burst each), so its own wall-clock cost scales with however
// loaded the machine is, same as the measurement inside it. Vitest's
// 5000ms default test timeout is a budget, and a tight one at that:
// measured up to ~18s for this test alongside eight concurrent full-suite
// runs, which the default would kill outright as "Test timed out" before
// the ratio assertion below ever ran -- a second, unrelated flake this fix
// does not want to trade the first one for. 60s leaves headroom over that
// worst case without turning a genuine hang (an infinite loop, a real
// deadlock) into something this suite would wait out silently.
const PERFORMANCE_TEST_HANG_BACKSTOP_MS = 60_000;

describe('createCircleciCompletionSource performance', () => {
  it(
    "resolves a completion in well under one keystroke's budget on a ~500-line config, relative to this run's own machine load",
    () => {
      const jobCount = 30; // renders to ~540 lines via generateLargeConfig -- see its own doc comment
      const text = generateLargeConfig(jobCount);
      expect(text.split('\n').length).toBeGreaterThan(480);

      // A cursor positioned mid-document, on a fresh sibling line inside a
      // job body (the same shape of query the editor issues on every
      // keystroke while a user is typing a key) -- inserted immediately
      // before an existing same-indent line so the rewritten line is
      // unambiguously a new sibling key, not spliced into the middle of a
      // nested block where it could itself make the probe text invalid YAML.
      const marker = `  job-${Math.floor(jobCount / 2)}:\n    docker:`;
      const anchor = text.indexOf(marker);
      expect(anchor).toBeGreaterThan(0);
      const insertAt = anchor + `  job-${Math.floor(jobCount / 2)}:\n`.length;
      const probeText = `${text.slice(0, insertAt)}    re\n${text.slice(insertAt)}`;
      const pos = insertAt + '    re'.length;

      // Each iteration times one completion call *and* one calibration burst
      // back to back, accumulating the two into separate running totals.
      // Interleaving them this tightly -- rather than, say, one contiguous
      // calibration block before and after a separate contiguous measurement
      // block -- matters: contention on a busy machine is bursty (another
      // process's scheduling quantum, a GC pause), not a constant multiplier,
      // so two measurements that are only *nearby* in time can still land on
      // opposite sides of a burst and disagree wildly (an earlier version of
      // this fix measured that directly: separate before/after calibration
      // blocks swung the ratio 10x across otherwise-identical runs). Charging
      // each of the 50 calibration bursts against its own adjacent completion
      // call means both totals are built from the same 50 slices of wall
      // clock, so a burst that hits one hits the other in the same iteration.
      const iterations = 50;
      // Sized so an idle-machine calibration burst lands within an order of
      // magnitude of one completion call (fractions of a millisecond would be
      // dominated by timer-resolution noise rather than by the work itself --
      // measured directly: single-JSON.stringify bursts produced a ratio that
      // swung 26,000x-290,000x across otherwise identical runs under load,
      // purely from that noise, before this constant was widened).
      const calibrationOpsPerIteration = 4_000;

      let completionTotalMs = 0;
      let calibrationTotalMs = 0;
      for (let i = 0; i < iterations; i++) {
        const completionStart = performance.now();
        const result = runSync(source(fakeContext(probeText, pos)));
        completionTotalMs += performance.now() - completionStart;
        expect(result?.options.length).toBeGreaterThan(0);

        const calibrationStart = performance.now();
        let lastLength = 0;
        for (let k = 0; k < calibrationOpsPerIteration; k++) {
          lastLength = calibrationOp(k);
        }
        calibrationTotalMs += performance.now() - calibrationStart;
        // Trivially true, and enough to stop the loop above from being
        // optimized away as dead code (its result is otherwise never read).
        expect(lastLength).toBeGreaterThan(0);
      }
      const perCallMs = completionTotalMs / iterations;

      // How many calibration bursts one completion call "costs" on this
      // machine, right now. Machine slowdown inflates completionTotalMs and
      // calibrationTotalMs by roughly the same factor -- both are synchronous
      // JS on this same thread, sampled across the same interleaved stretch
      // of wall clock -- so the ratio cancels that factor out.
      const ratio = completionTotalMs / calibrationTotalMs;

      // eslint-disable-next-line no-console -- deliberately reported for the pass's perf measurement, not left-over debugging.
      console.log(
        `createCircleciCompletionSource: ${perCallMs.toFixed(2)}ms/call over ${iterations} calls on a ${text.split('\n').length}-line config ` +
          `(${ratio.toFixed(2)}x a ${calibrationOpsPerIteration}-op calibration burst)`,
      );

      // This guards against a *gross* regression -- an accidental quadratic
      // re-parse, say -- and nothing finer; ratio is deliberately far looser
      // than the real budget it protects (locally this measures ~2-6x; the
      // bound below is ~15-30x that).
      //
      // It's a ratio rather than an absolute millisecond figure because an
      // absolute figure is only as stable as the machine running it, and a
      // shared CI runner (or a laptop mid-parallel-suite) is much slower and
      // much noisier than an idle one: the previous version of this assertion
      // measured under 5ms/call locally and over 100ms/call under full-suite
      // parallel load, which failed a fixed bound while nothing had
      // regressed (issue #162). Comparing against a same-run, interleaved
      // calibration instead means both figures absorb the same slowdown at
      // the same moments, so the ratio stays put whether this run is alone on
      // an idle machine or one of several suites contending for the same
      // cores -- verified directly by running this file repeatedly alongside
      // eight full-suite `vitest run` invocations at once (see the PR
      // description for the actual numbers) rather than trusting the theory.
      //
      // The real per-keystroke budget is roughly one frame (~16ms); the
      // logged measurement above is what to look at for actual performance,
      // not this assertion.
      expect(ratio).toBeLessThan(100);
    },
    PERFORMANCE_TEST_HANG_BACKSTOP_MS,
  );
});

/**
 * The `xcode:` completion (issue #211). The versions come from the same
 * module-cached response the macOS executor field reads, so the two surfaces
 * cannot offer different answers -- see `getLoadedXcodeVersions` for why this
 * accessor is synchronous and what `undefined` has to mean.
 */
describe('xcode: value completion', () => {
  beforeEach(() => {
    __setLoadedXcodeVersionsForTests(xcodeVersionsFixture());
  });
  afterEach(() => {
    __resetXcodeVersionsCacheForTests();
  });

  it('proposes the supported versions under a macos executor', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: ‸\n    steps:\n      - checkout\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    expect(labelsOf(result)).toEqual([
      '27.0',
      '26.6',
      '26.5',
      '26.4.1',
      '16.4.0',
    ]);
    // Whole-value replacement, exactly as `resource_class` does: `from` is where
    // the value starts, not where a word boundary happens to fall.
    expect(result?.from).toBe(text.indexOf('xcode: ') + 'xcode: '.length);
  });

  it('ranks a supported version above a higher-numbered pre-release', () => {
    // The table is newest-first, so its top rows are a beta and a release
    // candidate. Left unranked, the first thing the popup offers would be an image
    // upstream says is not frozen.
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: ‸\n',
    );
    const result = runSync(source(fakeContext(text, pos)));
    const boost = (label: string) =>
      result?.options.find((o) => o.label === label)?.boost ?? 0;
    expect(boost('26.5')).toBeGreaterThan(boost('27.0'));
    expect(result?.options.find((o) => o.label === '27.0')?.detail).toBe(
      'beta',
    );
    expect(result?.options.find((o) => o.label === '26.6')?.detail).toBe(
      'release candidate',
    );
    expect(result?.options.find((o) => o.label === '26.5')?.detail).toBe(
      'Xcode version',
    );
  });

  it('narrows by prefix as a version is typed', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: 26.‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toEqual([
      '26.6',
      '26.5',
      '26.4.1',
    ]);
  });

  it('offers nothing for a prefix no supported version starts with', () => {
    // `15.3` in particular: the version this editor used to write (issue #203).
    // There is nothing to complete it into, and inventing something would be the
    // same defect again.
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: 15.3‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toEqual([]);
  });

  it('offers the whole list again once the value is deleted', () => {
    // Deleting characters is the commonest way to change a version you already
    // have, which is why `reopenCompletionOnDelete` exists. This is the state it
    // re-opens into: an empty value, and the full list.
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: ‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toHaveLength(5);
  });

  it('does not fire for an xcode key anywhere else', () => {
    // `xcode:` only means a version inside a `macos:` object. A stray key of the
    // same name elsewhere gets the schema's own answer, not this list.
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    environment:\n      xcode: ‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toEqual([]);
  });

  it('offers nothing, rather than a guess, before the list has loaded', () => {
    __resetXcodeVersionsCacheForTests();
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    macos:\n      xcode: ‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toEqual([]);
  });

  it('completes an executors: entry as well as a job', () => {
    const { text, pos } = withCursor(
      'executors:\n  mac:\n    macos:\n      xcode: ‸\n',
    );
    expect(labelsOf(runSync(source(fakeContext(text, pos))))).toHaveLength(5);
  });
});
