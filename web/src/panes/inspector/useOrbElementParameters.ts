/**
 * Resolves the parameters an orb *declares* for one of its jobs or commands, at
 * a call site in this config.
 *
 * The orb browser has always had this (issues #89/#128): it fetches the orb's
 * source, `parseOrbSource` turns it into `OrbElement`s with typed, required-ness-
 * annotated parameters, and the element rows render them. The inspector had half
 * of it — `OrbJobParamsSection` did exactly this for an orb *job* — and nothing
 * at all for an orb *command* dropped into a job's steps, which is the gap issue
 * #252 reports: the step landed and then offered no way to configure it, so a
 * command with required parameters was unconfigurable in the UI.
 *
 * Extracted into a hook rather than copied because the step row needs it too, and
 * needs it in a place where a conditional call is not an option — a step row does
 * not know whether it is an orb command until it has described its own step. So
 * this is written to be called unconditionally: pass an empty `elementName` (or
 * an alias this config does not import) and it settles into `'idle'` without
 * fetching anything.
 *
 * Like `OrbJobParamsSection` before it, this deliberately goes through
 * `useOrbStore.loadOrb` rather than adding a second fetch path, and equally
 * deliberately does not touch `selectedOrb`/`loadingOrb`/`error`: inspecting a
 * job or a step must never hijack what the orb browser panel is showing. See
 * `loadOrb`'s own doc comment.
 */
import { useEffect, useState } from 'react';

import { parseOrbRef, type OrbParameter } from '~/lib/orbs/types';
import { useOrbStore } from '~/state/orbStore';

/**
 * `'idle'` means nothing was asked for — not that a lookup failed. The
 * distinction matters at the call site: `'idle'` renders nothing, while
 * `'unavailable'` renders the reason, because a step whose parameters could not
 * be resolved must not look like one that has none.
 */
export type OrbElementParamsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; params: OrbParameter[] }
  | { status: 'unavailable'; message: string };

/**
 * Looks up `elementName` among the `kind` elements of the orb imported in this
 * config under `orbAlias`.
 *
 * `orbRefValue` is the value of `orbs.<orbAlias>` (e.g.
 * `"cci-labs/act@1.2.3"`), read by the caller from the live document rather
 * than by this hook, so the hook has no opinion about document shape and
 * re-resolves whenever the import itself is edited.
 */
export function useOrbElementParameters(
  orbAlias: string,
  orbRefValue: string,
  elementName: string,
  kind: 'job' | 'command',
): OrbElementParamsState {
  const [state, setState] = useState<OrbElementParamsState>({ status: 'idle' });

  useEffect(() => {
    if (!orbAlias || !elementName) {
      setState({ status: 'idle' });
      return;
    }
    if (!orbRefValue) {
      setState({
        status: 'unavailable',
        message: `Orb alias "${orbAlias}" is not imported under orbs: in this config.`,
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    const { namespace, orbName, version } = parseOrbRef(orbRefValue);
    const name = namespace ? `${namespace}/${orbName}` : orbName;

    useOrbStore
      .getState()
      .loadOrb(name, version)
      .then((parsed) => {
        if (cancelled) return;
        const elements = kind === 'job' ? parsed.jobs : parsed.commands;
        const element = elements.find((e) => e.name === elementName);
        if (!element) {
          setState({
            status: 'unavailable',
            message: `"${elementName}" was not found among the "${name}" orb's ${kind === 'job' ? 'jobs' : 'commands'}.`,
          });
          return;
        }
        setState({ status: 'ready', params: element.parameters });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'unavailable',
          message:
            err instanceof Error ? err.message : 'Failed to load the orb.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [orbAlias, orbRefValue, elementName, kind]);

  return state;
}

/**
 * The declared parameters that are `required` and have no value at this call
 * site — i.e. exactly the ones that make the written config invalid.
 *
 * "Has a value" is membership in `set`, not truthiness: `false`, `0` and `""`
 * are all values a parameter can legitimately be given, and treating any of
 * them as absent would flag a correctly-configured step. A parameter with a
 * default is never required (`parseOrb` derives `required` as "the declaration
 * had no `default` key"), so nothing here needs to consult defaults.
 */
export function missingRequiredParams(
  params: OrbParameter[],
  set: ReadonlySet<string>,
): OrbParameter[] {
  return params.filter((param) => param.required && !set.has(param.name));
}
