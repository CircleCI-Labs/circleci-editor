import { describe, expect, it } from 'vitest';

import type { GraphEdge } from '~/lib/graph/buildGraph';

import {
  generateUniqueJobName,
  getAncestorChain,
  isEditableTarget,
  wouldCreateCycle,
} from './dagUtils';

function edge(source: string, target: string): GraphEdge {
  return { id: `${source}->${target}`, source, target };
}

describe('wouldCreateCycle', () => {
  it('rejects a self-loop', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true);
  });

  it('allows adding an edge to an empty graph', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });

  it('allows extending a simple chain', () => {
    const edges = [edge('a', 'b')];
    expect(wouldCreateCycle(edges, 'b', 'c')).toBe(false);
  });

  it('rejects an edge that would close a two-node cycle', () => {
    // a -> b already exists (b requires a); adding b -> a would create a <-> b.
    const edges = [edge('a', 'b')];
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true);
  });

  it('rejects an edge that would close a longer cycle', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    // c -> a would close a -> b -> c -> a.
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true);
  });

  it('allows a fan-in that does not close any cycle', () => {
    const edges = [edge('a', 'c'), edge('b', 'c')];
    expect(wouldCreateCycle(edges, 'a', 'd')).toBe(false);
  });
});

describe('getAncestorChain', () => {
  it('includes just the node itself when it has no dependencies', () => {
    expect(getAncestorChain([], 'a')).toEqual(new Set(['a']));
  });

  it('walks a simple chain back to its root', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(getAncestorChain(edges, 'c')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not include descendants, only ancestors', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(getAncestorChain(edges, 'a')).toEqual(new Set(['a']));
  });

  it('collects every branch of a fan-in', () => {
    const edges = [edge('a', 'c'), edge('b', 'c')];
    expect(getAncestorChain(edges, 'c')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('excludes an unrelated sibling subgraph', () => {
    const edges = [edge('a', 'b'), edge('x', 'y')];
    expect(getAncestorChain(edges, 'b')).toEqual(new Set(['a', 'b']));
  });

  it('terminates on a cycle instead of looping forever', () => {
    const edges = [edge('a', 'b'), edge('b', 'a')];
    expect(getAncestorChain(edges, 'a')).toEqual(new Set(['a', 'b']));
  });
});

describe('generateUniqueJobName', () => {
  it('returns "new-job" when it is not taken', () => {
    expect(generateUniqueJobName([])).toBe('new-job');
    expect(generateUniqueJobName(['build', 'test'])).toBe('new-job');
  });

  it('returns "new-job-2" when "new-job" is taken', () => {
    expect(generateUniqueJobName(['new-job'])).toBe('new-job-2');
  });

  it('skips past every already-taken numbered variant', () => {
    expect(generateUniqueJobName(['new-job', 'new-job-2', 'new-job-3'])).toBe(
      'new-job-4',
    );
  });
});

describe('isEditableTarget', () => {
  it('is true for an input, textarea, or select element', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    // jsdom doesn't implement `contentEditable`/`isContentEditable`, so this
    // stubs the getter directly rather than setting the attribute.
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it('is false for a plain element, null, or a non-Element event target', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
