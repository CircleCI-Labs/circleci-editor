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

// Package schema embeds the official CircleCI configuration JSON Schema and
// serves it to the frontend as the source of truth for YAML autocompletion
// (issue #32).
//
// # Provenance
//
// schema.json in this directory is vendored, byte-for-byte and unmodified,
// from the "schema.json" release asset published by
// https://github.com/CircleCI-Public/circleci-yaml-language-server — the
// same schema that powers that project's own LSP completions and the
// official CircleCI VS Code extension. It is licensed Apache-2.0; see
// CONTRIBUTING.md's third-party attributions for the full attribution. It is
// deliberately vendored as a static asset rather than by running that
// project's (13-20MB per platform) language server binary as a subprocess:
// this keeps the editor a single self-contained binary, and a JSON Schema is
// more than enough to drive structural/enum-aware completion without needing
// a live LSP connection.
//
// # Refreshing
//
// There is no automated refresh; upstream publishes a new schema.json with
// every release, and this one is not guaranteed to stay current. To pick up
// a newer version, from the repository root:
//
//	gh api repos/CircleCI-Public/circleci-yaml-language-server/releases/latest \
//	  --jq '.assets[]|select(.name=="schema.json")|.url' \
//	  | xargs -I{} gh api {} -H 'Accept: application/octet-stream' \
//	  > internal/schema/schema.json
//	go test ./internal/schema/...
//
// then update the release version mentioned in CONTRIBUTING.md's
// third-party attributions.
//
// Note the tag naming: releases are tagged without a leading "v" (0.36.1,
// not v0.36.1), even though the GitHub UI and `gh release list` display a
// "v"-prefixed title. `gh release download v0.36.1` therefore fails with
// "release not found", which is easy to misread as the asset having moved.
//
// The vendored copy was verified byte-identical to upstream 0.36.1
// (sha256 7e3d291ea3ebba1d76b1752c925420c2637863cbac1e3f723e10e80e4be31220);
// TestSchemaChecksum pins that, so an accidental local edit fails the build
// rather than silently diverging from the file we claim to redistribute.
//
// This package cannot add a `task schema:refresh` target itself (Taskfile.yml
// is outside its remit); adding one that wraps the command above to
// Taskfile.yml would be a good follow-up.
package schema

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
)

// raw is the vendored schema, embedded verbatim at build time. See the
// package doc comment for provenance and refresh instructions.
//
//go:embed schema.json
var raw []byte

// JSON returns the embedded schema's raw JSON bytes. Callers must treat the
// returned slice as read-only: it aliases the package-level embedded data,
// not a copy.
func JSON() []byte {
	return raw
}

// etag is computed once at package init from the embedded bytes: the schema
// can only change by rebuilding the binary, so a single fixed ETag for the
// lifetime of the process is correct and never needs invalidating.
var etag = computeETag(raw)

// ETag returns a quoted HTTP ETag value (RFC 9110 §8.8.3) for the embedded
// schema, suitable for GET /api/schema's ETag response header and for
// comparing against an incoming If-None-Match request header.
func ETag() string {
	return etag
}

func computeETag(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf(`"%s"`, hex.EncodeToString(sum[:])[:32])
}
