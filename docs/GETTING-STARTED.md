# Getting started with CircleCI Editor

A walkthrough from nothing installed to confidently editing a real
`.circleci/config.yml`. Read it top to bottom the first time; after that the
[Common tasks](#7-common-tasks) recipes are the part worth coming back to.

This guide is task-oriented. For the complete list of flags, environment
variables and installation methods, see the [README](../README.md) and
[INSTALL.md](./INSTALL.md) — this guide links to them rather than repeating
them, so there is only ever one copy to be wrong.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Install it](#2-install-it)
3. [Add a token (and what works without one)](#3-add-a-token-and-what-works-without-one)
4. [Open your first config](#4-open-your-first-config)
5. [The five panes, and when to use each](#5-the-five-panes-and-when-to-use-each)
6. [Your first edit, start to finish](#6-your-first-edit-start-to-finish)
7. [Common tasks](#7-common-tasks)
8. [Running a pipeline from the editor](#8-running-a-pipeline-from-the-editor)
9. [The AI assistant (optional)](#9-the-ai-assistant-optional)
10. [Commands and flags you will actually use](#10-commands-and-flags-you-will-actually-use)
11. [Windows notes](#11-windows-notes)
12. [When something looks wrong](#12-when-something-looks-wrong)

---

## 1. Before you start

**What this is.** A single binary that opens a local web page for editing your
`.circleci/config.yml` visually — a YAML editor, a workflow graph you can drag,
a searchable orb registry, and CircleCI's documentation, side by side.

**What you need:**

- A repository with a `.circleci/` directory. (You don't strictly need a config
  file yet — see [step 4](#4-open-your-first-config).)
- A browser.
- Optionally, the [CircleCI CLI](https://circleci.com/docs/local-cli/) — if you
  have it, the editor becomes `circleci editor` and picks up your token
  automatically.
- Optionally, a CircleCI API token — see [step 3](#3-add-a-token-and-what-works-without-one).

**What you do not need:** a CircleCI account to *start* (though you'll want one
to validate), an internet connection for the core editing features, or any
configuration file of your own. Nothing is deployed and nothing is uploaded.
The editor binds to `127.0.0.1` only.

---

## 2. Install it

### macOS and Linux

The one-liner:

```shell
curl -fsSL https://raw.githubusercontent.com/CircleCI-Labs/circleci-editor/main/scripts/install.sh | sh
```

It detects your OS and architecture, verifies a checksum, and installs to
`/usr/local/bin` — falling back to `~/.local/bin` if that isn't writable.

Verify:

```shell
circleci-editor --version
```

```
circleci-editor version 1.2.0 (commit 7a69d6f…, built 2026-08-07T…)
```

**Prefer Homebrew or a package manager?** There isn't a tap yet. Use the
installer, or [download an archive directly](./INSTALL.md#method-3-download-a-release-archive-directly)
if you'd rather not pipe a script to a shell — a completely reasonable
preference, and the archives are checksummed.

### Windows

The install script does **not** support Windows. Download the `.zip` from the
[releases page](https://github.com/CircleCI-Labs/circleci-editor/releases),
extract it, and put `circleci-editor.exe` somewhere on your `PATH`. Full steps
are in [INSTALL.md](./INSTALL.md#method-3-download-a-release-archive-directly);
see also [Windows notes](#11-windows-notes) below.

### Making `circleci editor` work

If you have the CircleCI CLI, the plugin form works with no extra step — the CLI
discovers plugins by name on your `PATH`, so a binary called `circleci-editor`
*is* the `circleci editor` subcommand. There is no `circleci plugin add`.

```shell
circleci editor --version     # same binary, same flags
```

Running it this way is worth preferring: the CLI passes its own credentials to
the plugin, so if the CLI is authenticated you can skip step 3 entirely.

---

## 3. Add a token (and what works without one)

**The editor is useful without a token.** Editing, the workflow graph, saving,
the YAML round-trip, CircleCI's bundled documentation, and searching the public
orb registry all work with no credential at all.

**A token adds** config validation and compilation (against CircleCI's own
compiler, so the answer is authoritative), config policy checks, your project's
contexts and their variable names, usage-based right-sizing suggestions, your
organization's *private* orbs, and triggering pipelines.

### The easy way: authenticate the CLI

If you have the CircleCI CLI, sign in once and you are done — no token to copy,
paste or store yourself:

```shell
circleci auth login        # opens a browser sign-in
```

Then run the editor through the CLI:

```shell
circleci editor
```

The CLI passes its own credentials to the plugin as `CIRCLECI_TOKEN`, which the
editor reads. (`circleci setting set token` works too, if you would rather give
the CLI a personal API token than sign in through a browser.)

### The other way: export a token yourself

Useful when you are running `circleci-editor` standalone, or in a container or CI
job with no CLI.

CircleCI web app → your avatar → **Personal API Tokens** → **Create New Token**.
Copy it immediately; it is shown once. Then:

```shell
# macOS / Linux — add to ~/.zshrc or ~/.bashrc to persist
export CIRCLE_TOKEN="your-token-here"
```

```powershell
# Windows PowerShell — current session
$env:CIRCLE_TOKEN = "your-token-here"
# …or persist it
[Environment]::SetEnvironmentVariable("CIRCLE_TOKEN", "your-token-here", "User")
```

**Self-hosted CircleCI Server?** Also set `CIRCLE_HOST` to your installation's
hostname. Be aware that Server support is only partly verified — see
[Limitations](../README.md#limitations-and-known-gaps).

### How you can tell

The top bar shows a **token** badge. Without one, features that need it say so
plainly rather than appearing broken or silently degrading — if something looks
unavailable, the reason is on screen.

---

## 4. Open your first config

From anywhere inside your repository:

```shell
cd my-project
circleci editor
```

You'll see a banner, then your browser opens:

```
circleci-editor 1.2.0
  URL:         http://127.0.0.1:54321
  Config file: /Users/you/my-project/.circleci/config.yml
```

The editor walks *up* from your current directory looking for
`.circleci/config.yml` (or `.yaml`), so you don't have to be at the repository
root.

**No config file yet?** The banner says so and the editor starts anyway. Build
one in the graph and palette, and saving creates the file at the path shown.

**More than one YAML file in `.circleci/`?** A file switcher appears in the top
bar — useful for a `setup: true` config plus the continuation config it hands
off to. The graph, validation and everything else follow whichever file is open.

**Want a specific file?** `circleci editor --config path/to/config.yml`.

---

## 5. The five panes, and when to use each

The window is five panes, each movable and collapsible. The layout preset
switcher in the top bar has **Columns**, **Graph focus** (the default),
**Editor focus**, **Graph only** and **Editor only** — try them; different tasks
genuinely want different shapes.

### Config — the YAML

A full editor with syntax highlighting and completion. Three views:

- **Source** — what you wrote.
- **Compiled** — what CircleCI actually runs, with orbs resolved, parameters
  substituted and matrix jobs expanded. Use this when a config *looks* right but
  behaves oddly. Needs a token.
- **Diff** — your unsaved changes.

Errors are underlined in place, like a spell-check squiggle, as well as listed
in the diagnostics strip beneath.

### Workflow Graph — the picture

Your jobs and workflows as a dependency graph. Drag between nodes to create a
`requires:` edge; a connection that would create a cycle is refused while you're
still dragging, not after. Select a node to open the **inspector** on the right,
where you can rename a job (references update for you), change its executor
image and resource class, and add, remove or reorder steps.

Approval jobs, orb-provided jobs and matrix jobs all render. A `job-groups`
invocation draws its members when you select it.

### Palette — the parts bin

Six drawers to drag from: **Executors**, **Steps**, **Commands**,
**Parameters**, **Contexts** and **Orbs**. The Orbs drawer searches the live
registry — type `slack`, not `circleci/slack`. Required orb parameters are
collected in a form, so you can't end up with an invalid config.

The palette also surfaces right-sizing suggestions when it has enough usage data
(see [Common tasks](#7-common-tasks)).

### Reference — the manual, and your project

Two surfaces, switched in the tab strip:

- **Reference** → **Keys** (the config schema, key by key) and **Guides**
  (CircleCI's own documentation, bundled into the binary — works offline).
- **Project** → **Project**, **Policies** and **Caches** for the project you're
  bound to.

Selecting a key in the editor or the inspector can take you straight to its
documentation, and links that leave the app are marked with an arrow.

### AI Assistant — optional

Off until you give it a key. See [step 9](#9-the-ai-assistant-optional).

---

## 6. Your first edit, start to finish

A deliberately small change, to see how the whole loop feels.

**Goal:** give a job a bigger resource class.

1. **Select the job** in the Workflow Graph. The inspector opens on the right.
2. **Find `Resource class`.** If the job inherits it from an executor, the
   inspector says so and offers **Override for this job** — it will not quietly
   change the executor and affect every other job using it.
3. **Pick a new class.** The list comes from CircleCI's real catalogue, with
   sizes, so `large` versus `xlarge` is a decision you can make rather than
   guess.
4. **Look at the Config pane.** The YAML already changed. There is one document,
   not a form and a file that can disagree.
5. **Click Save.** You get a **diff first** — check that only the line you meant
   to change has changed.
6. **Confirm.** Now the file on disk has changed, and `git diff` shows the same
   one-line change.

That last point is the thing to internalise: **your file comes back as you wrote
it.** Comments, blank lines, key order, quote style, anchors and aliases all
survive, because edits are surgical changes to your document rather than a
regeneration of it. If you column-align your trailing comments, that alignment
survives too.

---

## 7. Common tasks

### Add a job

Drag an executor from the Palette onto the canvas. It becomes a new job with
that executor. Rename it in the inspector, then drag steps in from the Palette's
**Steps** drawer.

### Add an orb, and use one of its jobs

Palette → **Orbs** → search by name (e.g. `slack`). Drag an orb's job onto the
canvas, a command into a job's steps, or an executor onto a job. Required
parameters are collected in a form up front.

*Private orbs need a token; public registry search does not.*

### Wire up dependencies

Drag from one node to another to add `requires:`. To remove one, select the edge
and delete it. Deleting a mid-chain job leaves the graph honestly disconnected
rather than silently re-wiring around it — the graph shows what your config
says.

### Attach a context

Palette → **Contexts** → drag onto a job node, or drop it into the inspector's
**Contexts** field. Once a context is attached, `$NAME` completions inside `run`
command bodies include that context's variable names — so a typo in a secret
name gets caught while you type instead of by a red pipeline. *Needs a token;
only names are ever fetched, never values.*

### Check whether it actually compiles

Validation runs as you type against CircleCI's own compiler, so it is
authoritative rather than an approximation. Errors appear underlined in place
and listed in the diagnostics strip. Switch the Config pane to **Compiled** to
see what CircleCI will really run.

**One trap worth knowing about:** CircleCI's compiler does not check top-level
key names, so `workflow:` instead of `workflows:` compiles as *valid* while
running almost nothing. The editor warns about that itself, in its own voice —
if you see a warning that isn't a compiler error, this is why.

### Check config policies

Reference pane → **Project** → **Policies**. Evaluated against your
organization's real policies, using the compiled config, which is what CircleCI
itself evaluates at trigger time.

### Right-size a job

If the Palette shows a suggestion like *"this job averaged 20% CPU across 14
runs; utilisation suggests `medium` would be enough"*, that comes from your
organization's real usage data. Two things to know:

- The observation and the advice are separate. The utilisation is a measured
  fact; the suggested class is an inference.
- **Availability depends on your plan** and Cloud/Server tier, so the suggestion
  is phrased as an observation rather than an instruction. Check before you
  commit to it.

*Needs a token, and the data warms in the background — it won't be there the
instant you open the editor.*

---

## 8. Running a pipeline from the editor

You can run a pipeline straight from the editor, without leaving it and without
committing first. This is the fastest way to close the loop on a config change:
edit, validate, run, look at the result.

**Unversioned runs are the useful part.** The editor can run *the config
currently in your editor* rather than what's committed — so you can try a change
on real infrastructure before you commit it, which is much quicker than the
commit-push-wait-fix cycle. Handy for a new job, an orb you haven't used before,
or a matrix you want to see expand for real.

To keep that honest, the editor fetches back the config the new pipeline is
actually running and compares it byte-for-byte with what was on your screen, so
you always know exactly what ran.

Triggering is its own explicit action — it isn't part of saving, so saving your
file never starts a build you didn't ask for. And if you'd rather commit first,
that works too: the editor doesn't push for you, so save and use git as normal.

---

## 9. The AI assistant (optional)

Bring your own API key. Everything else in the editor works without it, and the
pane is inert until you configure one.

```shell
circleci editor ai set-key anthropic     # prompts, stores in your keychain
circleci editor ai status                # what's configured, and where from
circleci editor ai remove-key anthropic
```

Or supply one per-session without storing it:

```shell
export CIRCLECI_EDITOR_AI_KEY_ANTHROPIC="sk-…"
```

**What it can do.** Answer questions about the config that's open, grounded in
CircleCI's bundled documentation, and propose changes. Every proposed change
arrives as a **diff you approve** — it never writes to your file directly. With
a token it can also read your pipeline state: *"why did my last build fail?"*
fetches the actual job logs.

It has read access to your pipelines, not write access — actions like triggering,
cancelling or rerunning stay with you, in the editor's own UI. That keeps the
assistant a good thing to ask questions of, and keeps decisions where you can
see them.

**What it sends, and where.** This is the one place your file contents go to a
third party, so it's worth being precise: when you press Send, it sends the open
config's text and path, the other files in `.circleci/`, your job and workflow
names, the current validation result, and a few excerpts of CircleCI's bundled
documentation — to your configured provider, authenticated with your key.
Nothing else in your repository is read for it. CircleCI does not receive it and
neither does this project. Nothing is sent until you press Send. The full
disclosure is in the Reference pane under *What the AI pane sends, and to whom*,
and summarised in the [README](../README.md#what-leaves-your-machine).

---

## 10. Commands and flags you will actually use

```shell
circleci editor                       # open the config found from here
circleci editor start                 # identical; the explicit form
circleci editor --config path/to.yml  # a specific file
circleci editor --port 8080           # a fixed port (default: any free one)
circleci editor --no-browser          # don't open a browser; keeps running
circleci editor --app                 # chromeless app-style window
circleci editor --debug               # print what it's doing and why
circleci editor --version
circleci editor --help
```

Standalone, it's `circleci-editor` with exactly the same flags.

The three worth remembering:

- **`--debug`** — the first thing to try when something is unavailable and you
  want to know why. It names every request and its outcome.
- **`--no-browser`** — for a remote or headless machine; the editor then never
  stops on its own, since nothing may ever connect.
- **`--port`** — when you need a predictable URL, e.g. through an SSH tunnel.

Closing the editor window stops the editor (unsaved changes are confirmed
first). `Ctrl-C` works as you'd expect. Pass `--keep-alive` to stay running
after the window closes.

### Shell completion

Worth two minutes if you'll use it often — `bash`, `zsh`, `fish` and
`powershell` are all supported:

```shell
# zsh — add to ~/.zshrc
source <(circleci-editor completion zsh)

# bash — add to ~/.bashrc
source <(circleci-editor completion bash)

# fish
circleci-editor completion fish | source

# PowerShell — add to your $PROFILE
circleci-editor completion powershell | Out-String | Invoke-Expression
```

Run `circleci-editor completion <shell> --help` for the persistent-install
instructions for your shell.

The complete tables of flags and environment variables are in the
[README](../README.md#flags).

---

## 11. Windows notes

The Go binary is supported and its test suite runs on Windows in CI. The web UI
and browser tests currently run on Linux only in CI, so **day-to-day coverage of
the UI on Windows is thinner** — it works, but it is less exercised than macOS
and Linux. If you hit something, please
[file an issue](https://github.com/CircleCI-Labs/circleci-editor/issues); that
gap is exactly where reports are most useful.

Specifics:

- **Install** by downloading the `.zip` from the releases page. `install.sh`
  does not support Windows.
- **Set the token** with PowerShell's `$env:CIRCLE_TOKEN` or
  `[Environment]::SetEnvironmentVariable(...)` — see
  [step 3](#3-add-a-token-and-what-works-without-one).
- **Paths** are handled natively; use `--config C:\path\to\config.yml` if you
  need to be explicit.
- **`--app`** depends on your default browser supporting an app-style window;
  without it you get an ordinary tab, which is fine.
- **WSL** works well, and gives you the macOS/Linux path: install with the
  one-liner inside your WSL distribution. Note the editor opens a browser on
  the side it runs on, so from WSL you may need to open the printed URL in
  Windows manually.

---

## 12. When something looks wrong

The editor tries never to show a state it can't determine as though it could —
if something is unavailable, it should say why on screen. Start with `--debug`.

| What you see | What it means | What to do |
| --- | --- | --- |
| Banner says no config file found | Nothing named `.circleci/config.yml` or `.yaml` from here up to the repository root | Nothing to fix — saving creates it at the path shown |
| Validation says "unavailable"; token badge warns | No `CIRCLE_TOKEN` | Export it, or run via `circleci editor` |
| `bind: address already in use` | Port taken | `--port` with another, or omit it to auto-pick |
| `Error: no web interface embedded` | Built with `go install` or a bare `go build`, so no UI is embedded | Use the installer or a release archive — see [INSTALL.md](./INSTALL.md) |
| Orb search finds little right after start | Registry cache still warming | Wait a few seconds; certified orbs are searchable almost immediately |
| Right-sizing suggestions absent | Usage data still warming, or no token | Give it a moment; check the token badge |
| Resource class list says it may be older than CircleCI's | The bundled docs snapshot is being used because a refresh couldn't be read | Harmless — the list is still correct as of the release; it is telling you it isn't freshly fetched |
| Browser tab still open after `Ctrl-C` | `Ctrl-C` stops the server, not your browser | Within seconds the tab shows "Connection lost", and offers to download or copy unsaved changes |

Still stuck? [Open an issue](https://github.com/CircleCI-Labs/circleci-editor/issues)
with the `--debug` output. It is genuinely the fastest route to an answer.

---

## Where to go next

- [README](../README.md) — full flag and environment-variable reference, what
  leaves your machine, current limitations
- [INSTALL.md](./INSTALL.md) — every installation method, verification,
  uninstalling
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how it works inside, if you're curious
  or want to contribute
- [CONTRIBUTING.md](../CONTRIBUTING.md) — if you'd like to help

**A note on what this is.** CircleCI Editor is a CircleCI Labs project: built by
engineers at CircleCI, used by real customers, and **not covered by CircleCI
support**. Issues and pull requests are very welcome.
