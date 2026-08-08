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

// Command refresh-image-index rewrites internal/guides/imageindex/index.json
// from the current head of circleci/circleci-docs: a basename -> canonical-
// page-URL map covering every page in the repository that shows an image,
// not only the twenty pages internal/guides/snapshot vendors as prose.
//
// Run it via `task guides:refresh-image-index` from the repository root,
// then run `go test ./internal/guides/...`.
//
// This is deliberately a *separate* command from refresh-snapshot, and
// running it neither requires nor triggers a run of the other. refresh-
// snapshot rewrites vendored prose -- a decision with its own review burden,
// including the open question tracked in issue #44 -- while this only ever
// widens the set of image basenames a citation can resolve against; the two
// change at different rates for different reasons and this must be runnable
// on its own. See internal/guides/imageindex_build.go's doc comment for the
// full reasoning, and internal/guides/imageindex.go's for what the output
// file records and why it needs no per-file SHA-256 of prose the way
// snapshot/manifest.json does.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

func main() {
	out := flag.String("out", "internal/guides/imageindex/index.json", "path to write the generated image index, relative to the repository root")
	flag.Parse()

	// os.Exit skips deferred calls, so stop() is called explicitly on both
	// paths rather than deferred (gocritic's exitAfterDefer) -- matching
	// refresh-snapshot's own main().
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, *out)
	stop()
	if err != nil {
		fmt.Fprintf(os.Stderr, "refresh-image-index: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, out string) error {
	fetcher := &guides.Fetcher{}

	commit, committedAt, err := fetcher.ResolveCommit(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("resolved %s@%s to %s (%s)\n", guides.UpstreamRepo, guides.DefaultBranch, commit, committedAt.Format(time.RFC3339))

	idx, stats, err := fetcher.BuildImageIndex(ctx, commit, committedAt)
	if err != nil {
		return err
	}
	fmt.Printf("scanned %d pages, fetched %d files, indexed %d distinct image basename(s), %d collision(s)\n",
		stats.PagesScanned, stats.FilesFetched, len(idx.Images), stats.Collisions)

	encoded, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return fmt.Errorf("encode image index: %w", err)
	}
	encoded = append(encoded, '\n')

	if mkErr := os.MkdirAll(filepath.Dir(out), 0o750); mkErr != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(out), mkErr)
	}
	if writeErr := os.WriteFile(out, encoded, 0o600); writeErr != nil {
		return fmt.Errorf("write %s: %w", out, writeErr)
	}

	fmt.Printf("wrote %s at commit %s\n", out, commit)
	return nil
}
