import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the editor component is stubbed; every other export is passed through
// from the real module. Replacing the module wholesale meant that each time
// the YAML pane started using another CodeMirror export (Prec, Decoration,
// ViewPlugin, ...) this mock broke with "No X export is defined", which is a
// failure about the mock rather than about the app.
vi.mock('@uiw/react-codemirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uiw/react-codemirror')>();
  return {
    ...actual,
    __esModule: true,
    default: ({
      value,
      onChange,
      'aria-label': ariaLabel,
    }: {
      value: string;
      onChange?: (value: string) => void;
      'aria-label'?: string;
    }) => (
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    ),
  };
});

vi.mock('@xyflow/react', () => ({
  // Only the enum value DagPane actually uses; importing the real module
  // would pull React Flow's DOM-dependent components into jsdom.
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="react-flow">{children}</div>
  ),
  ReactFlowProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  useReactFlow: () => ({ fitView: vi.fn<() => void>() }),
}));

import { App } from './App';

const META = {
  version: '0.1.0',
  configPath: '/repo/.circleci/config.yml',
  configExists: true,
  configFound: true,
  projectSlug: 'gh/acme/widgets',
  hasToken: true,
  host: 'localhost:8080',
  cwd: '/repo',
  projectWebUrl: 'https://app.circleci.com/projects/gh/acme/widgets',
};

const CONFIG = {
  path: '/repo/.circleci/config.yml',
  contents: 'version: 2.1\n',
  exists: true,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Routes each stubbed request by path rather than by arrival order.
 *
 * A queue of responses was fine while the app bar made exactly two requests in
 * a known order; it broke the moment the bar's project indicator (issue #149)
 * added a third, because React flushes a child's effects before its parent's --
 * so `/api/project-context` claimed the response meant for `/api/meta`. Routing
 * by path is what the real host does and cannot be reordered out of.
 */
function stubHostApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/meta')) {
        return Promise.resolve(jsonResponse(200, META));
      }
      if (url.includes('/api/project-context')) {
        return Promise.resolve(
          jsonResponse(200, {
            available: true,
            projectSlug: 'gh/acme/widgets',
            contexts: [],
            projectVariables: [],
          }),
        );
      }
      if (url.includes('/api/config-files')) {
        return Promise.resolve(
          jsonResponse(200, {
            dir: '/repo/.circleci',
            primaryPath: CONFIG.path,
            files: [
              {
                path: CONFIG.path,
                relPath: 'config.yml',
                size: CONFIG.contents.length,
                isPrimary: true,
                isConfig: true,
                configReason: 'Declares version: 2.1.',
              },
            ],
          }),
        );
      }
      if (url.includes('/api/config')) {
        return Promise.resolve(jsonResponse(200, CONFIG));
      }
      return Promise.resolve(jsonResponse(200, {}));
    }),
  );
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the three pane headings after a successful load', async () => {
    stubHostApi();

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /config\.yml/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /ai assistant/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /workflow graph/i }),
    ).toBeInTheDocument();
  });

  it('shows a retry button when the initial load fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(
            jsonResponse(500, { error: { message: 'host unavailable' } }),
          ),
        ),
    );

    render(<App />);

    expect(
      await screen.findByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/host unavailable/i)).toBeInTheDocument();
  });
});
