/**
 * The "Fix with AI" action, shared between `DiagnosticsStrip` (issue #163,
 * for compile diagnostics) and `PolicyRulesView` (issue #247, which asks that
 * a policy violation get exactly the same treatment: "treat a policy
 * violation as a first-class case for Fix with AI the way a compile error
 * already is" -- shown in the Policies tab (the Project pane since issue
 * #306; see `panes/docs/DocsPane.tsx`) rather than a strip in the editor, at
 * the owner's later direction).
 *
 * Extracted rather than duplicated because the two call sites must never
 * drift on what counts as "no key configured" or "status could not be
 * checked" -- a user reading both must see the same words for the same
 * condition. What differs between them is only which `Diagnostic` and which
 * orb-version facts (if any) go into the prompt; this hook takes both as
 * plain arguments and stays ignorant of where they came from.
 *
 * Still seeds and never sends -- see `buildFixPrompt`'s own doc comment.
 */
import { useState } from 'react';

import { fixTopicFor } from '~/lib/ai/deterministicSources';
import type { Diagnostic } from '~/lib/validation/diagnostics';
import { buildFixPrompt } from '~/lib/validation/prompt';
import { isProviderConfigured, useAiStore } from '~/state/aiStore';

/** What the last "Fix with AI" click produced. Rendered inline so the button never silently does nothing. */
export type FixWithAiNotice =
  | { kind: 'seeded' }
  | { kind: 'no-key' }
  | { kind: 'status-error'; message: string };

export interface RunFixWithAiInput {
  diagnostic: Diagnostic;
  /** The editor's current text -- the same bytes the diagnostic's location counts against. */
  text: string;
  configPath: string;
  /** See `FixPromptInput.orbVersions`: facts about the orb, when the diagnostic is about one and the registry has answered. */
  orbVersions?: { versions?: readonly string[]; latestVersion?: string };
}

export function useFixWithAi() {
  const [notice, setNotice] = useState<FixWithAiNotice | null>(null);

  const run = async (input: RunFixWithAiInput) => {
    const store = useAiStore.getState();
    // A preset that doesn't show the AI pane never mounts it, so nothing
    // will have loaded provider status. Load it before saying anything about
    // whether a key exists -- claiming "no key" because we never looked would
    // be the same class of dishonesty as claiming CircleCI said something it
    // didn't.
    if (store.statusState !== 'ready') await store.loadStatus();
    const after = useAiStore.getState();
    if (after.statusState === 'error') {
      setNotice({
        kind: 'status-error',
        message: after.statusError ?? 'AI status could not be loaded.',
      });
      return;
    }
    if (!isProviderConfigured(after.providers, after.selectedProvider)) {
      setNotice({ kind: 'no-key' });
      return;
    }
    // Issue #210: the prompt and the citations are aimed by the same
    // classification the rest of this strip already runs on --
    // `diagnostic.target`, extracted mechanically, never guessed.
    after.seedPrompt(
      buildFixPrompt(input),
      fixTopicFor(input.diagnostic.target, input.orbVersions),
    );
    setNotice({ kind: 'seeded' });
  };

  return { notice, setNotice, run };
}
