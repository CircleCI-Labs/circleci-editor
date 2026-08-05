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

// Package orbs maintains a locally-cached, searchable copy of the CircleCI
// orb registry, so the editor's UI can offer orbs by plain-text search
// (no namespace required) and let the user drag a chosen orb's jobs,
// commands, and executors into a config.
//
// The CircleCI v3 orb registry API (see internal/circleci.ListOrbPackages)
// only supports an exact match on an orb's full "<namespace>/<name>"; it has
// no fuzzy or prefix search of its own. Cache crawls the registry into
// memory (persisting it to disk between runs) and Search ranks that local
// copy against a plain-text query.
package orbs

import (
	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// OrbPackage is the cache's representation of one orb package: everything
// ListOrbPackages returns, plus whether it is certified. Certification is
// not itself a field of the v3 orb/packages response — it is only knowable
// by having asked the API to filter by it — so the cache tracks it
// separately from the embedded circleci.OrbPackage (learned by crawling with
// ListOrbsOptions.Certified set, see Cache.warmCertified).
type OrbPackage struct {
	circleci.OrbPackage
	Certified bool `json:"certified"`
}
