import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderOrbDescription } from './orbDescription';

describe('renderOrbDescription', () => {
  it('renders plain text with no markdown untouched', () => {
    render(<div>{renderOrbDescription('A simple orb for doing things.')}</div>);
    expect(
      screen.getByText('A simple orb for doing things.'),
    ).toBeInTheDocument();
  });

  it('renders **bold** as a <strong> element', () => {
    render(
      <div>{renderOrbDescription('Please read **the docs** first.')}</div>,
    );
    const strong = screen.getByText('the docs');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders `code` as a <code> element', () => {
    render(
      <div>
        {renderOrbDescription('Runs `circleci-agent` under the hood.')}
      </div>,
    );
    const code = screen.getByText('circleci-agent');
    expect(code.tagName).toBe('CODE');
  });

  it('renders an http(s) [label](url) link as a real, safe anchor', () => {
    render(
      <div>
        {renderOrbDescription(
          'See [our GitHub](https://github.com/example/orb).',
        )}
      </div>,
    );
    const link = screen.getByRole('link', { name: 'our GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/example/orb');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  // Third-party orb text is untrusted; a non-http(s) scheme must never
  // become a clickable href (see the module's own doc comment).
  it('does not linkify a non-http(s) link target', () => {
    render(
      <div>{renderOrbDescription('[click me](javascript:alert(1))')}</div>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/click me/)).toBeInTheDocument();
  });

  it('splits blank-line-separated text into separate paragraphs', () => {
    const { container } = render(
      <div>
        {renderOrbDescription('First paragraph.\n\nSecond paragraph.')}
      </div>,
    );
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe('First paragraph.');
    expect(paragraphs[1]?.textContent).toBe('Second paragraph.');
  });

  it('renders a single newline within a paragraph as a line break, not a new paragraph', () => {
    const { container } = render(
      <div>{renderOrbDescription('Line one.\nLine two.')}</div>,
    );
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  // Defensive: orb descriptions are third-party YAML text -- this must
  // never construct raw HTML from it (no dangerouslySetInnerHTML anywhere
  // in the module), so a description containing a literal tag renders as
  // inert text, not markup.
  it('never renders third-party text as HTML', () => {
    const { container } = render(
      <div>{renderOrbDescription('<img src=x onerror="alert(1)">')}</div>,
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
