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

package circleci

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// orbPackagesPath is the CircleCI API v3 endpoint used to list orb
// packages. Orb endpoints are v3-only — unlike config compilation, which is
// v2-only (see compileConfigPath) — the CircleCI API has no v2/v3 overlap
// here.
const orbPackagesPath = "/api/v3/orb/packages"

// orbSourcePathFmt is the CircleCI API v3 endpoint used to fetch a single
// orb version's raw YAML source, formatted with the version's UUID.
const orbSourcePathFmt = "/api/v3/orb/versions/%s/source"

// maxOrbPackagePages bounds how many pages ListAllOrbPackages will follow
// before giving up, guarding against an API bug (or a cursor that never
// terminates) turning a crawl into an infinite loop. The full public
// registry is roughly 6,400 orbs: ~13 pages at the 500-item page size
// internal/orbs currently requests, or up to ~64 pages if it has fallen back
// to the smallest page size it retries at (see pageSizeFloor in
// internal/orbs/cache.go). This cap leaves generous headroom above either.
const maxOrbPackagePages = 500

// ErrOrbNotFound is returned by GetOrbPackageByName when the CircleCI API
// reports no orb matching the requested name.
var ErrOrbNotFound = errors.New("circleci: orb not found")

// OrbVersion describes a single published version of an orb.
type OrbVersion struct {
	// ID is the version's UUID, as used by GetOrbSource.
	ID string `json:"id"`

	// Version is the orb version string, e.g. "1.10.0". CircleCI also
	// allows non-semver "dev:<label>" versions; Compare (via
	// OrbPackage.LatestVersion) ranks those below any parseable semver
	// version and falls back to CreatedAt to order them.
	Version string `json:"version"`

	// CreatedAt is when this version was published.
	CreatedAt time.Time `json:"createdAt"`
}

// OrbPackage describes a single orb (a namespace/name pair) together with
// every version the API returned for it.
type OrbPackage struct {
	// ID is the orb's UUID.
	ID string `json:"id"`

	// Name is the orb's full "<namespace>/<name>".
	Name string `json:"name"`

	// Private reports whether this orb is private to its namespace's
	// organization, as opposed to publicly visible.
	Private bool `json:"private"`

	// Listed reports whether this orb opted in to being listed in the
	// public registry (an unlisted orb can still be fetched by exact
	// name, but is not meant to be discovered by browsing/searching).
	Listed bool `json:"listed"`

	// NamespaceID is the UUID of the namespace this orb belongs to.
	NamespaceID string `json:"namespaceId"`

	// Versions lists every version the API returned for this orb. For
	// packages obtained from ListOrbPackages/ListAllOrbPackages/
	// GetOrbPackageByName, this is populated directly from the list
	// response — no extra request is needed to learn an orb's versions.
	Versions []OrbVersion `json:"versions"`
}

// LatestVersion returns the newest entry in p.Versions, or ok=false if
// p.Versions is empty. "Newest" is determined by CompareVersions, falling
// back to CreatedAt to break ties (including whenever neither version
// string is parseable as semver).
func (p OrbPackage) LatestVersion() (OrbVersion, bool) {
	if len(p.Versions) == 0 {
		return OrbVersion{}, false
	}

	best := p.Versions[0]
	for _, v := range p.Versions[1:] {
		if versionIsNewer(v, best) {
			best = v
		}
	}
	return best, true
}

// versionIsNewer reports whether a should be considered newer than b.
func versionIsNewer(a, b OrbVersion) bool {
	if c := CompareVersions(a.Version, b.Version); c != 0 {
		return c > 0
	}
	return a.CreatedAt.After(b.CreatedAt)
}

// semverPattern matches a (possibly "v"-prefixed) dotted-triple semver
// version, with an optional dot/hyphen-separated pre-release suffix (e.g.
// "1.10.0", "v2.0.0-beta.1"). CircleCI's non-semver "dev:<label>" orb
// versions never match this and are therefore always treated as
// unparseable by parseSemver.
var semverPattern = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)

// semver is a minimal parsed semantic version: just enough to order
// CircleCI orb versions correctly (in particular, numeric segment
// comparison rather than lexical string comparison, and pre-release
// versions ranking below their corresponding stable release).
type semver struct {
	major, minor, patch int
	pre                 string // "" for a stable (non-pre-release) version.
}

// parseSemver parses v as a semver string, reporting ok=false if it does
// not match semverPattern (e.g. a "dev:<label>" orb version).
func parseSemver(v string) (semver, bool) {
	m := semverPattern.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return semver{}, false
	}

	major, err1 := strconv.Atoi(m[1])
	minor, err2 := strconv.Atoi(m[2])
	patch, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		// Unreachable given semverPattern only captures digit runs, but
		// checked explicitly rather than ignored.
		return semver{}, false
	}

	return semver{major: major, minor: minor, patch: patch, pre: m[4]}, true
}

// compare returns a negative number if a is older than b, zero if they are
// equal, and a positive number if a is newer than b. A pre-release version
// is always older than the stable version with the same major.minor.patch
// (matching the SemVer 2.0.0 spec); beyond that, pre-release identifiers are
// compared as plain strings, which is not a full SemVer 2.0.0 pre-release
// comparison but is more than sufficient to order CircleCI orb versions.
func (a semver) compare(b semver) int {
	if a.major != b.major {
		return a.major - b.major
	}
	if a.minor != b.minor {
		return a.minor - b.minor
	}
	if a.patch != b.patch {
		return a.patch - b.patch
	}
	switch {
	case a.pre == "" && b.pre == "":
		return 0
	case a.pre == "":
		return 1
	case b.pre == "":
		return -1
	default:
		return strings.Compare(a.pre, b.pre)
	}
}

// CompareVersions orders two orb version strings, returning a negative
// number if a is older than b, zero if it cannot tell them apart, and a
// positive number if a is newer than b.
//
// When both parse as semver (see parseSemver), they are compared
// numerically (so "1.10.0" correctly orders after "1.9.0", unlike a plain
// string comparison) with a pre-release version ranked below the
// corresponding stable release. A version that parses as semver is always
// considered newer than one that does not (this is how CircleCI's
// non-semver "dev:<label>" orb versions end up ranked below every real
// release). When neither parses, CompareVersions returns 0: callers that
// need a total order in that case (see OrbPackage.LatestVersion) fall back
// to another signal, such as CreatedAt.
func CompareVersions(a, b string) int {
	pa, oka := parseSemver(a)
	pb, okb := parseSemver(b)

	switch {
	case oka && okb:
		return pa.compare(pb)
	case oka && !okb:
		return 1
	case !oka && okb:
		return -1
	default:
		return 0
	}
}

// ListOrbsOptions configures ListOrbPackages and ListAllOrbPackages.
type ListOrbsOptions struct {
	// Certified, when non-nil, filters to only certified (true) or only
	// uncertified (false) orbs.
	Certified *bool

	// NamespaceID, when non-empty, filters to orbs belonging to this
	// namespace UUID.
	NamespaceID string

	// Name, when non-empty, filters to the orb whose full name (exactly
	// "<namespace>/<name>") equals this value. This is an exact match:
	// the CircleCI v3 orb registry has no fuzzy or prefix search, and a
	// bare orb name without its namespace (e.g. "act" rather than
	// "cci-labs/act") matches nothing.
	Name string

	// Visibility, when non-empty, is sent as filter[visibility] ("public" or
	// "private").
	//
	// Caution: the registry currently accepts this filter but does not apply
	// it — visibility=private returns the same set as visibility=public. Do
	// not rely on it to partition the registry; read each package's Private
	// field instead. It is kept here so callers can still send the filter if
	// the API's behaviour changes.
	Visibility string

	// Limit caps the number of packages returned on a single page. The API
	// advertises a maximum of 1000 (page[limit]=1001 answers 400 "Page limit
	// must be at most 1000"), but does not reliably serve that: see
	// IsResourceExhausted (this package) and pageSizeFloor
	// (internal/orbs/cache.go) for what was actually measured and how a
	// caller degrades when it changes. Zero leaves it unset, letting the API
	// apply its own default.
	Limit int

	// Cursor, when non-empty, resumes listing from the opaque page
	// cursor previously returned as nextCursor.
	Cursor string
}

// queryValues renders o as the URL query parameters the orb/packages
// endpoint expects, including the literal "[" "]" characters in filter/page
// parameter names (net/url takes care of percent-encoding them).
func (o ListOrbsOptions) queryValues() url.Values {
	v := url.Values{}
	if o.Certified != nil {
		v.Set("filter[certified]", strconv.FormatBool(*o.Certified))
	}
	if o.NamespaceID != "" {
		v.Set("filter[namespace_id]", o.NamespaceID)
	}
	if o.Name != "" {
		v.Set("filter[name]", o.Name)
	}
	if o.Visibility != "" {
		v.Set("filter[visibility]", o.Visibility)
	}
	if o.Limit > 0 {
		v.Set("page[limit]", strconv.Itoa(o.Limit))
	}
	if o.Cursor != "" {
		v.Set("page[cursor]", o.Cursor)
	}
	return v
}

// orbPackagesResponse is the JSON response body from GET /api/v3/orb/packages.
type orbPackagesResponse struct {
	Data []orbPackageWire `json:"data"`
	Page struct {
		Next string `json:"next"`
	} `json:"page"`
}

// orbPackageWire is the JSON shape of a single entry in orbPackagesResponse.Data.
type orbPackageWire struct {
	ID         string `json:"id"`
	Attributes struct {
		Name      string `json:"name"`
		IsPrivate bool   `json:"is_private"`
		IsListed  bool   `json:"is_listed"`
	} `json:"attributes"`
	References struct {
		Namespace struct {
			ID string `json:"id"`
		} `json:"namespace"`
		OrbVersions []orbVersionWire `json:"orb_versions"`
	} `json:"references"`
}

// orbVersionWire is the JSON shape of a single entry in
// orbPackageWire.References.OrbVersions.
type orbVersionWire struct {
	ID         string `json:"id"`
	Attributes struct {
		Version   string    `json:"version"`
		CreatedAt time.Time `json:"created_at"`
	} `json:"attributes"`
}

// toOrbPackage converts the wire representation to the public OrbPackage
// type.
func (w orbPackageWire) toOrbPackage() OrbPackage {
	versions := make([]OrbVersion, 0, len(w.References.OrbVersions))
	for _, v := range w.References.OrbVersions {
		versions = append(versions, OrbVersion{
			ID:        v.ID,
			Version:   v.Attributes.Version,
			CreatedAt: v.Attributes.CreatedAt,
		})
	}

	return OrbPackage{
		ID:          w.ID,
		Name:        w.Attributes.Name,
		Private:     w.Attributes.IsPrivate,
		Listed:      w.Attributes.IsListed,
		NamespaceID: w.References.Namespace.ID,
		Versions:    versions,
	}
}

// ListOrbPackages calls GET /api/v3/orb/packages once, returning the page
// of packages matching opts and the opaque cursor to pass as opts.Cursor to
// fetch the next page (empty when this was the last page).
func (c *Client) ListOrbPackages(ctx context.Context, opts ListOrbsOptions) (packages []OrbPackage, nextCursor string, err error) {
	path := orbPackagesPath
	if q := opts.queryValues(); len(q) > 0 {
		path += "?" + q.Encode()
	}

	var wire orbPackagesResponse
	if doErr := c.do(ctx, http.MethodGet, path, nil, &wire); doErr != nil {
		return nil, "", doErr
	}

	packages = make([]OrbPackage, 0, len(wire.Data))
	for _, d := range wire.Data {
		packages = append(packages, d.toOrbPackage())
	}
	return packages, wire.Page.Next, nil
}

// ListAllOrbPackages repeatedly calls ListOrbPackages, following
// page.next, until the API reports no further page or ctx is cancelled. It
// gives up with an error after maxOrbPackagePages pages, as a safety net
// against an API bug turning this into an infinite loop.
//
// onPage, if non-nil, is invoked once per page with the number of packages
// that page contained, so callers can report crawl progress; it is never
// invoked concurrently.
func (c *Client) ListAllOrbPackages(ctx context.Context, opts ListOrbsOptions, onPage func(int)) ([]OrbPackage, error) {
	var all []OrbPackage
	cursor := opts.Cursor

	for page := 0; page < maxOrbPackagePages; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		pageOpts := opts
		pageOpts.Cursor = cursor

		pkgs, next, err := c.ListOrbPackages(ctx, pageOpts)
		if err != nil {
			return nil, err
		}
		all = append(all, pkgs...)
		if onPage != nil {
			onPage(len(pkgs))
		}

		if next == "" {
			return all, nil
		}
		cursor = next
	}

	return nil, fmt.Errorf("circleci: exceeded %d pages listing orb packages", maxOrbPackagePages)
}

// GetOrbPackageByName looks up a single orb by its exact "<namespace>/<name>",
// returning ErrOrbNotFound if the API reports no match.
func (c *Client) GetOrbPackageByName(ctx context.Context, name string) (*OrbPackage, error) {
	pkgs, _, err := c.ListOrbPackages(ctx, ListOrbsOptions{Name: name, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(pkgs) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrOrbNotFound, name)
	}
	return &pkgs[0], nil
}

// GetOrbSource calls GET /api/v3/orb/versions/{versionID}/source, returning
// the orb version's raw YAML source as text (this endpoint's response body
// is not JSON).
func (c *Client) GetOrbSource(ctx context.Context, versionID string) (string, error) {
	path := fmt.Sprintf(orbSourcePathFmt, url.PathEscape(versionID))

	body, err := c.doRaw(ctx, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	return string(body), nil
}
