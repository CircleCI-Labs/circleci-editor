import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ConfigureJobDialog,
  type PendingExecutorItem,
} from './ConfigureJobDialog';
import { findBuiltinExecutor } from './paletteExecutors';

const DOCKER_ITEM: PendingExecutorItem = {
  source: 'builtin',
  def: findBuiltinExecutor('docker')!,
  defaultJobName: 'new-job',
};

const LOCAL_ITEM: PendingExecutorItem = {
  source: 'local',
  executorName: 'py-executor',
  defaultJobName: 'new-job',
};

describe('ConfigureJobDialog', () => {
  it('renders nothing when item is null', () => {
    render(
      <ConfigureJobDialog
        item={null}
        existingJobNames={[]}
        existingExecutorNames={[]}
        onSubmit={vi.fn<() => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pre-fills the job name and built-in defaults, and submits them on "Create job"', () => {
    const onSubmit = vi.fn<(values: unknown) => void>();
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={['build']}
        existingExecutorNames={[]}
        onSubmit={onSubmit}
        onCancel={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByLabelText(/job name/i)).toHaveValue('new-job');
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      jobName: 'new-job',
      image: 'cimg/base:current',
      resourceClass: 'medium',
      saveAsExecutorName: undefined,
    });
  });

  it('disables "Create job" and shows an error for a job name that collides with an existing job', () => {
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={['new-job']}
        existingExecutorNames={[]}
        onSubmit={vi.fn<() => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );

    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
  });

  it('disables "Create job" for a job name with illegal characters', () => {
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={[]}
        existingExecutorNames={[]}
        onSubmit={vi.fn<() => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/job name/i), {
      target: { value: 'has a space' },
    });
    expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
  });

  it('checking "Save as a reusable executor" reveals the executor-name field and includes it in the submitted values', () => {
    const onSubmit = vi.fn<(values: unknown) => void>();
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={[]}
        existingExecutorNames={['other-executor']}
        onSubmit={onSubmit}
        onCancel={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByLabelText(/save as a reusable executor/i));
    const executorNameInput = screen.getByLabelText(/^executor name$/i);
    expect(executorNameInput).toHaveValue('new-job-executor');

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'new-job',
        saveAsExecutorName: 'new-job-executor',
      }),
    );
  });

  it('disables "Create job" when the reusable-executor name collides with an existing one', () => {
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={[]}
        existingExecutorNames={['new-job-executor']}
        onSubmit={vi.fn<() => void>()}
        onCancel={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByLabelText(/save as a reusable executor/i));
    expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
  });

  it('a "local" item shows no image/resource-class fields and submits just the job name', () => {
    const onSubmit = vi.fn<(values: unknown) => void>();
    render(
      <ConfigureJobDialog
        item={LOCAL_ITEM}
        existingJobNames={[]}
        existingExecutorNames={[]}
        onSubmit={onSubmit}
        onCancel={vi.fn<() => void>()}
      />,
    );

    expect(screen.queryByLabelText(/^image$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/uses the existing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      jobName: 'new-job',
      image: undefined,
      resourceClass: undefined,
      saveAsExecutorName: undefined,
    });
  });

  it('selecting "Other..." for resource class reveals a custom text field, used in the submitted value', () => {
    const onSubmit = vi.fn<(values: unknown) => void>();
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={[]}
        existingExecutorNames={[]}
        onSubmit={onSubmit}
        onCancel={vi.fn<() => void>()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/resource class/i), {
      target: { value: '__custom__' },
    });
    fireEvent.change(screen.getByLabelText(/custom resource class/i), {
      target: { value: 'my.custom.class' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceClass: 'my.custom.class' }),
    );
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn<() => void>();
    render(
      <ConfigureJobDialog
        item={DOCKER_ITEM}
        existingJobNames={[]}
        existingExecutorNames={[]}
        onSubmit={vi.fn<() => void>()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
