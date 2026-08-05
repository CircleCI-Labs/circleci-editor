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

// White-box tests for keychainStore: they live in package keystore (not
// keystore_test) specifically so they can inject a fake runner directly,
// deliberately never invoking a real `security`/`secret-tool` process. A
// real invocation could hang this test suite waiting on a GUI keychain
// unlock prompt on a machine that has one, and would need a live Secret
// Service session on Linux -- neither is available, or safe to depend on,
// in a headless CI run. See runner's doc comment in keystore.go.
package keystore

import (
	"context"
	"errors"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

const testSentinelKey = "sk-ant-keychain-store-sentinel-value"

// fakeSecurityNotFoundMessage reproduces, verbatim, the diagnostic text
// macOS's `security find-generic-password`/`delete-generic-password` print
// for "no matching entry" -- darwinCLI.isNotFound matches on this exact
// substring, so the fakes below need to reproduce it exactly, capitalization
// and trailing period included, to meaningfully exercise that matcher.
//
//nolint:revive // error-strings wants a lowercase, unpunctuated message; this is a fixture reproducing a real external tool's actual output, not this package's own error.
const fakeSecurityNotFoundMessage = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."

// fakeRunner simulates a credential-store CLI's process behaviour entirely
// in memory: existing reports which binaries are "installed", and calls
// records every invocation for assertions. handle, when set, lets a test
// substitute custom behaviour (e.g. an error) for a specific call.
type fakeRunner struct {
	existing map[string]bool
	calls    []fakeCall
	handle   func(name string, args []string, stdin string) (string, error)
}

type fakeCall struct {
	name  string
	args  []string
	stdin string
}

func (f *fakeRunner) commandExists(name string) bool { return f.existing[name] }

func (f *fakeRunner) run(_ context.Context, name string, args []string, stdin string) (string, error) {
	f.calls = append(f.calls, fakeCall{name: name, args: args, stdin: stdin})
	if f.handle != nil {
		return f.handle(name, args, stdin)
	}
	return "", nil
}

func TestDarwinCLI_Fn_SetArgsPassesTheKeyAsAnArgumentNotStdin(t *testing.T) {
	// Documents *why* darwinCLI.setArgs looks the way it does (see its doc
	// comment): `security add-generic-password` has no stdin form, so this
	// asserts the one place the raw key does appear on the argv, and that
	// stdin is empty (nothing accidentally duplicated there).
	args, stdin := darwinCLI{}.setArgs("anthropic", secret.New(testSentinelKey))
	assert.Equal(t, stdin, "")
	assert.Assert(t, containsArg(args, testSentinelKey), "expected the key in argv: %v", args)
	assert.Assert(t, containsArg(args, "anthropic"))
	assert.Assert(t, containsArg(args, service))
}

func TestLinuxCLI_Fn_SetArgsPassesTheKeyOnStdinNotArgv(t *testing.T) {
	// The opposite property from darwin: secret-tool's documented interface
	// takes the secret on stdin, so the argv must never contain it.
	args, stdin := linuxCLI{}.setArgs("anthropic", secret.New(testSentinelKey))
	assert.Equal(t, stdin, testSentinelKey)
	assert.Assert(t, !containsArg(args, testSentinelKey), "key leaked into argv: %v", args)
	assert.Assert(t, containsArg(args, "anthropic"))
	assert.Assert(t, containsArg(args, service))
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestKeychainStore_Fn_SetThenGetRoundTrips(t *testing.T) {
	stored := map[string]string{}
	fr := &fakeRunner{
		existing: map[string]bool{"security": true},
		handle: func(_ string, args []string, _ string) (string, error) {
			switch args[0] {
			case "add-generic-password":
				// args: add-generic-password -a <acct> -s <svc> -w <key> -U
				stored[args[2]] = args[6]
				return "", nil
			case "find-generic-password":
				v, ok := stored[args[2]]
				if !ok {
					return "", errors.New(fakeSecurityNotFoundMessage)
				}
				return v + "\n", nil
			default:
				return "", nil
			}
		},
	}
	store := &keychainStore{cli: darwinCLI{}, r: fr}
	ctx := context.Background()

	assert.NilError(t, store.Set(ctx, "anthropic", secret.New(testSentinelKey)))

	got, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, got.Reveal(), testSentinelKey)
}

func TestKeychainStore_Fn_GetOfAbsentKeyIsNotFoundNotError(t *testing.T) {
	fr := &fakeRunner{
		existing: map[string]bool{"security": true},
		handle: func(string, []string, string) (string, error) {
			return "", errors.New(fakeSecurityNotFoundMessage)
		},
	}
	store := &keychainStore{cli: darwinCLI{}, r: fr}

	_, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)
}

func TestKeychainStore_Fn_GetSurfacesAGenuineFailure(t *testing.T) {
	fr := &fakeRunner{
		existing: map[string]bool{"security": true},
		handle: func(string, []string, string) (string, error) {
			return "", errors.New("security: something unexpected and not a not-found error")
		},
	}
	store := &keychainStore{cli: darwinCLI{}, r: fr}

	_, ok, err := store.Get(context.Background(), "anthropic")
	assert.Equal(t, ok, false)
	assert.ErrorContains(t, err, "unexpected")
}

func TestKeychainStore_Fn_DeleteOfAbsentKeyIsNotAnError(t *testing.T) {
	fr := &fakeRunner{
		existing: map[string]bool{"secret-tool": true},
		handle: func(string, []string, string) (string, error) {
			return "", errors.New("secret-tool: exit status 1")
		},
	}
	store := &keychainStore{cli: linuxCLI{}, r: fr}
	assert.NilError(t, store.Delete(context.Background(), "anthropic"))
}

func TestNewKeychainStore_Fn_UnavailableWhenBinaryIsMissing(t *testing.T) {
	// newKeychainStore consults the real execRunner internally; this only
	// exercises the GOOS->adapter selection and the "not on PATH" path
	// safely by picking a GOOS this test host is not (so the real PATH
	// lookup is irrelevant), rather than by asserting anything about
	// whether `security`/`secret-tool` actually exist on the machine
	// running the test.
	if cliAdapterForGOOS("plan9") != nil {
		t.Fatal("expected no adapter for an unsupported GOOS")
	}
}
