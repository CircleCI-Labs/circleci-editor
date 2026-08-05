/**
 * Assembles the repo-aware context sent alongside every chat request (issue
 * #92: "repo-aware context... is what makes it useful"). Every field here
 * comes from state the app already has loaded in `appStore` -- the open
 * config's own text and path, and the job/workflow names and validation
 * result that state already derived from it -- never from a fresh
 * filesystem read. That is what makes "never send the whole repo silently"
 * an invariant of this function rather than a promise this module has to
 * keep by discipline: there is no broader surface it could reach for even
 * if it wanted to.
 */
import type { Document } from 'yaml';

import { getJobNames, getWorkflowNames } from '~/lib/yaml/documentUtils';
import type { ConfigFileInfo } from '~/lib/rpc/client';
import type {
  AiChatContext,
  AiChatContextFile,
  AiChatPolicyViolation,
  AiChatSkippedFile,
} from '~/lib/rpc/client';
import type { ValidateErrorItem } from '~/lib/rpc/client';

/**
 * The slice of `appStore`'s state this module actually needs -- deliberately
 * a narrow, structural type (rather than importing `appStore`'s own full
 * `AppState`) so this stays easy to unit test with a plain object and so it
 * can never accidentally widen to depend on some unrelated store field.
 */
export interface AiContextSource {
  configPath: string;
  text: string;
  doc: Document | null;
  validation: { errors: ValidateErrorItem[] };
  /**
   * The config-policy engine's current, non-stale failing rules (issue
   * #247's item 6: "make sure the AI chat has access to those policies... so
   * if someone needs help editing a config to be compliant we'd actually
   * know how to help them"). Absent or empty means either nothing has fired
   * or nothing is known yet -- exactly the same convention `validation.errors`
   * already uses, and for the same reason: this module derives no meaning
   * from an empty list beyond "nothing to add here".
   *
   * `policyStore` is a separate store from the one this interface otherwise
   * mirrors (`appStore`), so the caller (`aiStore.sendMessage`) is
   * responsible for reading it and passing already-narrowed, already
   * non-stale violations in -- this function does not reach into any store
   * itself, by the same rule the rest of this module follows.
   */
  policyViolations?: AiChatPolicyViolation[];
}

/**
 * Bounds how many tokens' worth of *other* files (issue #102) one chat
 * request will carry, on top of the open file's own text -- which is
 * never subject to this budget, since it's the file being edited and the
 * whole reason the pane exists. 20,000 tokens is roughly 80KB of YAML:
 * generous for a handful of sibling setup/continuation configs (the
 * overwhelmingly common `.circleci` shape per issue #106's own framing --
 * "usually 1-4 files"), while still bounded so a `.circleci` directory
 * that happens to also vendor something enormous can't turn one message
 * into a surprise-sized request. Exported so this module's tests and the
 * docs page that states the rule in prose ("What leaves your machine" in
 * `internal/guides/editor/using-this-editor.adoc`) are checked against one
 * number rather than two that could drift apart.
 */
export const DIRECTORY_CONTEXT_TOKEN_BUDGET = 20_000;

/** What `buildDirectoryContext` produces: the read-only files worth sending, and which ones were left out and why. */
export interface DirectoryContext {
  otherFiles: AiChatContextFile[];
  skippedFiles: AiChatSkippedFile[];
}

const EMPTY_DIRECTORY_CONTEXT: DirectoryContext = {
  otherFiles: [],
  skippedFiles: [],
};

/**
 * Builds the read-only "other files" half of the AI context (issue #102)
 * from the directory listing `appStore.files` already holds. Every file
 * other than `activePath` is included, in `relPath` order, until
 * `budgetTokens` (see `DIRECTORY_CONTEXT_TOKEN_BUDGET`) would be exceeded
 * -- at which point *that* file, and every one after it in the fixed
 * order, is reported in `skippedFiles` with why, rather than silently
 * dropped (issue #102: "never silently truncate"). A file the host
 * already couldn't include the text of (`omitted`, e.g. over the host's
 * own per-file size cap) or that this call simply didn't fetch contents
 * for (`contents === undefined`, e.g. `getConfigFiles()` was called
 * without `withContents`) is skipped the same explicit way, never
 * partially included.
 *
 * Pure and synchronous: it does no fetching itself. Callers (`AiPane`)
 * are responsible for having already called `getConfigFiles(true)`.
 */
export function buildDirectoryContext(
  activePath: string,
  files: ConfigFileInfo[],
  budgetTokens: number = DIRECTORY_CONTEXT_TOKEN_BUDGET,
): DirectoryContext {
  const siblings = files
    .filter((f) => f.path !== activePath)
    .slice()
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const otherFiles: AiChatContextFile[] = [];
  const skippedFiles: AiChatSkippedFile[] = [];
  let used = 0;

  for (const file of siblings) {
    if (file.omitted) {
      skippedFiles.push({ path: file.path, reason: 'too large to load' });
      continue;
    }
    if (file.contents === undefined) {
      skippedFiles.push({ path: file.path, reason: 'contents unavailable' });
      continue;
    }
    const text = labelledSiblingText(file);
    const tokens = estimateTokens(text);
    if (used + tokens > budgetTokens) {
      skippedFiles.push({ path: file.path, reason: 'token budget exceeded' });
      continue;
    }
    otherFiles.push({ path: file.path, text });
    used += tokens;
  }

  return { otherFiles, skippedFiles };
}

/**
 * Prefixes a sibling's text with one line naming what the host already
 * determined it is, for a non-config file only (issue #146, following on
 * from #145's fix for the same underlying gap: sending a non-config's
 * contents unlabelled invites the model to reason about it as though it
 * were a pipeline it could propose an edit to).
 *
 * Reuses `isConfig`/`configReason` exactly as the host reports them
 * (`GET /api/config-files`, #135's classifier) rather than re-deriving
 * "is this a config" here -- the same fields `ConfigFileSwitcher` and
 * `appStore.revalidate` (#145) already read, so all three surfaces can
 * never disagree about the same file. No new request and no host change:
 * this only reshapes text this call already has.
 *
 * A real config sibling (most commonly a continuation config a setup
 * workflow hands off to) is returned unlabelled -- it *is* one of the
 * things the model is being told it cannot edit, but it is not
 * misrepresented as something else, so there is nothing to add.
 */
function labelledSiblingText(file: ConfigFileInfo): string {
  if (file.isConfig) return file.contents ?? '';
  return `# Read-only sibling, not a CircleCI config: ${file.configReason}\n${file.contents ?? ''}`;
}

/** Builds the `AiChatContext` sent with a chat request from the app's current state, plus (issue #102) the read-only directory context `buildDirectoryContext` assembled -- omit `directory` for the pre-#102 shape (both arrays empty). */
export function buildAiContext(
  state: AiContextSource,
  directory: DirectoryContext = EMPTY_DIRECTORY_CONTEXT,
): AiChatContext {
  return {
    configPath: state.configPath,
    configText: state.text,
    jobNames: state.doc ? getJobNames(state.doc) : [],
    workflowNames: state.doc ? getWorkflowNames(state.doc) : [],
    validationErrors: state.validation.errors.map((e) => e.message),
    otherFiles: directory.otherFiles,
    skippedFiles: directory.skippedFiles,
    policyViolations: state.policyViolations ?? [],
  };
}

/**
 * A rough token-count estimate for `text`. ~4 characters per token is a
 * commonly cited rule of thumb for English/YAML text; it is not exact for
 * any particular tokenizer, and this function does not pretend otherwise
 * -- it is never anything a provider bills against.
 *
 * Its one caller is `buildDirectoryContext`'s budget: it decides how much
 * sibling YAML is worth carrying, not what any UI displays. Until #253
 * there was a second, `estimateContextTokens`, which existed solely to put
 * a total on the AI pane's transparency line ("Sends: N files… ~M tokens").
 * That line is gone and so is that function; what a request
 * contains is stated in this editor's docs page rather than counted on
 * screen.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
