import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigFileInfo } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';

import {
  ConfigFileSwitcher,
  fileLabel,
  fileTitle,
  knownRoleName,
} from './ConfigFileSwitcher';

/** A listing entry as the host would send it: classified, with a reason. */
function file(overrides: Partial<ConfigFileInfo> = {}): ConfigFileInfo {
  return {
    path: '/repo/.circleci/config.yml',
    relPath: 'config.yml',
    size: 10,
    isPrimary: true,
    isConfig: true,
    configReason: 'Declares version: 2.1.',
    ...overrides,
  };
}

const CONFIG = file();
const CONTINUE_CONFIG = file({
  path: '/repo/.circleci/continue-config.yml',
  relPath: 'continue-config.yml',
  size: 20,
  isPrimary: false,
  configReason: 'Has CircleCI top-level keys: jobs, workflows.',
});
const GOSS = file({
  path: '/repo/.circleci/goss.yaml',
  relPath: 'goss.yaml',
  size: 30,
  isPrimary: false,
  isConfig: false,
  configReason:
    'No CircleCI structure: no top-level version: 2, 2.0 or 2.1, and none of jobs, workflows, orbs, executors, commands, setup.',
});

/**
 * `.circleci/info.yml` as the host reports it (issue #198): not a config, and
 * *named* all the same. Both fields matter here -- `isConfig: false` is what keeps
 * it behind the reveal, and `knownRole` is what stops it being described as
 * unexplained other YAML once revealed.
 */
const PROJECT_BINDING = file({
  path: '/repo/.circleci/info.yml',
  relPath: 'info.yml',
  size: 40,
  isPrimary: false,
  isConfig: false,
  configReason:
    'No CircleCI structure: no top-level version: 2, 2.0 or 2.1, and none of jobs, workflows, orbs, executors, commands, setup.',
  knownRole: 'projectBinding',
  knownRoleSummary:
    'Records which CircleCI project this checkout is bound to, written by `circleci project link`. It names gh/example-org/flaky-todo-list in example-org.',
});

describe('ConfigFileSwitcher', () => {
  beforeEach(() => {
    useAppStore.setState({
      configPath: '/repo/.circleci/config.yml',
      files: [],
      docCache: {},
      isDirty: false,
      status: 'ready',
    });
  });

  it('renders nothing when the directory has one file, or none', () => {
    useAppStore.setState({ files: [CONFIG] });
    const { container, unmount } = render(<ConfigFileSwitcher />);
    expect(container).toBeEmptyDOMElement();
    // Unmounted before the next store write: this component now holds local
    // state (the reveal toggle), so updating the store underneath a mounted
    // instance is an un-acted React update.
    unmount();

    useAppStore.setState({ files: [] });
    const { container: container2 } = render(<ConfigFileSwitcher />);
    expect(container2).toBeEmptyDOMElement();
  });

  it('renders one button per file and marks the active one pressed', () => {
    useAppStore.setState({ files: [CONFIG, CONTINUE_CONFIG] });

    render(<ConfigFileSwitcher />);

    const active = screen.getByRole('button', { name: 'config.yml' });
    const other = screen.getByRole('button', {
      name: 'continue-config.yml',
    });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(other).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a different file calls switchFile with its path', async () => {
    useAppStore.setState({ files: [CONFIG, CONTINUE_CONFIG] });
    const switchFile = vi.fn<(path: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    useAppStore.setState({ switchFile });

    render(<ConfigFileSwitcher />);
    await userEvent.click(
      screen.getByRole('button', { name: 'continue-config.yml' }),
    );

    expect(switchFile).toHaveBeenCalledWith(
      '/repo/.circleci/continue-config.yml',
    );
  });

  it('shows a dirty indicator for the active file from top-level isDirty, and for an inactive one from its cached snapshot', () => {
    useAppStore.setState({
      isDirty: true,
      files: [CONFIG, CONTINUE_CONFIG],
      docCache: {
        '/repo/.circleci/continue-config.yml': {
          doc: null,
          text: 'x',
          savedText: 'y',
          parseError: null,
          isDirty: true,
          undoStack: [],
          redoStack: [],
          canUndo: false,
          canRedo: false,
          validation: { state: 'idle', errors: [] },
          editError: null,
          selectedWorkflow: null,
          selectedNodeId: null,
          workflowSelected: false,
        },
      },
    });

    render(<ConfigFileSwitcher />);

    expect(screen.getByRole('button', { name: 'config.yml' }).title).toContain(
      'unsaved',
    );
    expect(
      screen.getByRole('button', { name: 'continue-config.yml' }).title,
    ).toContain('unsaved');
  });

  // Issue #135: the reported defect, at the level the owner actually saw it.
  describe('YAML that is not a CircleCI config', () => {
    it('is hidden from the switcher by default', () => {
      useAppStore.setState({ files: [CONFIG, CONTINUE_CONFIG, GOSS] });

      render(<ConfigFileSwitcher />);

      expect(
        screen.getByRole('button', { name: 'config.yml' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'continue-config.yml' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('goss.yaml')).not.toBeInTheDocument();
    });

    it('is revealed by the affordance, labelled with the host’s own reason', async () => {
      useAppStore.setState({ files: [CONFIG, GOSS] });

      render(<ConfigFileSwitcher />);

      const reveal = screen.getByRole('button', {
        name: 'Show 1 other YAML file',
      });
      expect(reveal).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(reveal);

      const revealed = screen.getByRole('button', { name: /^goss\.yaml/ });
      // The reason travels from the host rather than being re-derived here,
      // so the switcher and the pane can never disagree about why.
      expect(revealed).toHaveAccessibleName(/not a CircleCI config/);
      expect(revealed).toHaveAccessibleName(/No CircleCI structure/);
      expect(revealed.title).toContain('No CircleCI structure');
      expect(
        screen.getByRole('button', { name: 'Hide 1 other YAML file' }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    it('pluralizes the affordance and counts only the hidden files', () => {
      useAppStore.setState({
        files: [
          CONFIG,
          GOSS,
          file({
            path: '/repo/.circleci/.service/goss.yaml',
            relPath: '.service/goss.yaml',
            isPrimary: false,
            isConfig: false,
            configReason: 'No CircleCI structure: ...',
          }),
        ],
      });

      render(<ConfigFileSwitcher />);

      expect(
        screen.getByRole('button', { name: 'Show 2 other YAML files' }),
      ).toBeInTheDocument();
    });

    it('stays visible while it is the open file, even collapsed', () => {
      // A revealed non-config the user opened must not vanish from its own
      // switcher: there would be no way back to the file being edited.
      useAppStore.setState({
        configPath: GOSS.path,
        files: [CONFIG, GOSS],
      });

      render(<ConfigFileSwitcher />);

      expect(
        screen.getByRole('button', { name: /^goss\.yaml/ }),
      ).toHaveAttribute('aria-pressed', 'true');
      // ...and it is not counted as hidden, so no reveal is offered.
      expect(
        screen.queryByRole('button', { name: /^Show/ }),
      ).not.toBeInTheDocument();
    });

    it('keeps the switcher rendered for a lone config with a filtered sibling, so the reveal stays reachable', () => {
      useAppStore.setState({ files: [CONFIG, GOSS] });

      render(<ConfigFileSwitcher />);

      expect(
        screen.getByRole('group', { name: 'Open config file' }),
      ).toBeInTheDocument();
    });
  });

  // Issue #198's item 4. The switcher already excluded `info.yml`; excluding is
  // not the same as naming, and a file whose purpose the host knows should not be
  // described as unexplained other YAML.
  describe('a named non-config (the project binding)', () => {
    it('is still hidden by default, because it is still not a config', () => {
      useAppStore.setState({ files: [CONFIG, PROJECT_BINDING] });

      render(<ConfigFileSwitcher />);

      expect(
        screen.queryByRole('button', { name: /^info\.yml/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Show 1 other YAML file' }),
      ).toBeInTheDocument();
    });

    it('names what it is instead of only saying what it is not', async () => {
      const user = userEvent.setup();
      useAppStore.setState({ files: [CONFIG, PROJECT_BINDING] });

      render(<ConfigFileSwitcher />);
      await user.click(screen.getByRole('button', { name: /^Show/ }));

      const revealed = screen.getByRole('button', { name: /^info\.yml/ });
      expect(revealed).toHaveAccessibleName(/CircleCI project binding/);
      // The host's own sentence, verbatim -- so this and the host can never
      // disagree about what the file is.
      expect(revealed).toHaveAccessibleName(/circleci project link/);
      expect(revealed.title).toContain('CircleCI project binding');
      // And it does not lead with the least interesting true thing about it.
      expect(revealed).not.toHaveAccessibleName(/not a CircleCI config/);
    });

    it('names it in the reveal affordance, where the count alone understates it', () => {
      useAppStore.setState({ files: [CONFIG, PROJECT_BINDING] });

      render(<ConfigFileSwitcher />);

      expect(screen.getByRole('button', { name: /^Show/ }).title).toContain(
        'info.yml is this checkout’s circleci project binding',
      );
    });
  });
});

// The three shared helpers, unit-tested directly: both forms of the switcher use
// them, and the row form deliberately shows the role only through them (see the
// module's own header on why a row button gains no visible text).
describe('fileTitle / fileLabel / knownRoleName', () => {
  it('leaves a config alone', () => {
    expect(fileTitle(CONFIG, false)).toBe('/repo/.circleci/config.yml');
    expect(fileLabel(CONFIG)).toBeUndefined();
    expect(knownRoleName(CONFIG)).toBeUndefined();
  });

  it('marks unsaved changes on a named file without losing the name', () => {
    const title = fileTitle(PROJECT_BINDING, true);
    expect(title).toContain('(unsaved changes)');
    expect(title).toContain('CircleCI project binding');
  });

  it('falls back to the classifier reason for an unrecognised non-config', () => {
    expect(fileTitle(GOSS, false)).toContain('Not a CircleCI config.');
    expect(fileLabel(GOSS)).toContain('not a CircleCI config');
    expect(knownRoleName(GOSS)).toBeUndefined();
  });

  it('tolerates a named file whose summary the host omitted', () => {
    const withoutSummary = file({
      ...PROJECT_BINDING,
      knownRoleSummary: undefined,
    });
    expect(fileTitle(withoutSummary, false)).toContain(
      'CircleCI project binding.',
    );
    expect(fileLabel(withoutSummary)).toBe(
      'info.yml — CircleCI project binding.',
    );
  });
});
