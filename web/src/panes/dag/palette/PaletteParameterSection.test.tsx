import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from 'yaml';

import { FIXTURE_RAW_SCHEMA } from '~/lib/schema/testFixtures';
import { __resetCircleciSchemaCacheForTests } from '~/lib/schema/useCircleciSchema';
import { cloneDocument, getIn, parseConfig } from '~/lib/yaml/documentUtils';

import { PaletteParameterSection } from './PaletteParameterSection';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

/**
 * `useCircleciSchema` fetches `/api/schema` once per app session, and the
 * parameter type control is driven by it (issue #250) -- so every test here
 * stubs the fetch with the shared schema fixture and resets the module-level
 * cache first, the same pattern `Inspector.test.tsx` uses.
 */
function stubSchemaFetch(body: unknown = FIXTURE_RAW_SCHEMA) {
  __resetCircleciSchemaCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

/** Applies a mutation to a clone the way the store does, so a test can assert on the result without a store. */
function mutateInto(doc: Document, applied: { doc: Document | null }) {
  return (fn: (d: Document) => void) => {
    const clone = cloneDocument(doc);
    fn(clone);
    applied.doc = clone;
  };
}

const CONFIG = `parameters:
  deploy-env:
    type: enum
    enum: ["staging", "prod"]
    default: "staging"
  run-slow-tests:
    type: boolean
jobs:
  build:
    parameters:
      target:
        type: string
        default: debug
    docker:
      - image: cimg/base:current
    steps:
      - checkout
`;

beforeEach(() => {
  stubSchemaFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaletteParameterSection', () => {
  it('shows an empty-state message for a doc with no parameters:, or no doc at all', () => {
    render(<PaletteParameterSection doc={null} mutate={() => {}} />);
    expect(screen.getByText(/no config loaded/i)).toBeInTheDocument();
  });

  it("lists each of the config's own pipeline parameters as editable fields", () => {
    render(<PaletteParameterSection doc={parse(CONFIG)} mutate={() => {}} />);

    // The name is now an input holding the name, not a static label -- which is
    // the whole point of issue #250.
    expect(screen.getByLabelText('Name of deploy-env')).toHaveValue(
      'deploy-env',
    );
    expect(screen.getByLabelText('Type of deploy-env')).toHaveValue('enum');
    expect(screen.getByLabelText('Default of deploy-env')).toHaveValue(
      'staging',
    );
    expect(screen.getByLabelText('Name of run-slow-tests')).toHaveValue(
      'run-slow-tests',
    );
    expect(screen.getByLabelText('Type of run-slow-tests')).toHaveValue(
      'boolean',
    );
  });

  it('says it is editable but not a drag source, and shows the reference syntax', () => {
    render(<PaletteParameterSection doc={parse(CONFIG)} mutate={() => {}} />);
    expect(screen.getByText(/not draggable/i)).toBeInTheDocument();
    expect(
      screen.getByText('<< pipeline.parameters.deploy-env >>'),
    ).toBeInTheDocument();
  });

  it('points at the inspector for a job that declares its own parameters', () => {
    render(<PaletteParameterSection doc={parse(CONFIG)} mutate={() => {}} />);
    expect(screen.getByText(/build \(1\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/inspector.s Declared parameters section/i),
    ).toBeInTheDocument();
  });

  it('offers only the four pipeline parameter types the schema allows, and no others', async () => {
    render(<PaletteParameterSection doc={parse(CONFIG)} mutate={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText('Type of run-slow-tests'),
      ).toBeInTheDocument();
    });
    const select = screen.getByLabelText<HTMLSelectElement>(
      'Type of run-slow-tests',
    );
    await waitFor(() => {
      expect([...select.options].map((option) => option.value).sort()).toEqual([
        'boolean',
        'enum',
        'integer',
        'string',
      ]);
    });
    // `steps`/`executor`/`env_var_name` are element-only; offering them here
    // would offer a config that cannot compile.
    expect([...select.options].map((option) => option.value)).not.toContain(
      'steps',
    );
  });

  it('adds a parameter with exactly the type chosen and nothing else', async () => {
    const user = userEvent.setup();
    const doc = parse(CONFIG);
    const applied: { doc: Document | null } = { doc: null };
    render(
      <PaletteParameterSection doc={doc} mutate={mutateInto(doc, applied)} />,
    );
    await waitFor(() => {
      expect(
        [
          ...screen.getByLabelText<HTMLSelectElement>(
            'Type of the new pipeline parameter',
          ).options,
        ].length,
      ).toBeGreaterThan(1);
    });

    await user.type(
      screen.getByLabelText('Name of the new pipeline parameter'),
      'image-tag',
    );
    await user.selectOptions(
      screen.getByLabelText('Type of the new pipeline parameter'),
      'string',
    );
    await act(async () => {
      await user.click(
        screen.getByRole('button', { name: 'Add pipeline parameter' }),
      );
    });

    expect(applied.doc).not.toBeNull();
    // Exactly `type:`. No invented default, no description, no enum.
    expect(getIn(applied.doc!, ['parameters', 'image-tag'])).toEqual({
      type: 'string',
    });
  });

  it('will not add a parameter until a type is chosen', async () => {
    const user = userEvent.setup();
    const doc = parse(CONFIG);
    const applied: { doc: Document | null } = { doc: null };
    render(
      <PaletteParameterSection doc={doc} mutate={mutateInto(doc, applied)} />,
    );

    await user.type(
      screen.getByLabelText('Name of the new pipeline parameter'),
      'image-tag',
    );
    await user.click(
      screen.getByRole('button', { name: 'Add pipeline parameter' }),
    );

    expect(screen.getByText('Choose a type.')).toBeInTheDocument();
    expect(applied.doc).toBeNull();
  });

  it('warns that a pipeline parameter with no default needs one, without writing one', () => {
    render(<PaletteParameterSection doc={parse(CONFIG)} mutate={() => {}} />);
    // `run-slow-tests` has no `default:`.
    expect(
      screen.getByText(/a pipeline parameter needs a/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText<HTMLSelectElement>('Default of run-slow-tests'),
    ).toHaveValue('__unset__');
  });
});
