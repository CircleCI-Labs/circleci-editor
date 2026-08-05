/**
 * CircleCI's own step keywords that this app has a schema-driven field
 * editor for (issue #48), factored out of `Inspector.tsx` into its own
 * tiny module so the palette's Steps section (`paletteSteps.ts`, issue
 * #71) can reuse the exact same set without creating a circular import
 * between the inspector and the DAG pane's palette.
 *
 * See `Inspector.tsx`'s own (more detailed) comment on `KNOWN_STEP_KEYS`
 * for why this list is exactly what it is: every keyword
 * `internal/schema/schema.json`'s `definitions.step` enumerates except
 * `run`/`checkout`/`when`/`unless`, each of which needs its own
 * non-uniform handling (a scalar shorthand, or a nested-steps group)
 * rather than fitting this "single-key map of plain fields" shape.
 */
export const KNOWN_STEP_KEYS = new Set([
  'setup_remote_docker',
  'save_cache',
  'restore_cache',
  'store_artifacts',
  'store_test_results',
  'persist_to_workspace',
  'attach_workspace',
  'add_ssh_keys',
]);
