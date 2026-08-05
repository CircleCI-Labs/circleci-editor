import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isInsideOpaqueScalar, resolveCursorContext } from './yamlPath';

/** Splits `template` at its `‸` cursor marker (chosen because it can't appear in real YAML), returning the marker-free text and the offset it sat at. */
function withCursor(template: string): { text: string; pos: number } {
  const pos = template.indexOf('‸');
  if (pos === -1)
    throw new Error('withCursor: template is missing its ‸ marker');
  return { text: template.slice(0, pos) + template.slice(pos + 1), pos };
}

describe('resolveCursorContext', () => {
  it('resolves a fresh key at the document root', () => {
    const { text, pos } = withCursor('ver‸');
    const ctx = resolveCursorContext(text, pos);
    expect(ctx).toEqual({
      containerPath: [],
      slot: 'key',
      key: undefined,
      from: 0,
      prefix: 'ver',
    });
  });

  it('resolves a fresh key on a wholly empty document', () => {
    const { text, pos } = withCursor('‸');
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual([]);
    expect(ctx?.slot).toBe('key');
    expect(ctx?.prefix).toBe('');
  });

  it('resolves a fresh key inside a job body', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker:\n      - image: cimg/node:20.1\n    re‸\n    steps:\n      - checkout\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual(['jobs', 'build']);
    expect(ctx?.slot).toBe('key');
    expect(ctx?.prefix).toBe('re');
  });

  it('resolves a value being typed for an existing key', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    resource_class: med‸\n    steps:\n      - checkout\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual(['jobs', 'build']);
    expect(ctx).toMatchObject({
      slot: 'value',
      key: 'resource_class',
      prefix: 'med',
    });
  });

  it('resolves a value being typed with nothing typed yet', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    resource_class: ‸\n    steps:\n      - checkout\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx).toMatchObject({
      slot: 'value',
      key: 'resource_class',
      prefix: '',
    });
  });

  it('resolves a fresh sequence-item key inside a steps list', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    steps:\n      - che‸\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual(['jobs', 'build', 'steps', 0]);
    expect(ctx?.slot).toBe('key');
    expect(ctx?.prefix).toBe('che');
  });

  it('resolves the second step in a list at index 1', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    steps:\n      - checkout\n      - ru‸\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual(['jobs', 'build', 'steps', 1]);
  });

  it('resolves a fresh key inside a workflow job invocation options map', () => {
    const { text, pos } = withCursor(
      'workflows:\n  test:\n    jobs:\n      - build\n      - deploy:\n          req‸\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual([
      'workflows',
      'test',
      'jobs',
      1,
      'deploy',
    ]);
    expect(ctx?.slot).toBe('key');
    expect(ctx?.prefix).toBe('req');
  });

  it('resolves a fresh item at the top of a workflow jobs list', () => {
    const { text, pos } = withCursor(
      'workflows:\n  test:\n    jobs:\n      - build\n      - depl‸\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual(['workflows', 'test', 'jobs', 1]);
  });

  it('resolves a fresh item nested inside a requires list', () => {
    const { text, pos } = withCursor(
      'workflows:\n  test:\n    jobs:\n      - build\n      - deploy:\n          requires:\n            - buil‸\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.containerPath).toEqual([
      'workflows',
      'test',
      'jobs',
      1,
      'deploy',
      'requires',
      0,
    ]);
    expect(ctx?.prefix).toBe('buil');
  });

  it('returns null when the cursor is inside a flow mapping', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    docker: [{ image: cimg/node, na‸ }]\n',
    );
    expect(resolveCursorContext(text, pos)).toBeNull();
  });

  it('returns null when the line is entirely a comment', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    # a comment, still being typ‸\n',
    );
    expect(resolveCursorContext(text, pos)).toBeNull();
  });

  it('returns null once the cursor is past a trailing comment on a key line', () => {
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    resource_class: medium # note‸\n',
    );
    expect(resolveCursorContext(text, pos)).toBeNull();
  });

  it('does not treat a comment before the cursor as suppressing an earlier key', () => {
    // The comment starts after the colon on a *different*, later line; this
    // line's own key is still being typed and must resolve normally.
    const { text, pos } = withCursor(
      'jobs:\n  build:\n    re‸\n    resource_class: medium # ok\n',
    );
    const ctx = resolveCursorContext(text, pos);
    expect(ctx?.slot).toBe('key');
  });
});

describe('isInsideOpaqueScalar', () => {
  it('is false for a position inside plain YAML structure', () => {
    const text = 'jobs:\n  build:\n    resource_class: medium\n';
    const doc = parseDocument(text, { merge: true });
    expect(isInsideOpaqueScalar(doc, text.indexOf('medium'))).toBe(false);
  });

  it('is true inside a double-quoted scalar', () => {
    const text =
      'jobs:\n  build:\n    docker:\n      - image: "cimg/node:20.1"\n';
    const doc = parseDocument(text, { merge: true });
    expect(isInsideOpaqueScalar(doc, text.indexOf('20.1'))).toBe(true);
  });

  it('is true inside a block-literal scalar (a run command body)', () => {
    const text =
      'jobs:\n  build:\n    steps:\n      - run: |\n          echo hello\n          echo world\n';
    const doc = parseDocument(text, { merge: true });
    expect(isInsideOpaqueScalar(doc, text.indexOf('world'))).toBe(true);
  });

  it('is false for the key preceding a quoted scalar value', () => {
    const text = 'jobs:\n  build:\n    docker:\n      - image: "cimg/node"\n';
    const doc = parseDocument(text, { merge: true });
    expect(isInsideOpaqueScalar(doc, text.indexOf('image'))).toBe(false);
  });
});
