# Installing circleci-editor

The long-form install guide referenced from the [README](../README.md) and
from this binary's own error message when it can't find a web build. It
covers every install method, how to verify the install, how to uninstall,
and platform-specific notes. For building from source as a contributor, see
[CONTRIBUTING.md](../CONTRIBUTING.md#development-setup) instead.

## Verifying an install

Whichever method you use, verify it the same way:

```shell
circleci-editor --version
```

This prints the version, commit, and build date, e.g.:

```
circleci-editor version v1.2.3 (commit ab12cd3, built 2026-07-27T12:00:00Z)
```

A locally built binary that has not been given `-ldflags` manually prints
`dev` in place of the version — that's expected and not an error;
`task build` sets it from `git describe`.

## Making the CLI plugin path work

None of the methods below register the editor with the CircleCI CLI
explicitly, because there is no registration step. The CircleCI CLI's
plugin mechanism is purely naming-based: any executable named
`circleci-<name>` found on `PATH` becomes runnable as `circleci <name>`.
This tool's binary is named `circleci-editor` for exactly that reason, so as
long as it ends up on your `PATH` under that exact name (which every method
below does), the CircleCI CLI will pick it up automatically — no
`circleci plugin add` or similar command exists or is needed.

Confirm it's wired up correctly:

```shell
circleci editor --version
```

If that fails with "unknown command" while `circleci-editor --version` (the
direct invocation) succeeds, `PATH` most likely lacks the directory the
binary was installed into, or the CircleCI CLI itself is not installed. Run
`which circleci-editor` to check the former, and `which circleci` to check
the latter.

## Method 1: curl-pipe installer

```shell
curl -fsSL https://raw.githubusercontent.com/CircleCI-Labs/circleci-editor/main/scripts/install.sh | sh
```

This script (`scripts/install.sh` in this repository) detects your OS and
architecture, resolves the latest release tag from the GitHub API (or an
explicit version you pass), downloads the matching `.tar.gz` release
archive, verifies its SHA-256 checksum against the release's
`checksums.txt`, and installs the extracted binary to `/usr/local/bin`
(falling back to `~/.local/bin` if that isn't writable).

Options:

```shell
# Install a specific version instead of the latest release.
curl -fsSL .../install.sh | sh -s -- v1.2.3

# Install somewhere other than /usr/local/bin.
INSTALL_DIR="$HOME/bin" curl -fsSL .../install.sh | sh

# See what OS/arch the script detects on this machine, without installing.
curl -fsSL .../install.sh | sh -s -- --print-target

# Full option/flag reference.
curl -fsSL .../install.sh | sh -s -- --help
```

This script is POSIX `sh` (no bashisms), so it works under `dash` and other
minimal shells, not only `bash`. It explicitly does not support Windows —
on Windows, use Method 3 (download a release archive) instead.

## Method 2: `go install`

> **Not recommended: this does not include the web interface, and the
> resulting binary refuses to start rather than pretend otherwise.**
> The browser UI is a generated bundle embedded into the binary at build
> time and is not committed to the repository, so a binary built from the
> module source alone has no UI to serve at all.
>
> Earlier versions of this tool started anyway and served a "web interface
> not built yet" placeholder page — which looks, at a glance, like the app
> loaded. That was judged worse than an outright refusal: a binary built
> this way now exits immediately with an error explaining exactly what's
> missing and how to fix it (build from source, or use a release archive),
> rather than opening a browser tab to something broken. Tracked in
> [issue #37](https://github.com/CircleCI-Labs/circleci-editor/issues/37).
>
> ```console
> $ circleci-editor
> this build has no web interface embedded
> ...
> Error: no web interface embedded
> ```
>
> `circleci-editor --version` still works even on a binary built this
> way — the version check happens before the web-assets check — so it
> remains a valid (if incomplete) way to confirm *that* `go install` worked,
> just not a way to actually use the editor.

```shell
go install github.com/CircleCI-Labs/circleci-editor/cmd/circleci-editor@latest
```

Requires Go 1.26 or newer. Places the binary in `$(go env GOPATH)/bin`
(commonly `~/go/bin`); make sure that directory is on your `PATH`. To
install a specific version instead of the latest commit on the default
branch, replace `@latest` with a tag, e.g. `@v1.2.3`.

## Method 3: download a release archive directly

Visit the
[Releases page](https://github.com/CircleCI-Labs/circleci-editor/releases),
download the archive matching your OS/arch, and extract the
`circleci-editor` binary onto your `PATH`:

| OS      | Arch    | Archive                                              |
| ------- | ------- | ----------------------------------------------------- |
| Linux   | amd64   | `circleci-editor_<version>_linux_amd64.tar.gz`   |
| Linux   | arm64   | `circleci-editor_<version>_linux_arm64.tar.gz`   |
| macOS   | amd64   | `circleci-editor_<version>_darwin_amd64.tar.gz`  |
| macOS   | arm64   | `circleci-editor_<version>_darwin_arm64.tar.gz`  |
| Windows | amd64   | `circleci-editor_<version>_windows_amd64.zip`    |
| Windows | arm64   | `circleci-editor_<version>_windows_arm64.zip`    |

`<version>` is the release tag with any leading `v` stripped (e.g. `1.2.3`
for tag `v1.2.3`). Each release also publishes a `checksums.txt` covering
every archive, if you want to verify the download yourself:

```shell
shasum -a 256 -c checksums.txt --ignore-missing
```

## Method 4: build from source

See [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup) for
prerequisites and the full build. Short version:

```shell
git clone https://github.com/CircleCI-Labs/circleci-editor.git
cd circleci-editor
task web:install
task build
cp bin/circleci-editor /usr/local/bin/
```

**Do not** build with a bare `go build ./cmd/circleci-editor` instead of
`task build` — see [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup)
for why that produces a binary with a placeholder UI instead of the real
one.

## Uninstalling

Remove the binary from wherever you installed it:

```shell
# Wherever `which circleci-editor` points, e.g.:
rm /usr/local/bin/circleci-editor
# or, for a go install:
rm "$(go env GOPATH)"/bin/circleci-editor
```

Optionally, also remove the local orb registry cache (see the README's
[environment variables](../README.md#environment-variables) section):

```shell
rm -rf ~/.cache/circleci-editor
```

Uninstalling does not touch any `.circleci/config.yml` in any of your
projects — the editor never writes anywhere outside the config file(s) you
explicitly open and save.

## Platform notes

* **macOS and Linux** are the primary development and testing targets; the
  Go binary and the web UI are both exercised on these platforms.
* **Windows** is supported for the Go binary specifically — the Go test
  suite runs on Windows in CI — but the web UI and end-to-end browser tests
  currently run on Linux only in CI, so day-to-day coverage of the app's UI
  on Windows is thinner. `scripts/install.sh` does not support Windows at
  all (see Method 1 above); use Method 3's `.zip` archive there instead.
* The editor opens a normal browser tab by default; pass `--app` for a
  chromeless, app-style window if your OS and default browser support it.
