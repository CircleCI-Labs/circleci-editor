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

// Command refresh-snapshot rewrites internal/guides/snapshot/ from the
// current head of circleci/circleci-docs, along with the manifest recording
// the upstream commit SHA and a SHA-256 for every vendored file.
//
// Run it via `task guides:refresh` from the repository root, then run
// `go test ./internal/guides/...`; snapshot/manifest.json records the
// upstream commit SHA, so nothing else needs updating by hand.
// See internal/guides's package doc comment for the provenance and licensing
// this snapshot rests on.
//
// It writes only after a complete, consistent fetch: every file comes from one
// pinned commit, and a failure part-way leaves the existing snapshot untouched.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

func main() {
	dir := flag.String("dir", "internal/guides/snapshot", "snapshot directory to rewrite, relative to the repository root")
	flag.Parse()

	// os.Exit skips deferred calls, so stop() is called explicitly on both
	// paths rather than deferred (gocritic's exitAfterDefer).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, *dir)
	stop()
	if err != nil {
		fmt.Fprintf(os.Stderr, "refresh-snapshot: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, dir string) error {
	fetcher := &guides.Fetcher{}

	commit, committedAt, err := fetcher.ResolveCommit(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("resolved %s@%s to %s (%s)\n", guides.UpstreamRepo, guides.DefaultBranch, commit, committedAt.Format(time.RFC3339))

	files, err := fetcher.FetchAll(ctx, commit)
	if err != nil {
		return err
	}
	fmt.Printf("fetched %d files\n", len(files))

	// Parse before writing: a snapshot this package cannot parse is not one
	// worth committing, and finding that out now beats finding out from a
	// blank pane.
	parsed, err := guides.ParseFiles(files)
	if err != nil {
		return fmt.Errorf("fetched snapshot does not parse: %w", err)
	}
	for _, guide := range parsed {
		fmt.Printf("  %-26s %3d sections\n", guide.ID, len(guide.Sections))
	}

	// Replace wholesale rather than merging, so a file upstream has deleted
	// does not linger in the snapshot and keep being served.
	if rmErr := os.RemoveAll(dir); rmErr != nil {
		return fmt.Errorf("clear %s: %w", dir, rmErr)
	}

	manifest := guides.Manifest{
		Repo:        guides.UpstreamRepo,
		Ref:         guides.DefaultBranch,
		Commit:      commit,
		CommittedAt: committedAt.UTC(),
		VendoredAt:  time.Now().UTC().Truncate(time.Second),
		Files:       make(map[string]string, len(files)),
	}

	paths := make([]string, 0, len(files))
	for repoPath := range files {
		paths = append(paths, repoPath)
	}
	sort.Strings(paths)

	for _, repoPath := range paths {
		target := filepath.Join(dir, filepath.FromSlash(repoPath))
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o750); mkErr != nil {
			return fmt.Errorf("create %s: %w", filepath.Dir(target), mkErr)
		}
		if writeErr := os.WriteFile(target, files[repoPath], 0o600); writeErr != nil {
			return fmt.Errorf("write %s: %w", target, writeErr)
		}
		sum := sha256.Sum256(files[repoPath])
		manifest.Files[repoPath] = hex.EncodeToString(sum[:])
	}

	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	encoded = append(encoded, '\n')
	if writeErr := os.WriteFile(filepath.Join(dir, "manifest.json"), encoded, 0o600); writeErr != nil {
		return fmt.Errorf("write manifest: %w", writeErr)
	}

	fmt.Printf("wrote %s at commit %s\n", dir, commit)
	return nil
}
