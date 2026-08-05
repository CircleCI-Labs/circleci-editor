import { describe, expect, it } from 'vitest';

import { getIn, listKeys, parseConfig } from '~/lib/yaml/documentUtils';

import { extractImageTagToParameter } from './imageParameterMutations';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

const FIXTURE = `jobs:
  build:
    docker:
      - image: cimg/node:20.9
    resource_class: medium
    steps:
      - checkout
  test:
    docker:
      - image: cimg/node:20.9
    resource_class: large
    steps:
      - checkout
`;

describe('extractImageTagToParameter', () => {
  it('adds a pipeline parameter with the tag as its default and rewrites every location', () => {
    const doc = parse(FIXTURE);
    extractImageTagToParameter(
      doc,
      [
        ['jobs', 'build', 'docker', 0, 'image'],
        ['jobs', 'test', 'docker', 0, 'image'],
      ],
      'cimg/node:20.9',
      'node-image',
    );

    expect(listKeys(doc, ['parameters'])).toEqual(['node-image']);
    expect(getIn(doc, ['parameters', 'node-image'])).toEqual({
      type: 'string',
      default: 'cimg/node:20.9',
    });
    expect(getIn(doc, ['jobs', 'build', 'docker', 0, 'image'])).toBe(
      '<< pipeline.parameters.node-image >>',
    );
    expect(getIn(doc, ['jobs', 'test', 'docker', 0, 'image'])).toBe(
      '<< pipeline.parameters.node-image >>',
    );
    // Untouched otherwise.
    expect(getIn(doc, ['jobs', 'build', 'resource_class'])).toBe('medium');
    expect(getIn(doc, ['jobs', 'test', 'resource_class'])).toBe('large');
  });

  it('rejects fewer than two locations, leaving the document untouched', () => {
    const doc = parse(FIXTURE);
    const before = doc.toString();
    expect(() =>
      extractImageTagToParameter(
        doc,
        [['jobs', 'build', 'docker', 0, 'image']],
        'cimg/node:20.9',
        'node-image',
      ),
    ).toThrow(/at least two locations/);
    expect(doc.toString()).toBe(before);
  });

  it('re-verifies every location still holds the literal, refusing if one has since diverged', () => {
    const doc = parse(FIXTURE);
    const locations: (string | number)[][] = [
      ['jobs', 'build', 'docker', 0, 'image'],
      ['jobs', 'test', 'docker', 0, 'image'],
    ];
    // The document changed since detection ran.
    doc.setIn(['jobs', 'test', 'docker', 0, 'image'], 'cimg/node:22.0');
    const before = doc.toString();
    expect(() =>
      extractImageTagToParameter(
        doc,
        locations,
        'cimg/node:20.9',
        'node-image',
      ),
    ).toThrow(/no longer all pin the same image/);
    expect(doc.toString()).toBe(before);
  });

  it('rejects a parameter name that already exists, leaving the document untouched', () => {
    const doc = parse(`parameters:
  node-image:
    type: string
    default: cimg/node:18.0
${FIXTURE}`);
    const before = doc.toString();
    expect(() =>
      extractImageTagToParameter(
        doc,
        [
          ['jobs', 'build', 'docker', 0, 'image'],
          ['jobs', 'test', 'docker', 0, 'image'],
        ],
        'cimg/node:20.9',
        'node-image',
      ),
    ).toThrow(/already has a parameter/);
    expect(doc.toString()).toBe(before);
  });
});
