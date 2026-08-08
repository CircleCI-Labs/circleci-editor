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

package guides

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// This file fetches the guides' AsciiDoc source from GitHub. Two callers use
// it: `task guides:refresh` (which writes snapshot/), and Cache's background
// refresh (which keeps a running editor's copy current between releases).
// Both go through FetchAll so the vendored snapshot and a live refresh are
// always the same set of files, resolved the same way.
//
// It reads *public raw content only* -- no token, no authentication, no
// CircleCI API. That matters twice over: the pane must work for a user who
// has no CIRCLE_TOKEN (most of this app's endpoints need one), and this
// project must never be in a position where it wants a credential it cannot
// legitimately hold.

const (
	// rawContentBase serves a file's bytes at a pinned commit. Pinned, never
	// a branch name: a refresh must produce a set of files that all came from
	// one upstream commit, or the include graph can be internally
	// inconsistent (a page referring to a partial added after it was read).
	rawContentBase = "https://raw.githubusercontent.com"

	// commitAPIURL resolves a branch to the commit SHA to pin to.
	commitAPIURL = "https://api.github.com/repos/%s/commits/%s"

	// DefaultBranch is the branch a refresh resolves, and the ref recorded
	// alongside the commit it resolves to (Manifest.Ref, Provenance.Ref) --
	// see ResolveCommit. Exported because callers that record provenance
	// need to name it, not just this file that resolves it.
	//
	// circleci/circleci-docs publishes no tags or releases (verified via
	// `gh api repos/circleci/circleci-docs/tags` and `/releases`, both `[]`,
	// issue #286), so this is not a placeholder pending tag support -- it is
	// the only ref there currently is to point at upstream.
	DefaultBranch = "main"

	// maxFileBytes bounds any single fetched file. The largest in the
	// snapshot is the configuration reference at ~110 KB; 4 MB is generous
	// headroom that still refuses to stream something pathological into
	// memory.
	maxFileBytes = 4 << 20

	// maxFiles bounds the include closure, so a cycle or an upstream change
	// that includes a whole directory tree cannot turn a refresh into an
	// unbounded crawl. The twenty-page set needs ~40 (twenty entry pages plus
	// the partials they share); 300 leaves room for upstream factoring more
	// content out into partials without a refresh starting to fail, while
	// still being far below the 811-file corpus. TestUpstreamClosureFits
	// WithinTheFetchBudget checks the real closure against this.
	maxFiles = 300

	// fetchTimeout bounds one file's request.
	fetchTimeout = 20 * time.Second
)

// ErrNotFound reports that a requested upstream file does not exist. It is
// distinguished from other failures because a *missing* include is a content
// change upstream (the parser renders a note in its place), whereas a
// transport failure means "try again later".
var ErrNotFound = errors.New("guides: upstream file not found")

// Fetcher reads files from an upstream circleci-docs commit.
type Fetcher struct {
	// HTTPClient is the client used for every request; nil means
	// http.DefaultClient. Tests substitute one backed by an httptest server.
	HTTPClient *http.Client
	// Repo is the upstream repository; empty means UpstreamRepo.
	Repo string
	// BaseURL overrides rawContentBase, for tests.
	BaseURL string
	// APIBaseURL overrides the commit-resolution endpoint, for tests.
	APIBaseURL string
	// TreeAPIURL overrides the tree-listing endpoint ListTree calls, for
	// tests. Separate from APIBaseURL because the two hit different GitHub
	// API shapes (a commit lookup vs. a recursive tree listing) and a test
	// exercising both needs to point them at different handlers on the same
	// fake server.
	TreeAPIURL string
}

func (f *Fetcher) client() *http.Client {
	if f.HTTPClient != nil {
		return f.HTTPClient
	}
	return http.DefaultClient
}

func (f *Fetcher) repo() string {
	if f.Repo != "" {
		return f.Repo
	}
	return UpstreamRepo
}

// ResolveCommit resolves DefaultBranch to a full commit SHA and that commit's
// own timestamp, so a fetch can be pinned and the result honestly dated.
func (f *Fetcher) ResolveCommit(ctx context.Context) (sha string, committedAt time.Time, err error) {
	base := f.APIBaseURL
	if base == "" {
		base = fmt.Sprintf(commitAPIURL, f.repo(), DefaultBranch)
	}

	body, err := f.get(ctx, base, "application/vnd.github+json")
	if err != nil {
		return "", time.Time{}, err
	}

	var payload struct {
		SHA    string `json:"sha"`
		Commit struct {
			Committer struct {
				Date time.Time `json:"date"`
			} `json:"committer"`
		} `json:"commit"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", time.Time{}, fmt.Errorf("guides: parse commit response: %w", err)
	}
	if payload.SHA == "" {
		return "", time.Time{}, errors.New("guides: commit response carried no sha")
	}
	return payload.SHA, payload.Commit.Committer.Date, nil
}

// FetchFile reads one repository path at commit.
func (f *Fetcher) FetchFile(ctx context.Context, commit, repoPath string) ([]byte, error) {
	base := f.BaseURL
	if base == "" {
		base = rawContentBase
	}
	url := fmt.Sprintf("%s/%s/%s/%s", strings.TrimRight(base, "/"), f.repo(), commit, repoPath)
	return f.get(ctx, url, "text/plain")
}

func (f *Fetcher) get(ctx context.Context, url, accept string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("guides: build request for %s: %w", url, err)
	}
	req.Header.Set("Accept", accept)

	// gosec's taint analysis flags this as SSRF because `url` is a variable.
	// It is not reachable from request input: every caller builds it from this
	// package's own constants (rawContentBase / commitAPIURL, or a test's
	// httptest URL) plus a commit SHA and a repository path derived from
	// Sources and from `include::` directives inside content fetched from that
	// same pinned commit. Nothing a browser or a config file can set reaches
	// here.
	resp, err := f.client().Do(req) //nolint:gosec // See the note above: url is package-internal, not request-derived.
	if err != nil {
		return nil, fmt.Errorf("guides: fetch %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, url)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("guides: fetch %s: unexpected status %d", url, resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("guides: read %s: %w", url, err)
	}
	if len(data) > maxFileBytes {
		return nil, fmt.Errorf("guides: %s exceeds the %d-byte limit", url, maxFileBytes)
	}
	return data, nil
}

// FetchAll fetches every file the vendored guides need at commit: every
// UpstreamSources entry page plus the transitive closure of their `include::`
// targets.
//
// This is the *whole* mechanism the owner asked to keep going ("Ideally we could
// just take from CircleCI and utilize that, so that way we can keep that update
// mechanism going"). Both `task guides:refresh` and Cache's seven-day background
// refresh call this one function, and it derives its work list from
// UpstreamSources() rather than from a separate hand-maintained list -- so a
// page added to Sources is vendored *and* refreshed with no further wiring, and
// a widened snapshot cannot end up with nineteen frozen pages and one live one.
//
// Resolving the closure -- rather than vendoring a hand-listed set of files --
// is what makes a refresh a one-command operation: when upstream factors a
// section out into a new partial, the next refresh picks it up without anyone
// noticing and editing a list. A target that 404s is skipped (the parser
// renders an honest note in its place); a target under archive/ or in a
// server-admin component is skipped by policy (see ExcludedPathReason), so the
// closure cannot walk into the 429 files this project deliberately does not
// serve; any other failure aborts, because a half-fetched snapshot must never
// be written.
func (f *Fetcher) FetchAll(ctx context.Context, commit string) (map[string][]byte, error) {
	files := map[string][]byte{}

	type queued struct {
		repoPath  string
		component string
		module    string
	}
	sources := UpstreamSources()
	queue := make([]queued, 0, len(sources))
	for _, src := range sources {
		queue = append(queue, queued{repoPath: src.entryPath(), component: src.Component, module: src.Module})
	}

	for len(queue) > 0 {
		if len(files) > maxFiles {
			return nil, fmt.Errorf("guides: include closure exceeded %d files", maxFiles)
		}
		item := queue[0]
		queue = queue[1:]
		if _, seen := files[item.repoPath]; seen {
			continue
		}
		if reason := ExcludedPathReason(item.repoPath); reason != "" {
			// Not fetched at all, so it can neither be written to the snapshot
			// nor spliced into a page. An entry page can never land here --
			// TestNoSourceIsAnExcludedPath pins that -- so this only ever fires
			// on an include target, which the parser then renders as a note.
			continue
		}

		data, err := f.FetchFile(ctx, commit, item.repoPath)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		files[item.repoPath] = data

		if !strings.HasSuffix(item.repoPath, ".adoc") {
			continue
		}
		ctxFor := spanContext{component: item.component, module: item.module}
		for _, target := range includeTargets(data) {
			id, idErr := parseResourceID(target, ctxFor)
			if idErr != nil {
				// An include this package cannot address is left to the
				// parser to report as a note; nothing to fetch.
				continue
			}
			queue = append(queue, queued{repoPath: id.repoPath(), component: id.component, module: id.module})
		}
	}

	// Every upstream entry page must be present, or the refresh produced
	// something this package cannot serve and must not overwrite a good
	// snapshot with. All twenty, not a quorum: a refresh that silently lost a
	// page would leave that page frozen at whatever the binary shipped, which
	// is exactly the failure the expanded set has to rule out.
	for _, src := range sources {
		if _, ok := files[src.entryPath()]; !ok {
			return nil, fmt.Errorf("guides: entry page %s was not fetched", src.entryPath())
		}
	}
	return files, nil
}

// includeTargets extracts every `include::target[]` target from AsciiDoc
// source. Deliberately textual and line-anchored, matching what the parser
// itself recognises, so the fetcher and the parser can never disagree about
// what needs to be present.
func includeTargets(source []byte) []string {
	var out []string
	for _, line := range splitLines(string(source)) {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "include::") {
			continue
		}
		target := strings.TrimPrefix(trimmed, "include::")
		if bracket := strings.IndexByte(target, '['); bracket >= 0 {
			target = target[:bracket]
		}
		target = strings.TrimSpace(target)
		if target != "" {
			out = append(out, target)
		}
	}
	return out
}
