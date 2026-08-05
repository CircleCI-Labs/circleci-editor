import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { PaletteCommandSection } from './PaletteCommandSection';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('PaletteCommandSection', () => {
  it('shows an empty-state message for a doc with no commands:, or no doc at all', () => {
    render(
      <PaletteCommandSection
        doc={null}
        localJobNames={[]}
        onAddToJob={vi.fn<(jobName: string, commandName: string) => void>()}
      />,
    );
    expect(
      screen.getByText(/no reusable commands defined yet/i),
    ).toBeInTheDocument();
  });

  it("lists each of the config's own commands with its step/parameter counts", () => {
    const doc = parse(`commands:
  ci-setup:
    parameters:
      node-version:
        type: string
        default: "20"
    steps:
      - checkout
      - run: npm ci
jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
`);
    render(
      <PaletteCommandSection
        doc={doc}
        localJobNames={['build']}
        onAddToJob={vi.fn<(jobName: string, commandName: string) => void>()}
      />,
    );
    expect(screen.getByText('ci-setup')).toBeInTheDocument();
    expect(screen.getByText('2 steps')).toBeInTheDocument();
    expect(screen.getByText('1 parameter')).toBeInTheDocument();
  });

  it('adding a command to a job via the JobPicker calls onAddToJob with the command name', () => {
    const doc = parse(`commands:
  ci-setup:
    steps:
      - checkout
jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
`);
    const onAddToJob = vi.fn<(jobName: string, commandName: string) => void>();
    render(
      <PaletteCommandSection
        doc={doc}
        localJobNames={['build']}
        onAddToJob={onAddToJob}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAddToJob).toHaveBeenCalledWith('build', 'ci-setup');
  });
});
