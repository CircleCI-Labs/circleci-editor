import { startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@uiw/react-codemirror';
import type { Extension } from '@uiw/react-codemirror';

/**
 * Re-opens the completion popup after a *deletion*, which
 * `autocompletion({ activateOnTyping: true })` deliberately does not do.
 *
 * CodeMirror's `activateOnTyping` fires on **input**, not on any document
 * change, so backspacing never re-queries the completion source. That is
 * usually the right default -- a popup appearing every time you delete a
 * character would fight anyone clearing a line -- but it makes the single
 * most common way of *editing an existing value* a dead end:
 *
 *     image: cimg/python:3.12
 *                        ^^^^ select and delete, expecting to pick a new version
 *
 * The prefix is now `cimg/python:`, which is exactly the shape
 * `cimgLiveTagRepoName` (see `~/lib/schema/completion`) recognises and would
 * happily answer with live Docker Hub tags. Nothing asked it to. The user
 * reported this as "it doesn't always tab autocomplete, like when I'm editing
 * the version", and they were right: typing offers help, editing doesn't.
 *
 * Rather than bind this to a key, it triggers on the deletion itself, because
 * the alternative was worse. `Tab` is load-bearing for indentation in a YAML
 * editor and rebinding it to "start completion" would break block editing;
 * `Mod-Space` already works but is not discoverable, and telling a user to
 * learn a chord to get behaviour they expected automatically is not a fix.
 *
 * Cheap by construction: it only asks the source to run, and the source
 * already returns `null` everywhere it has nothing to say (a non-completable
 * path, an opaque scalar, a comment), so a deletion in ordinary prose opens
 * nothing. `startCompletion` is also a no-op when a popup is already open.
 */
export function reopenCompletionOnDelete(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    // Ignore programmatic replacements -- most importantly the store->editor
    // sync that rewrites the whole document when a DAG or inspector edit lands.
    // Those are not the user deleting something, and popping a completion open
    // in response to one would be baffling.
    if (!update.transactions.some((tr) => tr.isUserEvent('delete'))) return;

    // Only a *collapsing* change counts: text removed and nothing put back.
    // A replacement (select-all then paste, or an autocompletion's own
    // `apply`) reports as a delete plus an insert, and should not re-arm.
    let deletedOnly = false;
    update.changes.iterChanges((fromA, toA, fromB, toB) => {
      if (toA > fromA && toB === fromB) deletedOnly = true;
    });
    if (!deletedOnly) return;

    // Deferred out of the update cycle: `startCompletion` dispatches its own
    // transaction, and dispatching from inside an update listener is what
    // CodeMirror warns against ("Calls to EditorView.update are not allowed
    // while an update is in progress").
    queueMicrotask(() => startCompletion(update.view));
  });
}
