/**
 * The one table of `circleci.com/docs` URLs this app links to (issue #78:
 * "quick links to documentation... would actually be really, really
 * awesome"). Every doc link anywhere in the UI resolves through
 * `docsUrl`/`stepDocsUrl` rather than a scattered string literal, so:
 *
 *  - a stale or wrong URL is checkable in one place, not by grepping the
 *    whole tree for `circleci.com`;
 *  - `docsLinks.test.ts` can assert every entry actually resolves (a live
 *    check, tolerant of no network -- see that file) and catch rot before a
 *    user does;
 *  - issue #77's image picker (a sibling, concurrent piece of work) can
 *    import from here too instead of inventing its own second table.
 *
 * Every URL below was verified by hand against the live docs site while
 * writing this table (`curl`, following redirects) -- see the PR
 * description for the check transcript. CircleCI's docs platform migrated
 * URLs at least once during this app's lifetime (`/docs/reusing-config/` ->
 * `/docs/reference/reusing-config/`, still redirecting), so the pretty,
 * un-migrated paths are used here where both resolve: they're the ones a
 * human would type or paste, and they degrade gracefully (a 301, not a
 * 404) if the site reorganizes again.
 *
 * Anchors (`#fragment`) are only used where the target heading's actual
 * `id` was confirmed in the rendered page -- CircleCI's step-reference
 * anchors are not always the step keyword itself (e.g. `save_cache` is
 * `#savecache`, no underscore; `add_ssh_keys` is `#add-ssh-keys`, a
 * hyphen) -- so guessing would silently produce a link that "resolves"
 * (the fragment isn't sent to the server, so a wrong one still 200s) but
 * scrolls nowhere.
 */

export interface DocLink {
  /** Shown as the link's accessible name / tooltip -- what a user is told this points to. */
  label: string;
  url: string;
}

/**
 * Every doc link this app can render, keyed by where/what it's for. Grouped
 * to match issue #78's own list (executors, images, steps, reusable config,
 * workflows, orbs) so the table reads as a checklist against that issue.
 *
 * URLs are the **post-redirect canonical paths**, not the shorter legacy ones.
 * CircleCI's docs moved under `/docs/guides/...`, `/docs/orbs/...` and
 * `/docs/reference/...`, and the old paths still 301 today -- so both forms
 * "work", and `curl` without `-L` can't tell them apart. Recording the
 * destination means a link keeps working if those redirects are ever retired,
 * and it's what a user sees in the address bar. Verified with `curl -sIL` and
 * asserted by `docsLinks.test.ts`'s live check.
 */
export const DOCS_LINKS = {
  /**
   * The three pages the reference pane renders *in-app* from vendored AsciiDoc
   * (issue #104, `internal/guides`). They are in this table too, rather than
   * only in the Go host, for two reasons: the pane needs a link out to the live
   * page for anything the snapshot can't reproduce (an unresolved `include::`,
   * an image), and `docsLinks.test.ts`'s live check is then the thing that
   * catches these three URLs rotting -- which matters more for them than for
   * most entries here, because `internal/guides` derives every *section* URL by
   * appending a fragment to them.
   *
   * Verified non-redirecting with `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}'`
   * while writing this: all three answer `200` with no redirect target.
   */
  guides: {
    configurationReference: {
      label: 'Configuration reference',
      url: 'https://circleci.com/docs/reference/configuration-reference/',
    },
    reusingConfig: {
      label: 'Reusable config',
      url: 'https://circleci.com/docs/reference/reusing-config/',
    },
    dynamicConfig: {
      label: 'Dynamic config',
      url: 'https://circleci.com/docs/guides/orchestrate/dynamic-config/',
    },
    /**
     * Issue #250 asks for the `pipeline-variables` guide to be *the* reference
     * linked from the parameters editor, and issue #180 vendored it: the page
     * behind this URL is snapshotted at
     * `internal/guides/snapshot/docs/guides/modules/orchestrate/pages/pipeline-variables.adoc`
     * and rendered in-app by the reference pane under the id
     * `pipeline-variables`.
     *
     * It is in this table anyway, for the same reason the three above are: the
     * pane can only render what the snapshot captured, and this is the URL its
     * own section links append a fragment to. The editor's link uses
     * `DocsLink`, which is the app's one outbound-docs affordance -- there is
     * deliberately no cross-pane "jump to this guide" action, because the docs
     * pane owns its own guide/section state locally (see `DocsPane`) and giving
     * a palette section the power to retarget another pane is a bigger change
     * than issue #250 asks for, and one #248 may well decide differently.
     */
    pipelineVariables: {
      label: 'Pipeline values and parameters',
      url: 'https://circleci.com/docs/guides/orchestrate/pipeline-variables/',
    },
    /**
     * Issue #292's matrix-job recommendation links here: the worked example
     * this page walks through (`os`/`node-version` parameters expanding one
     * job into several) is the same shape `detectMatrixCandidates.ts` looks
     * for -- one job invoked repeatedly in a workflow with only its
     * arguments differing. Verified `200` with no redirect while adding it.
     */
    matrixJobs: {
      label: 'Using matrix jobs',
      url: 'https://circleci.com/docs/guides/orchestrate/using-matrix-jobs/',
    },
    /**
     * Issue #292's `restore_cache` fallback-key recommendation
     * (`detectCacheFallback.ts`) links the "Restoring cache" section
     * specifically, not just the page: that section is where CircleCI's own
     * docs show the exact pattern being suggested (a checksum key plus a
     * plain-prefix fallback) and explain that fallback keys are matched by
     * prefix. Anchor confirmed against the page's own rendered heading id
     * while adding it.
     */
    caching: {
      label: 'Restoring cache (fallback keys)',
      url: 'https://circleci.com/docs/guides/optimize/caching/#restoring-cache',
    },
  },
  /**
   * Issue #19: the inspector's `StepsSection` (shared by a job's own `steps:`
   * and, per issue #37, a workflow entry's `pre-steps:`/`post-steps:`) had a
   * docs link on every *individual* step type once it was expanded
   * (`stepDocsUrl`, issue #78) but none on the section itself -- so a reader
   * who has not added any steps yet, or who wants "what is a step, generally"
   * rather than "what does `save_cache` take", had nothing to click. This is
   * the configuration reference's own `steps` section (`== *`steps`*`), the
   * page the per-keyword anchors in `STEP_DOCS_ANCHORS` all live inside.
   */
  jobs: {
    steps: {
      label: 'The steps key',
      url: 'https://circleci.com/docs/reference/configuration-reference/#steps',
    },
    /**
     * `pre-steps`/`post-steps` (issue #37) are a *different* documented
     * section from `steps` above -- upstream's own `[#pre-steps-and-
     * post-steps]` anchor, not a fragment of the plain `steps` one -- so the
     * inspector's Pre-steps/Post-steps sections must not reuse `steps`'s
     * link: doing so would point at the wrong prose for the specific
     * question a reader of *that* section actually has ("what are these
     * two, specifically" rather than "what is a step, generally").
     */
    prePostSteps: {
      label: 'pre-steps and post-steps',
      url: 'https://circleci.com/docs/reference/configuration-reference/#pre-steps-and-post-steps',
    },
  },
  executors: {
    docker: {
      label: 'Docker execution environment',
      url: 'https://circleci.com/docs/guides/execution-managed/using-docker/',
    },
    machine: {
      label: 'Linux VM (machine) execution environment',
      url: 'https://circleci.com/docs/guides/execution-managed/using-linuxvm/',
    },
    macos: {
      label: 'macOS execution environment',
      url: 'https://circleci.com/docs/guides/execution-managed/using-macos/',
    },
    windows: {
      label: 'Windows execution environment',
      url: 'https://circleci.com/docs/guides/execution-managed/using-windows/',
    },
    resourceClass: {
      label: 'Resource classes',
      url: 'https://circleci.com/docs/reference/configuration-reference/#resourceclass',
    },
    dockerReference: {
      label: 'The docker executor reference',
      url: 'https://circleci.com/docs/reference/configuration-reference/#docker',
    },
    machineReference: {
      label: 'The machine executor reference',
      url: 'https://circleci.com/docs/reference/configuration-reference/#machine',
    },
    macosReference: {
      label: 'The macos executor reference',
      url: 'https://circleci.com/docs/reference/configuration-reference/#macos',
    },
    /**
     * The supported-Xcode table itself (issue #211). The Xcode field's list is
     * derived from this exact section of the vendored snapshot, so linking the
     * section rather than the page says "here is the table this list came from"
     * rather than "here is somewhere the answer might be".
     */
    supportedXcodeVersions: {
      label: 'Supported Xcode versions',
      url: 'https://circleci.com/docs/guides/execution-managed/using-macos/#supported-xcode-versions',
    },
  },
  images: {
    dockerConvenience: {
      label: 'Convenience images',
      url: 'https://circleci.com/docs/guides/execution-managed/circleci-images/',
    },
    machine: {
      label: 'Available Linux VM images',
      url: 'https://circleci.com/docs/guides/execution-managed/using-linuxvm/',
    },
    machineTags: {
      label: 'Available machine images',
      url: 'https://circleci.com/docs/reference/configuration-reference/#available-machine-images',
    },
    private: {
      label: 'Using private or authenticated images',
      url: 'https://circleci.com/docs/guides/execution-managed/private-images/',
    },
    /**
     * CircleCI's own advice against mutable tags: "Avoid using mutable tags like
     * `latest` or `1` as the image version in your `config.yml` file... Mutable
     * tags often lead to unexpected changes in your job environment."
     *
     * Linked from the tag combobox's warning (issue #213) so that the warning is
     * upstream's position with a citation rather than this project's opinion.
     */
    mutableTags: {
      label: 'Why not to pin a mutable tag',
      url: 'https://circleci.com/docs/guides/execution-managed/using-docker/#best-practices',
    },
  },
  reusableConfig: {
    overview: {
      label: 'Reusable configuration reference',
      url: 'https://circleci.com/docs/reference/reusing-config/',
    },
    executors: {
      label: 'The executors key',
      url: 'https://circleci.com/docs/reference/reusing-config/#the-executors-key',
    },
    commands: {
      label: 'The commands key',
      url: 'https://circleci.com/docs/reference/reusing-config/#the-commands-key',
    },
    parameters: {
      label: 'Using the parameters declaration',
      url: 'https://circleci.com/docs/reference/reusing-config/#using-the-parameters-declaration',
    },
  },
  workflows: {
    requires: {
      label: 'Flexible job dependency (requires)',
      url: 'https://circleci.com/docs/guides/orchestrate/workflows/#flexible-job-dependency',
    },
    filters: {
      label: 'Job filters (branches/tags)',
      url: 'https://circleci.com/docs/reference/configuration-reference/#jobfilters',
    },
    approval: {
      label: 'Hold a workflow for a manual approval',
      url: 'https://circleci.com/docs/guides/orchestrate/workflows/#configure-an-approval-job',
    },
    /**
     * Issue #288: the workflow-level `triggers:`/`schedule:` section --
     * `#triggers`/`#schedule`/`#cron`/`#schedule-branches` are the
     * configuration-reference page's own section ids (verified with
     * `curl -sS ... | grep 'id="'` while adding this, the same way every
     * other entry here was). Not the guides page of the same name: the
     * vendored guides deliberately excluded that page (`triggers:`/
     * `schedule:` is legacy syntax superseded by UI-configured scheduled
     * pipelines, and serving upstream's replacement guidance would be
     * actively wrong for *this* still-valid, still-editable syntax). The
     * *reference* page continues to document the syntax
     * CircleCI still compiles, which is exactly what this field edits.
     */
    triggers: {
      label: 'Scheduled workflows (triggers)',
      url: 'https://circleci.com/docs/reference/configuration-reference/#triggers',
    },
    cron: {
      label: 'The cron key (crontab syntax)',
      url: 'https://circleci.com/docs/reference/configuration-reference/#cron',
    },
    maxAutoReruns: {
      label: 'max_auto_reruns',
      url: 'https://circleci.com/docs/reference/configuration-reference/#max_auto_reruns',
    },
    contexts: {
      label: 'Contexts',
      url: 'https://circleci.com/docs/guides/security/contexts/',
    },
    /*
      Issue #251's three anchors, all on the contexts page this repository
      already vendors (`internal/guides/snapshot/.../security/pages/contexts.adoc`)
      and whose own section ids these are -- `[#restrict-a-context]`,
      `[#project-restrictions]`, `[#expression-restrictions]`. So the fragment is
      checked against the vendored source rather than guessed, and the live
      link-resolution check below still only ever fetches the one base URL.

      Three entries rather than one because the three restriction kinds are three
      different concepts with three different remedies, and a user looking at
      "restricted to 1 group" needs the security-group section, not the top of a
      long page.
    */
    contextRestrictions: {
      label: 'Restrict a context',
      url: 'https://circleci.com/docs/guides/security/contexts/#restrict-a-context',
    },
    contextProjectRestrictions: {
      label: 'Project restrictions on contexts',
      url: 'https://circleci.com/docs/guides/security/contexts/#project-restrictions',
    },
    contextExpressionRestrictions: {
      label: 'Expression restrictions on contexts',
      url: 'https://circleci.com/docs/guides/security/contexts/#expression-restrictions',
    },
  },
  env: {
    projectVariables: {
      label: 'Project environment variables',
      url: 'https://circleci.com/docs/guides/security/set-environment-variable/',
    },
  },
  orbs: {
    intro: {
      label: 'Orbs introduction',
      url: 'https://circleci.com/docs/orbs/use/orb-intro/',
    },
    /**
     * Added by #210. Both this and `intro` are pages `internal/guides` already
     * vendors (`orb-intro`/`orb-concepts`), which is what makes them resolvable
     * with no network and citable with certainty for an orb diagnostic -- see
     * `lib/ai/deterministicSources`. Verified `200` with no redirect target
     * while adding it, the same way every other entry in this table was.
     */
    concepts: {
      label: 'Orb concepts',
      url: 'https://circleci.com/docs/orbs/use/orb-concepts/',
    },
    creating: {
      label: 'Creating orbs',
      url: 'https://circleci.com/docs/orbs/author/creating-orbs/',
    },
    registry: {
      label: 'CircleCI Orb Registry',
      url: 'https://circleci.com/developer/orbs',
    },
    /**
     * Issue #292's "orb pinned behind its latest" recommendation
     * (`detectOutdatedOrbs.ts`) links here rather than `intro`/`concepts`:
     * the semantic-versioning section is specifically what a version pin
     * means and why bumping one is a deliberate choice, which is the frame
     * that recommendation needs to stay informational rather than read as a
     * defect. Anchor is the page's own `#semantic-versioning` heading id,
     * confirmed against the rendered page while adding it (the shorter
     * `#versioning` some drafts of this table used does not exist as a
     * heading, and would have "resolved" anyway -- see this file's own doc
     * comment on why a wrong fragment still 200s).
     */
    versioning: {
      label: 'Orb versioning',
      url: 'https://circleci.com/docs/orbs/use/orb-concepts/#semantic-versioning',
    },
  },
} as const satisfies Record<string, Record<string, DocLink>>;

/**
 * Every step keyword this app has a dedicated editor for (see
 * `~/lib/schema/stepKeywords`'s `KNOWN_STEP_KEYS`, plus `run`/`checkout`/
 * `when`/`unless`, which are handled separately in the inspector but are
 * just as much "a step type" for this table's purposes) mapped to its own
 * anchor in the configuration reference. Kept as a separate table (not
 * folded into `DOCS_LINKS`) because it's addressed by a dynamic key (the
 * step's own keyword, read off the document) rather than a fixed one --
 * `stepDocsUrl` below is the one place that distinction matters.
 */
export const STEP_DOCS_ANCHORS: Record<string, string> = {
  checkout: 'checkout',
  run: 'run',
  when: 'the-when-step',
  unless: 'the-when-step',
  setup_remote_docker: 'setupremotedocker',
  save_cache: 'savecache',
  restore_cache: 'restorecache',
  store_artifacts: 'storeartifacts',
  store_test_results: 'storetestresults',
  persist_to_workspace: 'persisttoworkspace',
  attach_workspace: 'attachworkspace',
  add_ssh_keys: 'add-ssh-keys',
};

const CONFIGURATION_REFERENCE_URL =
  'https://circleci.com/docs/reference/configuration-reference/';

/**
 * The docs URL for one step keyword (e.g. `"save_cache"`), or `undefined`
 * for a keyword this table doesn't know about -- a custom command
 * reference or an orb command have no CircleCI-authored docs page to link
 * to, so callers (the inspector's `StepRow`) simply render no link rather
 * than a guessed one.
 */
export function stepDocsUrl(stepKey: string): string | undefined {
  const anchor = STEP_DOCS_ANCHORS[stepKey];
  return anchor ? `${CONFIGURATION_REFERENCE_URL}#${anchor}` : undefined;
}

/**
 * The docs URL for one orb's own registry entry (issue #89: "a docs link to
 * the orb registry entry"), built from `DOCS_LINKS.orbs.registry.url` --
 * whose live check already confirms that base page is canonical and
 * non-redirecting -- plus the orb's own `/orb/<namespace>/<name>` path.
 * That per-orb path can't itself be a `DOCS_LINKS` entry the live check
 * iterates (there are thousands of orbs, not a fixed handful like
 * `STEP_DOCS_ANCHORS`), so it's built the same way `stepDocsUrl` builds a
 * dynamic anchor URL from a checked base -- confirmed by hand for
 * `circleci/node` while writing this (`curl -sIL`: 200, no redirect).
 * Returns `undefined` for an incomplete reference rather than a broken
 * link, mirroring `stepDocsUrl`'s "nothing to link to" convention.
 */
export function orbDocsUrl(
  namespace: string,
  orbName: string,
): string | undefined {
  if (!namespace || !orbName) return undefined;
  return `${DOCS_LINKS.orbs.registry.url}/orb/${namespace}/${orbName}`;
}

/**
 * Looks up `url` against every canonical URL this table knows (both
 * `DOCS_LINKS` and `STEP_DOCS_ANCHORS`), for issue #103's "citations...
 * inherit the canonical-URL guarantee": a link the AI pane renders from an
 * MCP tool result is dynamic, external, unverified-by-this-table text --
 * but when it happens to point at a page we've already curated (and
 * confirmed non-redirecting -- see this file's own doc comment),
 * prefer that curated `DocLink` over the raw URL the tool returned, the
 * same way `stepDocsUrl` already prefers a known anchor over guessing one.
 *
 * Matching is on the URL's origin + pathname + `#fragment` (a query string
 * is stripped from both sides before comparing, since that's the only part
 * a tracking parameter like `?utm_source=` would add). The fragment is
 * deliberately *not* stripped, unlike a query string: `configuration-
 * reference/#resourceclass` and `configuration-reference/#save_cache` are
 * two different entries in this very table that happen to share one page,
 * so ignoring the fragment would make an arbitrary one of them "the" match
 * for any URL pointing at that page. An invalid `url` (whatever a
 * compromised or misbehaving MCP server might send) returns `undefined`
 * rather than throwing -- callers should treat that exactly like "not in
 * the table" and fall back to rendering the raw string.
 */
export function lookupDocLink(url: string): DocLink | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const key = target.origin + target.pathname + target.hash;
  for (const { link } of allDocLinks()) {
    let candidate: URL;
    try {
      candidate = new URL(link.url);
    } catch {
      continue;
    }
    if (candidate.origin + candidate.pathname + candidate.hash === key) {
      return link;
    }
  }
  return undefined;
}

/** Every entry in `DOCS_LINKS`, flattened, for iteration (the link-check test) and for looking one up by its dotted path. */
export function allDocLinks(): { path: string; link: DocLink }[] {
  const out: { path: string; link: DocLink }[] = [];
  for (const [group, entries] of Object.entries(DOCS_LINKS)) {
    for (const [key, link] of Object.entries(entries)) {
      out.push({ path: `${group}.${key}`, link });
    }
  }
  for (const [stepKey, anchor] of Object.entries(STEP_DOCS_ANCHORS)) {
    out.push({
      path: `steps.${stepKey}`,
      link: {
        label: `${stepKey} step`,
        url: `${CONFIGURATION_REFERENCE_URL}#${anchor}`,
      },
    });
  }
  return out;
}
