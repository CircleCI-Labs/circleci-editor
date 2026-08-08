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
	"net/url"
	"path"
	"strings"
)

// This file turns the raw URL strings an AI provider's docs tool call produced
// into citations worth showing a human (issue #156). It lives in this package
// because the answer comes entirely from the vendored AsciiDoc this package
// already parses: a page's own title, a section's own title, and the `image::`
// macros that say which page shows which image.
//
// # Why resolve locally instead of fetching the URLs
//
// The obvious way to get a human title for a link is to fetch it and read its
// <title>. This deliberately does not, and the choice is a security one, not a
// performance one:
//
//   - The URLs come from model output, extracted from a third-party MCP
//     server's tool results (see internal/ai/anthropic.extractSources). Making
//     the host issue requests to destinations chosen by that pipeline is an
//     SSRF-shaped surface -- the host runs on the user's machine, inside their
//     network, and "fetch whatever URL the model produced" is exactly the
//     capability an injected docs page would want.
//   - It leaks. A fetch tells a third party, in near real time, which docs page
//     the user's question was about. This tool sends the user's config to a
//     provider only because that is what asking a question requires; adding a
//     second, silent channel of "what were they asking about" is not something
//     a user asked for.
//   - The local answer is better anyway. The snapshot has the real page *and
//     section* titles -- a fetch of a `#fragment` URL would return the page
//     title only, since the fragment never reaches the server.
//
// So: titles for the three vendored guides (and every section within them)
// resolve offline and exactly; anything else keeps its URL and lets the
// frontend derive a readable label from the path (see web/src/lib/ai/sources.ts).
// Nothing here ever opens a socket.

// Citation is one source link fit to show a human: a URL that is worth
// clicking, plus a title when one could be resolved offline. An empty Title
// means "no local answer" -- the frontend then derives a label from the URL
// rather than this package guessing one.
type Citation struct {
	URL   string
	Title string
}

// assetExtensions are the file extensions that are never a citation worth
// showing: a bare image, stylesheet, script or font is not a page a reader can
// learn anything from. The owner's report is the canonical example -- a reply
// grounded in the workspaces documentation cited
// `circleci-docs/guides/_images/workspace.png`, which is noise; the page that
// *shows* that diagram is the useful citation (issue #156).
var assetExtensions = map[string]bool{
	// Images -- mappable to their containing page, see imageExtensions.
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true,
	".webp": true, ".avif": true, ".bmp": true, ".ico": true, ".tif": true,
	".tiff": true,
	// Everything else here is unmappable by construction and simply dropped.
	".css": true, ".js": true, ".mjs": true, ".cjs": true, ".map": true,
	".woff": true, ".woff2": true, ".ttf": true, ".eot": true,
}

// imageExtensions is the subset of assetExtensions that Guide.Images can map
// back to a page.
var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true,
	".webp": true, ".avif": true, ".bmp": true, ".ico": true, ".tif": true,
	".tiff": true,
}

// CitationResolver resolves citation URLs against the parsed guides. Build one
// with NewCitationResolver; it is read-only and safe to share.
type CitationResolver struct {
	// titles maps a normalized docs URL (see citationKey) to the title of the
	// page or section it addresses.
	titles map[string]string
	// imagePages maps an image's lowercased basename to the URL of the guide
	// page that shows it.
	imagePages map[string]string
}

// NewCitationResolver indexes gs for citation resolution: every guide's page
// title, every section's title (a section URL carries a `#fragment` only when
// the anchor came from the source's own `[#id]`, so a resolved fragment title
// is never a guess -- see Section.AnchorDerived), and every image each page
// shows.
//
// A nil or empty gs yields a resolver that still drops asset citations and
// still deduplicates, just with no titles to add -- which is what the host
// wants when its own snapshot failed to parse: fewer bad citations, not none.
func NewCitationResolver(gs []Guide) *CitationResolver {
	r := &CitationResolver{
		titles:     map[string]string{},
		imagePages: map[string]string{},
	}
	for _, guide := range gs {
		if key := citationKey(guide.URL); key != "" && guide.Title != "" {
			r.titles[key] = guide.Title
		}
		for _, section := range guide.Sections {
			if key := citationKey(section.URL); key != "" && section.Title != "" {
				// Document order wins a collision, matching
				// web/src/lib/guides/guides.ts's findSectionForKey: the
				// configuration reference documents `version` and `jobs` twice,
				// and the top-level one comes first.
				if _, taken := r.titles[key]; !taken {
					r.titles[key] = section.Title
				}
			}
		}
		for _, image := range guide.Images {
			if _, taken := r.imagePages[image]; !taken {
				r.imagePages[image] = guide.URL
			}
		}
	}
	return r
}

// AddImageIndex extends r with the wider basename -> URL mapping
// cmd/refresh-image-index builds by walking every page in circleci-docs, not
// just the twenty gs vendors as prose (issue #19's remaining piece: "Image
// indexing beyond the vendored guides"). idx typically comes from
// LoadImageIndex.
//
// Applied *after* NewCitationResolver's own indexing and using the exact same
// "first claim wins" rule as the imagePages loop above: a basename the
// vendored guides already map keeps that mapping. That is not merely
// consistent with the existing convention, it is necessary -- the vendored
// mapping points at a page this resolver can also title (via r.titles), and
// idx carries no titles at all, so letting idx displace it would trade a
// titled citation for an untitled one covering the identical basename.
//
// A collision the wider index had to resolve on its own (two upstream pages
// both showing one basename, neither of them vendored) was already decided
// when idx was built -- see imageIndexSeeds's doc comment -- so there is
// nothing left to decide here; this only ever adds a mapping the vendored
// guides did not already have one for.
func (r *CitationResolver) AddImageIndex(idx ImageIndex) {
	for basename, page := range idx.Images {
		if _, taken := r.imagePages[basename]; !taken {
			r.imagePages[basename] = page
		}
	}
}

// Normalize turns the raw citation URLs a provider returned into the citations
// to show, in the order they arrived. It:
//
//   - maps a cited image to the guide page that shows it, when the vendored
//     AsciiDoc knows one;
//   - drops any other asset citation (an unmappable image, a stylesheet, a
//     script), because a bare asset is never a source a reader can use;
//   - drops anything that is not an absolute http(s) URL, since it is not
//     something the UI could safely link to anyway;
//   - collapses duplicates -- including a duplicate *created* by mapping an
//     image onto a page that was already cited, which is the case the owner's
//     report runs into;
//   - attaches a title resolved from the snapshot, when there is one.
//
// It never adds a citation the provider did not give, and never reorders.
func (r *CitationResolver) Normalize(urls []string) []Citation {
	out := make([]Citation, 0, len(urls))
	seen := map[string]bool{}

	for _, raw := range urls {
		resolved, ok := r.resolveOne(raw)
		if !ok {
			continue
		}
		key := citationKey(resolved)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, Citation{URL: resolved, Title: r.title(key)})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// title looks a citation key up, falling back from a section to the page that
// contains it. The fallback matters because the snapshot only has an anchor for
// a section whose heading carries an explicit `[#id]`: a citation of any other
// fragment is still a citation of a page we can name, and "Configuration
// reference" beats no title at all.
func (r *CitationResolver) title(key string) string {
	if title, ok := r.titles[key]; ok {
		return title
	}
	if hash := strings.IndexByte(key, '#'); hash >= 0 {
		return r.titles[key[:hash]]
	}
	return ""
}

// resolveOne applies the per-URL policy: keep a real page, remap a known
// image, drop everything else.
func (r *CitationResolver) resolveOne(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}

	ext := strings.ToLower(path.Ext(parsed.Path))
	if assetExtensions[ext] {
		// An asset. Its filename is the only part of it worth anything, and
		// only if the snapshot says which page shows it. This is checked
		// *before* the scheme, so a bare `circleci-docs/guides/_images/
		// workspace.png` path -- not a URL at all -- still gets its one chance
		// to be mapped to the page that shows it.
		if !imageExtensions[ext] {
			return "", false
		}
		page, mapped := r.imagePages[strings.ToLower(path.Base(parsed.Path))]
		if !mapped {
			return "", false
		}
		return page, true
	}

	// Not an asset: keep it, provided it is something the UI can link to.
	// Anything relative, scheme-less or non-http(s) is dropped here rather
	// than handed to the frontend to reject a second time.
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	if parsed.Host == "" {
		return "", false
	}
	return trimmed, true
}

// citationKey is the identity of a cited page for title lookup and
// deduplication: host + path + fragment, lowercased on host, with the query
// string dropped and a trailing slash on the path ignored.
//
// The query goes because the only thing that ever adds one to a docs URL is
// tracking (`?utm_source=`), and two citations of one page must collapse. The
// fragment stays, for the same reason web/src/lib/docs/docsLinks.ts's
// lookupDocLink keeps it: `configuration-reference/#docker` and
// `configuration-reference/#macos` are different sections of one page, and
// ignoring the fragment would make an arbitrary one of them "the" title for
// the whole page.
func citationKey(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Host)
	if host == "" {
		return ""
	}
	p := strings.TrimSuffix(parsed.Path, "/")
	key := host + p
	if parsed.Fragment != "" {
		key += "#" + parsed.Fragment
	}
	return key
}
