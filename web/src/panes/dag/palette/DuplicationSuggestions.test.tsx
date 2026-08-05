import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import { DuplicationSuggestions } from './DuplicationSuggestions';

const DUPLICATE_EXECUTOR_CONFIG = `jobs:
  build:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
  test:
    docker:
      - image: cimg/base:2024.01
    steps:
      - checkout
`;

const DUPLICATE_STEPS_CONFIG = `jobs:
  build:
    docker:
      - image: cimg/node:20.10
    steps:
      - checkout
      - run: npm ci
      - run: npm test
  test:
    docker:
      - image: cimg/python:3.12
    steps:
      - checkout
      - run: npm ci
      - run: npm test
`;

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

describe('DuplicationSuggestions', () => {
  it('renders nothing for a null doc, or a doc with no duplication', () => {
    const { container } = render(
      <DuplicationSuggestions
        doc={null}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );
    expect(container).toBeEmptyDOMElement();

    const { container: container2 } = render(
      <DuplicationSuggestions
        doc={parse(
          'jobs:\n  build:\n    docker:\n      - image: cimg/base:current\n    steps:\n      - checkout\n',
        )}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );
    expect(container2).toBeEmptyDOMElement();
  });

  it('offers to extract a shared inline executor, pre-filled with a free name, and calls back with the trimmed name on Extract', () => {
    const onExtractExecutor =
      vi.fn<(jobNames: string[], executorName: string) => void>();
    render(
      <DuplicationSuggestions
        doc={parse(DUPLICATE_EXECUTOR_CONFIG)}
        onExtractExecutor={onExtractExecutor}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );

    expect(
      screen.getByText(/2 jobs share an identical docker executor/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/build, test/)).toBeInTheDocument();

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('docker-executor');

    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    expect(onExtractExecutor).toHaveBeenCalledWith(
      ['build', 'test'],
      'docker-executor',
    );
  });

  it('offers to extract a shared steps sequence into a command', () => {
    const onExtractCommand =
      vi.fn<(jobNames: string[], commandName: string) => void>();
    render(
      <DuplicationSuggestions
        doc={parse(DUPLICATE_STEPS_CONFIG)}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={onExtractCommand}
      />,
    );

    expect(
      screen.getByText(/2 jobs run the exact same 3-step sequence/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    expect(onExtractCommand).toHaveBeenCalledWith(
      ['build', 'test'],
      'shared-steps',
    );
  });

  it('rejects a name that collides with an existing executor, disabling Extract', () => {
    const doc = parse(`executors:
  docker-executor:
    docker:
      - image: cimg/base:current
${DUPLICATE_EXECUTOR_CONFIG}`);
    render(
      <DuplicationSuggestions
        doc={doc}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );

    // The default name would have collided, so it must not be the bare
    // "docker-executor" -- generateUniqueName should have picked the next
    // free suffix instead.
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('docker-executor-2');
    expect(screen.getByRole('button', { name: 'Extract' })).not.toBeDisabled();

    fireEvent.change(input, { target: { value: 'docker-executor' } });
    expect(screen.getByRole('button', { name: 'Extract' })).toBeDisabled();
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
  });

  it('dismissing a suggestion removes its card without calling either extract callback', () => {
    render(
      <DuplicationSuggestions
        doc={parse(DUPLICATE_EXECUTOR_CONFIG)}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );
    expect(
      screen.getByText(/2 jobs share an identical docker executor/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss this suggestion' }),
    );
    expect(
      screen.queryByText(/2 jobs share an identical docker executor/i),
    ).not.toBeInTheDocument();
  });

  it('renders a docs link explaining the payoff, pointing at the reusable-config reference', () => {
    render(
      <DuplicationSuggestions
        doc={parse(DUPLICATE_EXECUTOR_CONFIG)}
        onExtractExecutor={vi.fn<
          (jobNames: string[], executorName: string) => void
        >()}
        onExtractCommand={vi.fn<
          (jobNames: string[], commandName: string) => void
        >()}
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('reusing-config'),
    );
    expect(link).toHaveAttribute('target', '_blank');
  });
});
