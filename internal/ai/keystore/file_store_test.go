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
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

const sentinelKey = "sk-ant-file-store-sentinel-value"

// newFileBackedStore forces the file backend via the env var escape hatch
// (see keystore.KeystoreBackendEnvVar) and points XDG_CONFIG_HOME at a fresh
// temp directory, so every test gets an isolated store regardless of what
// keychain tooling happens to be on the host running the test.
func newFileBackedStore(t *testing.T) (keystore.Store, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv(keystore.KeystoreBackendEnvVar, "file")

	store, err := keystore.Open()
	assert.NilError(t, err)
	assert.Equal(t, store.Backend(), keystore.BackendFile)
	return store, dir
}

func TestFileStore_Fn_RoundTripsAKey(t *testing.T) {
	store, _ := newFileBackedStore(t)
	ctx := context.Background()

	_, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false, "no key stored yet")

	assert.NilError(t, store.Set(ctx, "anthropic", secret.New(sentinelKey)))

	got, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, got.Reveal(), sentinelKey)
}

func TestFileStore_Fn_DeleteRemovesTheKey(t *testing.T) {
	store, _ := newFileBackedStore(t)
	ctx := context.Background()

	assert.NilError(t, store.Set(ctx, "anthropic", secret.New(sentinelKey)))
	assert.NilError(t, store.Delete(ctx, "anthropic"))

	_, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)
}

func TestFileStore_Fn_DeleteOfAbsentKeyIsNotAnError(t *testing.T) {
	store, _ := newFileBackedStore(t)
	assert.NilError(t, store.Delete(context.Background(), "anthropic"))
}

func TestFileStore_Fn_KeysForDifferentProvidersAreIndependent(t *testing.T) {
	store, _ := newFileBackedStore(t)
	ctx := context.Background()

	assert.NilError(t, store.Set(ctx, "anthropic", secret.New("anthropic-key")))
	assert.NilError(t, store.Set(ctx, "other-provider", secret.New("other-key")))
	assert.NilError(t, store.Delete(ctx, "anthropic"))

	_, ok, err := store.Get(ctx, "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)

	got, ok, err := store.Get(ctx, "other-provider")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, got.Reveal(), "other-key")
}

func TestFileStore_Fn_WritesA0600File(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on windows")
	}
	store, _ := newFileBackedStore(t)
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(sentinelKey)))

	info, err := os.Stat(store.Location())
	assert.NilError(t, err)
	assert.Equal(t, info.Mode().Perm(), os.FileMode(0o600))
}

func TestFileStore_Fn_LocationIsUnderTheConfiguredConfigDir(t *testing.T) {
	store, dir := newFileBackedStore(t)
	assert.Assert(t, strings.HasPrefix(store.Location(), dir), "location %q not under %q", store.Location(), dir)
	assert.Assert(t, is.Contains(store.Location(), "circleci-editor"))
}

// TestFileStore_Fn_NeverWritesAKeyOutsideItsOwnFile guards the core promise
// this backend exists to keep: the key lands in exactly one file, at 0600,
// and nowhere the rest of the process's filesystem footprint (a repo
// checkout, a temp directory some other component might scan) would ever
// see it. It does that by asserting the sentinel value appears in exactly
// the one file this store reports as its Location.
func TestFileStore_Fn_NeverWritesAKeyOutsideItsOwnFile(t *testing.T) {
	store, dir := newFileBackedStore(t)
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(sentinelKey)))

	var hits []string
	assert.NilError(t, filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // test-only walk of a t.TempDir().
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), sentinelKey) {
			hits = append(hits, path)
		}
		return nil
	}))

	assert.DeepEqual(t, hits, []string{store.Location()})
}

func TestFileStore_Fn_KeysFileHasNoOtherPlaintextLeaks(t *testing.T) {
	store, _ := newFileBackedStore(t)
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(sentinelKey)))

	data, err := os.ReadFile(store.Location()) //nolint:gosec // test-only read of a t.TempDir() path.
	assert.NilError(t, err)

	var decoded map[string]string
	assert.NilError(t, json.Unmarshal(data, &decoded))
	assert.DeepEqual(t, decoded, map[string]string{"anthropic": sentinelKey})
}
