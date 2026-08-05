/**
 * One turn of the chat transcript: which role component renders it, and nothing
 * else.
 *
 * This file used to *be* the message — one component branching on `message.role`
 * and rendering a bubble either way. #192 catalogued why that was the wrong shape
 * and #209 changed it: a component per role, around a shared frame, so the
 * assistant's replies can carry a toolbar and citations while the user's messages
 * carry neither. See `MessageRow` for the frame, and `AssistantMessage` for where
 * the security-relevant rendering decisions now live.
 *
 * Keeping this component (rather than inlining the switch into `AiPane`) keeps the
 * mapping from a stored message to a rendered one in one testable place — the role
 * of a message is a policy question, and `ChatMessageView.test.tsx` is where it is
 * pinned.
 */
import type { ChatMessage } from '~/state/aiStore';

import { AssistantMessage } from './AssistantMessage';
import { MessageRow } from './MessageRow';
import { NoticeMessage } from './NoticeMessage';
import { UserMessage } from './UserMessage';

interface ChatMessageViewProps {
  message: ChatMessage;
  onApprove: () => void;
  onReject: () => void;
}

export function ChatMessageView({
  message,
  onApprove,
  onReject,
}: ChatMessageViewProps) {
  if (message.role === 'user') {
    return (
      <MessageRow role="user">
        <UserMessage content={message.content} />
      </MessageRow>
    );
  }

  // A notice is host-supplied copy about a degraded state, not something either
  // side of the conversation said -- see `NoticeMessage`. It is checked before the
  // assistant case because a notice *is* stored with `role: 'assistant'` (that is
  // what puts it in the right place in the thread), and rendering it as a reply
  // would run a Markdown formatter over the host's own words.
  if (message.isNotice) {
    return (
      <MessageRow role="notice">
        <NoticeMessage content={message.content} />
      </MessageRow>
    );
  }

  return (
    <MessageRow role="assistant">
      <AssistantMessage
        message={message}
        onApprove={onApprove}
        onReject={onReject}
      />
    </MessageRow>
  );
}
