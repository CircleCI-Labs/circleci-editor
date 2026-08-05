/**
 * One reply from the model (#192's "a component per message role", shipped by
 * #209): its prose, its citations, its grounding notice, and the affordances that
 * belong to it.
 *
 * Everything security-relevant about rendering model output lives in two calls at
 * the top of this component, and neither moved in #209:
 *
 *  - `stripActionBlock` runs **before** anything renders, exactly as before, so
 *    the Markdown renderer never sees the ```action fence. The approval-gated
 *    apply path still works off `message.action`, parsed from the *untouched*
 *    `message.content`, so an AI edit is still never applied without the user
 *    accepting a diff.
 *  - `Markdown` is this project's own renderer (#168), in which raw HTML is
 *    impossible by construction rather than disabled by configuration. #192
 *    catalogued Chunk's `Streamdown` + `react-markdown` setup and #209 explicitly
 *    declined to adopt it: this pane renders a **user-supplied** model's output
 *    inside a page that can reach a localhost host API, which is a materially
 *    different threat model from a first-party model in a first-party page. The
 *    styling crossed over; the renderer and its hostile-input tests stayed.
 */
import { useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { describeAction, stripActionBlock } from '~/lib/ai/actions';
import { rankSources } from '~/lib/ai/sources';
import { Markdown } from '~/lib/markdown/Markdown';
import type { ChatMessage } from '~/state/aiStore';

import { CopyMessageButton, MessageActions } from './MessageActions';
import { MessageAuthor, MessageBody } from './MessageRow';
import { ProposeChangeDialog } from './ProposeChangeDialog';
import { SourcesList } from './SourcesList';

export function AssistantMessage({
  message,
  onApprove,
  onReject,
}: {
  message: ChatMessage;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const prose = message.action
    ? stripActionBlock(message.content)
    : message.content;
  // Relevance and the cap (#210). The transcript still holds exactly what the
  // host sent (`message.sources`); which of them are shown, in what order, and
  // what this app attached itself from the diagnostic are decided here, at render
  // time, so the history never loses anything.
  const sources = rankSources(message.sources, message.sourceTopic);
  const pending = message.actionStatus === 'pending';

  return (
    <>
      <MessageAuthor>Assistant</MessageAuthor>
      <MessageBody>
        <Markdown source={prose} />
      </MessageBody>

      {message.action ? (
        <div
          className="max-w-full rounded-md border border-cc-border-strong bg-cc-panel px-3 py-2"
          data-testid="ai-action-card"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-cc-text-muted">
              {describeAction(message.action)}
            </span>
            <ActionStatusBadge status={message.actionStatus} />
          </div>
          {message.actionStatus === 'failed' && message.actionError ? (
            <p className="mt-1 text-xs text-cc-danger">{message.actionError}</p>
          ) : null}
        </div>
      ) : null}

      {sources.rows.length > 0 ? <SourcesList sources={sources} /> : null}

      {/* The other half of citations: saying so when there were none to give. A
          docs server was configured -- so the user has every reason to believe
          this answer is sourced -- but it could not be reached, and an answer that
          quietly stopped being grounded is worse than one that was never grounded
          at all (issue #103). Rendered from a host-supplied flag rather than
          trusting the model to mention it, and never formatted: it must keep
          saying exactly what the host said. */}
      {message.groundingReason ? (
        <p
          className="max-w-full text-2xs text-cc-warning"
          data-testid="ungrounded-notice"
        >
          Answered without docs grounding: {message.groundingReason}
        </p>
      ) : null}

      {/* The per-message toolbar (#192). "Review change…" is the contextual
          action for this app -- see `MessageActions` -- and it keeps its label and
          its behaviour: the dialog, the diff, and the explicit approval. */}
      <MessageActions prominent={pending}>
        <CopyMessageButton text={prose} />
        {pending ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            Review change…
          </Button>
        ) : null}
      </MessageActions>

      {message.action && dialogOpen ? (
        <ProposeChangeDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          action={message.action}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : null}
    </>
  );
}

function ActionStatusBadge({
  status,
}: {
  status: ChatMessage['actionStatus'];
}) {
  switch (status) {
    case 'applied':
      return <Badge tone="success">Applied</Badge>;
    case 'rejected':
      return <Badge tone="neutral">Rejected</Badge>;
    case 'failed':
      return <Badge tone="danger">Failed</Badge>;
    case 'pending':
    default:
      return <Badge tone="info">Proposed</Badge>;
  }
}
