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

package host

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// defaultHost is used for Environment.Host when CIRCLE_HOST is unset or
// empty.
const defaultHost = "https://circleci.com"

// Environment captures the variables the CircleCI CLI injects into plugin
// processes. The Token field must never be exposed outside this process
// (e.g. over the HTTP API) — use HasToken instead.
type Environment struct {
	// Token is the CircleCI API token, from CIRCLE_TOKEN. Never serialize
	// this value; expose HasToken() instead.
	Token string

	// Host is the CircleCI API host, from CIRCLE_HOST, defaulting to
	// https://circleci.com when unset.
	Host string

	// ProjectID is the CircleCI project ID, from CIRCLE_PROJECT_ID.
	ProjectID string

	// VCSType is the VCS provider slug (e.g. "github", "bitbucket",
	// "circleci"), from CIRCLE_VCS_TYPE, exactly as injected. The CLI injects
	// the long spelling; every slug built from it is normalised to CircleCI's
	// canonical short one -- see CanonicalVCSSegment.
	VCSType string

	// Org is the VCS organization or user name, from
	// CIRCLE_PROJECT_USERNAME.
	Org string

	// Repo is the VCS repository name, from CIRCLE_PROJECT_REPONAME.
	Repo string

	// Branch is the current VCS branch, from CIRCLE_BRANCH.
	Branch string

	// DefaultBranch is the repository's default branch, from
	// CIRCLE_DEFAULT_BRANCH.
	DefaultBranch string
}

// LoadEnvironment reads the CircleCI CLI plugin environment variables from
// the process environment.
func LoadEnvironment() Environment {
	host := os.Getenv("CIRCLE_HOST")
	if host == "" {
		host = defaultHost
	}

	return Environment{
		Token:         token(),
		Host:          host,
		ProjectID:     os.Getenv("CIRCLE_PROJECT_ID"),
		VCSType:       os.Getenv("CIRCLE_VCS_TYPE"),
		Org:           os.Getenv("CIRCLE_PROJECT_USERNAME"),
		Repo:          os.Getenv("CIRCLE_PROJECT_REPONAME"),
		Branch:        os.Getenv("CIRCLE_BRANCH"),
		DefaultBranch: os.Getenv("CIRCLE_DEFAULT_BRANCH"),
	}
}

// token resolves the CircleCI API token, preferring CIRCLE_TOKEN and falling
// back to CIRCLECI_TOKEN.
//
// What the CLI actually injects is CIRCLE_TOKEN. From the CLI's own
// extension launcher (internal/extension/manifest.go, buildEnv):
//
//	overlays := []kv{
//	    {"CIRCLE_TOKEN", cfg.EffectiveToken()},
//	    {"CIRCLE_HOST", cfg.EffectiveHost()},
//	    ...
//	}
//
// and EffectiveToken() resolves CIRCLE_TOKEN, then CIRCLE_CLI_TOKEN, then the
// token loaded from the OS keyring -- which is where `circleci auth login`
// puts it. So a browser sign-in reaches this host as CIRCLE_TOKEN, and the
// primary lookup above, not the fallback, is what makes running as a plugin
// work.
//
// An earlier version of this comment claimed the CLI passes CIRCLECI_TOKEN
// (note the second "CI"), citing a 2026-08-08 run of a throwaway plugin with
// CIRCLE_TOKEN unset. That reading was wrong: buildEnv starts from
// os.Environ(), so a CIRCLECI_TOKEN already exported in the surrounding shell
// is passed through to the plugin and is indistinguishable from one the CLI
// added. Re-checked 2026-08-11 with *both* variables unset in the CLI's
// environment -- the plugin received neither, and the CLI could not
// authenticate itself either, since it reads the keyring rather than the
// legacy ~/.circleci/cli.yml. The other variables that run did see
// (CIRCLE_HOST, CIRCLE_VCS_TYPE, CIRCLE_PROJECT_USERNAME,
// CIRCLE_PROJECT_REPONAME, CIRCLE_BRANCH, CIRCLE_DEFAULT_BRANCH,
// CIRCLE_PROJECT_ID) are injected as documented.
//
// The fallback stays regardless. It costs one env lookup, it is the spelling
// some CI images and wrappers use, and reading a token a user did set under a
// plausible name is better than reporting "no token" next to one.
//
// CIRCLE_TOKEN wins when both are set: it is the variable a user exports
// deliberately, and an explicit choice should outrank an inherited one.
func token() string {
	if v := os.Getenv("CIRCLE_TOKEN"); v != "" {
		return v
	}
	return os.Getenv("CIRCLECI_TOKEN")
}

// HasToken reports whether a CircleCI API token is available, without
// exposing the token value itself.
func (e Environment) HasToken() bool {
	return e.Token != ""
}

// IsSelfHosted reports whether Host points at something other than CircleCI's
// cloud — i.e. a CircleCI Server installation, per CIRCLE_HOST.
//
// It exists because the same observation means different things on the two, and
// a UI that cannot tell them apart has to hedge. The case that prompted it
// (issue #257, from the Server research in #256) is an empty orb registry: on
// cloud that is a surprise worth investigating, while on Server it is the
// ordinary starting state, because a Server installation's registry is private
// to that installation and seeded one orb at a time by an admin.
//
// An unparseable or empty Host counts as cloud, matching how every other reader
// of this field treats it (see WebAppBaseURL, which falls back to defaultHost):
// the fallback is the cloud default, so claiming "self-hosted" for a value we
// could not read would be asserting more than we know.
func (e Environment) IsSelfHosted() bool {
	host := strings.TrimRight(strings.TrimSpace(e.Host), "/")
	if host == "" {
		return false
	}
	u, err := url.Parse(host)
	if err != nil || u.Host == "" {
		return false
	}
	switch strings.ToLower(u.Host) {
	case "circleci.com", "www.circleci.com", "app.circleci.com":
		return false
	default:
		return true
	}
}

// CanonicalVCSSegment returns the canonical short spelling of a VCS type --
// "gh", "bb" or "gl" -- for use as the first segment of a project or
// organization slug.
//
// This is the CircleCI CLI's own rule, copied deliberately rather than
// invented here (issue #182). `internal/gitremote.buildSlug` in
// CircleCI-Public/circleci-cli derives the slug from the git remote's host and
// emits exactly these three short forms:
//
//	case strings.Contains(host, "github"):    vcs = "gh"
//	case strings.Contains(host, "bitbucket"): vcs = "bb"
//	case strings.Contains(host, "gitlab"):    vcs = "gl"
//
// Substring matching, not equality, for two reasons the CLI shares: a
// self-hosted remote host is spelled "github.example.com", and the value we
// normalise may equally be a project record's `vcs_provider`, which CircleCI
// capitalises ("GitHub"). So the input is lower-cased first and matched by
// substring.
//
// Anything unrecognised is returned lower-cased but otherwise unchanged, which
// is what makes "circleci" -- the VCS type of GitLab and GitHub App projects,
// whose slugs carry opaque IDs rather than names -- pass through intact instead
// of being mangled into a spelling no API knows.
func CanonicalVCSSegment(vcsType string) string {
	v := strings.ToLower(strings.TrimSpace(vcsType))
	switch {
	case v == "":
		return ""
	case strings.Contains(v, "github"):
		return "gh"
	case strings.Contains(v, "bitbucket"):
		return "bb"
	case strings.Contains(v, "gitlab"):
		return "gl"
	default:
		return v
	}
}

// ProjectSlug returns the "<vcs>/<org>/<repo>" project slug when VCSType, Org,
// and Repo are all present, and the empty string otherwise.
//
// The VCS segment is normalised to CircleCI's canonical short spelling (see
// CanonicalVCSSegment), so a CLI-injected CIRCLE_VCS_TYPE of "github" produces
// `gh/acme/web`. Issue #182: the long form was being passed through verbatim,
// and while both spellings are accepted by the v2 API (verified against it),
// CircleCI's own response reports the canonical `"slug": "gh/..."` even when
// asked with `github/...`. Emitting the same spelling CircleCI and the CLI use
// means what this editor displays, logs and links matches what the platform
// calls the project.
//
// This is still only the *claimed* slug, assembled from injected environment
// variables. When a project record has been fetched, its own Slug field is
// ground truth and supersedes this -- see fetchProjectContext.
func (e Environment) ProjectSlug() string {
	vcs := CanonicalVCSSegment(e.VCSType)
	if vcs == "" || e.Org == "" || e.Repo == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s", vcs, e.Org, e.Repo)
}

// OrgSlug returns the "<vcs>/<org>" owner slug used to scope
// organization-level lookups -- contexts belong to an organization, not to a
// project -- and the empty string when either half is missing.
//
// Normalised the same way, and for the same reason, as ProjectSlug: the CLI
// injects the long VCS spelling ("github") while CircleCI's own documentation,
// its API responses and the CLI's own slugs use the short one ("gh"). Both are
// accepted by the v2 context API (verified against it), so this is a
// consistency fix rather than a bug fix -- but a fallback path that emits a
// different spelling from the primary one is a difference nobody should have to
// reason about.
func (e Environment) OrgSlug() string {
	vcs := CanonicalVCSSegment(e.VCSType)
	if vcs == "" || e.Org == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s", vcs, e.Org)
}

// nameAddressedVCSSegments are the canonical VCS segments whose CircleCI web UI
// pages are addressed by organization and repository *name*, and which this
// host is therefore willing to build a URL for.
//
// Only the canonical short spellings appear, because every slug this package
// builds or accepts passes through CanonicalVCSSegment first -- "github" and
// "GitHub" both arrive here as "gh".
//
// Deliberately absent: "gl". A GitLab OAuth project is name-addressed like
// "gh"/"bb" as far as this host knows, but that specific route was never
// checked against a live one, and issue #20 did not change that -- its
// verification (see overviewRouteVCS) covered only "circleci"-addressed
// organizations and projects, not GitLab's.
//
// "circleci" -- the VCS type of GitLab and GitHub App *standalone* projects,
// whose slugs are `circleci/<org-id>/<project-id>` with opaque IDs rather than
// names -- is also absent from this map, and stays absent even after issue
// #20 verified two of the four routes this package builds for it. That
// verification lives in overviewRouteVCS instead of here on purpose: folding
// "circleci" into this shared map would silently have extended it to
// ProjectSettingsWebURLForSlug and PipelineWebURL too, and neither of those
// routes' shape was checked against a live standalone project. See
// overviewRouteVCS for what was checked and what still is not.
var nameAddressedVCSSegments = map[string]bool{
	"gh": true,
	"bb": true,
}

// overviewRouteVCS reports whether vcs's project-overview page
// (ProjectWebURLForSlug) and organization-pipelines page (OrgWebURLForSlug)
// can be addressed by this host -- the two routes issue #20 verified live.
//
// ## The evidence (verified live against app.circleci.com, 2026-08-07, unauthenticated)
//
//	/pipelines/github/CircleCI-Labs                     -> 200  organization
//	/pipelines/github                                   -> 404  (route is depth-sensitive)
//	/pipelines/github/CircleCI-Labs/extra/segments/here -> 404
//	/projects/github/CircleCI-Labs/circleci-editor      -> 200  project overview
//	/projects/github/CircleCI-Labs                      -> 404  (depth-sensitive)
//	/projects/github/CircleCI-Labs/circleci-editor/x    -> 404
//	/projects/circleci/LmhyFJ56pbaEFz4NsPonHD/aproject  -> 200  STANDALONE project, same 3-segment shape
//	/projects/circleci/LmhyFJ56pbaEFz4NsPonHD           -> 404
//	/pipelines/circleci/LmhyFJ56pbaEFz4NsPonHD          -> 200  standalone organization
//	/not-a-route/github/CircleCI-Labs                   -> 404  control
//
// ## What this does and does not establish
//
// app.circleci.com is a SPA, and it answers 200 for *any* path shaped like a
// route it recognises without validating the VCS segment at all --
// `/pipelines/notavcs/CircleCI-Labs` also answers 200 -- so this table proves
// **route shape, not existence**: that the routes are real, that they are
// depth-sensitive (too few or too many segments 404s), and that a standalone
// organization/project's opaque-ID slug fits the identical shape gh/bb already
// use. It does not, and cannot, prove that any particular organization or
// project exists or that its page renders real content -- the same limitation
// every other verification of these SPA routes in this package already lives
// with, and the reason this host never uses either route as an existence
// probe (fetchProjectContext asks the v2 API for that instead).
//
// ## Why only these two routes, and not the whole of nameAddressedVCSSegments
//
// `/settings/project/circleci/<org-id>/<project-id>`
// (ProjectSettingsWebURLForSlug) and
// `/pipelines/circleci/<org-id>/<project-id>/<number>` (PipelineWebURL) were
// not probed here, and adding "circleci" to nameAddressedVCSSegments itself
// would have unlocked both of them as an accidental side effect of fixing
// two unrelated ones. Each caller willing to build a `circleci/...` URL says
// so explicitly, at the point it does -- ContextWebURL already made this
// exact choice, for its own (organization-settings) route, before this issue
// existed.
func overviewRouteVCS(vcs string) bool {
	return nameAddressedVCSSegments[vcs] || vcs == "circleci"
}

// WebAppBaseURL returns the base URL of the CircleCI web UI corresponding to
// this environment's API host.
//
// circleci.com serves the API while app.circleci.com serves the UI, so the
// public case needs that one substitution. A CircleCI Server installation
// serves both from the same hostname, so any other host is returned as-is --
// which is also the honest default for a host this code has never seen.
func (e Environment) WebAppBaseURL() string {
	host := strings.TrimRight(e.Host, "/")
	if host == "" {
		host = defaultHost
	}

	u, err := url.Parse(host)
	if err != nil || u.Host == "" {
		return ""
	}
	switch u.Host {
	case "circleci.com", "www.circleci.com":
		u.Host = "app.circleci.com"
	}
	u.Path = ""
	return strings.TrimRight(u.String(), "/")
}

// ProjectWebURL returns the CircleCI web UI URL for the *overview* of the
// project this environment claims to belong to -- the deep link behind issue
// #149, and the same "hand observation to the web UI" move this host already
// makes elsewhere.
//
// Built from the CLI-injected environment, so it needs no token and costs no
// request. Once a project record has been fetched, prefer
// ProjectWebURLForSlug with CircleCI's own canonical slug: the record is the
// authority on how the project is addressed, and issue #182 is precisely about
// preferring it. A caller that has a record must not fall back to this value if
// the record produced none -- see projectPayload.WebURL.
//
// ## Nothing in the product calls this any more (issue #198)
//
// Stated plainly so the next reader does not assume it is live: **the only caller
// is a test.** Since issue #198, GET /api/meta builds its URL with
// ProjectWebURLForSlug from the resolved ProjectIdentity, so a checkout whose
// `.circleci/info.yml` names a different project than its git remote gets a link
// to the *binding's* project rather than to the stale remote's name. Adding a call
// to this method back into a handler would reintroduce that defect.
//
// It is kept, rather than deleted, only because the environment-to-URL rules
// documented above deserve a name and the table of cases in
// TestEnvironment_ProjectWebURL is worth keeping runnable. A caller that has a
// resolved identity must pass its slug to ProjectWebURLForSlug instead.
//
// Empty when the project slug is incomplete or its VCS type is one this host
// still cannot build a project-overview URL for (see overviewRouteVCS): a
// caller must render the project's identity as plain text in that case rather
// than as a link that cannot work.
func (e Environment) ProjectWebURL() string {
	return e.ProjectWebURLForSlug(e.ProjectSlug())
}

// ProjectWebURLForSlug returns the CircleCI web UI *project overview* URL for
// an explicit "<vcs>/<org>/<repo>" project slug -- normally CircleCI's own
// canonical one, straight off the project record.
//
// ## Why the overview, and not the pipelines page (issue #214)
//
// The owner asked for the destination the top bar's project link opens to be
// reconsidered: *"I think there's actually an overview page that might be
// actually pretty good... because then from the overview page you can browse
// anywhere you want."* CircleCI's own web UI has exactly that route, and its
// shape is pinned by CircleCI's own test —
// CircleCI's own web UI exports
// getProjectOverviewPath, whose test asserts
// getProjectOverviewPath('github', 'circleci', 'web-ui') ==
// '/projects/github/circleci/web-ui'. So the URL is
// `<app>/projects/<vcs>/<org>/<repo>`, and it is a hub: the rendered page links
// onward to Usage, Insights and Settings for the project.
//
// ## How the path form was verified (issues #182, #214)
//
// Both forms were checked in a real Chromium against a public project
// (`CircleCI-Public/circleci-cli`), unauthenticated. A bare HTTP fetch could
// not establish anything here: app.circleci.com answers 200 for *any* path
// under a known route (it is a SPA — the limitation recorded in issue #173 and
// restated in #196), so only rendered content is evidence.
//
//	/projects/gh/CircleCI-Public/circleci-cli      -> real page, <title>
//	                                                 "circleci-cli - CircleCI-Public",
//	                                                 links to Usage/Insights/Settings
//	/projects/github/CircleCI-Public/circleci-cli  -> identical page
//	/pipelines/gh/CircleCI-Public/circleci-cli     -> real page, real branch list
//
// The long and short VCS spellings are equivalent here as they are on
// /pipelines/ and in the API, so nothing depends on which one arrives; this
// host emits the canonical short one because that is what CircleCI reports.
//
// One honest difference from /pipelines/, worth recording because #182 relied
// on it: the overview route does *not* render "Page Not Found" for a
// fabricated repository — `/projects/gh/CircleCI-Public/<nonexistent>` renders
// a page titled after the nonexistent name. So this URL form cannot be used as
// an existence probe the way /pipelines/ could. That costs nothing here (this
// host never probes; "does CircleCI know this project" is answered by the v2
// API in fetchProjectContext), but it does mean a future verification of this
// route has to compare against a *live* project's rendered content rather than
// looking for a 404.
//
// `/settings/project/<vcs>/<org>/<repo>` -- the URL form the owner quoted in
// #196 -- is also a real route (confirmed again in issue #182's route
// verification), and this method never builds it: observation, not
// administration, stays on the other side of this boundary, and the overview
// page reaches settings in one click for anyone who wants it. Issue #248
// asked for the settings link directly rather than relying on that one
// click, though -- see ProjectSettingsWebURLForSlug, which builds exactly
// this route. Handing over a link is still observation; only writing through
// it would cross that boundary, and this host has no write path to project
// settings at all.
//
// ## Standalone (GitLab / GitHub App) projects, since issue #20
//
// A standalone project's canonical slug is `circleci/<org-id>/<project-id>` --
// opaque IDs, not names -- and until issue #20 that VCS segment was refused
// outright (see nameAddressedVCSSegments' own history). The refusal was never
// about this route's *shape*: a standalone project fits the identical
// three-segment `/projects/<vcs>/<org>/<repo>` pattern gh/bb already use, with
// the IDs simply standing in for names CircleCI does not have. It was that no
// one had checked a live standalone project against it. Issue #20 did --
// `/projects/circleci/<org-id>/<project-id>` answers 200 for a real one, the
// same route depth-sensitivity as every other case here -- so the guard below
// now accepts it. See overviewRouteVCS for the full evidence and for why that
// acceptance lives in its own predicate rather than in nameAddressedVCSSegments.
func (e Environment) ProjectWebURLForSlug(slug string) string {
	base := e.WebAppBaseURL()
	if base == "" || slug == "" {
		return ""
	}

	segments := strings.Split(slug, "/")
	if len(segments) != 3 {
		return ""
	}
	vcs := CanonicalVCSSegment(segments[0])
	if !overviewRouteVCS(vcs) || segments[1] == "" || segments[2] == "" {
		return ""
	}

	return fmt.Sprintf("%s/projects/%s/%s/%s",
		base,
		vcs,
		url.PathEscape(segments[1]),
		url.PathEscape(segments[2]),
	)
}

// OrgWebURLForSlug returns the CircleCI web UI URL for the *pipelines* page of
// an organization named by an explicit "<vcs>/<org>" slug -- normally
// CircleCI's own canonical one, straight off the project record's
// OrganizationSlug, in preference to anything this host inferred.
//
// This is issue #20's first item: the top bar showed "<organization>/<project>"
// with the whole label linking to the project, and no organization-level URL
// had ever been verified to link the organization half separately. See
// overviewRouteVCS for the live evidence (`/pipelines/<vcs>/<org>`, checked for
// both a name-addressed and a standalone organization) and for the honest
// limitation it carries: the evidence establishes this route's *shape*, not
// that any particular organization exists or renders real content.
//
// Same emptiness contract as ProjectWebURLForSlug, for the same reason: empty
// when the slug is not exactly two segments, either segment is empty, or its
// VCS type is not one overviewRouteVCS accepts. A caller must render the
// organization's name as plain text then, rather than as a link that cannot
// work.
func (e Environment) OrgWebURLForSlug(slug string) string {
	base := e.WebAppBaseURL()
	if base == "" || slug == "" {
		return ""
	}

	segments := strings.Split(slug, "/")
	if len(segments) != 2 {
		return ""
	}
	vcs := CanonicalVCSSegment(segments[0])
	if !overviewRouteVCS(vcs) || segments[1] == "" {
		return ""
	}

	return fmt.Sprintf("%s/pipelines/%s/%s",
		base,
		vcs,
		url.PathEscape(segments[1]),
	)
}

// ProjectSettingsWebURLForSlug returns the CircleCI web UI URL for the
// *settings* page of the project named by an explicit "<vcs>/<org>/<repo>"
// slug -- normally CircleCI's own canonical one, straight off the project
// record, matching ProjectWebURLForSlug's own contract.
//
// This is the settings half of the link pair issue #248 moved into the
// reference pane's Project tab: the owner asked for "links to the projects
// and maybe links to the settings, so people can easily click them and go to
// the UI to edit things" (quoted again in issue #226).
// `/settings/project/<vcs>/<org>/<repo>` was already confirmed as a real
// route while this host was working out the top bar's single project link,
// which deliberately chose not to use it -- that decision was about *where
// one link should point*, not about whether this host may ever address the
// page at all. A dedicated settings link is a second, explicit affordance,
// not a reversal: this method still only ever hands the user to CircleCI's
// own UI to make a change, the same move ContextWebURL already makes for a
// context's restrictions.
//
// Same emptiness contract as ProjectWebURLForSlug, for the same reason:
// empty when the slug is incomplete or its VCS type is not
// name-addressed. A caller must render plain text in that case rather than a
// link that cannot work.
func (e Environment) ProjectSettingsWebURLForSlug(slug string) string {
	base := e.WebAppBaseURL()
	if base == "" || slug == "" {
		return ""
	}

	segments := strings.Split(slug, "/")
	if len(segments) != 3 {
		return ""
	}
	vcs := CanonicalVCSSegment(segments[0])
	if !nameAddressedVCSSegments[vcs] || segments[1] == "" || segments[2] == "" {
		return ""
	}

	return fmt.Sprintf("%s/settings/project/%s/%s/%s",
		base,
		vcs,
		url.PathEscape(segments[1]),
		url.PathEscape(segments[2]),
	)
}

// ContextWebURL returns the CircleCI web UI URL for one context's own settings
// page — where its restrictions are actually edited.
//
// This is the link issue #251 asks for. The editor can say a context is
// restricted, and can say to what, and can say when it cannot tell; what it
// cannot do is *change* the restriction, because this host has no write path to
// contexts at all. So the honest end of that sentence is a link to the
// one page that can, which is the same "hand the rest to the web UI" move
// already made for observation elsewhere in this host.
//
// orgSlug is a two-segment `<vcs>/<org>` organization slug — CircleCI's own,
// off the project record, in preference to anything this host inferred.
//
// ## How the route was established
//
// `app.circleci.com` is a Next.js app, and its served HTML names the matched
// route in the `"page"` field of its own hydration payload. That makes it a real
// existence probe, unlike the SPA 200s that issue #182 could not use as
// evidence — an unknown path answers HTTP 404 with `"page":"/_error"`:
//
//	/settings/organization/github/CircleCI-Public/contexts
//	  -> 200, "page":"/settings/organization/[vcsType]/[orgName]/contexts"
//	/settings/organization/github/CircleCI-Public/contexts/<uuid>
//	  -> 200, "page":"/settings/organization/[vcsType]/[orgName]/contexts/[contextId]"
//	/settings/organization/github/CircleCI-Public/nonsense-route-xyz
//	  -> 404, "page":"/_error"
//
// So the per-context route exists, which is what had to be shown. The two path
// parameters are *not* validated at the routing layer (a fabricated vcsType also
// answers 200), so getting them right is this host's job rather than something
// the probe can confirm — which is why they come from CircleCI's own record.
//
// ## Why nameAddressedVCSSegments does not gate this one
//
// ProjectWebURLForSlug refuses to build a URL for a `circleci/<org-id>/<project-id>`
// slug, because that project page is addressed by names this host does not have
// and #182 could not verify the ID-addressed form. Neither problem exists here.
// This route's second segment is an *organization* key, and for a GitLab or
// GitHub App organization CircleCI's own slug is exactly `circleci/<org-id>` —
// the ID *is* how the platform addresses it, not a fallback for a missing name.
// Both spellings were probed above and matched the same route.
//
// The honest caveat, recorded because the next reader will want it: rendered
// page *content* cannot be checked without a session, so what is verified is
// that the route exists and accepts these shapes, not that a particular
// organization's page renders. A wrong org here lands on CircleCI's own "not
// found" handling inside the app, which is a page about the problem — not a
// broken link.
//
// Empty when there is no context ID, no organization slug, or the slug is not
// two segments: a caller must render the context's name as plain text then,
// rather than as a link that cannot work.
func (e Environment) ContextWebURL(orgSlug, contextID string) string {
	if contextID == "" || orgSlug == "" {
		return ""
	}

	base := e.WebAppBaseURL()
	if base == "" {
		return ""
	}

	segments := strings.Split(orgSlug, "/")
	if len(segments) != 2 || segments[0] == "" || segments[1] == "" {
		return ""
	}

	return fmt.Sprintf("%s/settings/organization/%s/%s/contexts/%s",
		base,
		CanonicalVCSSegment(segments[0]),
		url.PathEscape(segments[1]),
		url.PathEscape(contextID),
	)
}

// PipelineWebURL returns the CircleCI web UI URL for one pipeline of the
// project named by slug, addressed by its pipeline *number*.
//
// This is the deep link that closes the loop on issue #194: this editor
// starts a run and then hands the user to the web UI, since observation
// belongs there rather than in a second-rate version built here.
//
// ## Why /pipelines/ and not /projects/, unlike ProjectWebURLForSlug
//
// The overview route is a project hub and has nowhere to put a pipeline
// number. `/pipelines/<vcs>/<org>/<repo>/<number>` is the form CircleCI's own
// VS Code extension builds (`views/sidebar/Workflow.ts` composes
// `/pipelines/${projectSlug}/${pipelineNumber}/workflows/${id}`, so the prefix
// used here is that URL with its workflow segment dropped), and CircleCI's
// documentation contains a literal example of the same shape --
// `app.circleci.com/pipelines/github/CircleCI-Public/orb-tools-orb/947/...` in
// the "create an orb" guide. It is the shortest URL that names a pipeline
// without also needing a workflow UUID this host does not have.
//
// The same emptiness contract as ProjectWebURLForSlug, for the same reason:
// empty when the slug is incomplete, when its VCS type is not
// name-addressed, or when number is not positive. A caller must render the
// pipeline number as plain text in that case. A link that cannot work is worse
// than no link -- and worse still here, where the user has just spent money and
// is owed a way to see what they bought.
func (e Environment) PipelineWebURL(slug string, number int64) string {
	if number <= 0 {
		return ""
	}

	base := e.WebAppBaseURL()
	if base == "" || slug == "" {
		return ""
	}

	segments := strings.Split(slug, "/")
	if len(segments) != 3 {
		return ""
	}
	vcs := CanonicalVCSSegment(segments[0])
	if !nameAddressedVCSSegments[vcs] || segments[1] == "" || segments[2] == "" {
		return ""
	}

	return fmt.Sprintf("%s/pipelines/%s/%s/%s/%d",
		base,
		vcs,
		url.PathEscape(segments[1]),
		url.PathEscape(segments[2]),
		number,
	)
}
