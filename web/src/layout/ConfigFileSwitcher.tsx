/**
 * Issue #106's file switcher: lets the user open any file the host indexed
 * in the same directory as the primary config (`.circleci/`, in the
 * overwhelmingly common case), not just the one it happened to resolve at
 * startup. Modelled on `PresetSwitcher`'s "row of toggle buttons in a
 * `role=group`" shape for the same reason that one gives -- this reads as
 * consistent app-bar chrome rather than a second widget style.
 *
 * Deliberately a flat row, not a tree: the issue's own framing is that a
 * `.circleci` directory is "usually 1-4 files" and a tree is mostly chrome
 * at that size. Escalate to a tree only if real repos turn out to nest
 * deeply -- nothing here forecloses that; `ConfigFileInfo.relPath` already
 * carries the full relative path (including any subdirectory) for a
 * future tree view to group by.
 *
 * Lives in the app bar (`App.tsx`), not beside `DagPane`'s `WorkflowTabs`:
 * the app bar renders unconditionally regardless of which layout preset is
 * active, so "which file am I editing" stays reachable even in a preset
 * that hides the DAG pane entirely. `WorkflowTabs` has no such guarantee.
 *
 * Issue #135 added the split between configs and other YAML. A `.circleci`
 * directory routinely holds YAML that isn't a config at all (the reported
 * case was goss's `goss.yaml`), and listing those as configs was wrong.
 * They are *hidden by default, not dropped*: `ConfigFileInfo.isConfig` is
 * the host's structural judgement, and a wrong one must cost a click rather
 * than make a real config unreachable -- hence the reveal below, and the
 * host's own `configReason` shown on every revealed file instead of a
 * reason re-derived here that could drift from it.
 *
 * Issue #198 added the other half of that: a non-config the host can *name*.
 * `.circleci/info.yml` is `circleci project link`'s record of which CircleCI
 * project this checkout belongs to, and the classifier is quite right that it
 * is not a config -- but "1 other YAML file" is the wrong thing to say about a
 * file whose purpose is known. So `ConfigFileInfo.knownRole` names it, and
 * `knownRoleSummary` (again the host's own words) replaces the generic
 * not-a-config reason.
 *
 * It stays *hidden by default* all the same, and that is deliberate rather than
 * an oversight: naming the file is layered on top of the classification, not
 * instead of it, so the switcher never offers a project binding as though it
 * were something to author. Where the name is shown is decided by width. The
 * **menu** form has vertical room, so the role is a visible second line there.
 * The **row** form is the measured item this whole control's two-form dance is
 * built around (#154/#166) -- adding text to a row button would make
 * every named file push the bar towards a collapse it was audited not to need --
 * so there the role travels in the tooltip and the accessible name, both of
 * which cost no pixels.
 *
 * ---
 *
 * Issue #154 is the reported defect this control was at the centre of: on a
 * narrower window it grew *its own horizontal scrollbar*, because it was the
 * only shrinkable item in a bar of fixed-width furniture and it was
 * `overflow-x-auto`. `config.yml` stayed visible and everything else -- the
 * other configs, and #135's reveal affordance -- was reachable only by
 * scrolling a 265px-wide strip sideways. Nothing was lost, but "which file am
 * I editing, and what else is there" stopped being answerable at a glance,
 * which is the entire function of the control.
 *
 * That scroll region is gone. Instead this renders one of two forms:
 *
 * - the **row** of buttons, when the row's real rendered width fits the space
 *   the app bar has left it; or
 * - a **single menu trigger** naming the open file, with every file (and the
 *   #135 reveal) inside a keyboard-accessible menu, when it doesn't.
 *
 * The choice is *measured*, not keyed off a viewport breakpoint, and that is
 * deliberate: this control's content is unbounded (N files with arbitrary
 * names), so no width threshold could be right for both a two-file directory
 * and a nine-file one. Measuring also means the decision automatically
 * absorbs whatever else the app bar gains later -- a new item leaves this less
 * room, this notices, and it collapses earlier with nothing to retune. See
 * `./appBar` for why the *rest* of the bar does use thresholds.
 *
 * The mechanics of measuring without a feedback loop are worth spelling out,
 * because getting them wrong is how this kind of control ends up flickering
 * between its two forms:
 *
 * - The **slot** (the outer element) is `flex-1` -- `flex: 1 1 0%`. A
 *   zero-basis flex item's size comes entirely from the free space its
 *   siblings leave, never from its own content, so switching forms inside it
 *   cannot change how wide it is. That is what makes the measurement stable
 *   rather than circular.
 * - The **row** is always rendered and always `w-max`, so its natural width is
 *   readable whichever form is showing. When the menu form is active the row
 *   is taken out of flow (`absolute`) and hidden (`invisible`, plus
 *   `aria-hidden`) rather than unmounted: unmounting it would destroy the very
 *   measurement needed to decide when to bring it back, and it is
 *   `visibility: hidden` specifically because that removes it from the
 *   accessibility tree and from tab order while *keeping* its layout box
 *   measurable. The slot's `overflow-hidden` keeps that out-of-flow box from
 *   contributing to any ancestor's scroll width.
 */
import { useLayoutEffect, useState } from 'react';

import type { ConfigFileInfo } from '~/lib/rpc/client';
import { useAppStore } from '~/state/appStore';

import {
  DisclosureMenu,
  menuItemClassName,
  menuSectionClassName,
} from './DisclosureMenu';

/** Pluralizes the reveal affordance's label without a dependency. */
function fileCount(n: number): string {
  return n === 1 ? '1 other YAML file' : `${n} other YAML files`;
}

/** Wider than `DisclosureMenu`'s default: these items are file paths, and
 * `continue-config.yml` alone is 18 monospace characters. */
const FILE_MENU_WIDTH_PX = 248;

const groupClassName =
  'flex items-center gap-0.5 rounded-md border border-cc-border-strong bg-cc-panel-raised p-0.5 text-xs';

/** The dirty-state dot shown next to a file's name in either form. */
function DirtyDot({ onAccent }: { onAccent: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${onAccent ? 'bg-cc-on-accent' : 'bg-cc-warning'}`}
    />
  );
}

/** The short name for a file whose role the host recognised (issue #198), or
 * `undefined` for everything else.
 *
 * A lookup rather than the host's own string because this one has to be *short*:
 * it is a label beside a file name, while `knownRoleSummary` is the sentence that
 * explains it. The host still owns the explanation; this owns the noun. */
const KNOWN_ROLE_NAMES: Record<
  NonNullable<ConfigFileInfo['knownRole']>,
  string
> = {
  projectBinding: 'CircleCI project binding',
};

export function knownRoleName(file: ConfigFileInfo): string | undefined {
  return file.knownRole ? KNOWN_ROLE_NAMES[file.knownRole] : undefined;
}

/** `title` text for one file: its full path, whether it has unsaved changes,
 * and (for a non-config) either the host's name for what the file *is* or its
 * reason for classifying it as not a config. Shared by both forms so the two
 * can't drift. */
export function fileTitle(file: ConfigFileInfo, dirty: boolean): string {
  const dirtySuffix = dirty ? ' (unsaved changes)' : '';
  if (file.isConfig) return `${file.path}${dirtySuffix}`;

  const role = knownRoleName(file);
  if (role) {
    // Deliberately does not open with "Not a CircleCI config": true, and the
    // least interesting thing about a file whose purpose is known.
    return `${file.path}${dirtySuffix}\n${role}. ${file.knownRoleSummary ?? ''}`.trimEnd();
  }
  return `${file.path}${dirtySuffix}\nNot a CircleCI config. ${file.configReason}`;
}

/** Accessible name for one file, or `undefined` to let the visible label be
 * the name. Only non-configs need an explicit one: it starts with the visible
 * label (so "label in name" holds) and adds the host's reason, which is the
 * thing a screen-reader user would otherwise only get from the tooltip. */
export function fileLabel(file: ConfigFileInfo): string | undefined {
  if (file.isConfig) return undefined;

  const role = knownRoleName(file);
  if (role) {
    return `${file.relPath} — ${role}. ${file.knownRoleSummary ?? ''}`.trimEnd();
  }
  return `${file.relPath} — not a CircleCI config. ${file.configReason}`;
}

/** Renders nothing for a single-file directory: there is no *choice* to expose, so a switcher with one option would be chrome with no function -- unlike `WorkflowTabs`' deliberate "always visible, even for one" rule (issue #49), which exists to surface a hidden multi-workflow *capability*. A single config file isn't a hidden capability; it's just the file. */
export function ConfigFileSwitcher({
  onCollapsedChange,
}: {
  /**
   * Reports whether this control actually had to fall back to its menu form,
   * so the app bar can step its own furniture down a tier and give the row
   * another chance (see `./appBar`). `false` whenever the row fits, whenever
   * nothing is rendered at all, and -- importantly -- whenever the space
   * available hasn't been measured yet.
   *
   * Issue #166 replaced what this used to report: how many pixels the row
   * *wanted*, which the bar then costed against a hardcoded table of what each
   * of its own tiers costs. That table went stale within days (the validation
   * badge renders nothing for the first second of the app's life, so the table
   * understated the settled bar by 59px), the bar upgraded into a tier with no
   * room, and this control collapsed at a width where the next tier down had
   * 460px to spare. A measured "the row did not fit" cannot go stale the way a
   * predicted cost can.
   *
   * Reported *up* rather than read from a shared store because this is the only
   * consumer and the only producer, and a store would make the direction of the
   * dependency less obvious than a prop does.
   */
  onCollapsedChange?: (collapsed: boolean) => void;
} = {}) {
  const files = useAppStore((state) => state.files);
  const configPath = useAppStore((state) => state.configPath);
  const isDirty = useAppStore((state) => state.isDirty);
  const docCache = useAppStore((state) => state.docCache);
  const switchFile = useAppStore((state) => state.switchFile);
  const status = useAppStore((state) => state.status);
  const [showOthers, setShowOthers] = useState(false);

  // Held as *state* set by callback refs, not as `useRef` -- this component
  // renders nothing at all until the host's directory listing arrives (see the
  // `files.length <= 1` guard below), so with plain refs the measuring effect
  // runs once against two nulls and, having no reason to re-run, never
  // measures anything again. Storing the elements in state re-runs the effect
  // exactly when they attach.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  /**
   * `null` means *undecided*, not `false` -- there has been no usable
   * measurement yet, which is a different state from "the row fits".
   *
   * Keeping them distinct is what stops an unmeasurable moment from being read
   * as evidence either way. Undecided renders the row (the optimistic form,
   * clipped by the slot rather than scrolling, and corrected before paint by the
   * layout effect below) and reports "not collapsed" upwards, so the app bar
   * never demotes a tier on the strength of a measurement that hasn't happened.
   * Equally, an unmeasurable moment must never *leave a stale collapse
   * standing* -- see `measure`.
   */
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const compact = collapsed === true;

  // Declared before the early return below so the hook order is
  // unconditional; it simply has nothing to observe while this component
  // renders nothing.
  useLayoutEffect(() => {
    if (!slot || !row) {
      // Nothing rendered: there is no row that could fail to fit, so this can
      // never be a reason for the bar to give up furniture.
      onCollapsedChange?.(false);
      return;
    }

    function measure() {
      if (!slot || !row) return;
      const available = slot.clientWidth;
      const needed = Math.ceil(row.getBoundingClientRect().width);
      // Both zero in jsdom, which implements no layout at all, and momentarily
      // zero in a real browser if this runs before the bar has been laid out.
      // Either way there is no evidence here, so fall back to *undecided* --
      // deliberately not an early `return`, which would leave a previous
      // `true` latched and the app bar demoting tiers to chase a collapse that
      // nothing had measured. Unit tests therefore always exercise the row
      // form; the collapse is covered against a real browser instead
      // (`e2e/responsive-layout.spec.ts`).
      const next = available > 0 && needed > 0 ? needed > available : null;
      setCollapsed(next);
      onCollapsedChange?.(next === true);
    }

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // Both: the slot changes size when the window -- or anything else in the
    // bar, including a badge that only appears once validation resolves -- does,
    // and the row changes size when the file list or the #135 reveal does.
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    observer.observe(row);
    return () => observer.disconnect();
  }, [slot, row, onCollapsedChange]);

  // Note the condition is still "more than one file in the directory", not
  // "more than one *config*": with a single config and a filtered-out
  // sibling, the row exists solely to carry the reveal affordance below.
  // That is the point -- if the whole switcher vanished, a misclassified
  // config would have nowhere left to be recovered from.
  if (files.length <= 1) return null;

  // A non-config the user deliberately opened stays visible while
  // collapsed: the switcher must always show the file being edited, and
  // there would otherwise be no way back to it.
  const hideable = files.filter(
    (file) => !file.isConfig && file.path !== configPath,
  );
  const visible = showOthers
    ? files
    : files.filter((file) => file.isConfig || file.path === configPath);

  /** The active file's own dirty state lives at the top level of appStore
   * (see `DocSnapshot`'s doc comment); every other file's is whatever was
   * last snapshotted when it was left, or `false` if it has never been
   * opened this session at all. */
  function isFileDirty(file: ConfigFileInfo): boolean {
    return file.path === configPath
      ? isDirty
      : (docCache[file.path]?.isDirty ?? false);
  }

  const revealLabel = showOthers
    ? `Hide ${fileCount(hideable.length)}`
    : `Show ${fileCount(hideable.length)}`;
  // The named files among them, appended to the tooltip so "other YAML files"
  // stops being the only thing said about a file whose purpose is known
  // (issue #198). Nothing is appended when none of them is named.
  const namedHidden = hideable
    .map((file) => {
      const role = knownRoleName(file);
      return role
        ? `${file.relPath} is this checkout’s ${role.toLowerCase()}`
        : '';
    })
    .filter(Boolean);
  const revealTitle =
    (showOthers
      ? `Hide the ${fileCount(hideable.length)} in this directory that ${hideable.length === 1 ? 'is' : 'are'} not a CircleCI config`
      : `${fileCount(hideable.length)} in this directory ${hideable.length === 1 ? 'is' : 'are'} not a CircleCI config`) +
    (namedHidden.length > 0 ? ` — ${namedHidden.join('; ')}` : '');

  const activeFile = files.find((file) => file.path === configPath);
  const otherCount = files.length - 1;

  return (
    <div
      ref={setSlot}
      // `flex-1` (`flex: 1 1 0%`) and `min-w-0`: this slot takes whatever
      // horizontal space the rest of the bar leaves and never claims a
      // minimum of its own, so it can never be the thing that pushes the
      // header wider than the window. `relative` is the containing block for
      // the out-of-flow measuring row; `overflow-hidden` keeps that row's box
      // from reaching any ancestor's scroll width.
      // `min-w-32` (128px) is a floor for the *collapsed trigger*, and it is
      // load-bearing (issue #166). Without it, the app bar's "no terser tier
      // would fit the row either, so hand the width back to the config path"
      // path could leave this slot with almost nothing: measured on the real app
      // at 1366px with a six-file directory, 9px -- a menu trigger clipped to
      // invisibility, i.e. the switcher squeezed out of sight all over again,
      // which is the original #147 defect by another route.
      //
      // It works because `flex-1` here is `flex: 1 1 0%` while the identity
      // group beside it is `min-w-0` and truncates: flexbox honours this floor
      // by taking the difference from a shrinkable sibling, so the config path
      // pays for it. That is the documented priority -- the path is duplicated
      // in the YAML pane header, the switcher is duplicated nowhere.
      className="relative flex min-w-32 flex-1 items-center overflow-hidden"
      data-testid="config-file-switcher"
      data-compact={compact ? 'true' : 'false'}
      // Distinct from `data-compact`, which flattens "fits" and "undecided"
      // into `false`. E2E specs wait on *this* before measuring anything, so
      // they can never assert against a pre-measurement render -- which is what
      // made #166's real cause (a stale cost table in `./appBar`) look like a
      // timing race in CI.
      data-measured={collapsed === null ? 'false' : 'true'}
    >
      <div
        ref={setRow}
        role="group"
        aria-label="Open config file"
        // `aria-hidden` while collapsed so the menu form is the only exposed
        // switcher; `invisible` (`visibility: hidden`) also takes every button
        // in here out of tab order, while keeping the box measurable. See this
        // module's doc comment.
        aria-hidden={compact ? true : undefined}
        // `w-max shrink-0`: both halves matter. `w-max` (`width: max-content`)
        // makes this box exactly as wide as its buttons want to be, and
        // `shrink-0` stops flexbox from then shrinking it back down to the
        // slot -- which is what a flex item does by default, and which would
        // make this measure the space available rather than the space *needed*,
        // i.e. always conclude it fits. Overflowing the slot is fine and
        // deliberate: the slot clips (`overflow-hidden`, never `auto`), and the
        // layout effect that reads this width switches to the menu form before
        // the browser paints.
        className={`${groupClassName} w-max shrink-0 ${
          compact ? 'invisible pointer-events-none absolute left-0 top-0' : ''
        }`}
      >
        {visible.map((file) => {
          const isActive = file.path === configPath;
          const dirty = isFileDirty(file);

          return (
            <button
              key={file.path}
              type="button"
              aria-pressed={isActive}
              aria-label={fileLabel(file)}
              disabled={status === 'loading' && !isActive}
              onClick={() => void switchFile(file.path)}
              title={fileTitle(file, dirty)}
              className={`flex min-w-0 shrink-0 items-center gap-1.5 rounded px-2 py-0.5 font-mono transition-colors ${
                isActive
                  ? 'bg-cc-accent text-cc-on-accent'
                  : 'text-cc-text-muted hover:text-cc-text'
              }${file.isConfig ? '' : ' border border-dashed border-cc-border-interactive'}`}
            >
              {dirty ? <DirtyDot onAccent={isActive} /> : null}
              <span className="max-w-[12rem] truncate">{file.relPath}</span>
            </button>
          );
        })}

        {hideable.length > 0 ? (
          <button
            type="button"
            aria-expanded={showOthers}
            // The visible label is kept short because this row shares the app
            // bar with the config path, the validation badges and the preset
            // switcher. The full wording lives in the accessible name (of
            // which the visible text is a prefix, so "label in name" still
            // holds) and in the tooltip.
            aria-label={revealLabel}
            onClick={() => setShowOthers((shown) => !shown)}
            title={revealTitle}
            // `text-cc-text-muted` rather than `-faint`: this is the same
            // tone the inactive file buttons already use, which is the pair
            // the contrast spec (`e2e/contrast.spec.ts`) already covers on
            // this surface.
            className="shrink-0 rounded px-2 py-0.5 text-cc-text-muted transition-colors hover:text-cc-text"
          >
            {showOthers ? 'Hide' : `Show ${hideable.length} other`}
          </button>
        ) : null}
      </div>

      {compact ? (
        <div
          role="group"
          aria-label="Open config file"
          // `min-w-0`: on a window narrower than anything this app targets, the
          // trigger's file name truncates rather than the whole group being
          // clipped by the slot -- the caret and the count stay `shrink-0`, so
          // what remains is still recognisably the control.
          className={`${groupClassName} min-w-0`}
        >
          <DisclosureMenu
            widthPx={FILE_MENU_WIDTH_PX}
            menuLabel="Open config file"
            triggerTitle={
              activeFile
                ? `${fileTitle(activeFile, isDirty)}\n\n${files.length} YAML files in this directory -- click to choose another.`
                : `${files.length} YAML files in this directory -- click to choose one.`
            }
            // Starts with the trigger's own visible text, so "label in name"
            // holds, and then says what activating it does -- which the
            // visible text alone doesn't.
            triggerLabel={
              activeFile
                ? `${activeFile.relPath} +${otherCount} — open a different config file`
                : `Open a config file — ${files.length} in this directory`
            }
            triggerClassName="flex min-w-0 items-center gap-1.5 rounded bg-cc-accent px-2 py-0.5 font-mono text-cc-on-accent transition-colors"
            triggerContent={
              <>
                {activeFile && isFileDirty(activeFile) ? (
                  <DirtyDot onAccent />
                ) : null}
                <span className="truncate">
                  {activeFile?.relPath ?? 'Config file'}
                </span>
                <span aria-hidden="true" className="shrink-0 opacity-70">
                  +{otherCount}
                </span>
              </>
            }
          >
            {(close) => (
              <>
                {visible.map((file) => {
                  const isActive = file.path === configPath;
                  const dirty = isFileDirty(file);
                  const role = knownRoleName(file);
                  return (
                    <button
                      key={file.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      aria-label={fileLabel(file)}
                      title={fileTitle(file, dirty)}
                      disabled={status === 'loading' && !isActive}
                      onClick={() => {
                        void switchFile(file.path);
                        close();
                      }}
                      // `flex-col items-start` rather than `items-center`: a file
                      // whose role the host named gets a second line for it (see
                      // this module's header on why the row form does not). For
                      // every other file this is one full-width row, exactly as
                      // before.
                      className={`${menuItemClassName} flex flex-col items-start font-mono ${
                        isActive ? 'font-semibold text-cc-accent' : ''
                      }`}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        {dirty ? <DirtyDot onAccent={false} /> : null}
                        <span className="truncate">{file.relPath}</span>
                      </span>
                      {role ? (
                        // `font-normal` so it does not inherit the active file's
                        // semibold, and `font-sans` because this is prose rather
                        // than a path.
                        <span className="w-full truncate font-sans text-2xs font-normal text-cc-text-faint">
                          {role}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {hideable.length > 0 ? (
                  <>
                    <div
                      className="my-1 border-t border-cc-border"
                      role="separator"
                    />
                    <button
                      type="button"
                      role="menuitem"
                      aria-expanded={showOthers}
                      aria-label={revealLabel}
                      title={revealTitle}
                      // Deliberately does *not* close the menu: revealing the
                      // hidden files is a step towards choosing one, so
                      // closing would make the reveal cost two openings.
                      onClick={() => setShowOthers((shown) => !shown)}
                      className={`${menuItemClassName} text-cc-text-muted`}
                    >
                      {revealLabel}
                    </button>
                  </>
                ) : null}
                <div className={menuSectionClassName}>
                  {files.length} files in this directory
                </div>
              </>
            )}
          </DisclosureMenu>
        </div>
      ) : null}
    </div>
  );
}
