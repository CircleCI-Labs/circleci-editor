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

// This file is the `ai` subcommand tree (issue #112): setting, inspecting,
// and removing the AI pane's provider API key without opening a browser.
//
// Everything here is a thin wrapper over internal/ai/keystore, and every line
// of it obeys the same rules the pane's HTTP handlers already obey:
// the key is read without terminal echo, wrapped in secret.String the moment
// it exists, never printed, never logged, and never included in an error --
// not even a truncated prefix of it. `status` is built on keystore.LookupKey
// specifically because that type has no field capable of holding a key, so
// "status accidentally prints the secret" is not a mistake this code is able
// to make.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// aiStoreTimeout bounds any single key-store operation these commands
// perform. Generous on purpose: on macOS a locked login keychain makes
// `security` put up a GUI unlock prompt that a human has to type into, and
// timing that out after a few seconds would look like a bug in this tool
// rather than the wait it actually is. Still finite, so a wedged credential
// helper can never hang the command forever.
const aiStoreTimeout = 90 * time.Second

// maxKeyInputLength caps how much this command will accept as "a key". No
// provider key is anywhere near this long; the point is that piping the wrong
// thing in (`ai set-key anthropic < config.yml`) fails with a clear message
// instead of quietly storing a whole file's contents in the user's keychain.
const maxKeyInputLength = 1024

// aiDeps is the set of seams the `ai` commands are built on, so their
// behaviour can be tested without a real keychain, a real terminal, or a real
// provider: tests substitute a fake store and a fake key reader, and the
// production wiring (defaultAIDeps) is the only place that reaches for the
// process's actual environment.
type aiDeps struct {
	// openStore opens the key store these commands read and write.
	openStore func() (keystore.Store, error)
	// selectBackend explains which backend openStore will have chosen, and
	// why -- see keystore.Select. Kept separate from the store itself
	// because the explanation must be printable *before* a key is read (see
	// runAISetKey).
	selectBackend func() keystore.Selection
	// providers is the same registry the running editor uses, so a provider
	// id accepted here is exactly one the pane knows about.
	providers ai.Registry
	// readKey reads one secret value from the user, without echoing it.
	readKey func(cmd *cobra.Command, label string) (secret.String, error)
	// goos is runtime.GOOS, injectable so the Windows-specific honesty about
	// file permissions can be tested from any platform.
	goos string
}

func defaultAIDeps() *aiDeps {
	return &aiDeps{
		openStore:     keystore.Open,
		selectBackend: keystore.Select,
		providers:     host.DefaultAIProviders(),
		readKey: func(cmd *cobra.Command, label string) (secret.String, error) {
			return readKeyFrom(cmd, os.Stdin, label)
		},
		goos: runtime.GOOS,
	}
}

// newAICommand builds the `ai` command group, matching the conventions
// newStartCommand already set (cobra, SilenceUsage/SilenceErrors so main is
// the single place an error is printed).
func newAICommand() *cobra.Command {
	return newAICommandWithDeps(defaultAIDeps())
}

func newAICommandWithDeps(deps *aiDeps) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ai",
		Short: "Manage the AI pane's provider API key",
		Long: `Manage the AI pane's provider API key.

The AI pane is bring-your-own-key: this tool ships no key and no default
provider account. These commands are the terminal-side equivalent of the
pane's own settings, for seeding a fresh dev container, checking where a key
lives, or deleting one without opening a browser.

The key is never printed by any of these commands -- not by "status", not in
an error message, not even as a truncated prefix -- and never accepted as a
command-line argument, which would leave it in your shell history and in the
process list. "set-key" reads it from a terminal without echoing it, or from
standard input when stdin is a pipe.

Storage, in order of precedence:

  1. ` + keystore.KeyEnvVarPrefix + `<PROVIDER> in the environment, e.g. ` + keystore.KeyEnvVar("anthropic") + `.
     When set, it wins, and any stored key is ignored for as long as it is
     set. Nothing is written to disk or to a keyring.
  2. The stored key: your OS keychain (macOS Keychain via "security", or a
     Secret Service keyring via "secret-tool" on Linux) when one is
     available, otherwise a file with 0600 permissions under this tool's
     own config directory.

"status" always says which of the two is in effect, so "why is it using the
wrong key" has an answer. A key exported for some other program -- e.g.
ANTHROPIC_API_KEY -- is deliberately never read.`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.AddCommand(
		newAIStatusCommand(deps),
		newAISetKeyCommand(deps),
		newAIRemoveKeyCommand(deps),
	)
	return cmd
}

func newAIStatusCommand(deps *aiDeps) *cobra.Command {
	return &cobra.Command{
		Use:   "status [provider]",
		Short: "Report whether a provider key is configured, and where it comes from",
		Long: `Report whether a provider key is configured, and where it comes from.

Mirrors what the editor's own GET /api/ai/status reports: which providers
this build knows about, whether each has a key in effect, which model each
would use, and where keys are stored.

Reports presence and provenance only. The key itself is never printed, and
neither is any part of it: a prefix is enough to identify an account in a
support thread or a screen recording, and it buys nothing you can't get from
"configured from ` + keystore.KeyEnvVar("anthropic") + `" instead.

With no argument, reports every known provider.`,
		Args:          cobra.MaximumNArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAIStatus(cmd, deps, args)
		},
	}
}

func newAISetKeyCommand(deps *aiDeps) *cobra.Command {
	return &cobra.Command{
		Use:   "set-key <provider>",
		Short: "Store an API key for a provider, read without echo",
		Long: `Store an API key for a provider.

The key is read from a terminal prompt with echo turned off, so it never
appears on screen; when stdin is a pipe or a file, it is read from there
instead (one line), which is what makes seeding a container scriptable:

  printf '%s' "$MY_KEY" | circleci-editor ai set-key anthropic

There is deliberately no --key flag: an argument would be recorded in your
shell history and visible to every other process on the machine through the
process list for as long as this command ran.

Where the key ends up is printed on success, and if no OS keychain was
available -- so the 0600 file fallback is in use instead -- that is said
before the prompt, not after the write.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAISetKey(cmd, deps, args[0])
		},
	}
}

func newAIRemoveKeyCommand(deps *aiDeps) *cobra.Command {
	return &cobra.Command{
		Use:   "remove-key <provider>",
		Short: "Remove a provider's stored API key",
		Long: `Remove a provider's stored API key.

Deletes the key from the keychain (or the 0600 file), then reads back to
confirm it is really gone rather than trusting the delete call.

Removing a key that isn't there succeeds quietly, so this is safe to run
unconditionally from a script or a teardown step.

It cannot unset an environment variable in the shell that invoked it, so if
` + keystore.KeyEnvVarPrefix + `<PROVIDER> is set, this command says so: a key is still in
effect until you unset it yourself.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAIRemoveKey(cmd, deps, args[0])
		},
	}
}

// resolveProvider maps a provider id from the command line to the Provider
// the editor itself would use, so an id that works here works in the pane.
// The id is not a secret, so echoing it back in the error is fine -- and
// listing the known ids saves a second round trip to --help.
func resolveProvider(deps *aiDeps, id string) (ai.Provider, error) {
	if p, ok := deps.providers.Get(id); ok {
		return p, nil
	}
	known := make([]string, 0, len(deps.providers))
	for _, p := range deps.providers.Providers() {
		known = append(known, p.Name())
	}
	if len(known) == 0 {
		return nil, fmt.Errorf("unknown provider %q: this build has no AI providers registered", id)
	}
	return nil, fmt.Errorf("unknown provider %q (known providers: %s)", id, strings.Join(known, ", "))
}

func runAIStatus(cmd *cobra.Command, deps *aiDeps, args []string) error {
	store, err := deps.openStore()
	if err != nil {
		return fmt.Errorf("open the key store: %w", err)
	}

	providers := deps.providers.Providers()
	if len(args) == 1 {
		p, resolveErr := resolveProvider(deps, args[0])
		if resolveErr != nil {
			return resolveErr
		}
		providers = []ai.Provider{p}
	}

	ctx, cancel := context.WithTimeout(cmd.Context(), aiStoreTimeout)
	defer cancel()

	// Assembled in full, then written once -- the same shape printBanner uses
	// in main.go, and the reason none of the Fprintf calls below need their
	// own error check.
	var b strings.Builder
	fmt.Fprintf(&b, "Key storage: %s (%s backend)\n", store.Location(), store.Backend())
	b.WriteString(storageNotes(deps, store, deps.selectBackend()))

	if len(providers) == 0 {
		b.WriteString("\nThis build has no AI providers registered.\n")
	}
	for _, p := range providers {
		lookup := keystore.LookupKey(ctx, store, p.Name())
		fmt.Fprintf(&b, "\n%s (%s)\n", p.Label(), p.Name())
		fmt.Fprintf(&b, "  Key:   %s\n", describeKeyLookup(lookup, p))
		fmt.Fprintf(&b, "  Model: %s\n", p.DefaultModel())
	}
	if len(providers) > 0 {
		fmt.Fprintf(&b, "\nPrecedence: %s<PROVIDER> in the environment always wins over a stored key.\n", keystore.KeyEnvVarPrefix)
	}

	_, err = fmt.Fprint(cmd.OutOrStdout(), b.String())
	return err
}

// describeKeyLookup renders one provider's key state. It takes a
// keystore.Lookup rather than a key precisely so that there is no value here
// to leak: every branch below is a sentence about presence and provenance,
// and the function has nothing else available to print.
func describeKeyLookup(lookup keystore.Lookup, p ai.Provider) string {
	var b strings.Builder

	switch lookup.Source {
	case keystore.SourceEnv:
		fmt.Fprintf(&b, "configured, from the environment variable %s", lookup.EnvVar)
		if lookup.Stored {
			fmt.Fprintf(&b, " (a stored key also exists and is ignored while %s is set)", lookup.EnvVar)
		} else {
			b.WriteString(" (nothing is stored)")
		}
	case keystore.SourceStore:
		b.WriteString("configured, from the key store")
	case keystore.SourceNone:
		fmt.Fprintf(&b, "not configured -- run \"circleci-editor ai set-key %s\"", p.Name())
	}

	if lookup.StoreErr != nil {
		// Safe to include: every error internal/ai/keystore constructs is
		// built from a path, a command name, or a tool's stderr -- never from
		// key material (audited when this command was added; see #112), and
		// the key itself only ever exists there inside a secret.String.
		fmt.Fprintf(&b, "\n         Warning: reading the key store failed: %v", lookup.StoreErr)
	}
	return b.String()
}

// storageNotes renders anything about *where* keys are stored that a user
// would not otherwise know -- above all a fallback to the 0600 file because no
// OS keychain was reachable. Degrading the security posture silently is not an
// option this project takes (the same reason the editor warns about a missing
// CIRCLE_TOKEN in its startup banner), so this text is printed by `status` and
// by `set-key` before it reads anything.
//
// Returns text rather than writing it so `set-key` can print it to stderr and
// `status` can fold it into its stdout report, from one wording.
func storageNotes(deps *aiDeps, store keystore.Store, selection keystore.Selection) string {
	if store.Backend() != keystore.BackendFile {
		return ""
	}

	var b strings.Builder
	switch {
	case selection.UsesFallback():
		fmt.Fprintf(&b, "Note: no OS keychain is in use here (%s), so keys are kept in a file with 0600 permissions instead: %s\n", selection.FallbackReason, store.Location())
	case selection.Forced:
		fmt.Fprintf(&b, "Note: %s=%s selects the file backend, so keys are kept in a file with 0600 permissions: %s\n", keystore.KeystoreBackendEnvVar, keystore.BackendFile, store.Location())
	default:
		fmt.Fprintf(&b, "Note: keys are kept in a file with 0600 permissions: %s\n", store.Location())
	}

	if deps.goos == "windows" {
		b.WriteString("      On Windows those permission bits are an approximation Go maps onto the file's ACL, not the POSIX guarantee they are on macOS and Linux: treat the file as readable by anything running as you, and by an administrator.\n")
	}
	return b.String()
}

func runAISetKey(cmd *cobra.Command, deps *aiDeps, providerID string) error {
	p, err := resolveProvider(deps, providerID)
	if err != nil {
		return err
	}
	store, err := deps.openStore()
	if err != nil {
		return fmt.Errorf("open the key store: %w", err)
	}

	// Before the prompt, not after the write: someone who would rather not
	// put a key in a plain file (however well-permissioned) must find that
	// out while Ctrl-C is still a useful thing to press. Straight to stderr
	// so it doesn't pollute stdout for a caller reading the confirmation.
	//
	// This one write is error-checked, unlike the confirmations below: if the
	// notice that the security posture is weaker than advertised cannot be
	// shown, proceeding to read and store a key anyway would be exactly the
	// silent downgrade it exists to prevent.
	if notes := storageNotes(deps, store, deps.selectBackend()); notes != "" {
		if _, writeErr := fmt.Fprint(cmd.ErrOrStderr(), notes); writeErr != nil {
			return fmt.Errorf("print where the key would be stored: %w", writeErr)
		}
	}

	key, err := deps.readKey(cmd, fmt.Sprintf("%s API key", p.Label()))
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(cmd.Context(), aiStoreTimeout)
	defer cancel()

	if err := store.Set(ctx, p.Name(), key); err != nil {
		// %w on a keystore error: see describeKeyLookup on why those are
		// safe to surface. The key itself is in `key`, a secret.String,
		// which formats as [REDACTED] even if it ever reached this line.
		return fmt.Errorf("store the %s key: %w", p.Label(), err)
	}

	// Read back through LookupKey (which cannot see the value, only whether
	// one is stored): a Set that reported success but stored nothing is
	// exactly the failure a user would otherwise discover much later, in the
	// pane, as "my key doesn't work".
	lookup := keystore.LookupKey(ctx, store, p.Name())
	if !lookup.Stored {
		return fmt.Errorf("stored the %s key but %s reports no key for it afterwards", p.Label(), store.Location())
	}

	// Assembled then written once, and best-effort: the key is already stored
	// at this point, so a failing stdout is no reason to hand the caller an
	// error that says otherwise (main.go's run() takes the same line with its
	// shutdown notice).
	var b strings.Builder
	fmt.Fprintf(&b, "Stored an API key for %s in %s.\n", p.Label(), store.Location())
	if lookup.EnvSet {
		fmt.Fprintf(&b, "Note: %s is set in this environment and takes precedence, so the key you just stored will be ignored until you unset it.\n", lookup.EnvVar)
	}
	_, _ = fmt.Fprint(cmd.OutOrStdout(), b.String())
	return nil
}

func runAIRemoveKey(cmd *cobra.Command, deps *aiDeps, providerID string) error {
	p, err := resolveProvider(deps, providerID)
	if err != nil {
		return err
	}
	store, err := deps.openStore()
	if err != nil {
		return fmt.Errorf("open the key store: %w", err)
	}

	ctx, cancel := context.WithTimeout(cmd.Context(), aiStoreTimeout)
	defer cancel()

	before := keystore.LookupKey(ctx, store, p.Name())
	if before.StoreErr != nil {
		return fmt.Errorf("read the key store before removing the %s key: %w", p.Label(), before.StoreErr)
	}

	// Deleted unconditionally, even when the read above found nothing: the
	// point of this command is that the key is gone afterwards, and a
	// backend that disagreed with its own read (or a second process that
	// wrote in between) must not leave one behind. Deleting an absent key is
	// documented as a no-op on both backends.
	if err := store.Delete(ctx, p.Name()); err != nil {
		return fmt.Errorf("remove the %s key: %w", p.Label(), err)
	}

	after := keystore.LookupKey(ctx, store, p.Name())
	if after.StoreErr != nil {
		return fmt.Errorf("confirm the %s key was removed: %w", p.Label(), after.StoreErr)
	}
	if after.Stored {
		return fmt.Errorf("the key store at %s still reports a key for %s after removing it; remove it there by hand", store.Location(), p.Label())
	}

	var b strings.Builder
	if before.Stored {
		fmt.Fprintf(&b, "Removed the stored API key for %s from %s.\n", p.Label(), store.Location())
	} else {
		// Deliberately not an error: `remove-key` has to be safe to run in a
		// teardown script that doesn't know whether a key was ever set.
		fmt.Fprintf(&b, "No API key was stored for %s in %s; nothing to remove.\n", p.Label(), store.Location())
	}
	if after.EnvSet {
		fmt.Fprintf(&b, "Note: %s is still set in this environment, so %s still has a key in effect. Unset that variable to finish removing it.\n", after.EnvVar, p.Label())
	}
	// Best-effort for the same reason as set-key's confirmation: the removal
	// has already happened.
	_, _ = fmt.Fprint(cmd.OutOrStdout(), b.String())
	return nil
}

// readKeyFrom reads one key from in, wrapping it in a secret.String before
// returning: no caller of this function ever holds the value as a plain
// string.
//
// Two paths, chosen by whether in is a terminal:
//
//   - A terminal: prompt on stderr and read with echo disabled
//     (golang.org/x/term, which is also what makes this work on a Windows
//     console -- the alternative, shelling out to `stty -echo`, has no
//     Windows equivalent at all and would have meant a platform where the
//     key is typed in the clear).
//   - Anything else (a pipe, a file, /dev/null under `go test`): read one
//     line, and say on stderr that that is what's happening, so a user who
//     expected a prompt and is now staring at a command that appears to
//     hang knows it is waiting on stdin.
func readKeyFrom(cmd *cobra.Command, in *os.File, label string) (secret.String, error) {
	errOut := cmd.ErrOrStderr()

	// #nosec G115 -- in.Fd() returns a real OS file descriptor (a small
	// non-negative integer on every platform this builds for, and on Windows a
	// HANDLE that x/term is documented to take in exactly this int form); the
	// int conversion is what golang.org/x/term's own API requires, not an
	// arithmetic narrowing of untrusted input.
	fd := int(in.Fd())
	if term.IsTerminal(fd) {
		// Prompt/notice writes below are best-effort: if stderr itself is
		// failing there is nothing more useful to do than carry on reading,
		// and turning a broken tty into "your key was not stored" would be
		// worse than a missing prompt.
		_, _ = fmt.Fprintf(errOut, "%s (input is hidden): ", label)
		raw, err := term.ReadPassword(fd)
		// ReadPassword consumes the user's Enter without echoing it, so
		// without this the next line of output would continue on the prompt
		// line.
		_, _ = fmt.Fprintln(errOut)
		if err != nil {
			return secret.String{}, fmt.Errorf("read the %s from the terminal: %w", label, err)
		}
		key, keyErr := newValidatedKey(string(raw))
		// Best-effort scrub of the one copy we control. Go's string
		// conversion above made an immutable copy that cannot be wiped, so
		// this is a reduction in exposure, not a guarantee -- worth doing,
		// not worth claiming more for.
		for i := range raw {
			raw[i] = 0
		}
		return key, keyErr
	}

	_, _ = fmt.Fprintf(errOut, "Reading the %s from standard input (stdin is not a terminal, so there is nothing to prompt).\n", label)
	return readKeyLine(bufio.NewReader(in), label)
}

// readKeyLine reads a single line as a key. Separate from readKeyFrom purely
// so the non-terminal path is testable without a pipe.
func readKeyLine(r *bufio.Reader, label string) (secret.String, error) {
	line, err := r.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return secret.String{}, fmt.Errorf("read the %s from standard input: %w", label, err)
	}
	return newValidatedKey(line)
}

// newValidatedKey trims and sanity-checks raw, then wraps it. Every error it
// returns describes the *shape* of the problem and never quotes the value --
// "invalid key: sk-..." in a terminal, a CI log, or a bug report is precisely
// the leak this whole design exists to prevent.
//
// Deliberately not a format check: this tool has no business asserting what a
// provider's key looks like (a prefix convention that changes would lock
// users out of their own key for no security gain). Only the things that mean
// "you piped the wrong thing" are rejected.
func newValidatedKey(raw string) (secret.String, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return secret.String{}, errors.New("no key was provided; nothing was stored")
	}
	if len(trimmed) > maxKeyInputLength {
		return secret.String{}, fmt.Errorf("the value read is longer than %d characters, which is longer than any provider API key -- did you pipe a file in by mistake? nothing was stored", maxKeyInputLength)
	}
	for _, r := range trimmed {
		if unicode.IsSpace(r) || !unicode.IsPrint(r) {
			return secret.String{}, errors.New("the value read contains whitespace or a control character, which no provider API key does -- check for a stray copy/paste; nothing was stored")
		}
	}
	return secret.New(trimmed), nil
}
