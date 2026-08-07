// Copyright (c) 2026 Circle Internet Services, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// SPDX-License-Identifier: MIT

// Command circleci-editor boots a local HTTP server that serves a
// visual editor for a repository's .circleci/config.yml and opens it in the
// user's browser. It is designed to be invoked directly, or installed as a
// CircleCI CLI plugin and run as `circleci editor`.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// version, commit, and date are set via -ldflags at build time.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// noWebBuildMessage is printed verbatim by run when
// host.Server.WillServePlaceholder reports that this binary was compiled
// without the web build having run first (issue #25). Kept as a top-level
// constant, rather than inline in run, so TestRun_RefusesToStartWithoutARealWebBuild
// and a human reading this file see the exact same text.
const noWebBuildMessage = `this build has no web interface embedded

circleci-editor embeds its browser UI at build time (go:embed from
internal/webassets/dist), and that bundle is not committed to the
repository -- only "task build" (or "pnpm --dir web build" run before "go
build") produces it. This binary was built some other way, most likely
"go install" or a bare "go build ./cmd/circleci-editor", so it would
otherwise start and silently serve a placeholder page instead of the real
editor.

To fix this:
  git clone https://github.com/CircleCI-Labs/circleci-editor.git
  cd circleci-editor
  task build
  cp bin/circleci-editor <somewhere on your PATH>

See docs/INSTALL.md for every supported install method, and issue #25 for
why "go install" isn't one of them.
`

func main() {
	if err := newRootCommand().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

// options holds the resolved CLI flag values for the root command.
type options struct {
	port       int
	configPath string
	noBrowser  bool
	appMode    bool
	keepAlive  bool
	debug      bool
}

// debugEnvVar is the environment-variable spelling of --debug (issue #216),
// following this project's existing VCE_* convention (CIRCLECI_EDITOR_DEV_PROXY,
// CIRCLECI_EDITOR_GUIDES_NO_REFRESH, CIRCLECI_EDITOR_AI_KEYSTORE_BACKEND).
//
// It exists alongside the flag, not instead of it, for one specific reason:
// --debug is *also* a global flag on the CircleCI CLI this ships as a plugin
// to, so `circleci editor --debug` is ambiguous about which of the two
// programs is meant to consume it. The env var is the spelling that cannot be
// intercepted, and the one to reach for in that arrangement or in a script
// that cannot easily change an argument list.
//
// Any non-empty value enables it, matching how every other VCE_* variable in
// this project and every boolean variable in the CircleCI CLI's own
// environment (CIRCLE_NO_COLOR, CIRCLE_NO_INTERACTIVE, ...) is read: "set to
// any value". Deliberately not parsed as a boolean, so CIRCLECI_EDITOR_DEBUG=0 does not
// silently mean "on" to us and "off" to somebody's shell script -- see
// debugEnabled.
const debugEnvVar = "CIRCLECI_EDITOR_DEBUG"

// supersededDebugEnvVar is the pre-rename spelling, still honoured with a
// deprecation warning -- see internal/envcompat.
const supersededDebugEnvVar = "VCE_DEBUG"

// debugEnabled resolves whether debug output is on, from the flag and the
// environment. A pure function of both so it can be tested without a server,
// a browser, or t.Setenv ordering hazards on Windows.
//
// The flag wins when it is set, in the sense that either source turning it on
// turns it on: there is no --no-debug, because the default *is* off and the
// only reason to name a source of "off" would be to override an inherited
// environment -- for which unsetting the variable is the obvious answer.
//
// CIRCLECI_EDITOR_DEBUG="" is off, not on. An exported-but-empty variable is what a shell
// leaves behind after `export CIRCLECI_EDITOR_DEBUG=` or what CI injects for an unset
// value, and treating that as "on" would turn the flag on for people who
// meant the opposite.
func debugEnabled(flagSet bool, getenv func(string) string) bool {
	if flagSet || getenv(debugEnvVar) != "" {
		return true
	}
	// The superseded spelling still works. Warned about here rather than in
	// envcompat because this reads through an injected getenv so the decision
	// stays testable without touching the process environment.
	if getenv(supersededDebugEnvVar) != "" {
		warnSupersededDebugEnvVar()
		return true
	}
	return false
}

// stopOnLastClient decides whether this invocation stops when the last
// editor window closes (issue #177). It is the entire per-mode policy, in
// one place, and a pure function so it can be tested without starting a
// server or a browser:
//
//   - Default (this process opens a browser for the user): yes. This is the
//     mode the report came from -- close the Chrome window and "the little
//     program" is still running in a terminal nobody is looking at any
//     more. The "I might reopen that tab" case is covered by a grace period
//     rather than by refusing to exit at all; see lastClientGrace in
//     internal/host/clients.go for how long and why.
//   - --app: yes, and less debatably. The chromeless window *is* the
//     application, so closing it is a quit -- and since issue #216 it waits
//     exactly as long as a browser tab does, because the owner chose one
//     number for both.
//   - --no-browser: never. That flag's whole premise is that this process
//     does not know whether a browser will ever attach -- scripts use it,
//     CONTRIBUTING.md's release smoke test uses it, and so does anyone
//     driving the API by hand or attaching a browser later. A host that
//     stopped because nobody happened to be connected would break every one
//     of those, so the flag that says "I'll handle the browser" also means
//     "I'll handle stopping you". (internal/host will not exit before some
//     client has connected either -- see clientTracker -- but this is the
//     rule that makes it true by policy rather than by luck.)
//   - --keep-alive: never, in any mode. The escape hatch for anyone who
//     wants the pre-#177 behaviour: leave the host up across a browser
//     restart, keep it in a long-lived tmux pane, whatever the reason.
func stopOnLastClient(opts *options) bool {
	return !opts.keepAlive && !opts.noBrowser
}

func newRootCommand() *cobra.Command {
	opts := &options{}

	cmd := &cobra.Command{
		Use:   "circleci-editor",
		Short: "Visually edit your CircleCI config",
		Long: `circleci-editor visually edit your CircleCI config.

It starts a local web server, opens your browser to a visual editor for
your repository's .circleci/config.yml, and lets you edit it without
hand-writing YAML.

When installed on your PATH as a CircleCI CLI plugin, it can also be run
as:

  circleci editor

Running either form with no subcommand starts the editor -- exactly like
running "start" explicitly (see below). The bare form is kept working
because it's what has been documented and released through v0.5.0;
breaking it to gain a verb would be a poor trade. "start" exists so this
command has room to grow the way "circleci mcp server start" does, without
ever taking the bare form away.

"ai" manages the AI pane's provider API key (see internal/ai/keystore)
from the terminal, without opening the pane's settings in a browser:

  circleci-editor ai status
  circleci-editor ai set-key anthropic
  circleci-editor ai remove-key anthropic

Planned, not yet implemented: "validate" (compile the config against
CircleCI without opening a browser) and "version" (structured build info
outside the existing --version flag).`,
		Version: fmt.Sprintf("%s (commit %s, built %s)", version, commit, date),
		// Both true: main() is the single place that prints a returned
		// error (see below) -- without SilenceErrors, cobra's own
		// Execute() would print "Error: <err>" itself before returning it,
		// so the user would see every error duplicated on stderr.
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd, opts)
		},
	}

	// PersistentFlags, not Flags: these must parse identically whether the
	// user invokes the bare root command (e.g. "circleci-editor
	// --port 8080") or the "start" subcommand added below (e.g.
	// "circleci-editor start --port 8080") -- a plain local flag on
	// the root command would not be inherited by "start" at all.
	cmd.PersistentFlags().IntVarP(&opts.port, "port", "p", 0, "port to listen on (0 = pick a free port)")
	cmd.PersistentFlags().StringVarP(&opts.configPath, "config", "c", "", "path to config.yml (default: discover by walking up from cwd)")
	cmd.PersistentFlags().BoolVar(&opts.noBrowser, "no-browser", false, "do not automatically open a browser")
	cmd.PersistentFlags().BoolVar(&opts.appMode, "app", false, "open in a chromeless app-style browser window")
	cmd.PersistentFlags().BoolVar(&opts.keepAlive, "keep-alive", false, "keep running after the editor window is closed (default: stop; always implied by --no-browser)")
	// Named --debug, not --verbose, because that is what the CircleCI CLI
	// this ships as a plugin to calls its own global flag, with the
	// description "Enable debug logging" -- verified against the installed
	// CLI's own help output rather than assumed. Consistency with the tool a
	// user is already holding beats our own preference between the two words
	// (issue #216), and it means `circleci --debug ...` and
	// `circleci-editor --debug` mean the same thing. See debugEnvVar
	// for the environment spelling and why it also exists.
	cmd.PersistentFlags().BoolVar(&opts.debug, "debug", false, "enable debug logging (also "+debugEnvVar+"=1); the default prints the banner and anything actionable, nothing more")

	cmd.AddCommand(newStartCommand(opts))
	cmd.AddCommand(newAICommand())

	return cmd
}

// newStartCommand builds the "start" subcommand (issue #110): the explicit,
// primary-verb form of what the bare command already does, matching the
// shape of the CircleCI CLI's own "circleci mcp server start". It shares
// opts (and therefore every flag) with the root command via the pointer
// passed in, and calls the exact same run function, so the two forms can
// never drift apart in behavior.
func newStartCommand(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Start the editor",
		Long: `Start the editor.

Equivalent to running circleci-editor with no subcommand at all --
"start" is the explicit spelling for scripts and habits that prefer a verb,
kept alongside (never instead of) the bare form.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd, opts)
		},
	}
}

func run(cmd *cobra.Command, opts *options) error {
	wd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	srv, err := host.New(host.Options{
		Port:             opts.port,
		ConfigPath:       opts.configPath,
		OpenBrowser:      !opts.noBrowser,
		AppMode:          opts.appMode,
		StopOnLastClient: stopOnLastClient(opts),
		Debug:            debugEnabled(opts.debug, os.Getenv),
		Version:          version,
		WorkDir:          wd,
	})
	if err != nil {
		return fmt.Errorf("start server: %w", err)
	}

	// Issue #25: go install (and a bare `go build ./cmd/circleci-editor`)
	// skip the web build, so the SPA go:embeds is just a committed .gitkeep --
	// the resulting binary would otherwise start fine and silently serve a
	// "web interface not built yet" placeholder to every browser tab, which
	// looks like the app loaded and is broken. Refusing to start at all, with
	// an explanation that names the actual fix, was the owner's explicit call
	// over the alternative (committing the built bundle to the repo). The
	// explanation is printed directly rather than
	// carried in the returned error's text: main() prefixes whatever error
	// Execute() returns with a bare "Error: ", which reads badly for
	// several paragraphs, and golangci-lint's revive error-strings check
	// rejects a multi-line, punctuated string there anyway.
	if srv.WillServePlaceholder() {
		// Best-effort, matching the ctx.Err() branch below: if stderr itself
		// is failing there is nothing more useful to do than continue on to
		// the short error this function was already about to return.
		_, _ = fmt.Fprint(cmd.ErrOrStderr(), noWebBuildMessage)
		return errors.New("no web interface embedded")
	}

	if err := printBanner(cmd, srv); err != nil {
		return fmt.Errorf("print startup banner: %w", err)
	}

	ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runErr := srv.Run(ctx)

	// Issue #67: on Ctrl-C, the CircleCI CLI (when this runs as its
	// plugin) prints its own "extension terminated by signal" line while
	// tearing us down -- accurate about *how* it happened, but shaped like
	// a crash report to someone who just pressed Ctrl-C on purpose. We
	// can't edit the CLI's message, but we own everything printed before
	// this process exits, so print our own calmer line first: ctx.Err()
	// being non-nil here means Run's return was caused by the signal (not
	// some unrelated server error), which is exactly the case that message
	// needs to cover. Deliberately printed only *after* srv.Run has
	// finished shutting down, not from a separate goroutine racing it --
	// this process can exit the instant run() returns, and a goroutine that
	// hadn't yet been scheduled would have its output silently dropped
	// (caught by hand: an earlier version of this code raced exactly that
	// way and the line never appeared). Its wording deliberately tells the
	// same story as the browser tab's own disconnected-host banner (see
	// issue #110's frontend work in web/src/host/) -- what the terminal
	// says and what the page says must agree.
	if ctx.Err() != nil {
		// Best-effort: if stdout itself is failing, there is nothing more
		// useful to do about it than continue with the exit this function
		// was already about to perform.
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "\nShutting down circleci-editor. Any open browser tab will say so and let you copy or download unsaved changes; nothing further is written to your config file.")
	}

	// Issue #177's other half of the same courtesy: a process that stops
	// because its window closed has to say so, or the user is left with a
	// terminal that silently returned to a prompt and no way to tell that
	// from a crash. Deliberately a *different* line from the Ctrl-C one
	// above, and reached only when ctx.Err() is nil, so the wording issue
	// #67 settled is untouched -- and this branch clears the error rather
	// than returning it, because this is a normal, requested exit and
	// main() would otherwise print it as "Error: ...".
	//
	// It tells the same story about the config file as the Ctrl-C line and
	// as the browser's own "unsaved changes" prompt: whatever was unsaved
	// was already the subject of a warning in the tab, and nothing is
	// written here.
	if errors.Is(runErr, host.ErrLastClientLeft) {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), "\nThe editor window was closed, so circleci-editor stopped. Nothing further was written to your config file. Start it again whenever you need it, or use --keep-alive to leave it running when the window closes.")
		runErr = nil
	}

	if runErr != nil && !errors.Is(runErr, context.Canceled) {
		return fmt.Errorf("run server: %w", runErr)
	}
	return nil
}

// printBanner prints a friendly startup summary: the URL to open, the
// resolved config path, and warnings about missing config or credentials.
func printBanner(cmd *cobra.Command, srv *host.Server) error {
	var b strings.Builder

	fmt.Fprintf(&b, "circleci-editor %s\n", version)
	fmt.Fprintf(&b, "  URL:         %s\n", srv.URL())
	fmt.Fprintf(&b, "  Config file: %s\n", srv.ConfigPath())

	if !srv.ConfigFound() {
		fmt.Fprintln(&b, "  Warning:     no .circleci/config.yml found yet; one will be created when you save")
	}

	env := host.LoadEnvironment()
	if !env.HasToken() {
		fmt.Fprintln(&b, "  Warning:     no CIRCLE_TOKEN found; validation and orb lookups will be unavailable")
	}

	// Issue #67: a user told to expect Ctrl-C ahead of time is far less
	// likely to read its aftermath (this process exiting, and -- when run
	// as a CircleCI CLI plugin -- the CLI's own "extension terminated by
	// signal" line) as a failure.
	fmt.Fprintln(&b, "  Press Ctrl-C to stop.")

	// Issue #177, same reasoning one step further: a process that will stop
	// on its own should say so before it does, not surprise someone who
	// expected it to still be there. Printed after the Ctrl-C line, and
	// only in the modes it actually applies to, so the line above keeps
	// saying exactly what it always said.
	if srv.StopsOnLastClient() {
		fmt.Fprintln(&b, "               It also stops shortly after you close the editor window (--keep-alive to keep it running).")
	}

	// Issue #216: every line --debug unlocks is optional by construction, so
	// on a healthy machine a debug run and a quiet run can look identical --
	// which is indistinguishable from the flag not having been picked up at
	// all (the realistic way that happens is the CircleCI CLI consuming its
	// own --debug when this runs as its plugin; see debugEnvVar). One line of
	// acknowledgement is much cheaper than someone debugging their debug
	// flag.
	if srv.Debugging() {
		fmt.Fprintln(&b, "  Debug:       on; progress and cache diagnostics will be printed below.")
	}

	_, err := fmt.Fprint(cmd.OutOrStdout(), b.String())
	return err
}

// warnSupersededDebugEnvVar reports the old spelling once. Kept next to
// debugEnabled rather than in internal/envcompat because that helper reads the
// process environment directly, and debugEnabled deliberately takes an injected
// getenv so the flag's precedence can be tested as a pure function.
func warnSupersededDebugEnvVar() {
	supersededDebugOnce.Do(func() {
		// See internal/envcompat for why the write error is ignored.
		_, _ = fmt.Fprintf(os.Stderr, "warning: %s is deprecated and will be removed; use %s instead.\n",
			supersededDebugEnvVar, debugEnvVar)
	})
}

var supersededDebugOnce sync.Once
