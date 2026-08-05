import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '~/state/aiStore';

import { ChatMessageView } from './ChatMessageView';

/**
 * Which messages get Markdown, and which deliberately do not (issue #156).
 * `Markdown.test.tsx` covers *how* Markdown renders (including the hostile
 * cases); this file covers the policy decisions that live in this component.
 */
function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    ...overrides,
  };
}

function renderMessage(overrides: Partial<ChatMessage>) {
  return render(
    <ChatMessageView
      message={message(overrides)}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );
}

describe('ChatMessageView', () => {
  it('renders an assistant reply as Markdown', () => {
    const { container } = renderMessage({
      content: 'Use **save_cache**:\n\n```yaml\nkey: v1-deps\n```',
    });

    expect(container.querySelector('strong')?.textContent).toBe('save_cache');
    expect(container.querySelector('pre')?.textContent).toBe('key: v1-deps');
    expect(container.textContent).not.toContain('**');
  });

  it('leaves a user message exactly as typed', () => {
    // Someone who types `**not bold**` into the composer said those
    // characters; reformatting their own message would misrepresent it.
    const { container } = renderMessage({
      role: 'user',
      content: 'why is **this** failing?',
    });

    expect(container.querySelector('strong')).toBeNull();
    expect(screen.getByText('why is **this** failing?')).toBeInTheDocument();
  });

  it('leaves a host-supplied notice exactly as the host wrote it', () => {
    const { container } = renderMessage({
      isNotice: true,
      content: 'The request failed: no API key configured for Anthropic.',
    });

    expect(screen.getByText('Notice')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(
      screen.getByText(
        'The request failed: no API key configured for Anthropic.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the ungrounded notice host-supplied and unformatted', () => {
    // The notice is load-bearing (issue #103) and must never become
    // model-controlled or model-formatted.
    const { container } = renderMessage({
      content: 'An answer.',
      groundingReason: 'the docs sign-in expired **and** was not refreshed',
    });

    const notice = screen.getByTestId('ungrounded-notice');
    expect(notice.textContent).toContain(
      'the docs sign-in expired **and** was not refreshed',
    );
    expect(notice.querySelector('strong')).toBeNull();
    expect(
      container.querySelector('[data-testid="ungrounded-notice"] a'),
    ).toBeNull();
  });

  it('renders the prose of an action-carrying reply without the action block', () => {
    const { container } = renderMessage({
      content:
        'Adding it now.\n\n```action\n{"type": "addJob", "name": "lint"}\n```',
      action: { type: 'addJob', name: 'lint' },
      actionStatus: 'pending',
    });

    expect(screen.getByText('Adding it now.')).toBeInTheDocument();
    // stripActionBlock still runs before rendering: the JSON is not shown as
    // prose, and not rendered as a code fence either.
    expect(container.textContent).not.toContain('addJob');
    expect(container.querySelector('pre')).toBeNull();
    // The approval affordance is untouched -- an AI edit is never applied
    // without it.
    expect(
      screen.getByRole('button', { name: /review change/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Proposed')).toBeInTheDocument();
  });

  it('shows a source as a titled, single-link row and never shows an asset', () => {
    renderMessage({
      content: 'See the docs.',
      sources: [
        {
          url: 'https://circleci.com/docs/guides/execution-managed/persist-data/',
          title: 'Persist data',
        },
        { url: 'https://circleci.com/docs/guides/_images/workspace.png' },
      ],
    });

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      'https://circleci.com/docs/guides/execution-managed/persist-data/',
    );
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(links[0]?.textContent).toContain('Persist data');
    expect(links[0]?.textContent).toContain(
      'circleci.com/docs/guides/execution-managed/persist-data/',
    );
    expect(screen.queryByText(/workspace\.png/)).not.toBeInTheDocument();
  });

  it('shows no "Sources" box when every citation was filtered out', () => {
    renderMessage({
      content: 'An answer.',
      sources: [
        { url: 'https://circleci.com/docs/guides/_images/workspace.png' },
      ],
    });

    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  /**
   * Issue #187: an untrusted citation is shown, not linked, and counted — the
   * three properties together. Any one of them alone would be worse than the
   * behaviour before: dropping it hides the reference, linking it endorses a
   * destination a model chose, and showing it without saying why looks like a
   * broken row.
   */
  it('shows an untrusted source as plain text, with no anchor, and says how many were not linked', () => {
    renderMessage({
      content: 'See the docs.',
      sources: [
        {
          url: 'https://circleci.com/docs/guides/orchestrate/workflows/',
          title: 'Use workflows',
        },
        {
          url: 'https://app.slack.com/client/T00000000/C00000000',
          title: 'Ask in #ci',
        },
      ],
    });

    // Exactly one link, and it is the CircleCI one.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toContain('circleci.com');

    // The Slack citation is still on the page -- as text, with its destination.
    const unlinked = screen.getByTestId('ai-source-unlinked');
    expect(unlinked.textContent).toContain('Ask in #ci');
    expect(unlinked.textContent).toContain(
      'app.slack.com/client/T00000000/C00000000',
    );
    expect(unlinked.querySelector('a')).toBeNull();
    // ...and the count is stated, so nothing looks quietly missing.
    expect(
      screen.getByText(/1 source is shown without a link/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only circleci\.com and CircleCI-owned GitHub/),
    ).toBeInTheDocument();
  });

  it('renders a look-alike domain’s citation with no href anywhere in the box', () => {
    const { container } = renderMessage({
      content: 'An answer.',
      sources: [{ url: 'https://circleci.com.evil.example/docs/guides/' }],
    });

    const sources = screen.getByTestId('ai-sources');
    expect(sources.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain(
      'href="https://circleci.com.evil',
    );
    // Visible, so the user can see what the answer leant on.
    expect(sources.textContent).toContain('circleci.com.evil.example');
  });
});

/**
 * Issues #192 and #209: a component per role, and the affordances that became
 * possible once the assistant's replies stopped sharing a component with the
 * user's messages.
 */
describe('the role split (issues #192/#209)', () => {
  it('gives the assistant the full width and no bubble, and the user a bubble', () => {
    // Chunk's asymmetry, and the reason to take it is legibility: a reply can carry
    // a fenced YAML sample, and a code block inside an 85%-wide bubble in a
    // 320px-wide pane wraps to nothing.
    const assistant = renderMessage({ content: 'A reply.' });
    expect(
      assistant.container.querySelector('[data-testid="ai-user-message"]'),
    ).toBeNull();
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    assistant.unmount();

    renderMessage({ role: 'user', content: 'A question.' });
    expect(screen.getByTestId('ai-user-message')).toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
  });

  it('puts a copy action on a reply and none on a user message', () => {
    const assistant = renderMessage({ content: 'A reply.' });
    expect(
      screen.getByRole('button', { name: /copy this reply/i }),
    ).toBeInTheDocument();
    assistant.unmount();

    renderMessage({ role: 'user', content: 'A question.' });
    expect(
      screen.queryByRole('button', { name: /copy this reply/i }),
    ).not.toBeInTheDocument();
  });

  it('copies the prose the user was actually shown, without the action block', async () => {
    // Copying something never rendered would be a small lie about what is in the
    // clipboard -- and the action block is machine-readable JSON, not prose.
    // `userEvent.setup()` installs a clipboard stub of its own, so ours goes on
    // after it -- otherwise the assertion below tests theirs.
    const user = userEvent.setup();
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderMessage({
      content:
        'Adding it now.\n\n```action\n{"type": "addJob", "name": "lint"}\n```',
      action: { type: 'addJob', name: 'lint' },
      actionStatus: 'pending',
    });
    await user.click(screen.getByRole('button', { name: /copy this reply/i }));
    expect(writeText).toHaveBeenCalledWith('Adding it now.');
    // ...and it says so, briefly, so the click is not a no-op to the eye.
    expect(
      await screen.findByRole('button', { name: /copy this reply/i }),
    ).toHaveTextContent('Copied');
  });

  it('keeps the review affordance visible rather than hiding it behind a hover', () => {
    // The toolbar is quiet until hovered, which is right for a convenience and
    // wrong for the only route to an approval-gated action.
    renderMessage({
      content: 'Adding it now.',
      action: { type: 'addJob', name: 'lint' },
      actionStatus: 'pending',
    });
    const toolbar = screen.getByTestId('ai-message-actions');
    expect(toolbar.className).not.toContain('opacity-0');
    expect(
      screen.getByRole('button', { name: /review change/i }),
    ).toBeInTheDocument();
  });

  it('names the editor-attached sources, so they are not mistaken for grounding', () => {
    // Issue #210: these rows are present even on a reply that had no docs
    // grounding at all, because this app attached them from the error itself.
    renderMessage({
      content: 'That version was never published.',
      sourceTopic: {
        kind: 'orb',
        orb: { namespace: 'circleci', name: 'slack', latestVersion: '5.1.1' },
      },
    });
    expect(screen.getAllByTestId('ai-source-editor')).toHaveLength(3);
    expect(screen.getByTestId('ai-sources-editor-note').textContent).toContain(
      'attached them from the error itself',
    );
  });
});
