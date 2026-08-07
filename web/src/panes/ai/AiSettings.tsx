import { useId, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Spinner } from '~/design/components/Spinner';
import type { AiCircleCIStatus, AiKeySource } from '~/lib/rpc/client';
import { useAiStore } from '~/state/aiStore';

import { McpSettings } from './McpSettings';

/**
 * Key configuration for the AI pane (issue #92). Deliberately renders every
 * provider from `providers` generically -- nothing here names "Anthropic"
 * or any model string; those come entirely from `GET /api/ai/status`,
 * which is what "provider-agnostic... no hardcoded model names in
 * components" means in practice for this file.
 *
 * The storage line answers the security review's "make it obvious where
 * the key is stored and easy to remove" requirement directly: it always
 * shows the host's own `storage.location`, and "Remove key" is one click,
 * no separate settings surface to hunt for.
 */
export function AiSettings() {
  const providers = useAiStore((state) => state.providers);
  const storage = useAiStore((state) => state.storage);
  const circleCI = useAiStore((state) => state.circleCI);
  const savingKey = useAiStore((state) => state.savingKey);
  const keyError = useAiStore((state) => state.keyError);
  const saveKey = useAiStore((state) => state.saveKey);
  const removeKey = useAiStore((state) => state.removeKey);

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h3 className="text-sm font-semibold text-cc-text">AI provider keys</h3>
        <p className="mt-1 text-xs text-cc-text-muted">
          Your key is sent once to this local host, which stores it and proxies
          every request to the provider -- it never enters this repository, and
          this browser tab never sees it again.
        </p>
      </div>

      {storage ? (
        <div className="rounded-md border border-cc-border bg-cc-panel-raised px-3 py-2 text-xs text-cc-text-muted">
          Stored via{' '}
          <span className="font-medium text-cc-text">
            {storage.backend === 'keychain'
              ? 'your OS keychain'
              : 'a local file'}
          </span>
          {': '}
          <span className="font-mono">{storage.location}</span>
        </div>
      ) : null}

      {keyError ? <p className="text-xs text-cc-danger">{keyError}</p> : null}

      <div className="flex flex-col gap-3">
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            id={provider.id}
            label={provider.label}
            model={provider.model}
            configured={provider.configured}
            source={provider.source}
            envVar={provider.envVar}
            storedKeyShadowed={provider.storedKeyShadowed}
            saving={savingKey}
            onSave={(key) => saveKey(provider.id, key)}
            onRemove={() => removeKey(provider.id)}
          />
        ))}
        {providers.length === 0 ? (
          <p className="text-xs text-cc-text-faint">
            No AI providers are registered in this build.
          </p>
        ) : null}
      </div>

      <McpSettings />
      <CircleCIToolsStatus status={circleCI} />
    </div>
  );
}

/**
 * Issue #11's read-only status line for CircleCI's own hosted MCP tools --
 * pipeline/workflow/job status, logs, artifacts, test results. There is
 * nothing to configure here, unlike `McpSettings`' docs server: this one
 * rides the same CircleCI API token every other CircleCI-backed feature in
 * this app already uses, so the only fact worth showing is whether that
 * token exists right now, which is exactly `status` -- rendering `null`
 * (not yet loaded) as neither "on" nor "off" is the honest-degradation rule
 * this app applies everywhere else (see internal/host/ai.go's
 * circleCIMCPStatus): a state this component cannot yet determine must
 * never render as though it had already determined "off".
 */
function CircleCIToolsStatus({
  status,
}: {
  status: AiCircleCIStatus | null | undefined;
}) {
  // `undefined` is treated exactly like `null` (not yet loaded), not like a
  // third "loaded and off" state -- see aiStore.ts's own `?? null` on the
  // way in, which is the layer that is actually supposed to prevent this
  // ever being `undefined` at all. Guarding here too means a fixture, an
  // older host response, or a future refactor of that guard cannot turn
  // "we don't know yet" into a crash rather than simply rendering nothing.
  if (status == null) return null;

  return (
    <div
      className="flex flex-col gap-1 border-t border-cc-border pt-4"
      data-testid="circleci-mcp-status"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-cc-text">CircleCI tools</h3>
        <Badge tone={status.available ? 'success' : 'neutral'}>
          {status.available ? 'Available' : 'Not available'}
        </Badge>
      </div>
      <p className="text-xs text-cc-text-muted">
        {status.available
          ? 'Read-only: the assistant can check pipeline, workflow, and job status, read logs, and list artifacts and test results. It cannot trigger, cancel, or rerun anything -- use this editor’s own Run controls for that.'
          : (status.reason ?? 'Not available.')}
      </p>
    </div>
  );
}

interface ProviderRowProps {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  /** See `AiKeySource` -- where the key in effect, if any, actually comes from. */
  source: AiKeySource;
  /** The environment variable checked for this provider, always populated (see `keystore.KeyEnvVar`). */
  envVar: string;
  /** True when a stored key exists but `source` is `'environment'` -- Remove is real here, but it will not change the effective key. */
  storedKeyShadowed: boolean;
  saving: boolean;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => void;
}

function ProviderRow({
  id,
  label,
  model,
  configured,
  source,
  envVar,
  storedKeyShadowed,
  saving,
  onSave,
  onRemove,
}: ProviderRowProps) {
  const inputId = useId();
  const [draft, setDraft] = useState('');

  const handleSave = async () => {
    if (draft.trim() === '') return;
    const ok = await onSave(draft.trim());
    if (ok) setDraft('');
  };

  // Whether Remove would delete anything at all. Source 'store' always has
  // something to delete; source 'environment' only does when
  // storedKeyShadowed says a stored key exists underneath it. The remaining
  // case -- 'environment' with nothing stored -- is issue #7 itself: before
  // this, every configured row got a Remove button regardless, and clicking
  // it there deleted nothing while reporting success. There is no honest
  // disabled label for "this button would do nothing", so the fix is to not
  // render the button at all in that case, and say why instead (below).
  const canRemoveStoredKey = source === 'store' || storedKeyShadowed;

  return (
    <div
      className="rounded-md border border-cc-border-strong p-3"
      data-testid={`ai-provider-${id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-text">{label}</span>
          <Badge tone={configured ? 'success' : 'neutral'}>
            {configured ? 'Configured' : 'Not configured'}
          </Badge>
        </div>
        <span className="font-mono text-2xs text-cc-text-faint">{model}</span>
      </div>

      {configured ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {source === 'environment' ? (
            <p
              className="text-2xs text-cc-text-muted"
              data-testid={`ai-provider-${id}-env-note`}
            >
              Configured from the environment variable{' '}
              <span className="font-mono text-cc-text">{envVar}</span>.{' '}
              {storedKeyShadowed
                ? 'A stored key also exists but is ignored while it is set -- removing it will not change which key is used.'
                : `Nothing is stored; unset ${envVar} to store a key here instead.`}
            </p>
          ) : null}
          {canRemoveStoredKey ? (
            <div>
              <Button
                variant="danger"
                size="sm"
                disabled={saving}
                onClick={onRemove}
              >
                {source === 'environment' ? 'Remove stored key' : 'Remove key'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 flex items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            {label} API key
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${label} API key`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSave();
            }}
            className="flex-1 rounded-md border border-cc-border-interactive bg-cc-panel-raised px-2.5 py-1.5 text-sm text-cc-text placeholder:text-cc-text-faint"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={saving || draft.trim() === ''}
            onClick={() => void handleSave()}
          >
            {saving ? <Spinner size={12} label="Saving" /> : null}
            {saving ? 'Saving…' : 'Save key'}
          </Button>
        </div>
      )}
    </div>
  );
}
