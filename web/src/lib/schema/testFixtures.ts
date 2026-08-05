/**
 * Test-only fixtures shared by circleciSchema.test.ts and completion.test.ts.
 * Not itself a test file (no `.test.` in the name) so vitest doesn't try to
 * collect it, but it lives beside them rather than under a top-level
 * `test/` directory since nothing outside `~/lib/schema` should import it.
 */

/**
 * A hand-built stand-in for the real upstream schema.json (verified against
 * circleci-yaml-language-server 0.36.1 -- see circleciSchema.ts's doc
 * comment), preserving every `oneOf` index and `if`/`then`/`else` nesting
 * level each extractor in circleciSchema.ts actually navigates, so tests
 * against it exercise the same paths the real schema would. Deliberately
 * much smaller than the real ~194KB file, and deliberately *not* the real
 * file itself: these tests are about this module's navigation logic and
 * about the completion source built on top of it, not about pinning
 * today's upstream schema shape (a "does the real file still parse" check
 * belongs server-side, in internal/schema, not here).
 */
export const FIXTURE_RAW_SCHEMA = {
  properties: {
    version: { description: 'Config version' },
    orbs: { description: 'Reusable packages of config' },
    jobs: { markdownDescription: 'Collections of steps' },
    workflows: {
      description: 'Orchestrates jobs',
      additionalProperties: {
        properties: {
          triggers: {},
          max_auto_reruns: {},
          when: {},
          unless: {},
          jobs: { description: 'The jobs to run' },
        },
      },
    },
    executors: {
      additionalProperties: {
        oneOf: [
          {
            properties: {
              description: {},
              macos: {},
              resource_class: {
                oneOf: [
                  {
                    enum: ['small', 'medium', 'medium+', 'large', 'xlarge'],
                    default: 'medium',
                  },
                ],
              },
              docker: {},
              working_directory: {},
              machine: {},
              environment: {},
              shell: {},
              parameters: {},
            },
          },
        ],
      },
    },
    commands: { description: 'Reusable command sequences' },
    // The *pipeline* parameter block. Its type enum is deliberately the
    // shorter, four-value one the real schema uses here -- see
    // `pipelineParameterTypeValues`, and the element block further down for
    // the seven-value contrast the tests assert on.
    parameters: {
      additionalProperties: {
        properties: {
          type: { enum: ['boolean', 'string', 'enum', 'integer'] },
          default: {},
          description: {},
          enum: {},
        },
        required: ['default', 'type'],
      },
    },
  },
  definitions: {
    jobInvocation: {
      oneOf: [
        {
          type: 'string',
          description: 'A reference to a job defined elsewhere',
        },
        {
          properties: {
            type: {
              enum: ['build', 'release', 'lock', 'unlock', 'approval', 'no-op'],
            },
          },
          else: {
            else: {
              else: {
                // eslint-disable-next-line unicorn/no-thenable -- this is JSON Schema's `then` keyword (if/then/else), not a thenable.
                then: {
                  properties: {
                    description: {},
                    type: {},
                    parallelism: {},
                    macos: {},
                    resource_class: {},
                    docker: {
                      items: {
                        properties: {
                          image: {},
                          name: {},
                          entrypoint: {},
                          command: {},
                          user: {},
                          environment: {},
                        },
                      },
                    },
                    steps: { markdownDescription: "The job's steps" },
                    working_directory: {},
                    retention: {},
                    circleci_ip_ranges: {},
                    machine: {},
                    environment: {},
                    executor: {},
                    shell: {},
                    // An *element* parameter block: three more types than the
                    // pipeline one above.
                    parameters: {
                      additionalProperties: {
                        properties: {
                          type: {
                            enum: [
                              'boolean',
                              'string',
                              'steps',
                              'enum',
                              'executor',
                              'integer',
                              'env_var_name',
                            ],
                          },
                          default: {},
                          description: {},
                          enum: {},
                        },
                        required: ['type'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
    workflowJobInvocation: {
      oneOf: [
        { type: 'string' },
        {
          additionalProperties: {
            properties: {
              requires: { markdownDescription: 'Jobs this one depends on' },
              filters: {},
              context: {},
              type: {},
              'pre-steps': {},
              'post-steps': {},
              matrix: {},
              'serial-group': {},
              'override-with': {},
            },
          },
        },
      ],
    },
    // Field-level detail (issue #48's `stepFieldSchemas`) is only filled in
    // for the keywords `circleciSchema.test.ts`'s own suite actually
    // exercises -- `run` (shorthand + required `command`, an `environment`
    // `$ref`, a `when` enum, a `boolean` background), `checkout` (a
    // `method` enum, no required fields), `save_cache` (a required `array`
    // `paths`), and `restore_cache` (two object `oneOf` branches, `key` vs
    // `keys`, that `mergeStepFields` has to combine) -- between them these
    // cover every branch shape `extractStepFieldSchemas` has to navigate.
    // The rest stay as bare markers (`{}`) purely so `stepNames` still
    // finds all ten keywords; real field data for those lives only in the
    // vendored `internal/schema/schema.json` this fixture deliberately
    // doesn't pin (see this file's own doc comment).
    step: {
      oneOf: [
        {
          type: 'string',
          description: 'A reference to a command or built-in step',
        },
        {
          properties: {
            run: {
              oneOf: [
                { type: 'string' },
                {
                  properties: {
                    command: {
                      type: 'string',
                      markdownDescription: 'Command to run via the shell',
                    },
                    name: { type: 'string' },
                    shell: { type: 'string' },
                    environment: { $ref: '#/definitions/environment' },
                    background: { type: 'boolean', default: false },
                    working_directory: { type: 'string' },
                    no_output_timeout: { type: 'string', default: '10m' },
                    when: { enum: ['always', 'on_success', 'on_fail'] },
                  },
                  required: ['command'],
                },
              ],
            },
            checkout: {
              oneOf: [
                { type: 'string', enum: ['checkout'] },
                {
                  properties: {
                    path: { type: 'string' },
                    method: {
                      type: 'string',
                      enum: ['blobless', 'full', 'shallow'],
                    },
                    depth: { type: 'integer', minimum: 1 },
                  },
                },
              ],
            },
            setup_remote_docker: {},
            save_cache: {
              type: 'object',
              required: ['paths', 'key'],
              properties: {
                paths: { type: 'array', items: { type: 'string' } },
                key: { type: 'string' },
                name: { type: 'string' },
                when: { enum: ['always', 'on_success', 'on_fail'] },
              },
            },
            restore_cache: {
              oneOf: [
                {
                  type: 'object',
                  required: ['key'],
                  properties: {
                    key: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  required: ['keys'],
                  properties: {
                    keys: { type: 'array', items: { type: 'string' } },
                    name: { type: 'string' },
                  },
                },
              ],
            },
            store_artifacts: {},
            store_test_results: {},
            persist_to_workspace: {},
            attach_workspace: {},
            add_ssh_keys: {},
          },
        },
      ],
    },
  },
};

/** Generates a syntactically valid, realistically-shaped CircleCI config of roughly `jobCount` jobs, for performance measurement against a large document. */
export function generateLargeConfig(jobCount: number): string {
  const lines: string[] = [
    'version: 2.1',
    '',
    'orbs:',
    '  node: circleci/node@5.2.0',
    '',
    'jobs:',
  ];

  for (let i = 0; i < jobCount; i++) {
    lines.push(
      `  job-${i}:`,
      '    docker:',
      '      - image: cimg/node:20.1',
      '        environment:',
      `          JOB_INDEX: "${i}"`,
      '    resource_class: medium',
      '    working_directory: ~/project',
      '    steps:',
      '      - checkout',
      '      - node/install-packages',
      '      - run:',
      '          name: build',
      '          command: |',
      `            echo building job ${i}`,
      '            npm run build',
      '      - save_cache:',
      `          key: job-${i}-cache`,
      '          paths:',
      '            - node_modules',
    );
  }

  lines.push('', 'workflows:', '  main:', '    jobs:');
  for (let i = 0; i < jobCount; i++) {
    if (i === 0) {
      lines.push(`      - job-${i}`);
    } else {
      lines.push(
        `      - job-${i}:`,
        `          requires:`,
        `            - job-${i - 1}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
