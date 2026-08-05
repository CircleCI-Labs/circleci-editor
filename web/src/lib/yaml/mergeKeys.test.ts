/**
 * Tests for issue #35: YAML merge keys (`<<`) were invisible to every
 * reader in this tool (a merge-inherited field resolved as absent), and a
 * write to such a field silently created a shadowing duplicate instead of
 * touching the shared anchor. See `parseConfig`, `getInWithOrigin`,
 * `setIn`, and `setInOverridingMerge` in `documentUtils.ts` for the fix,
 * and `resolveExecutor.ts`'s `mergeInherited`/`mergeSource` for how it
 * threads through to the executor-resolution layer.
 */
import { describe, expect, it } from 'vitest';

import { resolveJobExecutor } from '~/lib/graph/resolveExecutor';

import mergeKeysConfig from '~/fixtures/merge-keys.yml?raw';

import {
  getIn,
  getInWithOrigin,
  parseConfig,
  setIn,
  setInOverridingMerge,
} from './documentUtils';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('merge-keys fixture (issue #35)', () => {
  it('parses without error and round-trips byte-for-byte with no edits', () => {
    const { doc, error } = parseConfig(mergeKeysConfig);
    expect(error).toBeNull();
    expect(doc).not.toBeNull();
    // The critical safety net: enabling `{ merge: true }` in parseConfig
    // must not change how *anything* -- merge keys included -- stringifies
    // back out. If this ever fails, something about turning `merge` on
    // altered serialization, and the fix must not ship as-is.
    expect(doc?.toString()).toBe(mergeKeysConfig);
  });

  describe('getIn resolves merge-inherited and whole-alias values', () => {
    const doc = parse(mergeKeysConfig);

    it('reads a field only present via a single-anchor merge key', () => {
      expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('large');
      expect(getIn(doc, ['jobs', 'build', 'working_directory'])).toBe(
        '~/project',
      );
      expect(getIn(doc, ['jobs', 'build', 'docker'])).toEqual([
        { image: 'cimg/node:20.10' },
      ]);
    });

    it('lets an explicit key win over the same key from the merge source', () => {
      expect(getIn(doc, ['jobs', 'build_large', 'resource_class'])).toBe(
        'xlarge',
      );
      // docker isn't overridden -- still comes from &base.
      expect(getIn(doc, ['jobs', 'build_large', 'docker'])).toEqual([
        { image: 'cimg/node:20.10' },
      ]);
    });

    it('resolves a whole-job value that is nothing but a plain alias', () => {
      expect(getIn(doc, ['jobs', 'build_alias'])).toEqual({
        docker: [{ image: 'cimg/node:20.10' }],
        resource_class: 'large',
        working_directory: '~/project',
      });
    });

    it('multi-anchor merge: an earlier source in the list wins per key (verified empirically against yaml@2.9.0, not assumed)', () => {
      // <<: [*small, *base] -- &small has resource_class/working_directory
      // of its own, so those win; &base's docker (which &small lacks) still
      // comes through.
      expect(getIn(doc, ['jobs', 'build_multi', 'resource_class'])).toBe(
        'small',
      );
      expect(getIn(doc, ['jobs', 'build_multi', 'working_directory'])).toBe(
        '~/small-project',
      );
      expect(getIn(doc, ['jobs', 'build_multi', 'docker'])).toEqual([
        { image: 'cimg/node:20.10' },
      ]);
    });
  });

  describe('getInWithOrigin distinguishes own / merged / absent', () => {
    const doc = parse(mergeKeysConfig);

    it('reports "merged" and the source anchor for an inherited field', () => {
      expect(getInWithOrigin(doc, ['jobs', 'build', 'resource_class'])).toEqual(
        { value: 'large', origin: 'merged', via: 'base' },
      );
    });

    it('reports "own" for a field the job wrote for itself, even next to a merge key', () => {
      expect(
        getInWithOrigin(doc, ['jobs', 'build_large', 'resource_class']),
      ).toEqual({ value: 'xlarge', origin: 'own' });
      expect(
        getInWithOrigin(doc, ['jobs', 'build_large', 'docker']).origin,
      ).toBe('merged');
    });

    it('reports "absent" for a field that is nowhere at all', () => {
      expect(getInWithOrigin(doc, ['jobs', 'build', 'nonexistent'])).toEqual({
        value: undefined,
        origin: 'absent',
      });
      expect(getInWithOrigin(doc, ['jobs', 'no_such_job'])).toEqual({
        value: undefined,
        origin: 'absent',
      });
    });

    it('reports the nearer anchor for a multi-anchor merge, per key', () => {
      expect(
        getInWithOrigin(doc, ['jobs', 'build_multi', 'resource_class']).via,
      ).toBe('small');
      expect(getInWithOrigin(doc, ['jobs', 'build_multi', 'docker']).via).toBe(
        'base',
      );
    });
  });

  describe('setIn refuses to shadow a merge-inherited field', () => {
    it('throws instead of silently creating a duplicate literal key', () => {
      const doc = parse(mergeKeysConfig);
      const before = doc.toString();
      expect(() =>
        setIn(doc, ['jobs', 'build', 'resource_class'], 'small'),
      ).toThrow(/merge key/i);
      // Nothing was written -- refusing means refusing, not "write and warn".
      expect(doc.toString()).toBe(before);
    });

    it('names the anchor in the error, when determinable', () => {
      const doc = parse(mergeKeysConfig);
      expect(() =>
        setIn(doc, ['jobs', 'build', 'resource_class'], 'small'),
      ).toThrow(/base/);
    });

    it('also refuses a write nested inside a merge-inherited container, not just an exact overwrite', () => {
      const doc = parse(mergeKeysConfig);
      const before = doc.toString();
      // `docker` itself only exists on `build` via &base; `environment`
      // doesn't exist anywhere yet -- but writing it here would still
      // fabricate a brand-new, job-level `docker:` that shadows &base's.
      expect(() =>
        setIn(doc, ['jobs', 'build', 'docker', 0, 'environment', 'FOO'], 'bar'),
      ).toThrow(/merge key/i);
      expect(doc.toString()).toBe(before);
    });

    it('does not refuse a write to a genuinely new field (no merge crossed at all)', () => {
      const doc = parse(mergeKeysConfig);
      setIn(doc, ['jobs', 'build', 'parallelism'], 2);
      expect(getIn(doc, ['jobs', 'build', 'parallelism'])).toBe(2);
    });

    it('does not refuse a write to a brand-new job', () => {
      const doc = parse(mergeKeysConfig);
      setIn(doc, ['jobs', 'new_job', 'resource_class'], 'medium');
      expect(getIn(doc, ['jobs', 'new_job', 'resource_class'])).toBe('medium');
    });
  });

  describe('setInOverridingMerge deliberately creates the override', () => {
    it('writes the value and reports what it shadowed', () => {
      const doc = parse(mergeKeysConfig);
      const result = setInOverridingMerge(
        doc,
        ['jobs', 'build', 'resource_class'],
        'small',
      );
      expect(result).toEqual({ overrode: true, via: 'base' });
      expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('small');
      // &base itself is untouched -- only `build` diverged.
      expect(getIn(doc, ['x-base', 'resource_class'])).toBe('large');
    });

    it('produces exactly the expected minimal diff -- one new literal line, everything else untouched', () => {
      const doc = parse(mergeKeysConfig);
      const before = doc.toString();
      setInOverridingMerge(doc, ['jobs', 'build', 'resource_class'], 'small');
      const after = doc.toString();

      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines.length).toBe(beforeLines.length + 1);
      expect(afterLines).toContain('    resource_class: small');
      // Every line from `before` is still present, in order, in `after`
      // (the new line is a pure insertion, not a rewrite of anything else).
      let cursor = 0;
      for (const line of beforeLines) {
        const idx = afterLines.indexOf(line, cursor);
        expect(idx).toBeGreaterThanOrEqual(cursor);
        cursor = idx + 1;
      }
    });

    it('reports overrode: false when the field was not actually merge-inherited', () => {
      const doc = parse(mergeKeysConfig);
      const result = setInOverridingMerge(
        doc,
        ['jobs', 'build_large', 'resource_class'],
        'medium',
      );
      expect(result).toEqual({ overrode: false });
      expect(getIn(doc, ['jobs', 'build_large', 'resource_class'])).toBe(
        'medium',
      );
    });
  });

  describe('resolveJobExecutor reports inherited-via-merge provenance', () => {
    const doc = parse(mergeKeysConfig);

    it('reports every inline field a job inherits via a single-anchor merge', () => {
      const resolved = resolveJobExecutor(doc, 'build');
      expect(resolved.source).toBe('job');
      expect(resolved.image).toBe('cimg/node:20.10');
      expect(resolved.resourceClass).toBe('large');
      expect(resolved.workingDirectory).toBe('~/project');
      expect(new Set(resolved.mergeInherited)).toEqual(
        new Set(['docker', 'resource_class', 'working_directory']),
      );
      expect(resolved.mergeSource).toEqual({
        docker: 'base',
        resource_class: 'base',
        working_directory: 'base',
      });
    });

    it('does not report an explicit job-level field as merge-inherited', () => {
      const resolved = resolveJobExecutor(doc, 'build_large');
      expect(resolved.resourceClass).toBe('xlarge');
      expect(resolved.mergeInherited).not.toContain('resource_class');
      expect(new Set(resolved.mergeInherited)).toEqual(
        new Set(['docker', 'working_directory']),
      );
      expect(resolved.mergeSource?.resource_class).toBeUndefined();
    });

    it('reports multi-anchor precedence per field through mergeSource', () => {
      const resolved = resolveJobExecutor(doc, 'build_multi');
      expect(resolved.resourceClass).toBe('small');
      expect(resolved.workingDirectory).toBe('~/small-project');
      expect(resolved.image).toBe('cimg/node:20.10');
      expect(resolved.mergeSource).toEqual({
        resource_class: 'small',
        working_directory: 'small',
        docker: 'base',
      });
    });

    it('reports merge provenance from a named executor: entry, not just an inline job', () => {
      const resolved = resolveJobExecutor(doc, 'build_named_executor');
      expect(resolved.source).toBe('executor');
      expect(resolved.name).toBe('shared-executor');
      expect(resolved.image).toBe('cimg/node:20.10');
      expect(resolved.jobOverrides).toEqual([]);
      expect(new Set(resolved.mergeInherited)).toEqual(
        new Set(['docker', 'resource_class', 'working_directory']),
      );
      expect(resolved.mergeSource).toEqual({
        docker: 'base',
        resource_class: 'base',
        working_directory: 'base',
      });
    });

    it('a whole-value alias job resolves identically to its anchor, without merge provenance (no `<<` involved)', () => {
      const resolvedAlias = resolveJobExecutor(doc, 'build_alias');
      const resolvedBuild = resolveJobExecutor(doc, 'build');
      expect(resolvedAlias.image).toBe(resolvedBuild.image);
      expect(resolvedAlias.resourceClass).toBe(resolvedBuild.resourceClass);
      expect(resolvedAlias.mergeInherited).toBeUndefined();
    });

    it("still leaves untouched jobs' non-existent executor info alone (no regression for a plain job)", () => {
      // Sanity: a job with no merge key anywhere involved still resolves
      // exactly as before, with mergeInherited simply absent.
      const resolved = resolveJobExecutor(doc, 'build_large');
      expect(resolved.mergeInherited?.includes('nonexistent')).toBe(false);
    });
  });
});
