/**
 * Shared, cached accessor for the parsed CircleCI schema (issue #48). The
 * inspector's per-step-type field editors need it every time a job with
 * steps is selected, and `Inspector` remounts on every selection change
 * (`key={node.id}` from `DagPane` -- see that component's own doc comment),
 * so fetching `/api/schema` fresh on every click would be wasteful and, on
 * a slow connection, would flash every step's fields blank each time. A
 * module-level cache -- this is the only consumer that mounts/unmounts
 * repeatedly within one app session -- makes the fetch-and-parse happen at
 * most once per session.
 *
 * Deliberately not merged with `YamlPane`'s own `getSchema()` call (which
 * drives YAML autocompletion): that component doesn't remount, so it has no
 * equivalent problem, and giving it a second reason to depend on this
 * module would be coupling for its own sake.
 */
import { useEffect, useState } from 'react';

import { getSchema } from '~/lib/rpc/client';

import { parseCircleciSchema, type CircleciSchema } from './circleciSchema';

let cached: Promise<CircleciSchema> | null = null;

function loadCircleciSchema(): Promise<CircleciSchema> {
  if (!cached) {
    // `parseCircleciSchema` never throws, but `getSchema()` itself can
    // reject (network/transport failure) -- fall back to parsing
    // `undefined`, i.e. the all-empty schema, rather than leaving `cached`
    // permanently rejected (which would otherwise wedge every future caller
    // in this session behind the first failed fetch).
    cached = getSchema()
      .then(parseCircleciSchema)
      .catch(() => parseCircleciSchema(undefined));
  }
  return cached;
}

/**
 * Test-only escape hatch: clears the module cache so the next
 * `useCircleciSchema()` call fetches (and re-parses) again instead of
 * replaying whatever the *first* test in a file happened to get back. Every
 * test that needs a specific schema (rather than "some schema, don't care
 * which") must call this before rendering -- see `Inspector.test.tsx`'s
 * step-field tests.
 */
export function __resetCircleciSchemaCacheForTests(): void {
  cached = null;
}

/**
 * `null` while the (at-most-once) fetch is in flight; the parsed schema --
 * or the all-empty fallback, on failure -- once it resolves. Every consumer
 * of `CircleciSchema` already treats "nothing schema-derived is known" as a
 * normal, renderable state (see `EMPTY_SCHEMA`), so callers don't need a
 * separate error branch here.
 */
export function useCircleciSchema(): CircleciSchema | null {
  const [schema, setSchema] = useState<CircleciSchema | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCircleciSchema().then((resolved) => {
      if (!cancelled) setSchema(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return schema;
}
