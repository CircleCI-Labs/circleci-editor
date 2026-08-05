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

// Package keystore persists provider API keys (issue #92's bring-your-own-key
// AI pane) outside the user's repository, per the design's non-negotiables:
// the key must never enter the working tree or `.circleci/`, must be stored
// with the OS keychain where one is available, and must otherwise fall back
// to a file with restrictive permissions (0600) whose location is easy to
// find and delete.
//
// Two backends implement Store:
//
//   - keychainStore (keychain_store.go): shells out to the platform's own
//     credential-store CLI -- `security` on macOS, `secret-tool` (libsecret)
//     on Linux -- the same "reuse the OS's own binary instead of vendoring a
//     cgo/syscall keychain client" approach this codebase already uses for
//     opening a browser (see internal/host/browser.go). No new Go dependency,
//     nothing to audit beyond argument construction.
//   - fileStore (file_store.go): a single JSON file under this tool's own
//     config directory, directory mode 0700 and file mode 0600, written
//     atomically. Used whenever no supported keychain tool is found (Windows,
//     for now -- see Open's doc comment) or the caller explicitly requests it.
//
// Open picks a backend automatically; Location always reports which one is
// active and where, in a form fit to show directly in the UI, so "where is
// my key stored, and how do I remove it" always has a concrete answer, and
// Select explains *why* that backend was chosen so a fallback can be reported
// rather than silently accepted.
//
// One thing outranks both backends: an environment variable
// (VCE_AI_KEY_<ENTRY>, see KeyEnvVar) supplies a key without storing one, and
// wins over anything stored. That precedence is applied by the wrapper Open
// returns (see WithEnvOverride), never re-implemented per caller, and
// LookupKey reports which of the two is in effect -- provenance being the
// thing a user debugging "why is it using the wrong key" actually needs.
package keystore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// Backend identifies which storage mechanism a Store uses, surfaced to the
// UI (via Store.Location) so it's never a mystery where a key lives.
type Backend string

// The two backends a Store can be. See Open's doc comment for how one is
// chosen.
const (
	BackendKeychain Backend = "keychain"
	BackendFile     Backend = "file"
)

// Store persists provider API keys. provider is a short stable identifier
// (e.g. "anthropic"), matching the id an ai.Provider reports from Name().
type Store interface {
	// Get returns the stored key for provider, or ok=false if none is
	// stored. err is only ever a genuine storage failure (e.g. the
	// keychain tool exited non-zero for a reason other than "not found");
	// a missing key is ok=false, err=nil, never an error.
	Get(ctx context.Context, provider string) (key secret.String, ok bool, err error)
	// Set stores key for provider, overwriting any previously stored key.
	Set(ctx context.Context, provider string, key secret.String) error
	// Delete removes the stored key for provider, if any. Deleting an
	// already-absent key is not an error.
	Delete(ctx context.Context, provider string) error
	// Backend reports which storage mechanism this Store uses.
	Backend() Backend
	// Location returns a human-readable description of where keys are
	// stored (e.g. "macOS Keychain (service \"circleci-editor\")" or
	// an absolute file path), suitable for display directly in the UI so a
	// user can find -- and, for the file backend, manually delete -- the
	// key without asking anyone.
	Location() string
}

// service names every key this tool stores under, in whichever backend is
// active -- the keychain "service" field, and part of the file backend's own
// path. Fixed and unexported: nothing about it is meant to be configurable,
// only stable enough that a key stored by one version of this tool is found
// by the next.
const service = "circleci-editor"

// KeystoreBackendEnvVar overrides automatic backend detection when set to
// "file" or "keychain". It exists for two reasons: it lets a headless
// session (SSH, CI, a sandboxed test run) that has no way to satisfy a GUI
// keychain-unlock prompt force the file fallback instead of hanging, and it
// lets a user who simply prefers a plain file say so. An unrecognised or
// empty value is ignored (falls through to automatic detection).
const KeystoreBackendEnvVar = "VCE_AI_KEYSTORE_BACKEND"

// Open picks and constructs a Store: the OS keychain when one is available
// for the current platform, otherwise the file fallback. The result is
// wrapped by WithEnvOverride, so a key supplied through the environment (see
// KeyEnvVar) wins over a stored one for every caller alike -- the CLI's `ai`
// commands and the host's own handlers -- with the precedence rule living in
// exactly one place.
//
// Availability is decided once, cheaply, by looking for the platform's
// credential CLI on PATH (`security` on darwin, `secret-tool` on linux) --
// it does not attempt an actual keychain operation, which could block on a
// GUI unlock prompt in a headless session. Windows has no equivalent
// standard CLI this tool shells out to yet (Credential Manager access
// without cgo needs a syscall-based client this codebase doesn't have), so
// it always uses the file backend today; that is an honest, working
// fallback, just not OS-native, and is recorded as a known gap rather than
// silently pretended away.
//
// Callers that need to *tell the user* which backend they ended up with, and
// why, should call Select for the explanation: falling back must be visible
// at the moment it happens, never a silent downgrade.
func Open() (Store, error) {
	store, err := openBackend(Select().Backend)
	if err != nil {
		return nil, err
	}
	return WithEnvOverride(store), nil
}

// forcedBackend reads KeystoreBackendEnvVar, returning ok=false for an
// unset, empty, or unrecognised value.
func forcedBackend() (Backend, bool) {
	switch os.Getenv(KeystoreBackendEnvVar) {
	case string(BackendFile):
		return BackendFile, true
	case string(BackendKeychain):
		return BackendKeychain, true
	default:
		return "", false
	}
}

func openBackend(backend Backend) (Store, error) {
	if backend == BackendKeychain {
		if store, ok := newKeychainStore(); ok {
			return store, nil
		}
		// Requested but unavailable on this platform: fall through to file
		// rather than error, since a working (if non-native) store beats
		// refusing to start.
	}
	return newFileStore()
}

// Selection records which backend Open will use and why. It exists so a
// fallback can be *reported*: "no silent degradation" is a project-wide
// invariant, and a user whose key just went into a 0600 file instead of their
// OS keychain has to be told at the moment it happens, not left to infer it
// from a path in some later status output.
type Selection struct {
	// Backend is what Open will construct.
	Backend Backend
	// Forced is true when KeystoreBackendEnvVar chose Backend, rather than
	// automatic detection.
	Forced bool
	// FallbackReason explains, in a sentence fit to print, why the keychain
	// backend is not in use. Empty when Backend is BackendKeychain, and also
	// empty when the file backend was explicitly requested (Forced) -- a
	// deliberate choice is not a degradation to warn about.
	FallbackReason string
}

// UsesFallback reports whether this Selection is the file fallback standing
// in for an unavailable OS keychain -- i.e. something a caller should tell
// the user about, as opposed to a keychain or a file store the user asked for
// by name.
func (s Selection) UsesFallback() bool { return s.FallbackReason != "" }

// Select reports which backend Open will pick, and why, without constructing
// or touching a store: it only reads KeystoreBackendEnvVar and looks for the
// platform's credential CLI on PATH. Open itself is defined in terms of this
// function so the explanation a user is shown can never disagree with the
// backend they actually got.
func Select() Selection {
	forced, isForced := forcedBackend()
	if isForced && forced == BackendFile {
		return Selection{Backend: BackendFile, Forced: true}
	}

	available, reason := keychainAvailability()
	if available {
		return Selection{Backend: BackendKeychain, Forced: isForced}
	}
	// Either automatic detection found no keychain, or the keychain backend
	// was explicitly requested but is unavailable here; both end up on the
	// file store, and both are worth explaining.
	return Selection{Backend: BackendFile, Forced: isForced, FallbackReason: reason}
}

// keychainAvailability reports whether the keychain backend can be used on
// this machine, and when it cannot, a printable reason why. The reason
// deliberately names the missing piece (the platform, or the binary that
// wasn't found) so the fix -- install libsecret's `secret-tool`, or accept
// the file store -- is obvious from the message alone.
func keychainAvailability() (bool, string) {
	adapter := cliAdapterForGOOS(runtime.GOOS)
	if adapter == nil {
		return false, fmt.Sprintf("this tool has no OS keychain integration for %s yet", runtime.GOOS)
	}
	if !(execRunner{}).commandExists(adapter.binary()) {
		return false, fmt.Sprintf("%q was not found on PATH, so no OS keyring is reachable from this session", adapter.binary())
	}
	return true, ""
}

// DefaultConfigDir returns the base directory this tool's own persisted,
// non-cache state (currently: the file-backend key store) lives under,
// following the same XDG Base Directory convention internal/orbs.Cache
// already uses for its disk cache -- $XDG_CONFIG_HOME (or ~/.config when
// unset) rather than XDG_CACHE_HOME, since a stored key is not disposable
// the way a re-crawlable orb cache is.
func DefaultConfigDir() (string, error) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, service), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("keystore: resolve home directory: %w", err)
	}
	return filepath.Join(home, ".config", service), nil
}

// runner abstracts one CLI invocation so keychainStore's tests can fake the
// external `security`/`secret-tool` process entirely -- exercising argument
// construction and output parsing without ever touching a real OS keychain
// (which could hang a test on a GUI unlock prompt) or requiring one to exist
// in CI. commandExists reports whether the underlying binary is on PATH,
// standing in for exec.LookPath the same way.
type runner interface {
	commandExists(name string) bool
	run(ctx context.Context, name string, args []string, stdin string) (stdout string, err error)
}

// execRunner is the production runner, backed by os/exec.
type execRunner struct{}

func (execRunner) commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func (execRunner) run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // name is one of a fixed set of literals ("security", "secret-tool") chosen by this package, args are built by this package from a fixed provider-id/service vocabulary, never from unsanitised request input.
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	// cmd.Stderr is deliberately left nil: exec.Output populates
	// ExitError.Stderr for us in that case, which is all the diagnostic
	// detail an error message below needs.
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", fmt.Errorf("keystore: %s: %w: %s", name, err, strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", fmt.Errorf("keystore: %s: %w", name, err)
	}
	return string(out), nil
}
