import { useId, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Spinner } from '~/design/components/Spinner';
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
    </div>
  );
}

interface ProviderRowProps {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  saving: boolean;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => void;
}

function ProviderRow({
  id,
  label,
  model,
  configured,
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
        <div className="mt-2">
          <Button
            variant="danger"
            size="sm"
            disabled={saving}
            onClick={onRemove}
          >
            Remove key
          </Button>
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
