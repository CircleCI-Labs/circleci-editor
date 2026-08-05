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

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// fakeKeyForTests is deliberately not shaped like any provider's key: nothing
// in this repository -- fixture, test, comment, or example -- ever contains a
// real credential, and a value this obviously invalid would be useless to
// anyone who found a stray copy of it.
const fakeKeyForTests = "not-a-real-key-cli-test-000000"

// fakeKeyStore is an in-memory keystore.Store that also records what was
// asked of it, so a test can assert e.g. that `remove-key` really called
// Delete even when nothing was stored.
type fakeKeyStore struct {
	keys        map[string]string
	getErr      error
	setErr      error
	deleteErr   error
	ignoreDelet bool // when true, Delete reports success without removing anything
	deletes     []string
	sets        []string
	backend     keystore.Backend
	location    string
}

func newFakeKeyStore() *fakeKeyStore {
	return &fakeKeyStore{
		keys:     map[string]string{},
		backend:  keystore.BackendKeychain,
		location: "fake keychain",
	}
}

func (f *fakeKeyStore) Get(_ context.Context, entry string) (secret.String, bool, error) {
	if f.getErr != nil {
		return secret.String{}, false, f.getErr
	}
	value, ok := f.keys[entry]
	if !ok {
		return secret.String{}, false, nil
	}
	return secret.New(value), true, nil
}

func (f *fakeKeyStore) Set(_ context.Context, entry string, key secret.String) error {
	f.sets = append(f.sets, entry)
	if f.setErr != nil {
		return f.setErr
	}
	f.keys[entry] = key.Reveal() // Test double for a real store's write: the only place a fake key becomes a plain string.
	return nil
}

func (f *fakeKeyStore) Delete(_ context.Context, entry string) error {
	f.deletes = append(f.deletes, entry)
	if f.deleteErr != nil {
		return f.deleteErr
	}
	if !f.ignoreDelet {
		delete(f.keys, entry)
	}
	return nil
}

func (f *fakeKeyStore) Backend() keystore.Backend { return f.backend }
func (f *fakeKeyStore) Location() string          { return f.location }

// testProvider is a stand-in for ai.Provider that names no real model, so
// these tests don't have to be updated when the default model changes.
type testProvider struct{}

func (testProvider) Name() string         { return "anthropic" }
func (testProvider) Label() string        { return "Anthropic" }
func (testProvider) DefaultModel() string { return "test-model" }
func (testProvider) Complete(context.Context, secret.String, string, ai.CompleteRequest) (ai.CompleteResult, error) {
	return ai.CompleteResult{}, errors.New("not used in these tests")
}

// isolateAIEnv makes every test below immune to the developer's own machine:
// no environment-supplied key leaks in, and if a test ever reaches the real
// keystore.Open (rather than a fake), it lands on a file inside a temp
// directory rather than touching a real OS keychain -- which could otherwise
// clobber the key of whoever is running the suite.
func isolateAIEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv(keystore.KeystoreBackendEnvVar, "file")
	t.Setenv(keystore.KeyEnvVar("anthropic"), "")
	return dir
}

// aiTestHarness wires an `ai` command tree onto a fake store and captured
// output streams, which is what every test below asserts against.
type aiTestHarness struct {
	cmd    *cobra.Command
	store  *fakeKeyStore
	deps   *aiDeps
	stdout *bytes.Buffer
	stderr *bytes.Buffer
}

func newAITestHarness(t *testing.T) *aiTestHarness {
	t.Helper()
	isolateAIEnv(t)

	store := newFakeKeyStore()
	deps := &aiDeps{
		openStore:     func() (keystore.Store, error) { return store, nil },
		selectBackend: func() keystore.Selection { return keystore.Selection{Backend: keystore.BackendKeychain} },
		providers:     ai.Registry{"anthropic": testProvider{}},
		readKey: func(*cobra.Command, string) (secret.String, error) {
			return secret.New(fakeKeyForTests), nil
		},
		goos: "linux",
	}

	cmd := newAICommandWithDeps(deps)
	h := &aiTestHarness{cmd: cmd, store: store, deps: deps, stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}}
	cmd.SetOut(h.stdout)
	cmd.SetErr(h.stderr)
	return h
}

// run executes the `ai` tree with args, returning whatever error the
// subcommand returned (cobra is silenced, so nothing is printed by it).
func (h *aiTestHarness) run(t *testing.T, args ...string) error {
	t.Helper()
	h.cmd.SetArgs(args)
	return h.cmd.Execute()
}

// output is everything the command wrote to either stream -- the exact set of
// bytes a user (or a CI log) would see.
func (h *aiTestHarness) output() string { return h.stdout.String() + h.stderr.String() }

func TestNewAICommand_Fn_RegistersTheThreeSubcommands(t *testing.T) {
	root := newRootCommand()

	aiCmd, _, err := root.Find([]string{"ai"})
	assert.NilError(t, err)
	assert.Equal(t, aiCmd.Name(), "ai")

	for _, name := range []string{"status", "set-key", "remove-key"} {
		sub, _, findErr := root.Find([]string{"ai", name})
		assert.NilError(t, findErr)
		assert.Equal(t, sub.Name(), name)
	}
}

// TestNewAICommand_Fn_HasNoFlagThatCouldCarryAKey is the structural guard
// behind "never accept the key as an argument": a --key flag would put the
// secret in the user's shell history and in every process listing for the
// lifetime of the command. If someone adds one for convenience, this fails.
func TestNewAICommand_Fn_HasNoFlagThatCouldCarryAKey(t *testing.T) {
	root := newRootCommand()
	aiCmd, _, err := root.Find([]string{"ai"})
	assert.NilError(t, err)

	for _, cmd := range append([]*cobra.Command{aiCmd}, aiCmd.Commands()...) {
		for _, name := range []string{"key", "api-key", "apikey", "secret", "token", "password"} {
			assert.Assert(t, cmd.Flags().Lookup(name) == nil,
				"%s has a --%s flag; a key must never be passable as an argument", cmd.CommandPath(), name)
		}
	}
}

func TestAISetKey_Fn_StoresTheKeyAndNeverPrintsIt(t *testing.T) {
	h := newAITestHarness(t)

	assert.NilError(t, h.run(t, "set-key", "anthropic"))

	stored, ok, err := h.store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, stored.Reveal(), fakeKeyForTests)

	assert.Assert(t, is.Contains(h.stdout.String(), "Stored an API key for Anthropic"))
	assertNoKeyInOutput(t, h.output())
}

// TestAISetKey_Fn_ErrorFromTheStoreDoesNotEchoTheKey covers the usual leak
// route: an error path that helpfully includes the value it failed to store.
func TestAISetKey_Fn_ErrorFromTheStoreDoesNotEchoTheKey(t *testing.T) {
	h := newAITestHarness(t)
	h.store.setErr = errors.New("keystore: security: exit status 45")

	err := h.run(t, "set-key", "anthropic")
	assert.ErrorContains(t, err, "store the Anthropic key")
	assert.Assert(t, !strings.Contains(err.Error(), fakeKeyForTests), "the error message echoed the key")
	assertNoKeyInOutput(t, h.output())
}

// TestAISetKey_Fn_FailsWhenTheStoreSilentlyStoredNothing is why set-key reads
// back after writing: a backend that returns success without persisting
// anything would otherwise surface much later as "the pane says my key isn't
// configured".
func TestAISetKey_Fn_FailsWhenTheStoreSilentlyStoredNothing(t *testing.T) {
	h := newAITestHarness(t)
	h.deps.openStore = func() (keystore.Store, error) {
		store := newFakeKeyStore()
		// Accepts the write, keeps nothing.
		store.setErr = nil
		store.keys = map[string]string{}
		return &discardingStore{fakeKeyStore: store}, nil
	}

	err := h.run(t, "set-key", "anthropic")
	assert.ErrorContains(t, err, "reports no key for it afterwards")
	assertNoKeyInOutput(t, h.output())
}

// discardingStore accepts Set and stores nothing, simulating a backend that
// reports success it did not deliver.
type discardingStore struct{ *fakeKeyStore }

func (d *discardingStore) Set(context.Context, string, secret.String) error { return nil }

func TestAISetKey_Fn_WarnsWhenAnEnvironmentVariableWins(t *testing.T) {
	h := newAITestHarness(t)
	t.Setenv(keystore.KeyEnvVar("anthropic"), "not-a-real-key-from-the-environment")

	assert.NilError(t, h.run(t, "set-key", "anthropic"))
	assert.Assert(t, is.Contains(h.stdout.String(), "VCE_AI_KEY_ANTHROPIC is set in this environment and takes precedence"))
}

func TestAISetKey_Fn_RejectsAnUnknownProvider(t *testing.T) {
	h := newAITestHarness(t)

	err := h.run(t, "set-key", "not-a-provider")
	assert.ErrorContains(t, err, `unknown provider "not-a-provider"`)
	assert.Assert(t, is.Contains(err.Error(), "anthropic"), "the error should list what is known")
	assert.Equal(t, len(h.store.sets), 0, "nothing should be written for an unknown provider")
}

// TestAISetKey_Fn_AnnouncesTheFileFallbackBeforeReadingTheKey is the "no
// silent degradation" requirement, in the one ordering that matters: the
// warning has to arrive while the user can still press Ctrl-C, not after
// their key is already in a plain file.
func TestAISetKey_Fn_AnnouncesTheFileFallbackBeforeReadingTheKey(t *testing.T) {
	h := newAITestHarness(t)
	h.store.backend = keystore.BackendFile
	h.store.location = filepath.Join(t.TempDir(), "keys.json")
	h.deps.selectBackend = func() keystore.Selection {
		return keystore.Selection{Backend: keystore.BackendFile, FallbackReason: `"secret-tool" was not found on PATH`}
	}

	var noticeSeenBeforeRead bool
	h.deps.readKey = func(*cobra.Command, string) (secret.String, error) {
		noticeSeenBeforeRead = strings.Contains(h.stderr.String(), "no OS keychain is in use here")
		return secret.New(fakeKeyForTests), nil
	}

	assert.NilError(t, h.run(t, "set-key", "anthropic"))
	assert.Assert(t, noticeSeenBeforeRead, "the fallback notice must be printed before the key is read, got: %q", h.stderr.String())
	assert.Assert(t, is.Contains(h.stderr.String(), "0600"))
}

func TestAIStatus_Fn_ReportsAnUnconfiguredProvider(t *testing.T) {
	h := newAITestHarness(t)

	assert.NilError(t, h.run(t, "status"))
	out := h.stdout.String()
	assert.Assert(t, is.Contains(out, "Anthropic (anthropic)"))
	assert.Assert(t, is.Contains(out, "not configured"))
	assert.Assert(t, is.Contains(out, "test-model"))
}

func TestAIStatus_Fn_ReportsAStoredKeyWithoutPrintingIt(t *testing.T) {
	h := newAITestHarness(t)
	assert.NilError(t, h.store.Set(context.Background(), "anthropic", secret.New(fakeKeyForTests)))

	assert.NilError(t, h.run(t, "status", "anthropic"))
	assert.Assert(t, is.Contains(h.stdout.String(), "configured, from the key store"))
	assertNoKeyInOutput(t, h.output())
}

// TestAIStatus_Fn_ExplainsWhichKeyIsInEffect is the answer to "why is it using
// the wrong key": both sources exist, and status has to name the winner and
// say the other is being ignored.
func TestAIStatus_Fn_ExplainsWhichKeyIsInEffect(t *testing.T) {
	h := newAITestHarness(t)
	assert.NilError(t, h.store.Set(context.Background(), "anthropic", secret.New(fakeKeyForTests)))
	t.Setenv(keystore.KeyEnvVar("anthropic"), "not-a-real-key-from-the-environment")

	assert.NilError(t, h.run(t, "status", "anthropic"))
	out := h.stdout.String()
	assert.Assert(t, is.Contains(out, "from the environment variable VCE_AI_KEY_ANTHROPIC"))
	assert.Assert(t, is.Contains(out, "ignored"))
	assert.Assert(t, is.Contains(out, "Precedence:"))
	assertNoKeyInOutput(t, h.output())
	assert.Assert(t, !strings.Contains(h.output(), "not-a-real-key-from-the-environment"))
}

func TestAIStatus_Fn_SurfacesAStoreReadFailure(t *testing.T) {
	h := newAITestHarness(t)
	h.store.getErr = errors.New("keystore: /home/u/.config/circleci-editor/keys.json is corrupt")

	assert.NilError(t, h.run(t, "status", "anthropic"))
	assert.Assert(t, is.Contains(h.stdout.String(), "reading the key store failed"))
}

// TestAIStatus_Fn_SaysWindowsPermissionsAreWeaker keeps the docs' claim and
// the tool's own output in agreement: on Windows the 0600 mode is an
// approximation, and pretending otherwise would overstate the protection.
func TestAIStatus_Fn_SaysWindowsPermissionsAreWeaker(t *testing.T) {
	h := newAITestHarness(t)
	h.store.backend = keystore.BackendFile
	h.deps.goos = "windows"
	h.deps.selectBackend = func() keystore.Selection {
		return keystore.Selection{Backend: keystore.BackendFile, FallbackReason: "this tool has no OS keychain integration for windows yet"}
	}

	assert.NilError(t, h.run(t, "status"))
	assert.Assert(t, is.Contains(h.stdout.String(), "On Windows those permission bits are an approximation"))
}

func TestAIRemoveKey_Fn_RemovesAStoredKey(t *testing.T) {
	h := newAITestHarness(t)
	assert.NilError(t, h.store.Set(context.Background(), "anthropic", secret.New(fakeKeyForTests)))

	assert.NilError(t, h.run(t, "remove-key", "anthropic"))
	assert.DeepEqual(t, h.store.deletes, []string{"anthropic"})
	_, ok, err := h.store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)
	assert.Assert(t, is.Contains(h.stdout.String(), "Removed the stored API key for Anthropic"))
	assertNoKeyInOutput(t, h.output())
}

// TestAIRemoveKey_Fn_SucceedsQuietlyWhenNothingIsStored keeps the command safe
// to run unconditionally from a script, and still deletes (rather than
// trusting the read) so "removal must actually remove" holds even if the
// backend disagrees with itself.
func TestAIRemoveKey_Fn_SucceedsQuietlyWhenNothingIsStored(t *testing.T) {
	h := newAITestHarness(t)

	assert.NilError(t, h.run(t, "remove-key", "anthropic"))
	assert.Assert(t, is.Contains(h.stdout.String(), "nothing to remove"))
	assert.DeepEqual(t, h.store.deletes, []string{"anthropic"})
}

// TestAIRemoveKey_Fn_FailsIfTheKeyIsStillThereAfterwards is the difference
// between "we called Delete" and "the key is gone".
func TestAIRemoveKey_Fn_FailsIfTheKeyIsStillThereAfterwards(t *testing.T) {
	h := newAITestHarness(t)
	h.store.ignoreDelet = true
	assert.NilError(t, h.store.Set(context.Background(), "anthropic", secret.New(fakeKeyForTests)))

	err := h.run(t, "remove-key", "anthropic")
	assert.ErrorContains(t, err, "still reports a key for Anthropic")
	assertNoKeyInOutput(t, h.output())
}

func TestAIRemoveKey_Fn_SaysAnEnvironmentKeyIsStillInEffect(t *testing.T) {
	h := newAITestHarness(t)
	t.Setenv(keystore.KeyEnvVar("anthropic"), "not-a-real-key-from-the-environment")

	assert.NilError(t, h.run(t, "remove-key", "anthropic"))
	assert.Assert(t, is.Contains(h.stdout.String(), "still set in this environment"))
}

func TestAIRemoveKey_Fn_ReportsADeleteFailureWithoutTheKey(t *testing.T) {
	h := newAITestHarness(t)
	h.store.deleteErr = errors.New("keystore: secret-tool: exit status 1")

	err := h.run(t, "remove-key", "anthropic")
	assert.ErrorContains(t, err, "remove the Anthropic key")
	assert.Assert(t, !strings.Contains(err.Error(), fakeKeyForTests))
}

func TestNewValidatedKey_Fn_RejectsBadInputWithoutQuotingIt(t *testing.T) {
	// Every rejected value below is deliberately nonsense; the assertion that
	// matters is that none of it appears in the error a user (or a CI log)
	// would see.
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: "no key was provided"},
		{name: "whitespace only", input: "   \n", want: "no key was provided"},
		{name: "internal space", input: "not a real key", want: "whitespace or a control character"},
		{name: "control character", input: "not-a-real-key\x07suffix", want: "whitespace or a control character"},
		{name: "far too long", input: strings.Repeat("z", maxKeyInputLength+1), want: "longer than any provider API key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, err := newValidatedKey(tc.input)
			assert.ErrorContains(t, err, tc.want)
			assert.Equal(t, key.IsSet(), false)
			trimmed := strings.TrimSpace(tc.input)
			if trimmed != "" {
				assert.Assert(t, !strings.Contains(err.Error(), trimmed), "the error quoted the rejected value")
			}
		})
	}
}

func TestNewValidatedKey_Fn_TrimsAndAcceptsAPlausibleValue(t *testing.T) {
	key, err := newValidatedKey("  " + fakeKeyForTests + "\r\n")
	assert.NilError(t, err)
	assert.Equal(t, key.Reveal(), fakeKeyForTests)
	// And the wrapper still redacts it everywhere, so a stray %v cannot leak
	// it (see internal/ai/secret).
	assert.Equal(t, key.String(), "[REDACTED]")
}

func TestReadKeyLine_Fn_ReadsOneLine(t *testing.T) {
	r := bufio.NewReader(strings.NewReader(fakeKeyForTests + "\nignored second line\n"))
	key, err := readKeyLine(r, "test key")
	assert.NilError(t, err)
	assert.Equal(t, key.Reveal(), fakeKeyForTests)
}

// TestReadKeyFrom_Fn_ReadsPipedStdinAndSaysSo exercises the real (uninjected)
// reader against a genuine pipe -- the scripted `printf ... | ai set-key`
// path -- including the notice that explains why there was no prompt.
//
// The terminal branch of readKeyFrom cannot be exercised here: `go test` has
// no controlling terminal, and term.ReadPassword needs a real one. That path's
// correctness rests on golang.org/x/term, which is the canonical
// implementation of "read without echo" on POSIX *and* Windows consoles; the
// hand-rolled alternative (shelling out to `stty -echo`) has no Windows
// equivalent at all.
func TestReadKeyFrom_Fn_ReadsPipedStdinAndSaysSo(t *testing.T) {
	reader, writer, err := os.Pipe()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = reader.Close() })

	go func() {
		defer func() { _ = writer.Close() }()
		_, _ = writer.WriteString(fakeKeyForTests + "\n")
	}()

	cmd := &cobra.Command{}
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)

	key, err := readKeyFrom(cmd, reader, "Anthropic API key")
	assert.NilError(t, err)
	assert.Equal(t, key.Reveal(), fakeKeyForTests)
	assert.Assert(t, is.Contains(stderr.String(), "Reading the Anthropic API key from standard input"))
	assert.Assert(t, !strings.Contains(stderr.String(), fakeKeyForTests), "the piped key must not be echoed")
}

// TestAIKeyLifecycle_Fn_AgainstTheRealFileStore is the end-to-end check
// against the actual storage code (not a fake): set, inspect, remove -- with
// the file's mode verified on disk, and the whole temp tree swept to prove the
// key exists in exactly one file and appears in no command output.
func TestAIKeyLifecycle_Fn_AgainstTheRealFileStore(t *testing.T) {
	dir := isolateAIEnv(t)

	newCmd := func() (*cobra.Command, *bytes.Buffer, *bytes.Buffer) {
		deps := defaultAIDeps()
		deps.readKey = func(*cobra.Command, string) (secret.String, error) {
			return secret.New(fakeKeyForTests), nil
		}
		cmd := newAICommandWithDeps(deps)
		stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
		cmd.SetOut(stdout)
		cmd.SetErr(stderr)
		return cmd, stdout, stderr
	}

	setCmd, setOut, setErr := newCmd()
	setCmd.SetArgs([]string{"set-key", "anthropic"})
	assert.NilError(t, setCmd.Execute())
	assertNoKeyInOutput(t, setOut.String()+setErr.String())

	keysPath := filepath.Join(dir, "circleci-editor", "keys.json")
	info, err := os.Stat(keysPath)
	assert.NilError(t, err)
	if runtime.GOOS == "windows" {
		// Windows has no POSIX mode bits; Go synthesises them from the ACL,
		// so asserting 0600 here would be asserting a fiction. The honest
		// statement -- made in the docs and by the command itself -- is that
		// the file's protection on Windows is whatever the user's profile
		// directory ACL gives it.
		t.Log("skipping the 0600 assertion: file modes are approximated on windows")
	} else {
		assert.Equal(t, info.Mode().Perm(), os.FileMode(0o600))
	}

	statusCmd, statusOut, statusErr := newCmd()
	statusCmd.SetArgs([]string{"status", "anthropic"})
	assert.NilError(t, statusCmd.Execute())
	assert.Assert(t, is.Contains(statusOut.String(), "configured, from the key store"))
	assertNoKeyInOutput(t, statusOut.String()+statusErr.String())

	// The key must exist in exactly one file: the store's own.
	assert.DeepEqual(t, filesContainingKey(t, dir), []string{keysPath})

	removeCmd, removeOut, removeErr := newCmd()
	removeCmd.SetArgs([]string{"remove-key", "anthropic"})
	assert.NilError(t, removeCmd.Execute())
	assert.Assert(t, is.Contains(removeOut.String(), "Removed the stored API key"))
	assertNoKeyInOutput(t, removeOut.String()+removeErr.String())
	assert.Equal(t, len(filesContainingKey(t, dir)), 0, "the key survived removal somewhere under %s", dir)

	// And removing again is a quiet success, so a teardown script can run it
	// unconditionally.
	againCmd, againOut, _ := newCmd()
	againCmd.SetArgs([]string{"remove-key", "anthropic"})
	assert.NilError(t, againCmd.Execute())
	assert.Assert(t, is.Contains(againOut.String(), "nothing to remove"))
}

// filesContainingKey returns every file under dir whose contents include the
// fake key, sorted -- the sweep behind "it is stored in exactly one place".
func filesContainingKey(t *testing.T, dir string) []string {
	t.Helper()
	var hits []string
	assert.NilError(t, filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // test-only walk of a t.TempDir().
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), fakeKeyForTests) {
			hits = append(hits, path)
		}
		return nil
	}))
	return hits
}

// assertNoKeyInOutput is the assertion every command test above shares: no
// stream a user or a CI log can see may contain the key, or any prefix of it
// long enough to identify an account.
func assertNoKeyInOutput(t *testing.T, output string) {
	t.Helper()
	assert.Assert(t, !strings.Contains(output, fakeKeyForTests), "output contained the key: %q", output)
	// A prefix check as well: a "helpful" sk-ant-abc… hint is exactly the
	// half-measure this project decided against (#112).
	assert.Assert(t, !strings.Contains(output, fakeKeyForTests[:12]), "output contained a prefix of the key: %q", output)
}
