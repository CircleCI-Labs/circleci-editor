/**
 * The policy violations currently on the table, as `Diagnostic`s, for every
 * pane that renders them (issue #215, background evaluation since #247).
 *
 * A hook rather than a per-pane `useMemo` for the reason `buildDiagnostics`
 * is shared between the YAML and DAG panes: the editor's line tint, the
 * graph's node ring and the Policies tab (`PolicyRulesView`, in the Project
 * pane since issue #306) must all be looking at the same objects, or they
 * will quietly disagree about what is wrong with the config.
 *
 * Reads only; triggers nothing itself. The check this reads the result of
 * runs automatically, on `appStore.revalidate`'s own debounce (issue #247)
 * -- see `policyStore.evaluateInBackground` -- never as a side effect of
 * this hook or of rendering.
 */
import { useMemo } from 'react';

import { useAppStore } from '~/state/appStore';
import { isPolicyDecisionStale, usePolicyStore } from '~/state/policyStore';

import type { Diagnostic } from './diagnostics';
import { buildPolicyDiagnostics } from './policyDiagnostics';

export function usePolicyDiagnostics(): Diagnostic[] {
  const doc = useAppStore((state) => state.doc);
  const text = useAppStore((state) => state.text);
  const decision = usePolicyStore((store) => store.decision);
  const checkedText = usePolicyStore((store) => store.checkedText);

  return useMemo(
    () =>
      buildPolicyDiagnostics({
        decision,
        doc,
        text,
        stale: isPolicyDecisionStale({ decision, checkedText }, text),
      }),
    [decision, checkedText, doc, text],
  );
}
