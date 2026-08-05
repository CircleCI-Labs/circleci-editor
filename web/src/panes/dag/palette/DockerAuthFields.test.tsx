import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DockerAuthFields,
  EMPTY_DOCKER_AUTH_FIELDS,
  resolveDockerAuthSpec,
} from './DockerAuthFields';

describe('resolveDockerAuthSpec', () => {
  it('resolves "none" to { kind: "none" }', () => {
    expect(resolveDockerAuthSpec(EMPTY_DOCKER_AUTH_FIELDS)).toEqual({
      kind: 'none',
    });
  });

  it('resolves "basic" to a $-prefixed password reference, never the raw field text', () => {
    const spec = resolveDockerAuthSpec({
      ...EMPTY_DOCKER_AUTH_FIELDS,
      mode: 'basic',
      username: 'mydockerhub-user',
      passwordEnvVar: 'DOCKERHUB_PASSWORD',
    });
    expect(spec).toEqual({
      kind: 'basic',
      username: 'mydockerhub-user',
      password: '$DOCKERHUB_PASSWORD',
    });
  });

  it('returns null for "basic" when the username is blank', () => {
    expect(
      resolveDockerAuthSpec({
        ...EMPTY_DOCKER_AUTH_FIELDS,
        mode: 'basic',
        passwordEnvVar: 'DOCKERHUB_PASSWORD',
      }),
    ).toBeNull();
  });

  it('returns null for "basic" when the password field does not look like an env var name', () => {
    for (const notAName of [
      'my secret pw',
      'p@ssw0rd!',
      '1STARTSWITHDIGIT',
      '',
    ]) {
      expect(
        resolveDockerAuthSpec({
          ...EMPTY_DOCKER_AUTH_FIELDS,
          mode: 'basic',
          username: 'u',
          passwordEnvVar: notAName,
        }),
      ).toBeNull();
    }
  });

  it('resolves "awsKeys" to a $-prefixed secret reference', () => {
    const spec = resolveDockerAuthSpec({
      ...EMPTY_DOCKER_AUTH_FIELDS,
      mode: 'awsKeys',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKeyEnvVar: 'ECR_AWS_SECRET_ACCESS_KEY',
    });
    expect(spec).toEqual({
      kind: 'awsKeys',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: '$ECR_AWS_SECRET_ACCESS_KEY',
    });
  });

  it('returns null for "awsKeys" when the secret field does not look like an env var name', () => {
    expect(
      resolveDockerAuthSpec({
        ...EMPTY_DOCKER_AUTH_FIELDS,
        mode: 'awsKeys',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKeyEnvVar: 'pasted secret value',
      }),
    ).toBeNull();
  });

  it('resolves "awsOidc" to a role ARN with no secret at all', () => {
    const spec = resolveDockerAuthSpec({
      ...EMPTY_DOCKER_AUTH_FIELDS,
      mode: 'awsOidc',
      roleArn: 'arn:aws:iam::123456789012:role/ecr-pull',
    });
    expect(spec).toEqual({
      kind: 'awsOidc',
      roleArn: 'arn:aws:iam::123456789012:role/ecr-pull',
    });
  });

  it('returns null for "awsOidc" when the role ARN is blank', () => {
    expect(
      resolveDockerAuthSpec({ ...EMPTY_DOCKER_AUTH_FIELDS, mode: 'awsOidc' }),
    ).toBeNull();
  });
});

describe('DockerAuthFields', () => {
  it('shows only the "None" mode\'s fields (none) by default', () => {
    render(
      <DockerAuthFields
        value={EMPTY_DOCKER_AUTH_FIELDS}
        onChange={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/access key id/i)).not.toBeInTheDocument();
  });

  it('switching to "Username & password" reveals those fields and reports changes', () => {
    const onChange = vi.fn<() => void>();
    render(
      <DockerAuthFields value={EMPTY_DOCKER_AUTH_FIELDS} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText(/registry authentication/i), {
      target: { value: 'basic' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'basic' }),
    );
  });

  it('shows a validation error for a password field that does not look like an env var name', () => {
    render(
      <DockerAuthFields
        value={{
          ...EMPTY_DOCKER_AUTH_FIELDS,
          mode: 'basic',
          username: 'u',
          passwordEnvVar: 'not a name!',
        }}
        onChange={vi.fn<() => void>()}
      />,
    );
    expect(screen.getByText(/never the secret itself/i)).toBeInTheDocument();
  });

  it('renders a doc link to the private-images documentation', () => {
    render(
      <DockerAuthFields
        value={EMPTY_DOCKER_AUTH_FIELDS}
        onChange={vi.fn<() => void>()}
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link.getAttribute('href')).toContain('circleci.com');
  });
});
