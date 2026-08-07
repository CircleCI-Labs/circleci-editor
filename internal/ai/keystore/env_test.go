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

package keystore_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// Every value below is deliberately not a key: no provider issues anything of
// this shape, so a copy that escaped into a log or a fixture would be
// worthless to anyone who found it. Nothing in this repo's tests ever holds a
// real credential.
const (
	envFakeKey    = "not-a-real-key-env-only"
	storedFakeKey = "not-a-real-key-store-only"
)

// memStore is an in-memory keystore.Store: enough for the precedence and
// provenance tests below without any file or keychain involvement.
type memStore struct {
	keys    map[string]string
	getErr  error
	backend keystore.Backend
}

func newMemStore() *memStore {
	return &memStore{keys: map[string]string{}, backend: keystore.BackendFile}
}

func (m *memStore) Get(_ context.Context, entry string) (secret.String, bool, error) {
	if m.getErr != nil {
		return secret.String{}, false, m.getErr
	}
	value, ok := m.keys[entry]
	if !ok {
		return secret.String{}, false, nil
	}
	return secret.New(value), true, nil
}

func (m *memStore) Set(_ context.Context, entry string, key secret.String) error {
	m.keys[entry] = key.Reveal() // Test double standing in for a real store's write; the one place a fake key becomes a plain string.
	return nil
}

func (m *memStore) Delete(_ context.Context, entry string) error {
	delete(m.keys, entry)
	return nil
}

func (m *memStore) Backend() keystore.Backend { return m.backend }
func (m *memStore) Location() string          { return "in-memory test store" }

func TestKeyEnvVar_Fn_DerivesTheNameFromTheEntryID(t *testing.T) {
	assert.Equal(t, keystore.KeyEnvVar("anthropic"), "CIRCLECI_EDITOR_AI_KEY_ANTHROPIC")
	// Non-alphanumerics become underscores so every id this store can hold
	// maps to a legal shell variable name.
	assert.Equal(t, keystore.KeyEnvVar("mcp-docs-token"), "CIRCLECI_EDITOR_AI_KEY_MCP_DOCS_TOKEN")
	assert.Equal(t, keystore.KeyEnvVar("provider.2"), "CIRCLECI_EDITOR_AI_KEY_PROVIDER_2")
}

// TestWithEnvOverride_Fn_EnvironmentWinsOverAStoredKey is the precedence rule
// itself: the documented answer to "which one is used" must be enforced in
// code, not just in the README.
func TestWithEnvOverride_Fn_EnvironmentWinsOverAStoredKey(t *testing.T) {
	inner := newMemStore()
	ctx := context.Background()
	assert.NilError(t, inner.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)

	store := keystore.WithEnvOverride(inner)
	got, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, got.Reveal(), envFakeKey)
}

func TestWithEnvOverride_Fn_FallsBackToTheStoreWhenUnset(t *testing.T) {
	inner := newMemStore()
	ctx := context.Background()
	assert.NilError(t, inner.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	// Explicitly empty rather than merely unset: an exported-but-empty
	// variable must not shadow a perfectly good stored key.
	t.Setenv(keystore.KeyEnvVar("anthropic"), "")

	store := keystore.WithEnvOverride(inner)
	got, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, got.Reveal(), storedFakeKey)
}

func TestWithEnvOverride_Fn_TrimsSurroundingWhitespace(t *testing.T) {
	t.Setenv(keystore.KeyEnvVar("anthropic"), "  "+envFakeKey+"\n")

	store := keystore.WithEnvOverride(newMemStore())
	got, _, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, got.Reveal(), envFakeKey)
}

// TestWithEnvOverride_Fn_WritesStillReachTheUnderlyingStore pins down the
// deliberate asymmetry documented on WithEnvOverride: this process cannot
// change its parent shell's environment, so Set/Delete must keep operating on
// real storage rather than silently becoming no-ops.
func TestWithEnvOverride_Fn_WritesStillReachTheUnderlyingStore(t *testing.T) {
	inner := newMemStore()
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)
	ctx := context.Background()

	store := keystore.WithEnvOverride(inner)
	assert.NilError(t, store.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	_, stored, err := inner.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, stored, true, "Set must write through the overlay")

	assert.NilError(t, store.Delete(ctx, "anthropic"))
	_, stored, err = inner.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, stored, false, "Delete must remove from the underlying store")
}

func TestLookupKey_Fn_ReportsTheStoreWhenNoVariableIsSet(t *testing.T) {
	inner := newMemStore()
	ctx := context.Background()
	assert.NilError(t, inner.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	t.Setenv(keystore.KeyEnvVar("anthropic"), "")

	lookup := keystore.LookupKey(ctx, keystore.WithEnvOverride(inner), "anthropic")
	assert.Equal(t, lookup.Source, keystore.SourceStore)
	assert.Equal(t, lookup.Stored, true)
	assert.Equal(t, lookup.EnvSet, false)
	assert.Equal(t, lookup.EnvVar, "CIRCLECI_EDITOR_AI_KEY_ANTHROPIC")
	assert.NilError(t, lookup.StoreErr)
}

// TestLookupKey_Fn_ReportsAShadowedStoredKey is the "why is it using the
// wrong key" case: both a variable and a stored key exist, and a user has to
// be able to see both facts at once.
func TestLookupKey_Fn_ReportsAShadowedStoredKey(t *testing.T) {
	inner := newMemStore()
	ctx := context.Background()
	assert.NilError(t, inner.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)

	lookup := keystore.LookupKey(ctx, keystore.WithEnvOverride(inner), "anthropic")
	assert.Equal(t, lookup.Source, keystore.SourceEnv)
	assert.Equal(t, lookup.EnvSet, true)
	assert.Equal(t, lookup.Stored, true, "the shadowed stored key must still be reported as stored")
}

func TestLookupKey_Fn_ReportsNothingConfigured(t *testing.T) {
	t.Setenv(keystore.KeyEnvVar("anthropic"), "")

	lookup := keystore.LookupKey(context.Background(), keystore.WithEnvOverride(newMemStore()), "anthropic")
	assert.Equal(t, lookup.Source, keystore.SourceNone)
	assert.Equal(t, lookup.Stored, false)
	assert.Equal(t, lookup.EnvSet, false)
}

// TestLookupKey_Fn_SurfacesAStoreFailureAlongsideAnEnvironmentKey covers the
// awkward middle: the store is unreadable, but a variable means a key is
// still in effect. Reporting only the failure would tell the user their AI
// pane is broken when it is not.
func TestLookupKey_Fn_SurfacesAStoreFailureAlongsideAnEnvironmentKey(t *testing.T) {
	inner := newMemStore()
	inner.getErr = errors.New("keystore: /tmp/keys.json is corrupt")
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)

	lookup := keystore.LookupKey(context.Background(), keystore.WithEnvOverride(inner), "anthropic")
	assert.Equal(t, lookup.Source, keystore.SourceEnv)
	assert.Assert(t, lookup.StoreErr != nil)
	assert.Equal(t, lookup.Stored, false)
}

// TestLookupKey_Fn_HasNoFieldThatCanHoldAKey is the structural guarantee the
// `ai status` command is built on: if this type ever grows a field carrying
// the value, a status command that prints "everything about the key" starts
// printing the key. Written as an assertion about the value rather than
// reflection over fields, since that is what actually matters -- no string in
// the result equals the key in effect.
func TestLookupKey_Fn_HasNoFieldThatCanHoldAKey(t *testing.T) {
	inner := newMemStore()
	ctx := context.Background()
	assert.NilError(t, inner.Set(ctx, "anthropic", secret.New(storedFakeKey)))
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)

	lookup := keystore.LookupKey(ctx, keystore.WithEnvOverride(inner), "anthropic")
	rendered := fmt.Sprintf("%#v %+v", lookup, lookup)
	assert.Assert(t, !strings.Contains(rendered, envFakeKey), "the lookup result rendered the environment key")
	assert.Assert(t, !strings.Contains(rendered, storedFakeKey), "the lookup result rendered the stored key")
}

// TestOpen_Fn_AppliesTheEnvironmentOverride checks the wrapper is applied by
// Open itself, not left to each caller: that is what keeps the CLI and the
// editor's own handlers on the same precedence rule.
func TestOpen_Fn_AppliesTheEnvironmentOverride(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv(keystore.KeystoreBackendEnvVar, "file")
	t.Setenv(keystore.KeyEnvVar("anthropic"), envFakeKey)

	store, err := keystore.Open()
	assert.NilError(t, err)

	got, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true, "the environment key must be visible through a store that has nothing stored")
	assert.Equal(t, got.Reveal(), envFakeKey)

	// Nothing was written: an environment key is not persisted as a side
	// effect of being read.
	_, statErr := os.Stat(store.Location())
	assert.Assert(t, os.IsNotExist(statErr), "reading an environment key must not create %s", store.Location())
}

func TestSelect_Fn_ForcedFileBackendIsNotReportedAsAFallback(t *testing.T) {
	t.Setenv(keystore.KeystoreBackendEnvVar, "file")

	selection := keystore.Select()
	assert.Equal(t, selection.Backend, keystore.BackendFile)
	assert.Equal(t, selection.Forced, true)
	assert.Equal(t, selection.UsesFallback(), false, "an explicitly requested file backend is a choice, not a degradation")
	assert.Equal(t, selection.FallbackReason, "")
}

// TestSelect_Fn_ExplainsAnUnavailableKeychain is the "no silent degradation"
// guarantee: when the platform's credential CLI can't be found, Select has to
// hand the caller a printable reason, because the CLI prints it before
// storing anything.
func TestSelect_Fn_ExplainsAnUnavailableKeychain(t *testing.T) {
	t.Setenv(keystore.KeystoreBackendEnvVar, "keychain")
	// An empty PATH makes exec.LookPath fail for every candidate binary, so
	// this exercises the unavailable branch identically on macOS, Linux, and
	// Windows (where there is no supported binary in the first place).
	t.Setenv("PATH", "")

	selection := keystore.Select()
	assert.Equal(t, selection.Backend, keystore.BackendFile)
	assert.Equal(t, selection.UsesFallback(), true)
	switch runtime.GOOS {
	case "darwin":
		assert.Assert(t, is.Contains(selection.FallbackReason, "security"))
	case "linux":
		assert.Assert(t, is.Contains(selection.FallbackReason, "secret-tool"))
	default:
		assert.Assert(t, is.Contains(selection.FallbackReason, runtime.GOOS))
	}
}

// TestSelect_Fn_MatchesTheBackendOpenActuallyReturns keeps the explanation
// honest: a Selection that disagreed with the store a user got would be worse
// than no explanation at all.
func TestSelect_Fn_MatchesTheBackendOpenActuallyReturns(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("PATH", "")

	store, err := keystore.Open()
	assert.NilError(t, err)
	assert.Equal(t, keystore.Select().Backend, store.Backend())
}

// TestEnvKey_SupersededPrefixStillWorks pins the migration promise: someone who
// exported the pre-rename variable name keeps working, and is told what to
// change. Renaming an environment variable that may sit in a shell profile
// should announce itself rather than silently stop supplying a key -- which,
// for an AI key, would look like the pane forgetting a key that is right there
// in the environment.
func TestEnvKey_SupersededPrefixStillWorks(t *testing.T) {
	t.Setenv(keystore.SupersededKeyEnvVarPrefix+"ANTHROPIC", "sk-from-old-name")

	store := keystore.WithEnvOverride(newMemStore())
	got, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Assert(t, ok, "the superseded variable name must still supply a key")
	assert.Equal(t, got.Reveal(), "sk-from-old-name")
}

// TestEnvKey_CurrentPrefixWinsOverSuperseded pins precedence between the two
// spellings, so a half-migrated environment behaves predictably rather than
// depending on lookup order.
func TestEnvKey_CurrentPrefixWinsOverSuperseded(t *testing.T) {
	t.Setenv(keystore.KeyEnvVarPrefix+"ANTHROPIC", "sk-from-new-name")
	t.Setenv(keystore.SupersededKeyEnvVarPrefix+"ANTHROPIC", "sk-from-old-name")

	store := keystore.WithEnvOverride(newMemStore())
	got, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Assert(t, ok)
	assert.Equal(t, got.Reveal(), "sk-from-new-name")
}

// TestLookupKey_NamesTheVariableActuallySupplyingTheKey pins an honesty
// property, not a formatting one. When the superseded spelling is what supplies
// the key, a status line that names the *current* variable is telling the user
// about a variable they have not set while a different one does the work -- and
// someone debugging "why is it using the wrong key" would be sent to look in
// the wrong place.
func TestLookupKey_NamesTheVariableActuallySupplyingTheKey(t *testing.T) {
	t.Setenv(keystore.SupersededKeyEnvVarPrefix+"ANTHROPIC", "sk-from-old-name")

	got := keystore.LookupKey(context.Background(), newMemStore(), "anthropic")
	assert.Equal(t, got.Source, keystore.SourceEnv)
	assert.Equal(t, got.EnvVar, keystore.SupersededKeyEnvVarPrefix+"ANTHROPIC")
}

// TestLookupKey_NamesTheCurrentVariableWhenNothingIsSet keeps the advice useful
// in the common case: with neither spelling set, the name worth showing is the
// one a reader should go and use.
func TestLookupKey_NamesTheCurrentVariableWhenNothingIsSet(t *testing.T) {
	got := keystore.LookupKey(context.Background(), newMemStore(), "anthropic")
	assert.Equal(t, got.Source, keystore.SourceNone)
	assert.Equal(t, got.EnvVar, keystore.KeyEnvVar("anthropic"))
}
