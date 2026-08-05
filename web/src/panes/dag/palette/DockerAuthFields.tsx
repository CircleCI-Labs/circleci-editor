/**
 * Registry-authentication fields for a custom Docker image (issue #77, part
 * 2). Exactly the two auth shapes the docker executor's schema actually
 * supports -- verified against the vendored official schema,
 * `internal/schema/schema.json`'s `docker.items.properties.auth` /
 * `.aws_auth` (also served at `GET /api/schema`, parsed by
 * `circleciSchema.ts`) -- never a `pull_policy` field, which does not exist
 * anywhere in that schema for a `docker:` image entry despite the user's
 * own framing of the issue mentioning one; see `DockerAuthSpec`'s doc
 * comment in `configMutations.ts` for the full citation.
 *
 * The one rule this component exists to *enforce*, not merely suggest: a
 * password or secret key must be an environment-variable reference
 * (`$SOME_ENV_VAR`, set via a CircleCI Project or Context), never the
 * literal secret written into the config. CircleCI's own docs
 * (circleci.com/docs/guides/execution-managed/private-images/) show exactly
 * this pattern -- e.g. `password: $DOCKERHUB_PASSWORD`. The
 * password/secret-key inputs below therefore only ever accept the
 * *variable name* (validated as a shell-identifier: letters/digits/
 * underscores, not starting with a digit); the leading "$" is rendered
 * statically beside the field and prepended by `resolveDockerAuthSpec`,
 * never typed by the user. There is no way to submit a literal secret
 * through this form -- the field that would hold one only ever produces a
 * `$NAME` reference.
 */
import { useId } from 'react';

import { DocsLink } from '~/design/components/DocsLink';
import { DOCS_LINKS } from '~/lib/docs/docsLinks';
import type { DockerAuthSpec } from '~/lib/mutations/configMutations';

const inputClassName =
  'w-full rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2 py-1.5 text-xs text-cc-text outline-none focus-visible:border-cc-accent';

/** A shell-style environment variable name -- what CircleCI project/context env vars are actually named. Deliberately rejects anything that looks like a pasted token/secret rather than a name (spaces, most punctuation, lowercase-with-symbols). */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type DockerAuthMode = 'none' | 'basic' | 'awsKeys' | 'awsOidc';

/** The form's own local state -- distinct from `DockerAuthSpec` because the two secret-shaped fields here are *environment variable names*, not yet the `$NAME` strings `DockerAuthSpec` carries; see `resolveDockerAuthSpec`. */
export interface DockerAuthFieldsValue {
  mode: DockerAuthMode;
  username: string;
  passwordEnvVar: string;
  accessKeyId: string;
  secretAccessKeyEnvVar: string;
  roleArn: string;
}

export const EMPTY_DOCKER_AUTH_FIELDS: DockerAuthFieldsValue = {
  mode: 'none',
  username: '',
  passwordEnvVar: '',
  accessKeyId: '',
  secretAccessKeyEnvVar: '',
  roleArn: '',
};

/**
 * Resolves `value` to the `DockerAuthSpec` `configMutations.ts` understands,
 * or `null` if the current mode's required fields aren't validly filled in
 * yet. The single source of truth both this component's own inline error
 * messages and `ConfigureJobDialog`'s submit-gating read from -- there is
 * exactly one place that decides "is this auth config ready to write."
 */
export function resolveDockerAuthSpec(
  value: DockerAuthFieldsValue,
): DockerAuthSpec | null {
  switch (value.mode) {
    case 'none':
      return { kind: 'none' };
    case 'basic':
      if (
        value.username.trim().length === 0 ||
        !ENV_VAR_NAME_PATTERN.test(value.passwordEnvVar.trim())
      )
        return null;
      return {
        kind: 'basic',
        username: value.username.trim(),
        password: `$${value.passwordEnvVar.trim()}`,
      };
    case 'awsKeys':
      if (
        value.accessKeyId.trim().length === 0 ||
        !ENV_VAR_NAME_PATTERN.test(value.secretAccessKeyEnvVar.trim())
      ) {
        return null;
      }
      return {
        kind: 'awsKeys',
        accessKeyId: value.accessKeyId.trim(),
        secretAccessKey: `$${value.secretAccessKeyEnvVar.trim()}`,
      };
    case 'awsOidc':
      return value.roleArn.trim().length === 0
        ? null
        : { kind: 'awsOidc', roleArn: value.roleArn.trim() };
  }
}

const MODE_OPTIONS: { value: DockerAuthMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Username & password' },
  { value: 'awsKeys', label: 'AWS ECR -- access keys' },
  { value: 'awsOidc', label: 'AWS ECR -- OIDC role' },
];

export function DockerAuthFields({
  value,
  onChange,
}: {
  value: DockerAuthFieldsValue;
  onChange: (value: DockerAuthFieldsValue) => void;
}) {
  const modeId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const accessKeyFieldId = useId();
  const secretKeyFieldId = useId();
  const roleArnId = useId();

  const passwordValid =
    value.mode !== 'basic' ||
    ENV_VAR_NAME_PATTERN.test(value.passwordEnvVar.trim());
  const secretValid =
    value.mode !== 'awsKeys' ||
    ENV_VAR_NAME_PATTERN.test(value.secretAccessKeyEnvVar.trim());

  return (
    <div className="mb-3 rounded-md border border-cc-border-strong bg-cc-panel-raised p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label
          htmlFor={modeId}
          className="text-2xs font-medium text-cc-text-muted"
        >
          Registry authentication
        </label>
        <DocsLink {...DOCS_LINKS.images.private} className="text-2xs" />
      </div>

      <select
        id={modeId}
        value={value.mode}
        onChange={(event) =>
          onChange({ ...value, mode: event.target.value as DockerAuthMode })
        }
        className={`${inputClassName} mb-2 font-mono`}
      >
        {MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {value.mode === 'basic' ? (
        <>
          <label
            htmlFor={usernameId}
            className="mb-1 block text-2xs text-cc-text-muted"
          >
            Username
          </label>
          <input
            id={usernameId}
            value={value.username}
            onChange={(event) =>
              onChange({ ...value, username: event.target.value })
            }
            placeholder="mydockerhub-user"
            className={`${inputClassName} mb-2 font-mono`}
          />
          <label
            htmlFor={passwordId}
            className="mb-1 block text-2xs text-cc-text-muted"
          >
            Password/token environment variable
          </label>
          <div className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="font-mono text-xs text-cc-text-faint"
            >
              $
            </span>
            <input
              id={passwordId}
              value={value.passwordEnvVar}
              onChange={(event) =>
                onChange({ ...value, passwordEnvVar: event.target.value })
              }
              placeholder="DOCKERHUB_PASSWORD"
              aria-invalid={!passwordValid}
              className={`${inputClassName} font-mono`}
            />
          </div>
          {!passwordValid ? (
            <p className="mt-1 text-2xs text-cc-danger">
              Enter the name of a Project/Context environment variable (letters,
              digits, underscores -- not starting with a digit) -- never the
              secret itself.
            </p>
          ) : (
            <p className="mt-1 text-2xs text-cc-text-faint">
              Set this variable's real value in the project's Environment
              Variables or a Context -- CircleCI substitutes it at run time. The
              config itself only ever gets the name.
            </p>
          )}
        </>
      ) : null}

      {value.mode === 'awsKeys' ? (
        <>
          <label
            htmlFor={accessKeyFieldId}
            className="mb-1 block text-2xs text-cc-text-muted"
          >
            AWS access key ID
          </label>
          <input
            id={accessKeyFieldId}
            value={value.accessKeyId}
            onChange={(event) =>
              onChange({ ...value, accessKeyId: event.target.value })
            }
            placeholder="AKIA..."
            className={`${inputClassName} mb-2 font-mono`}
          />
          <label
            htmlFor={secretKeyFieldId}
            className="mb-1 block text-2xs text-cc-text-muted"
          >
            Secret access key environment variable
          </label>
          <div className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="font-mono text-xs text-cc-text-faint"
            >
              $
            </span>
            <input
              id={secretKeyFieldId}
              value={value.secretAccessKeyEnvVar}
              onChange={(event) =>
                onChange({
                  ...value,
                  secretAccessKeyEnvVar: event.target.value,
                })
              }
              placeholder="ECR_AWS_SECRET_ACCESS_KEY"
              aria-invalid={!secretValid}
              className={`${inputClassName} font-mono`}
            />
          </div>
          {!secretValid ? (
            <p className="mt-1 text-2xs text-cc-danger">
              Enter the name of a Project/Context environment variable -- never
              the secret itself.
            </p>
          ) : null}
        </>
      ) : null}

      {value.mode === 'awsOidc' ? (
        <>
          <label
            htmlFor={roleArnId}
            className="mb-1 block text-2xs text-cc-text-muted"
          >
            IAM role ARN
          </label>
          <input
            id={roleArnId}
            value={value.roleArn}
            onChange={(event) =>
              onChange({ ...value, roleArn: event.target.value })
            }
            placeholder="arn:aws:iam::123456789012:role/ecr-pull"
            className={`${inputClassName} font-mono`}
          />
          <p className="mt-1 text-2xs text-cc-text-faint">
            No secret to store at all -- CircleCI's OIDC identity assumes this
            role at run time.
          </p>
        </>
      ) : null}

      {value.mode !== 'none' ? (
        <p className="mt-2 text-2xs text-cc-text-faint">
          Secrets are never written into the config -- only an environment
          variable name, substituted by CircleCI at run time.
        </p>
      ) : null}
    </div>
  );
}
