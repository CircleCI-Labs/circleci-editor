# Contributing

Thanks for your interest in contributing to the CircleCI Visual Config
Editor. This document covers the ground rules for reporting bugs, filing
issues, submitting pull requests, and building the project from source.

This is a [CircleCI Labs](./README.md) project — maintained by CircleCI
Field Engineering, not CircleCI support — so there's no formal SLA on
issues or pull requests, but they're genuinely welcome.

## Table of Contents

* [Reporting a Bug](#reporting-a-bug)
  * [Security disclosure](#security-disclosure)
* [Creating an Issue](#creating-an-issue)
* [Opening a Pull Request](#opening-a-pull-request)
* [Development Setup](#development-setup)
* [Releasing](#releasing)
* [Third-party attributions](#third-party-attributions)
* [Code of Conduct](#code-of-conduct)
* [License](#license)

## Reporting a Bug

If you've found a bug, please open a [GitHub issue](../../issues/new/choose)
using the bug report template. Include as much detail as you can: your
version of `circleci-editor`, your OS, a minimal config that
reproduces the issue, and the steps you took.

### Security disclosure

This is an unofficial, community-maintained tool, not a CircleCI-supported
product — there's no dedicated security team or bug bounty behind it. If
you believe you've found a security issue, please open a
[GitHub issue](../../issues/new/choose) in this repository, the same as any
other bug. If you'd rather not put the details somewhere public, look for a
maintainer in this repository's `CODEOWNERS` file and reach out directly
first — but please don't file a CircleCI support ticket or use CircleCI's
official security disclosure process for this project; this repository
isn't in scope for either.

## Creating an Issue

Before opening a new issue, please search existing
[issues](../../issues) to see whether it has already been reported. When
filing a new issue, use the appropriate template (bug report or feature
request) and fill it in as completely as possible — this makes it much
easier for maintainers to triage and respond.

### `#nnn` in source comments is history, not a link

This codebase comments heavily, and many of those comments cite an issue
number — `issue #285`, `#104`, `#219`. **Most of those numbers refer to this
project's predecessor repository, not to this one.** They were written while
the work lived elsewhere, and they came across with the code.

They are kept as written, deliberately. The prose around them explains the
reasoning on its own, which is the part worth having; the number is a
footnote about when a decision was made. Rewriting 318 files to strip them
would bury the history of every one of those files in a single mechanical
commit, for a footnote.

So: treat a bare `#nnn` in a comment as provenance, not as somewhere to
click. If you are writing a *new* comment, cite an issue in this repository
or describe the reason instead — a number that resolves to an unrelated
issue is worse than no number at all.

## Opening a Pull Request

1. Fork the repository and create a topic branch off `main`.
2. Make your changes, and where reasonable, reference the issue your
   change addresses (`Fixes #123` or `Refs #123`) in the pull request
   description.
3. Make sure `task check` passes locally before opening the PR — this
   is the same set of checks CI runs (linting, license headers, `go mod
   tidy`, tests, and the web equivalents).
4. Open the pull request against `main`.

### Commit messages and PR titles

This project uses [release-please](https://github.com/googleapis/release-please)
to automate releases from commit history, so **all commits must follow
[Conventional Commits](https://www.conventionalcommits.org/)**.

**It is your PR title that actually matters, not your commits.** Pull
requests are **squash-merged**, and the squash commit's subject — which
GitHub derives from the PR title by default — is the only thing
release-please ever sees; the individual commits inside your branch can be
as tidy or as messy as you like. Concretely: **give your PR a Conventional
Commits title**, e.g. `feat: add support for reusable executors`.

Only the types below are recognised. This list must stay identical to
`release-please-config.json`'s `changelog-sections` — a type missing from
that file is one release-please silently drops from the generated release
notes rather than rejecting:

* `feat:` — a new feature
* `fix:` — a bug fix
* `perf:` — a performance improvement
* `deps:` — a dependency version bump
* `docs:` — documentation only changes
* `chore:` — maintenance work with no production code change
* `refactor:` — a code change that neither fixes a bug nor adds a feature
* `test:` — adding or correcting tests
* `ci:` — changes to CI configuration and scripts
* `build:` — changes affecting the build system or dependencies

A `(scope)` is optional (`fix(dag): ...`), as is a `!` before the colon to
mark a breaking change. GitHub's own auto-generated revert title,
`Revert "<original title>"`, is also accepted as-is.

**This is enforced by CI, not just documented.** The `pr-title-lint` job
(`.circleci/config.yml`, `scripts/check-pr-title.sh`) fails your PR's build
if the title doesn't match. If you rename your PR after that job last ran,
push any new commit (even an empty one, `git commit --allow-empty`) to make
it re-check the new title. A second job, `check-main-history`, independently
re-checks every commit subject actually on `main` since the last tag, as a
backstop against that gap.

## Development Setup

Prerequisites:

* Go 1.26
* Node 22
* [pnpm](https://pnpm.io/) (version pinned in `web/package.json`; Corepack
  activates it automatically if enabled)
* [go-task](https://taskfile.dev/)

```shell
git clone https://github.com/CircleCI-Labs/circleci-editor.git
cd circleci-editor
task tools:install   # install Go dev tools (golangci-lint expected via Homebrew)
task web:install      # install web dependencies
task build            # build the web app and the Go binary
task test             # run the Go test suite
task check            # run everything CI runs
task fix              # auto-fix formatting, license headers, and lint issues
task dev              # run the Go host and the Vite dev server together
```

Run `task` on its own to list all available tasks. See
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for how the pieces of the
project (Go host, embedded SPA, CircleCI API client) fit together.

**Do not** build with a bare `go build ./cmd/circleci-editor` instead of
`task build`. The binary embeds the web app via `go:embed` from
`internal/webassets/dist`, which is empty (aside from a placeholder) until
the web app has actually been built; `task build` runs `task web:build`
first for exactly this reason. A binary built without that step still
starts, but every browser tab it opens shows a "please build the web
assets" placeholder instead of the real UI.

This is also why `go install .../cmd/circleci-editor@latest` (mentioned in
the [README](./README.md#installation)) isn't recommended: it has no source
tree to run the web build in, so the resulting binary has no UI to serve at
all. Rather than start anyway and show a placeholder page that looks like a
broken app, that binary exits immediately with an error explaining why and
pointing back here. Tracked in
[issue #37](https://github.com/CircleCI-Labs/circleci-editor/issues/37).

### Running the browser E2E suite (`pnpm --dir web test:e2e`)

Each run picks its own `vite preview` port automatically (derived from the
process's pid), so concurrent checkouts of this repo — several agent
worktrees on one machine is normal here — never attach to another run's
server and test its bundle instead of yours. You don't need to do anything
for this. Set `CIRCLECI_EDITOR_E2E_PORT` only if you want a fixed, memorable port, e.g.
to point a manual browser tab at the running app while debugging a spec.

## Releasing

Maintainers only — contributors don't need to do anything here beyond
following the [commit message conventions](#commit-messages-and-pr-titles)
above; the rest is automated.

1. Every squash-merge to `main` with a Conventional Commits-formatted
   message is picked up by
   [release-please](https://github.com/googleapis/release-please), run as a
   CircleCI job (`release-please`, in `.circleci/config.yml`) rather than
   `release-please-action`, so this stays on CircleCI like the rest of the
   pipeline. It keeps an open "release PR" up to date with the accumulated
   version bump (config: `release-please-config.json`).
2. A maintainer reviews and merges that release PR — the only manual step
   in the process. Merging it tags a new version (e.g. `v0.13.0`) and
   triggers the release workflow.
3. The `release` job in `.circleci/config.yml` then runs
   [GoReleaser](https://goreleaser.com/) against `.goreleaser.yml` to
   cross-compile `circleci-editor` for `linux`/`darwin`/`windows` on
   `amd64`/`arm64`, package each binary into an archive (with `README.md`
   and `LICENSE` included) alongside a checksums file, and publish a
   GitHub Release with the generated release notes attached.

**The web bundle must be built before that Go build runs.** The binary
embeds the SPA via `go:embed` from `internal/webassets/dist`; GoReleaser
itself only invokes `go build` and has no idea the web app exists. The
release job runs `task web:build` first, in the same workspace, immediately
before invoking `goreleaser release` — otherwise the published binaries
embed the placeholder page instead of the real UI. This ordering
requirement is called out explicitly in a comment at the top of
`.goreleaser.yml`; do not add a `pnpm`/`task web:build` call to that file's
`before.hooks`, since those hooks run once per build target, not once
before the whole release.

If you're testing release config changes locally, `goreleaser check`
validates `.goreleaser.yml`, and `goreleaser release --snapshot --skip=publish
--clean` runs the full pipeline (build, archive, checksum) without
publishing anything. The release smoke test — confirming the archives ship
the real UI, not the placeholder — is exactly `--no-browser` plus a curl
check:

```shell
task web:build
goreleaser release --snapshot --skip=publish --clean
tar -xzf dist/circleci-editor_*_$(go env GOOS)_$(go env GOARCH).tar.gz -C /tmp circleci-editor
/tmp/circleci-editor --no-browser --port 18234 &
curl -s http://127.0.0.1:18234/ | grep -qi 'please build' && echo "BROKEN: placeholder shipped" || echo "OK: real UI"
```

There's no Homebrew tap or other package-manager listing yet — see the
commented-out `brews:` block in `.goreleaser.yml`.

## Third-party attributions

This project's own source is MIT-licensed (see [LICENSE](./LICENSE)). It
also adapts or bundles a few pieces of third-party code and content, listed
here for attribution:

* **`internal/circleci`** is a from-scratch implementation adapted from
  [`circleci-cli`](https://github.com/CircleCI-Public/circleci-cli)'s
  MIT-licensed `internal/httpcl` design (retry policy, header handling,
  error shape) — not a copy of its source; Go's `internal/` import-visibility
  rule blocks importing it directly. See the package doc comment at the top
  of `internal/circleci/client.go`.
* **`internal/schema/schema.json`** is vendored, unmodified, from
  [`circleci-yaml-language-server`](https://github.com/CircleCI-Public/circleci-yaml-language-server)
  (the `schema.json` release asset, version 0.36.1 as of this writing),
  licensed Apache License 2.0. It drives this editor's YAML autocompletion;
  see `internal/schema`'s package doc comment for how to refresh it.
* **elkjs** ([kieler/elkjs](https://github.com/kieler/elkjs)), licensed
  EPL-2.0 OR GPL-3.0-or-later, is bundled unmodified into the web bundle and
  used to compute the workflow graph's automatic layout. Its source is
  available at the URL above; this project's own source remains separately
  MIT-licensed.
* **Inter** and **IBM Plex Mono**
  ([@fontsource/inter](https://www.npmjs.com/package/@fontsource/inter),
  [@fontsource/ibm-plex-mono](https://www.npmjs.com/package/@fontsource/ibm-plex-mono)),
  both licensed under the SIL Open Font License 1.1, are bundled as static
  `.woff2` files into the web bundle — the same way elkjs is, so they are listed
  here for the same reason.
* **`internal/guides/snapshot/`** vendors AsciiDoc source, verbatim and
  unmodified, from [`circleci/circleci-docs`](https://github.com/circleci/circleci-docs)
  — the source of `circleci.com/docs` — and renders it in the editor's
  Reference pane. That repository publishes no LICENSE file, so this use
  rests on an explicit grant of permission from this project's owner, a
  CircleCI employee, rather than a published license. Every vendored file,
  its upstream commit, and a checksum are recorded in
  `internal/guides/snapshot/manifest.json`; a test fails the build if any of
  them drift. `internal/guides/editor/` is this project's own documentation
  about the editor itself, not part of that vendored snapshot, and is
  MIT-licensed like the rest of this repository.

## Code of Conduct

This project and everyone participating in it is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected
to uphold this code.

## License

By contributing to this project, you agree that your contributions will be
licensed under its [MIT License](./LICENSE).
