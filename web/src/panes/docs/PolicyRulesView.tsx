/**
 * The config-policy decision, in full, in the Project pane (issue #215's
 * "browsing policies" half; #247 items 3 and 6 for what grew here). Moved
 * off the reference pane's own tab strip onto this shared-slot surface by
 * issue #306 -- see `panes/docs/DocsPane.tsx`.
 *
 * ## Why here, and why all of it lives here now
 *
 * The owner's first suggestion was the palette. The palette is a list of
 * things you *drag into a config* -- jobs, orbs, executors, contexts -- and
 * #178 is already about it being crowded. Policy rules are not insertable:
 * they are constraints on what you may write, which is precisely what this
 * pane is for.
 *
 * #247 first shipped the *detail* -- the full rule, its `reason` message,
 * and "Fix with AI" -- in a strip under the editor (`PolicyStrip`, now
 * deleted). The owner's later steer, once the reference pane was already
 * growing a family of tabs (#248), moved it here instead:
 *
 * > *"We mentioned policies over there because that will affect things. So I
 * > think having policies over there would be really helpful."*
 *
 * So this view is now the *only* place a violation's full detail is shown --
 * the badge row (`PolicyBadge`) still carries the verdict at a glance, and
 * the editor still tints a located violation's line and rings its DAG node,
 * but neither shows the rule or the reason in full. That is here, not in a
 * strip, a modal or an expanding panel in the editor.
 *
 * ## Why this shows rules and not the bundle
 *
 * `circleci policy fetch` returns the Rego source of the whole bundle, and
 * this editor deliberately does not call it. Two reasons, both load-bearing:
 * the bundle is only readable by a token with organization-admin-level
 * access (the live API answers 403 for most members -- 2 of 37 real orgs
 * probed while building #215 could read it), so a pane built on it would be
 * empty for almost everyone; and rendering Rego source would invite reading
 * it as authoritative when the *decision* is the authority. `enabled_rules`
 * comes back with every decision, costs no extra request, and is exactly the
 * list of controls that were applied. This is established, not worked
 * around -- see the section at the foot of this view, which says so on
 * screen rather than leaving the gap to be discovered.
 *
 * `enabled_rules`/`hard_failures`/`soft_failures` are also the whole of what
 * the wire sends -- no `metadata`, no `violations` array (#215) -- so this
 * view (and the AI context in `lib/ai/context.ts`) cannot offer more detail
 * than CircleCI's own decision carries. Sending the *compiled* config
 * (`input._compiled_`, issue #25) does not change that: it changes which
 * rules fire, not what a decision reports about the ones that do -- so this
 * view still cannot show more than `enabled_rules`/`hard_failures`/
 * `soft_failures` carry, it can only show *more rules firing* now that a
 * rule written against the compiled form has something to fire against.
 * When it did not run -- compilation failed, or the config does not
 * compile -- this view says so explicitly (see the "evaluated the source
 * config only" notice below) rather than leaving that gap to be
 * discovered from a rule that stayed silent.
 *
 * Which means this tab has nothing to show until a check has run -- and it
 * says so, rather than showing an empty list that could be read as "your
 * organization has no policies". Since #247 checking is automatic
 * (`appStore.revalidate`'s debounce), "nothing yet" now only lasts as long
 * as the debounce itself, or until whatever kept it from running (no token,
 * a parse error) clears.
 */
import { useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { useFixWithAi } from '~/lib/ai/useFixWithAi';
import type { Diagnostic } from '~/lib/validation/diagnostics';
import { buildPolicyDiagnostics } from '~/lib/validation/policyDiagnostics';
import { useAppStore } from '~/state/appStore';
import { isPolicyDecisionStale, usePolicyStore } from '~/state/policyStore';

interface PolicyRulesViewProps {
  /**
   * Opens the vendored "Config policies" guide page at a section, in this
   * same pane's Guides tab -- the existing cross-tab extension point
   * `EntryDetail` already uses (`DocsPane.openGuideSection`), reused rather
   * than duplicated so this view never grows a second navigation mechanism
   * of its own.
   */
  onOpenGuideSection?: (guideId: string, sectionId: string) => void;
}

/** One violation, with everything this view can honestly say about it: the reason in full, whether it blocks a pipeline, where it is (or that it cannot be placed), and "Fix with AI" as a first-class action -- issue #247 items 3 and 6. */
function ViolationDetail({
  diagnostic,
  activeKey,
  onFixWithAi,
  aiNotice,
}: {
  diagnostic: Diagnostic;
  activeKey: string | null;
  onFixWithAi: (diagnostic: Diagnostic) => void;
  aiNotice: ReturnType<typeof useFixWithAi>['notice'];
}) {
  return (
    <div className="mt-1.5 rounded border border-cc-border-strong bg-cc-panel-raised px-2 py-1.5">
      <p
        className="break-words font-mono text-2xs leading-relaxed text-cc-text"
        data-testid="policy-violation-reason"
      >
        {diagnostic.title}
      </p>
      <p className="mt-1 text-2xs text-cc-text-faint">
        {diagnostic.location
          ? `Location: line ${diagnostic.location.line}${diagnostic.location.basis === 'resolved' ? ' (resolved by matching the name in the reason against this config)' : ''}.`
          : // #163's rule, unchanged for a policy violation: a location is
            // shown only when it is provable. A violation naming no
            // declaration this config makes -- prose about a Docker image,
            // say -- honestly has no line to point at.
            'Location unknown -- this violation names nothing that matches exactly one place in this config, so there is no line to point at.'}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onFixWithAi(diagnostic)}
        >
          Fix with AI
        </Button>
        {activeKey === diagnostic.id && aiNotice?.kind === 'seeded' ? (
          <span role="status" className="text-2xs text-cc-text-muted">
            Prompt added to the AI pane&apos;s message box, including this
            rule&apos;s name and message. Review it there and press Send --
            sending it is a new request to your AI provider, and nothing has
            been sent yet.
          </span>
        ) : null}
        {activeKey === diagnostic.id && aiNotice?.kind === 'no-key' ? (
          <span role="status" className="text-2xs text-cc-warning">
            No AI provider key is configured. Add one in the AI pane&apos;s
            Settings, then try again.
          </span>
        ) : null}
        {activeKey === diagnostic.id && aiNotice?.kind === 'status-error' ? (
          <span role="status" className="text-2xs text-cc-warning">
            Couldn&apos;t check whether an AI provider is configured:{' '}
            {aiNotice.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function PolicyRulesView({ onOpenGuideSection }: PolicyRulesViewProps) {
  const state = usePolicyStore((store) => store.state);
  const reason = usePolicyStore((store) => store.reason);
  const decision = usePolicyStore((store) => store.decision);
  const checkedText = usePolicyStore((store) => store.checkedText);
  const doc = useAppStore((store) => store.doc);
  const text = useAppStore((store) => store.text);
  const configPath = useAppStore((store) => store.configPath);

  const { notice: aiNotice, run: runFixWithAi } = useFixWithAi();
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const stale = isPolicyDecisionStale({ decision, checkedText }, text);
  // The same Diagnostic objects the editor's line tint and the DAG's node
  // ring already use (`usePolicyDiagnostics`), so this view can never
  // disagree with either about a violation's location -- one source of
  // truth, not a second one derived from the raw violations directly.
  const diagnostics = buildPolicyDiagnostics({ decision, doc, text, stale });
  const firedRules = new Set(
    diagnostics.flatMap((d) => (d.policyRule ? [d.policyRule.name] : [])),
  );

  function handleFixWithAi(diagnostic: Diagnostic) {
    setActiveKey(diagnostic.id);
    void runFixWithAi({ diagnostic, text, configPath });
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-3 text-xs"
      data-testid="policy-rules-view"
    >
      <h2 className="mb-1 text-sm font-semibold text-cc-text">
        Config policies
      </h2>
      <p className="mb-3 leading-relaxed text-cc-text-muted">
        Your organization can require, forbid or flag things in a config before
        a pipeline is allowed to run. The list below is the rules CircleCI
        actually evaluated the last time this editor checked -- not a copy of
        the policy source, which only an organization admin can read (see
        below).
        {onOpenGuideSection ? (
          <>
            {' '}
            <button
              type="button"
              className="text-cc-accent hover:underline"
              onClick={() =>
                onOpenGuideSection('config-policies', 'introduction')
              }
            >
              What are config policies?
            </button>
          </>
        ) : null}
      </p>

      {state === 'idle' ? (
        <p className="rounded border border-cc-border bg-cc-panel px-2 py-1.5 leading-relaxed text-cc-text-muted">
          Nothing has been checked yet, so there is nothing to list.{' '}
          <strong>This does not mean your organization has no policies.</strong>{' '}
          A check runs automatically in the background a moment after you stop
          typing -- there is nothing to press -- and the rules it ran will
          appear here.
        </p>
      ) : null}

      {state === 'checking' ? (
        <p className="text-cc-text-muted">Asking CircleCI…</p>
      ) : null}

      {state === 'unavailable' || state === 'error' ? (
        <p
          className="rounded border border-cc-warning/40 bg-cc-panel px-2 py-1.5 leading-relaxed text-cc-warning"
          data-testid="policy-rules-unavailable"
        >
          The last check couldn&apos;t reach a decision
          {reason ? `: ${reason}` : '.'} So this list is unknown, not empty.
        </p>
      ) : null}

      {state === 'decided' && decision ? (
        <div>
          <p className="mb-2 text-2xs text-cc-text-faint">
            {decision.orgSlug ? <>{decision.orgSlug} · </> : null}
            {decision.policyContext ?? 'config'} policies
            {stale
              ? ' · from a check of an earlier version of this file -- a fresh check runs automatically'
              : ''}
          </p>

          {decision.compiledConfigIncluded ? null : (
            // Issue #25: a real decision, but not the one CircleCI itself
            // would reach -- the engine there also sees the config after
            // 2.1->2.0 compilation (`input._compiled_`), and a rule written
            // against that may simply not have fired below even though it
            // would for real. Stated here rather than left for a missing
            // rule to imply, because "PASS" and "PASS, but only checked
            // against the source" must never look the same.
            <p
              className="mb-2 rounded border border-cc-warning/40 bg-cc-panel px-2 py-1.5 leading-relaxed text-cc-warning"
              data-testid="policy-compiled-unavailable"
            >
              This check evaluated the source config only
              {decision.compiledConfigReason
                ? `: ${decision.compiledConfigReason}`
                : ''}
              . CircleCI&apos;s own pipeline-trigger evaluation also inspects
              the config after 2.1→2.0 compilation, so a rule written against
              that may not have fired below even though it would on CircleCI.
            </p>
          )}

          {decision.enabledRules.length === 0 ? (
            <p className="rounded border border-cc-border bg-cc-panel px-2 py-1.5 leading-relaxed text-cc-text-muted">
              CircleCI reported no enabled rules for this organization in this
              policy context. Nothing was checked, so the decision says nothing
              about this config.
            </p>
          ) : (
            <ul className="space-y-1">
              {decision.enabledRules.map((rule) => {
                const fired = diagnostics.filter(
                  (d) => d.policyRule?.name === rule,
                );
                const blocking = fired.some((d) => d.policyRule?.blocking);
                return (
                  <li
                    key={rule}
                    className="rounded border border-cc-border bg-cc-panel px-2 py-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-2xs text-cc-text">
                        {rule}
                      </span>
                      {firedRules.has(rule) ? (
                        <Badge tone={blocking ? 'danger' : 'warning'}>
                          {blocking ? 'Blocking failure' : 'Non-blocking'}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">Did not fire</Badge>
                      )}
                    </div>
                    {fired.map((diagnostic) => (
                      <ViolationDetail
                        key={diagnostic.id}
                        diagnostic={diagnostic}
                        activeKey={activeKey}
                        onFixWithAi={handleFixWithAi}
                        aiNotice={aiNotice}
                      />
                    ))}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Rules can fire without being listed as enabled -- the two lists
              come from different parts of the engine's answer, and dropping a
              violation because its rule wasn't named would hide a real
              finding. */}
          {diagnostics.some(
            (d) => !decision.enabledRules.includes(d.policyRule?.name ?? ''),
          ) ? (
            <div className="mt-2">
              <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-cc-text-muted">
                Also reported, without being listed as enabled
              </p>
              <ul className="space-y-1">
                {diagnostics
                  .filter(
                    (d) =>
                      !decision.enabledRules.includes(d.policyRule?.name ?? ''),
                  )
                  .map((diagnostic) => (
                    <li
                      key={diagnostic.id}
                      className="rounded border border-cc-border bg-cc-panel px-2 py-1.5"
                    >
                      <span className="font-mono text-2xs text-cc-text">
                        {diagnostic.policyRule?.name}
                      </span>
                      <ViolationDetail
                        diagnostic={diagnostic}
                        activeKey={activeKey}
                        onFixWithAi={handleFixWithAi}
                        aiNotice={aiNotice}
                      />
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 border-t border-cc-border pt-2 leading-relaxed text-cc-text-faint">
        This editor only ever <strong>reads</strong> policy decisions. It cannot
        create, edit or delete a policy — CircleCI&apos;s{' '}
        <code>policy push</code> is deliberately not implemented here.
        Evaluation runs automatically in the background and sends the open
        config to CircleCI to be evaluated; see the &ldquo;What leaves your
        machine&rdquo; section of this editor&apos;s own guide under{' '}
        <em>Guides</em>.
      </p>
      <p className="mt-2 leading-relaxed text-cc-text-faint">
        The rule name and the reason above are everything CircleCI&apos;s
        decision reports -- this view does not fetch the policy&apos;s Rego
        source (<code>circleci policy fetch</code>). That call requires
        organization-admin-level access and answers <strong>HTTP 403</strong>{' '}
        for most org members, so a view built on it would be empty for almost
        everyone; this is established, not a gap this editor works around. If
        you need the rule&apos;s full source, ask an organization admin.
      </p>
      <p className="mt-2 leading-relaxed text-cc-text-faint">
        Rule names and reasons named above are also sent as context to the AI
        pane when you send it a message, so it can help you make this config
        comply -- they may name internal services, teams or standards, so that
        is disclosed in the AI pane&apos;s own guide alongside the rest of what
        it sends.
      </p>
    </div>
  );
}
