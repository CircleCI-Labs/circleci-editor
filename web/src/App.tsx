import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '~/design/components/Badge';
import { Button } from '~/design/components/Button';
import { Spinner } from '~/design/components/Spinner';
import { ThemeToggle } from '~/design/components/ThemeToggle';
import { ValidationBadge } from '~/design/components/ValidationBadge';
import { HostGoneOverlay } from '~/host/HostGoneOverlay';
import { useBeforeUnloadGuard } from '~/host/useBeforeUnloadGuard';
import {
  INITIAL_SWITCHER_FIT,
  nextSwitcherFit,
  useAppBarTier,
  type AppBarTier,
  type SwitcherFitReport,
} from '~/layout/appBar';
import { CheckoutIdentity } from '~/layout/CheckoutIdentity';
import { CircleciReachability } from '~/layout/CircleciReachability';
import { ConfigFileSwitcher } from '~/layout/ConfigFileSwitcher';
import { LayoutRoot } from '~/layout/LayoutRoot';
import { PresetSwitcher } from '~/layout/PresetSwitcher';
import { ProjectIdentity } from '~/layout/ProjectIdentity';
import { isSetupConfig } from '~/lib/yaml/documentUtils';
import { AiPane } from '~/panes/ai/AiPane';
import { DagPane } from '~/panes/dag/DagPane';
import { PalettePane } from '~/panes/dag/palette/PalettePane';
import { DocsPane } from '~/panes/docs/DocsPane';
import { YamlPane } from '~/panes/yaml/YamlPane';
import { useAppStore } from '~/state/appStore';

const APP_NAME = 'CircleCI Visual Config Editor';
const APP_NAME_SHORT = 'Config Editor';

/**
 * How much of an absolute config path to show at a given tier. Issue #154:
 * the path is the app bar's lowest-value item and so the first to give ground
 * -- it is already shown in the YAML pane's own header (and, until #253 removed
 * that line, in the AI pane's transparency line too), and its full form is
 * always one hover away here via the `title` below, so shortening it costs a
 * user nothing they can't recover.
 * That ordering is exactly what issue #147 recommended ("let the config path
 * truncate first") and it is what keeps the file switcher -- which is *not*
 * duplicated anywhere -- showing as a row of buttons at more widths.
 */
function displayConfigPath(path: string, tier: AppBarTier): string {
  if (tier === 'full') return path;
  const segments = path.split('/').filter(Boolean);
  const keep = tier === 'compact' ? 2 : 1;
  return segments.slice(-keep).join('/');
}

function AppBar() {
  const meta = useAppStore((state) => state.meta);
  const configPath = useAppStore((state) => state.configPath);
  const doc = useAppStore((state) => state.doc);
  const validation = useAppStore((state) => state.validation);

  // Issues #154/#166: how much of this bar's bounded furniture is shown. The
  // starting point is the bar's own measured width; the file switcher then
  // reports whether its row actually fitted, and the bar steps a tier down if it
  // didn't. See `layout/appBar.ts` for the ladder and for why nothing here
  // predicts what the furniture costs.
  const headerRef = useRef<HTMLElement>(null);
  // Whether the file switcher actually had to fall back to its menu form,
  // reported up by the switcher itself. A collapse steps this bar's own
  // furniture down a tier and lets the row try again -- so a tier is never held
  // at a width where it has squeezed the switcher out, and (issue #166) the bar
  // needs no estimate of what its own furniture costs in order to get that
  // right. See `layout/appBar.ts`.
  const [switcherFit, setSwitcherFit] =
    useState<SwitcherFitReport>(INITIAL_SWITCHER_FIT);
  const reportSwitcherFit = useCallback((collapsed: boolean) => {
    setSwitcherFit((previous) => nextSwitcherFit(previous, collapsed));
  }, []);
  const { tier, settled } = useAppBarTier(headerRef, switcherFit);

  // Issue #106: the open file may be any file in the indexed directory,
  // not only the one this host resolved at startup -- `meta` is loaded
  // once and never changes as the user switches files (see appStore's own
  // `configPath` doc comment), so this comparison is exactly "is the open
  // file the primary one".
  const isPrimaryOpen = meta ? configPath === meta.configPath : true;

  return (
    <header
      ref={headerRef}
      data-app-bar-tier={tier}
      // Published so e2e specs can wait for the bar's *final* arrangement
      // rather than a frame count (issue #166): `false` while the tier probe is
      // still stepping down the ladder to find one where the file switcher's row
      // fits. See `layout/appBar.ts`.
      data-app-bar-settled={settled ? 'true' : 'false'}
      // `overflow-hidden` is a backstop, not the collapse strategy: every
      // group below either shrinks (`min-w-0` + `truncate`) or collapses to a
      // menu, so on any width this app targets nothing needs clipping. It is
      // here so that if some future item *does* overshoot, the failure is a
      // clipped app bar rather than a horizontally-scrolling page -- which is
      // the failure mode this whole change exists to remove. (Both menus in
      // this bar are portaled to `document.body`, so neither is clipped by
      // it -- see `layout/DisclosureMenu.tsx`.)
      // Issue #185: `bg-cc-bg`, not the `bg-cc-panel` this bar used to share
      // with every pane's *body* (and, in light mode, with the editor itself --
      // all three were `--color-white`, i.e. 1.000:1). `--color-cc-bg` is this
      // app's chrome plane now; see `styles.css`'s surface-role table for the
      // rule and the measured separations. Nothing about this bar's *geometry*
      // changes, deliberately: `layout/appBar.ts`'s tier ladder is driven by
      // measured furniture widths, and a colour cannot move them.
      className="flex h-12 shrink-0 items-center justify-between gap-4 overflow-hidden border-b border-cc-border bg-cc-bg px-4"
    >
      {/* The identity group: what this app is and which file is open. Every
          item in here shrinks or shortens before the file switcher does, and
          this is the group a new app-bar item (issue #149's org/project
          display) belongs in -- `min-w-0` and `shrink` mean adding one takes
          space from the *path* first, and then leaves the switcher to notice
          it has less room and collapse itself. Nothing needs retuning for
          that; see `layout/appBar.ts`. */}
      {/* `gap-2` at `tight` rather than `gap-3` (issue #214): four 12px gaps
          become four 8px ones, recovering 16px of what the branch/repository
          cells cost by density rather than by dropping anything. Getting denser
          as the window narrows is what the tersest tier is *for*, and measured,
          those 16px are the difference between an ordinary two-file `.circleci`
          directory keeping its row of buttons at 1024px and losing it. */}
      <div
        className={`flex min-w-0 shrink items-center ${
          tier === 'tight' ? 'gap-2' : 'gap-3'
        }`}
      >
        <span
          className="shrink-0 truncate text-sm font-semibold text-cc-text"
          title={APP_NAME}
        >
          {/* Issue #214: the short name now shows at `compact` as well as
              `tight`, and this is how the branch/repository cells below are
              *paid for* rather than simply added.

              #175's ladder is driven by measured furniture, so new items
              raise every tier's cost and push its threshold up -- which at 1280px
              (a very ordinary laptop width, and Playwright's default viewport)
              would have demoted `compact` to `tight` and taken the preset pills
              and the two-segment config path with it. That is precisely the band
              #154 exists to remove.
              Measured: the full name costs 205px at 14px semibold and the short
              one 96px, so this frees 109px -- more than the 81px the two new
              cells cost. `compact`'s furniture goes *down* rather than up, and
              1280 stays on `compact` with more margin than it had before.
              The app name is the right thing to shorten, on #147's own ordering
              logic: it is the item whose full form tells a user in this app the
              least, it still names the app, and the full form stays in the
              `title` one hover away. `full` keeps it. */}
          {tier === 'full' ? APP_NAME : APP_NAME_SHORT}
        </span>
        {configPath ? (
          <span
            className="truncate font-mono text-xs text-cc-text-muted"
            title={configPath}
          >
            {displayConfigPath(configPath, tier)}
          </span>
        ) : null}
        {/* Issue #106: "maybe a little badge up at the top where the
            config is" -- shown for *any* open file whose top-level
            `setup: true` is set, not only the primary one, since a repo's
            primary `.circleci/config.yml` is itself very often the setup
            config in practice. */}
        {doc && isSetupConfig(doc) ? (
          <Badge tone="info" className="shrink-0">
            Setup config
          </Badge>
        ) : null}
        {/* Issue #149: "I have no clue what project it is on CircleCI or what
            organization it belongs to." One compact element, last in the
            identity group and so immediately left of the file switcher,
            deep-linked to the project in the web UI. Placed here on #154's
            own advice above: it takes its space from the config path first,
            and the switcher then measures the room it has left. See
            `ProjectIdentity` for why "not a CircleCI project" and "couldn't
            reach CircleCI" must not render the same way. */}
        <ProjectIdentity />
        {/* Issue #214: "might be good to also pull in the branch that we're
            currently on... a link to their GitHub or VCS... you can put it up
            at the top where we have example-org." Immediately after the project
            identity, for that reason, and in the same shrinking group so it
            takes its space from the config path first. Renders nothing at all
            outside a checkout, and folds its two cells into one at `tight` --
            see `CheckoutIdentity` for why it is a bounded item at all. */}
        <CheckoutIdentity tight={tier === 'tight'} />
      </div>
      {/* Its own flex child rather than a member of the identity group: it
          owns a `flex-1` slot whose width is therefore the space this bar has
          left over, which is the measurement its collapse decision reads.
          Renders nothing at all for a single-file directory. */}
      <ConfigFileSwitcher onCollapsedChange={reportSwitcherFit} />
      <div className="flex shrink-0 items-center gap-2">
        {/* Issue #214, and it renders *nothing* unless a CircleCI call this app
            made has actually been seen to fail -- so it adds nothing to the
            furniture budget in the healthy case, which is every case the
            responsive specs measure. Placed with the other status badges rather
            than in the identity group: it is a statement about the platform, not
            about this file. See `CircleciReachability` for why this is an
            observed-failure notice and not a status poll. */}
        <CircleciReachability />
        {meta && !meta.configFound ? (
          <Badge tone="warning">No config found</Badge>
        ) : null}
        <ValidationBadge
          state={validation.state}
          reason={validation.reason}
          softenInvalid={!isPrimaryOpen}
        />
        {meta ? (
          <Badge tone={meta.hasToken ? 'success' : 'neutral'}>
            {meta.hasToken ? 'Token configured' : 'No token'}
          </Badge>
        ) : null}
        <PresetSwitcher compact={tier === 'tight'} />
        <ThemeToggle />
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center gap-3 text-sm text-cc-text-muted">
      <Spinner size={20} />
      Loading config…
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-lg border border-cc-danger/40 bg-cc-panel p-6 text-center">
        <p className="mb-1 text-sm font-semibold text-cc-danger">
          Couldn&apos;t load your config
        </p>
        <p className="mb-4 text-xs text-cc-text-muted">{message}</p>
        <Button variant="primary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function App() {
  const status = useAppStore((state) => state.status);
  const error = useAppStore((state) => state.error);
  const load = useAppStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  // Independent of the host-liveness overlay below (see issue #110): this
  // guards the ordinary "closed/reloaded the tab with unsaved changes"
  // case, which can happen with the host very much still alive.
  useBeforeUnloadGuard();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-cc-bg">
      <HostGoneOverlay />
      <AppBar />
      {status === 'loading' ? (
        <LoadingState />
      ) : status === 'error' && error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        // Issue #30: the fixed 3-column grid this used to be is now one of
        // several presets (see `layout/presets`) rendered generically by
        // `LayoutRoot`. `min-h-0` matters here -- without it this flex
        // child's default `min-height: auto` would let tall pane content
        // push it (and the page) taller than the viewport instead of
        // scrolling/clipping within it, which is exactly the horizontal/
        // vertical page-scroll failure mode this layout must never have.
        <main className="min-h-0 flex-1 overflow-hidden p-3">
          <LayoutRoot
            panes={{
              yaml: <YamlPane />,
              ai: <AiPane />,
              dag: <DagPane />,
              docs: <DocsPane />,
              // Issue #88: a real layout pane, not a column `DagPane`
              // renders inline -- see `PalettePane`'s own doc comment for
              // how `DagPane` still supplies its actual content.
              palette: <PalettePane />,
            }}
          />
        </main>
      )}
    </div>
  );
}
