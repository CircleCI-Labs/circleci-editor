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

package keystore

import (
	"context"
	"runtime"
	"strings"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// keychainStore stores keys in the platform's native credential store by
// shelling out to its CLI, exactly the "reuse the OS's own binary" approach
// internal/host/browser.go already uses for opening a URL. cli abstracts
// which platform tool is in play (macOS `security` vs. Linux `secret-tool`);
// r is the process runner, real in production and faked in tests (see
// runner's doc comment).
type keychainStore struct {
	cli cliAdapter
	r   runner
}

// cliAdapter builds the argv (and, where the tool supports it, the stdin
// payload) for one credential-store operation, and parses its output. Each
// platform's tool has a different calling convention -- see darwinCLI and
// linuxCLI below -- but the three operations (get/set/delete) are the same
// shape for both, which is all keychainStore itself needs to know.
type cliAdapter interface {
	// binary is the command name to resolve via runner.commandExists / to
	// invoke via runner.run.
	binary() string
	// label is what Store.Backend/Location should call this backend.
	label() string

	getArgs(provider string) []string
	// setArgs returns the argv and (possibly empty) stdin payload to store
	// key for provider. Only one of them actually carries the secret,
	// depending on the tool: see darwinCLI/linuxCLI's own doc comments for
	// why that differs between the two.
	setArgs(provider string, key secret.String) (args []string, stdin string)
	deleteArgs(provider string) []string

	// parseGetOutput extracts the stored key from a successful get
	// invocation's stdout.
	parseGetOutput(stdout string) string
	// isNotFound reports whether an error returned by runner.run for a get
	// or delete call means "no such entry" rather than a real failure --
	// the CLI's exit status/stderr shape for "not found" differs per tool.
	isNotFound(err error) bool
}

func newKeychainStore() (*keychainStore, bool) {
	adapter := cliAdapterForGOOS(runtime.GOOS)
	if adapter == nil {
		return nil, false
	}
	r := execRunner{}
	if !r.commandExists(adapter.binary()) {
		return nil, false
	}
	return &keychainStore{cli: adapter, r: r}, true
}

func cliAdapterForGOOS(goos string) cliAdapter {
	switch goos {
	case "darwin":
		return darwinCLI{}
	case "linux":
		return linuxCLI{}
	default:
		// Windows (and anything else): no supported CLI-based keychain
		// integration yet -- see keystore.go's Open doc comment.
		return nil
	}
}

func (k *keychainStore) Backend() Backend { return BackendKeychain }

func (k *keychainStore) Location() string { return k.cli.label() }

func (k *keychainStore) Get(ctx context.Context, provider string) (secret.String, bool, error) {
	out, err := k.r.run(ctx, k.cli.binary(), k.cli.getArgs(provider), "")
	if err != nil {
		if k.cli.isNotFound(err) {
			return secret.String{}, false, nil
		}
		return secret.String{}, false, err
	}
	value := k.cli.parseGetOutput(out)
	if value == "" {
		return secret.String{}, false, nil
	}
	return secret.New(value), true, nil
}

func (k *keychainStore) Set(ctx context.Context, provider string, key secret.String) error {
	args, stdin := k.cli.setArgs(provider, key)
	_, err := k.r.run(ctx, k.cli.binary(), args, stdin)
	return err
}

func (k *keychainStore) Delete(ctx context.Context, provider string) error {
	_, err := k.r.run(ctx, k.cli.binary(), k.cli.deleteArgs(provider), "")
	if err != nil && !k.cli.isNotFound(err) {
		return err
	}
	return nil
}

// darwinCLI drives macOS's `security` tool against the login keychain's
// generic-password store.
//
// `security add-generic-password` has no stdin-based form: the password
// must be passed as the `-w` argument, which is briefly visible to other
// local processes via `ps` for the lifetime of that one short-lived child
// process (a few milliseconds). That is a real, considered trade-off, not
// an oversight -- there is no scriptable alternative the tool itself
// offers, and it is strictly better than the file-store fallback, which
// leaves the plaintext key resident on disk for as long as it's configured,
// readable by the same set of local principals (this OS user) that could
// observe the argv window.
type darwinCLI struct{}

func (darwinCLI) binary() string { return "security" }
func (darwinCLI) label() string  { return `macOS Keychain (service "` + service + `")` }

func (darwinCLI) getArgs(provider string) []string {
	return []string{"find-generic-password", "-a", provider, "-s", service, "-w"}
}

func (darwinCLI) setArgs(provider string, key secret.String) ([]string, string) {
	// -U: update in place if an entry for this account+service already
	// exists, rather than erroring on a duplicate -- Set is documented to
	// overwrite.
	return []string{"add-generic-password", "-a", provider, "-s", service, "-w", key.Reveal(), "-U"}, ""
}

func (darwinCLI) deleteArgs(provider string) []string {
	return []string{"delete-generic-password", "-a", provider, "-s", service}
}

func (darwinCLI) parseGetOutput(stdout string) string {
	return strings.TrimRight(stdout, "\n")
}

func (darwinCLI) isNotFound(err error) bool {
	// `security find-generic-password`/`delete-generic-password` print
	// "SecKeychainSearchCopyNext: The specified item could not be found in
	// the keychain." (and exit 44) when there is no matching entry.
	return errorContainsAny(err, "could not be found in the keychain", "errSecItemNotFound")
}

// linuxCLI drives libsecret's `secret-tool` against the desktop Secret
// Service (gnome-keyring, KWallet's Secret Service shim, etc.).
//
// Unlike `security`, `secret-tool store` reads the password from stdin --
// its documented, scriptable interface -- so the key is never placed on
// this process's own command line at all.
type linuxCLI struct{}

func (linuxCLI) binary() string { return "secret-tool" }
func (linuxCLI) label() string  { return `Secret Service keyring (service "` + service + `")` }

func (linuxCLI) getArgs(provider string) []string {
	return []string{"lookup", "service", service, "account", provider}
}

func (linuxCLI) setArgs(provider string, key secret.String) ([]string, string) {
	return []string{"store", "--label", service + " (" + provider + ")", "service", service, "account", provider}, key.Reveal()
}

func (linuxCLI) deleteArgs(provider string) []string {
	return []string{"clear", "service", service, "account", provider}
}

func (linuxCLI) parseGetOutput(stdout string) string {
	return strings.TrimRight(stdout, "\n")
}

func (linuxCLI) isNotFound(err error) bool {
	// `secret-tool lookup`/`clear` exit non-zero with empty stdout/stderr
	// when there is no matching entry -- there is no distinguishing message
	// to match on, so treat any failure with empty output as "not found".
	// A genuine failure (no Secret Service running at all) was already
	// ruled out at Open() time by requiring the binary to exist; a
	// still-possible "no Secret Service session available" failure here
	// is rare enough, and safe enough to surface as "not found" rather
	// than a hard error, that this package accepts the imprecision.
	return err != nil
}

// errorContainsAny reports whether err's message contains any of needles,
// case-sensitively -- used to classify a keychainCLI failure by the
// diagnostic text the underlying tool printed to stderr (captured into the
// error by execRunner.run).
func errorContainsAny(err error, needles ...string) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, n := range needles {
		if strings.Contains(msg, n) {
			return true
		}
	}
	return false
}

// Ensure keychainStore satisfies Store at compile time.
var _ Store = (*keychainStore)(nil)
