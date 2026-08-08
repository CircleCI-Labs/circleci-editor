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
	"embed"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// ImageIndex is the remaining piece of issue #19 ("Image indexing beyond the
// vendored guides"): a basename -> canonical-page-URL map covering every
// page in circleci-docs that shows an image, not just the twenty this
// package vendors as prose. cmd/refresh-image-index builds it by walking the
// repository (see imageindex_build.go); CitationResolver.AddImageIndex is how
// a resolver uses it.
//
// Deliberately thin next to Manifest: it carries no vendored bytes, and so
// needs no per-file SHA-256 of prose, because it has no prose -- Images holds
// nothing but a basename and a URL, and both are already public (a docs
// page's own address is not a secret, nor is the filename of a picture on
// it). What makes it auditable instead is PageChecksums: a SHA-256, taken at
// generation time, of every page that actually contributed an entry to
// Images. Re-fetching that path at Commit and re-hashing it must reproduce
// the same digest, or this index no longer matches what it claims to
// describe -- the same guarantee Manifest gives the vendored prose, applied
// to pages this project deliberately never vendors.
type ImageIndex struct {
	// Repo and Ref name the upstream repository and branch, exactly as
	// Manifest's fields of the same name do.
	Repo string `json:"repo"`
	Ref  string `json:"ref"`
	// Commit is the upstream commit every page below was read at.
	Commit string `json:"commit"`
	// CommittedAt is that commit's own upstream timestamp.
	CommittedAt time.Time `json:"committedAt"`
	// GeneratedAt is when cmd/refresh-image-index produced this file.
	GeneratedAt time.Time `json:"generatedAt"`
	// PagesScanned is the number of Antora pages this run considered --
	// every non-excluded page-family file in the repository tree at Commit,
	// whether or not it ended up contributing an entry to Images.
	PagesScanned int `json:"pagesScanned"`
	// FilesFetched is the number of distinct files (pages, plus the
	// partials they include) this run actually fetched. Always
	// >= PagesScanned (every scanned page is itself fetched) and always
	// < maxIndexFiles.
	FilesFetched int `json:"filesFetched"`
	// Images maps a lowercased image basename to the canonical circleci.com
	// URL of the page that shows it. A basename shown by more than one page
	// maps to exactly one -- see imageIndexSeeds's doc comment for which one
	// and why.
	Images map[string]string `json:"images"`
	// PageChecksums maps the repository path of every page that contributed
	// at least one entry to Images to that page's own SHA-256 at Commit --
	// the provenance record this index has in place of Manifest's per-file
	// hash of vendored bytes.
	PageChecksums map[string]string `json:"pageChecksums"`
}

// imageIndexPath is where the generated index lives inside this package,
// embedded so resolving a citation needs no network -- the same property
// LoadManifest and ParseSnapshot already give the vendored prose, and for the
// same reason: this pane must work for a user with no CIRCLE_TOKEN and no
// connectivity at all.
const imageIndexPath = "imageindex/index.json"

//go:embed imageindex/index.json
var imageIndexFS embed.FS

var (
	imageIndexOnce sync.Once
	imageIndexVal  ImageIndex
	imageIndexErr  error
)

// LoadImageIndex reads the embedded image index, caching the parsed result
// after the first call.
//
// Caching is safe in a way it would not be for the vendored prose snapshot:
// Cache can replace *that* at runtime with a freshly fetched copy (see
// cache.go), but this index has no live-refresh path at all -- widening its
// coverage means running cmd/refresh-image-index and committing the result,
// which requires a rebuild to take effect either way. So the embedded copy is
// the only copy for the lifetime of the process, and re-parsing it on every
// citations() call (internal/host/ai.go) would buy nothing.
func LoadImageIndex() (ImageIndex, error) {
	imageIndexOnce.Do(func() {
		data, readErr := imageIndexFS.ReadFile(imageIndexPath)
		if readErr != nil {
			imageIndexErr = fmt.Errorf("guides: read image index: %w", readErr)
			return
		}
		if jsonErr := json.Unmarshal(data, &imageIndexVal); jsonErr != nil {
			imageIndexErr = fmt.Errorf("guides: parse image index: %w", jsonErr)
		}
	})
	return imageIndexVal, imageIndexErr
}
