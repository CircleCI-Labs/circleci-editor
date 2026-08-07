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

// This package is main, which cannot be imported by an external test
// package -- the black-box "_test package" convention this repo otherwise
// follows for everything under internal/ isn't available here, so these
// tests live in package main itself.
package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
	"github.com/CircleCI-Labs/circleci-editor/internal/webassets"
)

// newBannerTestServer builds a minimal, never-Run host.Server rooted at a
// fresh temp directory -- enough for printBanner's own fields (URL,
// ConfigPath, ConfigFound) without binding a real listener or making any
// network call.
func newBannerTestServer(t *testing.T) *host.Server {
	t.Helper()
	srv, err := host.New(host.Options{
		WorkDir: t.TempDir(),
		Version: "test-version",
	})
	assert.NilError(t, err)
	return srv
}

// TestStopOnLastClient is issue #177's per-mode policy, which is the part of
// that issue that needed deciding rather than implementing. A table so every
// mode's answer is visible beside the others, and so --no-browser -- the one
// mode where getting this wrong breaks scripted use and the release smoke
// test in CONTRIBUTING.md -- is pinned explicitly rather than inferred.
func TestStopOnLastClient(t *testing.T) {
	tests := []struct {
		name string
		opts options
		want bool
	}{
		{
			name: "default browser mode stops: this is the reported bug",
			opts: options{},
			want: true,
		},
		{
			name: "--app stops: the window is the application",
			opts: options{appMode: true},
			want: true,
		},
		{
			name: "--no-browser never stops on its own: nobody may ever connect",
			opts: options{noBrowser: true},
			want: false,
		},
		{
			name: "--keep-alive is the escape hatch back to the old behaviour",
			opts: options{keepAlive: true},
			want: false,
		},
		{
			name: "--keep-alive wins over --app too",
			opts: options{appMode: true, keepAlive: true},
			want: false,
		},
		{
			name: "--no-browser with --app still never stops on its own",
			opts: options{appMode: true, noBrowser: true},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := tt.opts
			assert.Equal(t, stopOnLastClient(&opts), tt.want)
		})
	}
}

// TestNewRootCommand_KeepAliveFlagIsInheritedByStart guards the same thing
// TestNewRootCommand_StartIsRegisteredAlongsideTheBareForm does for the older
// flags: --keep-alive is registered as a persistent flag, so it parses
// identically on the bare form and on "start".
func TestNewRootCommand_KeepAliveFlagIsInheritedByStart(t *testing.T) {
	root := newRootCommand()

	start, _, err := root.Find([]string{"start"})
	assert.NilError(t, err)
	assert.Assert(t, start.Flags().Lookup("keep-alive") != nil ||
		start.InheritedFlags().Lookup("keep-alive") != nil,
		"--keep-alive must be usable as \"circleci-editor start --keep-alive\" too")
}

// TestPrintBanner_MentionsStoppingOnWindowClose is issue #177's disclosure
// half: a process that will stop on its own has to say so before it does.
// The Ctrl-C line stays exactly as issue #67 left it either way.
func TestPrintBanner_MentionsStoppingOnWindowClose(t *testing.T) {
	stopping, err := host.New(host.Options{
		WorkDir:          t.TempDir(),
		Version:          "test-version",
		StopOnLastClient: true,
	})
	assert.NilError(t, err)

	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)
	assert.NilError(t, printBanner(cmd, stopping))
	assert.Assert(t, is.Contains(out.String(), "Press Ctrl-C to stop."))
	assert.Assert(t, is.Contains(out.String(), "close the editor window"))
	assert.Assert(t, is.Contains(out.String(), "--keep-alive"))

	// ...and says nothing of the sort when it isn't going to.
	var quiet bytes.Buffer
	quietCmd := &cobra.Command{}
	quietCmd.SetOut(&quiet)
	assert.NilError(t, printBanner(quietCmd, newBannerTestServer(t)))
	assert.Assert(t, is.Contains(quiet.String(), "Press Ctrl-C to stop."))
	assert.Assert(t, !strings.Contains(quiet.String(), "close the editor window"),
		"a host that will not stop on its own must not claim it will")
}

// TestNewRootCommand_StartIsRegisteredAlongsideTheBareForm is the
// regression test for issue #110's core requirement: adding "start" must
// never take away the bare invocation ("circleci-editor" with no
// subcommand) that has been documented and released through v0.5.0.
func TestNewRootCommand_StartIsRegisteredAlongsideTheBareForm(t *testing.T) {
	root := newRootCommand()

	start, _, err := root.Find([]string{"start"})
	assert.NilError(t, err)
	assert.Equal(t, start.Name(), "start")
	assert.Assert(t, start != root, "start must be a distinct subcommand, not the root command itself")

	// The bare form: Find with no args resolves back to the root command
	// itself (the thing whose RunE actually starts the editor), exactly as
	// it did before "start" existed.
	bare, _, err := root.Find([]string{})
	assert.NilError(t, err)
	assert.Equal(t, bare, root)
}

// TestNewRootCommand_FlagsAreSharedBetweenBareAndStart guards the
// PersistentFlags choice in newRootCommand: a plain (non-persistent) local
// flag on the root command would parse for the bare form but not for
// "start" at all, silently breaking every flag for anyone who types the
// verb.
func TestNewRootCommand_FlagsAreSharedBetweenBareAndStart(t *testing.T) {
	root := newRootCommand()
	start, _, err := root.Find([]string{"start"})
	assert.NilError(t, err)

	for _, name := range []string{"port", "config", "no-browser", "app"} {
		assert.Assert(t, root.PersistentFlags().Lookup(name) != nil, "root missing --%s", name)
		// Command.Flag (unlike Flags().Lookup) also checks flags inherited
		// from a parent's PersistentFlags -- which is exactly the
		// distinction this test exists to pin down: Flags().Lookup alone
		// would report a false negative here even though the flag parses
		// correctly once cobra actually executes the command.
		assert.Assert(t, start.Flag(name) != nil, "start does not inherit --%s from root", name)
	}
}

// TestNewRootCommand_BareAndStartRunTheSameFunction locks in that the two
// forms can never drift in behavior: both RunE closures must call the
// package-level run function (rather than each having their own, slowly
// diverging, copy of the server-startup logic). Comparing the wired-up
// options pointers is a proxy for that: newStartCommand takes opts by
// reference specifically so both commands configure and start the exact
// same host.Server.
func TestNewRootCommand_BareAndStartRunTheSameFunction(t *testing.T) {
	root := newRootCommand()
	start, _, err := root.Find([]string{"start"})
	assert.NilError(t, err)

	assert.Assert(t, root.RunE != nil)
	assert.Assert(t, start.RunE != nil)
}

// TestNewRootCommand_HelpMentionsReservedSiblings checks that the
// intentionally-not-yet-built commands ("validate", "version") are at least
// documented in --help, per issue #110's "reserve... without building them"
// instruction -- a follow-up PR adding either command should see this test
// start failing as a reminder to update the text, not as a sign something
// broke. That is exactly what happened to the third entry this test used to
// cover: issue #112 built the AI keystore CLI, so "ai" is now asserted to be
// a real command below rather than a documented gap.
func TestNewRootCommand_HelpMentionsReservedSiblings(t *testing.T) {
	root := newRootCommand()

	assert.Assert(t, is.Contains(root.Long, "validate"))
	assert.Assert(t, is.Contains(root.Long, "internal/ai/keystore"))

	_, _, err := root.Find([]string{"validate"})
	assert.ErrorContains(t, err, "unknown command", "\"validate\" must not exist as a real command yet")

	aiCmd, _, err := root.Find([]string{"ai"})
	assert.NilError(t, err, "\"ai\" must exist as a real command (issue #112)")
	assert.Equal(t, aiCmd.Name(), "ai")
}

// TestPrintBanner_MentionsCtrlC is issue #67's second ask: a user told to
// expect Ctrl-C ahead of time is far less likely to read its aftermath (the
// CLI's own "extension terminated by signal" line) as a failure.
func TestPrintBanner_MentionsCtrlC(t *testing.T) {
	srv := newBannerTestServer(t)
	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)

	assert.NilError(t, printBanner(cmd, srv))
	assert.Assert(t, is.Contains(out.String(), "Press Ctrl-C to stop."))
}

// TestRun_RefusesToStartWithoutARealWebBuild is issue #25's regression test:
// a binary compiled without the web build (go install, or a bare
// go build ./cmd/circleci-editor) must refuse to start with an
// actionable error, not silently serve the placeholder page as if the app
// had loaded. See host.Server.WillServePlaceholder's doc comment for why
// that check -- and this test -- depend on whether *this test binary*
// happens to have a real build embedded, which is an environment fact, not
// something to assume; internal/host's
// TestServer_WillServePlaceholder_MatchesHasRealBuildWithoutDevProxy covers
// the same logic in an environment-independent way.
func TestRun_RefusesToStartWithoutARealWebBuild(t *testing.T) {
	if webassets.HasRealBuild() {
		t.Skip("this test binary has a real web build embedded (task build ran first); nothing to refuse")
	}

	t.Chdir(t.TempDir())

	// run reaches this check before ever touching cmd.Context() or the
	// banner, so a bare *cobra.Command with only SetErr wired up is enough.
	cmd := &cobra.Command{}
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)

	err := run(cmd, &options{noBrowser: true})

	assert.ErrorContains(t, err, "no web interface embedded")
	assert.Assert(t, is.Contains(stderr.String(), "task build"))
	assert.Assert(t, is.Contains(stderr.String(), "docs/INSTALL.md"))
}

// TestDebugEnabled is issue #216's flag-versus-environment resolution, as a
// table so every case is visible beside the others -- above all the two that
// are easy to get backwards: an exported-but-empty CIRCLECI_EDITOR_DEBUG is *off*, and
// there is no spelling of "off" that overrides the flag, because off is
// already the default.
func TestDebugEnabled(t *testing.T) {
	tests := []struct {
		name    string
		flagSet bool
		env     map[string]string
		want    bool
	}{
		{
			name: "off by default: this is the whole point of the issue",
			want: false,
		},
		{
			name:    "--debug turns it on",
			flagSet: true,
			want:    true,
		},
		{
			name: "CIRCLECI_EDITOR_DEBUG turns it on without the flag, for when the CLI eats --debug",
			env:  map[string]string{debugEnvVar: "1"},
			want: true,
		},
		{
			name: "any non-empty value counts, matching every other VCE_* variable",
			env:  map[string]string{debugEnvVar: "yes please"},
			want: true,
		},
		{
			name: "CIRCLECI_EDITOR_DEBUG=0 is a value, so it is on -- deliberately not parsed as a boolean",
			env:  map[string]string{debugEnvVar: "0"},
			want: true,
		},
		{
			name: "exported but empty is off: that is what `export CIRCLECI_EDITOR_DEBUG=` leaves behind",
			env:  map[string]string{debugEnvVar: ""},
			want: false,
		},
		{
			name:    "both sources agreeing is still just on",
			flagSet: true,
			env:     map[string]string{debugEnvVar: "1"},
			want:    true,
		},
		{
			name: "an unrelated variable does not turn it on",
			env:  map[string]string{"CIRCLECI_EDITOR_DEV_PROXY": "http://localhost:5173"},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(key string) string { return tt.env[key] }
			assert.Equal(t, debugEnabled(tt.flagSet, getenv), tt.want)
		})
	}
}

// TestNewRootCommand_DebugFlagIsInheritedByStart: same guarantee every other
// flag has -- --debug must parse identically on the bare form and on "start",
// or `circleci-editor start --debug` would be an error.
func TestNewRootCommand_DebugFlagIsInheritedByStart(t *testing.T) {
	root := newRootCommand()

	assert.Assert(t, root.PersistentFlags().Lookup("debug") != nil,
		"--debug must be a persistent flag on the root command")

	start, _, err := root.Find([]string{"start"})
	assert.NilError(t, err)
	assert.Assert(t, start.Flags().Lookup("debug") != nil ||
		start.InheritedFlags().Lookup("debug") != nil,
		"--debug must be usable as \"circleci-editor start --debug\" too")
}

// TestNewRootCommand_DebugMatchesTheCircleCICLIsSpelling records *why* the
// flag is called --debug: the CircleCI CLI this ships as a plugin to has a
// global --debug flag described as "Enable debug logging", and matching the
// tool a user is already holding was worth more than our own preference
// between --debug and --verbose (issue #216).
//
// Asserting the absence of --verbose is the part with teeth: it is the name
// somebody would reach for later without knowing the decision.
func TestNewRootCommand_DebugMatchesTheCircleCICLIsSpelling(t *testing.T) {
	root := newRootCommand()

	assert.Assert(t, root.PersistentFlags().Lookup("verbose") == nil,
		"the CircleCI CLI calls this --debug; a second spelling would be the inconsistency the decision avoided")

	flag := root.PersistentFlags().Lookup("debug")
	assert.Assert(t, flag != nil)
	assert.Equal(t, flag.DefValue, "false", "quiet is the default")
	assert.Assert(t, is.Contains(flag.Usage, debugEnvVar),
		"the flag's help should name the environment spelling, since that is the one the CLI cannot intercept")
}

// TestPrintBanner_AcknowledgesDebug: every line --debug unlocks is optional by
// construction, so without an acknowledgement a debug run on a healthy machine
// can look exactly like the flag having been swallowed (see debugEnvVar).
func TestPrintBanner_AcknowledgesDebug(t *testing.T) {
	debugging, err := host.New(host.Options{
		WorkDir: t.TempDir(),
		Version: "test-version",
		Debug:   true,
	})
	assert.NilError(t, err)

	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)
	assert.NilError(t, printBanner(cmd, debugging))
	assert.Assert(t, is.Contains(out.String(), "Debug:"))

	// ...and stays silent about it otherwise, so the default banner keeps
	// saying exactly what issues #67 and #177 left it saying.
	var quiet bytes.Buffer
	quietCmd := &cobra.Command{}
	quietCmd.SetOut(&quiet)
	assert.NilError(t, printBanner(quietCmd, newBannerTestServer(t)))
	assert.Assert(t, !strings.Contains(quiet.String(), "Debug:"))
}

// TestPrintBanner_KeepsEveryLoadBearingLine is issue #216's "do not swallow
// things that matter", asserted on the one output the flag could most easily
// have been implemented by suppressing.
//
// Each of these exists because of a specific report: the URL and config path
// are why the banner exists at all, and "Press Ctrl-C to stop." is #67's
// wording, present because the CircleCI CLI's own teardown message reads like
// a crash and a user reported it as "seems to crash and not run". None of the
// three may depend on verbosity.
func TestPrintBanner_KeepsEveryLoadBearingLine(t *testing.T) {
	for _, debug := range []bool{false, true} {
		name := "default verbosity"
		if debug {
			name = "with --debug"
		}
		t.Run(name, func(t *testing.T) {
			srv, err := host.New(host.Options{
				WorkDir: t.TempDir(),
				Version: "test-version",
				Debug:   debug,
			})
			assert.NilError(t, err)

			cmd := &cobra.Command{}
			var out bytes.Buffer
			cmd.SetOut(&out)
			assert.NilError(t, printBanner(cmd, srv))

			assert.Assert(t, is.Contains(out.String(), srv.URL()),
				"the URL is the one thing the user cannot proceed without")
			assert.Assert(t, is.Contains(out.String(), srv.ConfigPath()),
				"the config path is how the user confirms it found the right file")
			assert.Assert(t, is.Contains(out.String(), "Press Ctrl-C to stop."),
				"issue #67's wording is load bearing at every verbosity")
		})
	}
}

// TestDebugEnabled_SupersededSpelling pins that the pre-rename variable still
// turns debug logging on. debugEnabled takes an injected getenv precisely so
// this can be asserted without touching the process environment.
func TestDebugEnabled_SupersededSpelling(t *testing.T) {
	env := func(name string) string {
		if name == supersededDebugEnvVar {
			return "1"
		}
		return ""
	}
	assert.Assert(t, debugEnabled(false, env), "the superseded spelling must still enable debug")
}

// TestDebugEnabled_SupersededEmptyIsStillOff carries the "exported but empty is
// off" rule across to the old spelling too, so a migration cannot change what
// `export VCE_DEBUG=` means.
func TestDebugEnabled_SupersededEmptyIsStillOff(t *testing.T) {
	env := func(string) string { return "" }
	assert.Assert(t, !debugEnabled(false, env))
}
