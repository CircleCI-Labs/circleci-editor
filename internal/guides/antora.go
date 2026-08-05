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
	"fmt"
	"strings"
)

// The circleci-docs site is built with Antora, which addresses content by
// *resource ID* rather than by file path: `[version@]component:module:family$relpath`.
// This file is the whole of this package's Antora knowledge -- enough to (a)
// turn an `include::` target into the repository path to fetch, and (b) turn
// an `xref:` target into the canonical published URL. It is deliberately
// small and rule-based rather than a playbook parser: the rules below were
// each verified against live URLs (see docsLinks.ts, whose own table is the
// independent check that the URL shape produced here is right).

// docsBaseURL is the published site's docs root. Every URL this package
// produces starts here, and `web/src/lib/docs/docsLinks.ts` holds the
// hand-verified table these are checked against.
const docsBaseURL = "https://circleci.com/docs"

// familyDirs maps an Antora family (the part before `$` in a resource ID) to
// the directory name it lives under inside a module.
var familyDirs = map[string]string{
	"page":       "pages",
	"partial":    "partials",
	"example":    "examples",
	"image":      "images",
	"attachment": "attachments",
}

// resourceID is a parsed Antora resource ID.
type resourceID struct {
	component string
	module    string
	family    string
	relpath   string
}

// parseResourceID parses an Antora resource ID, filling in the component and
// module from ctx when the ID leaves them implicit (which is the common case
// inside a single component).
//
// Forms seen in the snapshot, all handled:
//
//	partial$notes/x.adoc                       family only
//	ROOT:partial$faq/x.adoc                     module + family
//	guides:ROOT:partial$execution-resources/x.adoc  component + module + family
//	reusing-config.adoc#the-executors-key       page, family implied
//	guides:orchestrate:dynamic-config.adoc#     component + module, family implied
func parseResourceID(id string, ctx spanContext) (resourceID, error) {
	out := resourceID{component: ctx.component, module: ctx.module, family: "page"}

	// A version prefix (`1.2@component:...`) never appears in this snapshot,
	// but stripping it is one line and stops a future one being misread as a
	// component name.
	if at := strings.IndexByte(id, '@'); at >= 0 && !strings.ContainsAny(id[:at], "/$#") {
		id = id[at+1:]
	}

	body := id
	if dollar := strings.IndexByte(body, '$'); dollar >= 0 {
		coords := body[:dollar]
		out.relpath = body[dollar+1:]
		parts := strings.Split(coords, ":")
		out.family = parts[len(parts)-1]
		switch len(parts) {
		case 1: // family$ only
		case 2: // module:family$
			out.module = parts[0]
		case 3: // component:module:family$
			out.component, out.module = parts[0], parts[1]
		default:
			return resourceID{}, fmt.Errorf("guides: resource ID %q has %d coordinate segments", id, len(parts))
		}
	} else {
		parts := strings.Split(body, ":")
		out.relpath = parts[len(parts)-1]
		switch len(parts) {
		case 1: // relpath only
		case 2: // module:relpath
			out.module = parts[0]
		case 3: // component:module:relpath
			out.component, out.module = parts[0], parts[1]
		default:
			return resourceID{}, fmt.Errorf("guides: resource ID %q has %d coordinate segments", id, len(parts))
		}
	}

	if out.relpath == "" {
		return resourceID{}, fmt.Errorf("guides: resource ID %q has no path", id)
	}
	if out.component == "" || out.module == "" {
		return resourceID{}, fmt.Errorf("guides: resource ID %q has no resolvable component/module", id)
	}
	if _, known := familyDirs[out.family]; !known {
		return resourceID{}, fmt.Errorf("guides: resource ID %q has unknown family %q", id, out.family)
	}
	return out, nil
}

// repoPath returns the path this resource occupies inside the circleci-docs
// repository, which is the path the snapshot stores it under and the path the
// refresher fetches. Verified against the live repository tree for every
// include target in the snapshot (see TestSnapshotIncludeClosure).
func (r resourceID) repoPath() string {
	return fmt.Sprintf("docs/%s/modules/%s/%s/%s", r.component, r.module, familyDirs[r.family], r.relpath)
}

// pageURL returns the canonical published URL of a `page`-family resource:
// `https://circleci.com/docs/<component>[/<module>]/<basename>/`, with the
// `ROOT` module omitted from the path (Antora's own convention).
//
// Spot-checked against every page these three guides xref, and against the
// independently hand-verified table in web/src/lib/docs/docsLinks.ts:
//
//	reference / ROOT       / reusing-config.adoc  -> /docs/reference/reusing-config/
//	guides    / orchestrate/ dynamic-config.adoc  -> /docs/guides/orchestrate/dynamic-config/
//	orbs      / author     / creating-orbs.adoc   -> /docs/orbs/author/creating-orbs/
func (r resourceID) pageURL() string {
	base := strings.TrimSuffix(r.relpath, ".adoc")
	if r.module == "ROOT" {
		return fmt.Sprintf("%s/%s/%s/", docsBaseURL, r.component, base)
	}
	return fmt.Sprintf("%s/%s/%s/%s/", docsBaseURL, r.component, r.module, base)
}

// resolveXref resolves an `xref:` target relative to ctx.
//
// samePage is true when the target is the very page being parsed, in which
// case the caller should emit an in-pane SpanRef rather than an outbound link
// -- the config reference cross-references itself constantly, and following
// those out to the browser would defeat the point of having the guide in the
// app. anchor is the target's `#fragment`, empty when it had none.
func resolveXref(target string, ctx spanContext) (url, anchor string, samePage bool) {
	path, frag, _ := strings.Cut(target, "#")
	frag = strings.TrimSpace(frag)

	id, err := parseResourceID(path, ctx)
	if err != nil {
		return "", frag, false
	}
	if id.family != "page" {
		// A non-page xref is not a thing Antora publishes a URL for.
		return "", frag, false
	}

	if ctx.pageName != "" && id.component == ctx.component && id.module == ctx.module &&
		strings.TrimSuffix(id.relpath, ".adoc") == ctx.pageName {
		return "", frag, frag != ""
	}

	url = id.pageURL()
	if frag != "" {
		url += "#" + frag
	}
	return url, frag, false
}
