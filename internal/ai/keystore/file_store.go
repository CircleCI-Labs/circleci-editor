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
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// keysFileName is the file fileStore persists to, inside DefaultConfigDir().
const keysFileName = "keys.json"

// keysFileMode and configDirMode are deliberately restrictive: this file
// holds plaintext provider API keys (the OS filesystem's permission bits are
// the only control protecting them once the keychain backend isn't
// available), matching issue #92's "0600 file" requirement exactly. 0700 on
// the directory prevents another local user from even listing it.
const (
	keysFileMode  = 0o600
	configDirMode = 0o700
)

// fileStore is the keychain fallback: a single JSON file
// (`{configDir}/keys.json`, provider id -> plaintext key) written with 0600
// permissions outside any git working tree. Every write replaces the whole
// file atomically (temp file + rename in the same directory), the same
// pattern internal/orbs.Cache already uses for its own disk cache, so a
// crash or concurrent run can never observe a half-written file.
//
// mu serializes reads and writes within this process; it says nothing about
// two separate processes racing on the same file, which is an accepted gap
// -- this tool has no concept of a second instance running concurrently
// against the same key store, and the atomic-rename write pattern means the
// worst a race can do is "last write wins", never a corrupt file.
type fileStore struct {
	mu   sync.Mutex
	path string
}

func newFileStore() (*fileStore, error) {
	dir, err := DefaultConfigDir()
	if err != nil {
		return nil, err
	}
	return &fileStore{path: filepath.Join(dir, keysFileName)}, nil
}

func (f *fileStore) Backend() Backend { return BackendFile }

func (f *fileStore) Location() string { return f.path }

// keysFile is the on-disk (and only-ever-on-disk) shape of the file store.
// Deliberately a flat provider->key map with no metadata: there is nothing
// here worth versioning yet, and every field would need the same "never log
// this struct" discipline the secret package already gives String.
type keysFile map[string]string

func (f *fileStore) Get(_ context.Context, provider string) (secret.String, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	keys, err := f.read()
	if err != nil {
		return secret.String{}, false, err
	}
	value, ok := keys[provider]
	if !ok || value == "" {
		return secret.String{}, false, nil
	}
	return secret.New(value), true, nil
}

func (f *fileStore) Set(_ context.Context, provider string, key secret.String) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	keys, err := f.read()
	if err != nil {
		return err
	}
	if keys == nil {
		keys = keysFile{}
	}
	keys[provider] = key.Reveal() // The one justified Reveal call in this file: writing the key to its own store.
	return f.write(keys)
}

func (f *fileStore) Delete(_ context.Context, provider string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	keys, err := f.read()
	if err != nil {
		return err
	}
	if keys == nil {
		return nil
	}
	delete(keys, provider)
	return f.write(keys)
}

// read loads the keys file, returning an empty (nil) map -- not an error --
// if it doesn't exist yet, which is the normal state before the first key is
// ever configured.
func (f *fileStore) read() (keysFile, error) {
	data, err := os.ReadFile(f.path) //nolint:gosec // f.path is derived from DefaultConfigDir(), an operator-controlled location, plus a package constant filename, never from request input.
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("keystore: read %s: %w", f.path, err)
	}
	var keys keysFile
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, fmt.Errorf("keystore: %s is corrupt: %w", f.path, err)
	}
	return keys, nil
}

// write persists keys atomically: marshal, write to a temp file in the same
// directory (so the final rename is on the same filesystem and therefore
// atomic), then rename over the target path. The temp file is created with
// keysFileMode from the start so there is no window where the key data
// exists on disk with looser permissions.
func (f *fileStore) write(keys keysFile) error {
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, configDirMode); err != nil {
		return fmt.Errorf("keystore: create %s: %w", dir, err)
	}

	data, err := json.Marshal(keys)
	if err != nil {
		return fmt.Errorf("keystore: marshal key store: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "keys-*.tmp")
	if err != nil {
		return fmt.Errorf("keystore: create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	// tmpPath is a name os.CreateTemp itself chose inside dir; it is not
	// derived from any request input, so the Chmod/Remove/Rename calls
	// below are not the path-traversal risk gosec's taint analysis assumes
	// for a variable named "path" (same reasoning as internal/orbs.Cache's
	// saveDiskCache).
	cleanup := func() { _ = os.Remove(tmpPath) } //nolint:gosec

	if err := tmp.Chmod(keysFileMode); err != nil { //nolint:gosec
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("keystore: chmod temp file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("keystore: write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("keystore: close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, f.path); err != nil { //nolint:gosec
		cleanup()
		return fmt.Errorf("keystore: rename %s to %s: %w", tmpPath, f.path, err)
	}
	return nil
}
