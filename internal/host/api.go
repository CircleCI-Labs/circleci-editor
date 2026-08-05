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
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
)

// maxRequestBodyBytes bounds the size of request bodies accepted by the API,
// to guard against excessive memory use from a malicious or buggy client.
const maxRequestBodyBytes = 10 << 20 // 10 MiB

// errorEnvelope is the JSON shape returned for every API error response.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Message string `json:"message"`
}

// metaResponse is the JSON shape returned by GET /api/meta.
//
// HasToken also indicates whether POST /api/validate can perform
// server-side validation: that endpoint requires the same CIRCLE_TOKEN this
// field reports on, so no separate "validation available" field is exposed
// here.
type metaResponse struct {
	Version      string `json:"version"`
	ConfigPath   string `json:"configPath"`
	ConfigExists bool   `json:"configExists"`
	ConfigFound  bool   `json:"configFound"`
	ProjectSlug  string `json:"projectSlug"`
	HasToken     bool   `json:"hasToken"`
	Host         string `json:"host"`
	Cwd          string `json:"cwd"`

	// ProjectWebURL deep-links to this project in the CircleCI web UI
	// (issue #149). Derived purely from the CLI-injected environment, so
	// unlike everything under GET /api/project-context it needs no token and
	// costs no request -- which is the point: the top bar can say which
	// project this config belongs to before, and regardless of whether, any
	// CircleCI API call succeeds.
	//
	// Empty when there is no project slug, or when the VCS type is not one a
	// URL can be built for -- see Environment.ProjectWebURL. A client must
	// treat empty as "render the identity as text, without a link", never as
	// "there is no project".
	//
	// Superseded, once GET /api/project-context has returned a project record,
	// by that record's own `project.webUrl` (issue #182): this value is built
	// from an *assumed* VCS type, and the record's is built from the slug
	// CircleCI reports. A client that has a record must use the record's field
	// and must not fall back to this one -- including when the record's field is
	// empty, which means "this project has no name-addressed web page".
	ProjectWebURL string `json:"projectWebUrl,omitempty"`

	// Branch is the branch to *show* (issue #214), and BranchSource says where
	// it came from: "checkout" for the working tree's own HEAD, "environment"
	// for CIRCLE_BRANCH. The checkout wins when both are available, because the
	// user is editing this working tree and a stale injected value would be
	// worse than none.
	//
	// EnvBranch carries CIRCLE_BRANCH regardless, so a client can say *which*
	// branch it is showing when the two disagree instead of quietly preferring
	// one. All three are empty when neither source has anything -- which is the
	// ordinary case for a config edited outside a checkout.
	Branch       string `json:"branch,omitempty"`
	BranchSource string `json:"branchSource,omitempty"`
	EnvBranch    string `json:"envBranch,omitempty"`

	// RepoWebURL, RepoName and RepoHost describe the `origin` git remote: a
	// browsable URL for the repository, its "<owner>/<repo>" path, and the host
	// serving it. Empty when there is no usable remote (see GitInfo).
	//
	// Deliberately *not* presented as an authority on the project's identity.
	// Issue #198 documented the trap: a remote can be stale after a repository
	// rename, so this says where this checkout pushes, while
	// GET /api/project-context says what CircleCI calls the project. A client
	// must not let this override that -- see issue #182.
	RepoWebURL string `json:"repoWebUrl,omitempty"`
	RepoName   string `json:"repoName,omitempty"`
	RepoHost   string `json:"repoHost,omitempty"`

	// ProjectSlugSource says which of the two sources ProjectSlug above came
	// from: "binding" for `.circleci/info.yml`, "environment" for the CIRCLE_*
	// variables the CLI injected. Empty when there is no slug at all.
	//
	// Issue #198: the binding wins, because a git-remote-derived slug goes
	// permanently stale when a repository is renamed while the recorded binding
	// does not. Reported rather than merely applied, so a client can say where
	// the identity came from instead of presenting two rather different
	// confidences identically.
	ProjectSlugSource string `json:"projectSlugSource,omitempty"`

	// ProjectBinding describes `.circleci/info.yml` -- always present, never
	// omitted, because its `status` field is the answer even when it is
	// "absent". A client that saw no key at all could not tell "there is no
	// binding" from "this host did not look", which is the distinction issue
	// #198's constraint turns on.
	ProjectBinding projectBindingPayload `json:"projectBinding"`

	// CSRFToken is this launch's per-launch CSRF token (see csrf.go), handed
	// to the served page here so it can attach it to every state-changing
	// request from then on. Safe to include in an ordinary JSON response:
	// this endpoint sets no CORS header allowing another origin to read it,
	// so a page other than the one this host actually served can trigger a
	// request here but cannot read what comes back -- the same reasoning
	// that already makes CIRCLE_TOKEN-gated fields like HasToken safe to
	// expose without a token ever leaving this process.
	CSRFToken string `json:"csrfToken"`
}

// projectBindingPayload is the JSON shape of metaResponse.ProjectBinding: what
// `.circleci/info.yml` said, or why it said nothing.
//
// The recorded organization and project *IDs* are deliberately not here. They are
// not secret (the CLI prints them, and CircleCI's own web UI puts them in URLs),
// but nothing in the browser needs one -- every call that wants an ID is made
// host-side -- and this package's habit is to send what a client uses and no more.
type projectBindingPayload struct {
	// Status is "absent", "present" or "malformed". Three states, because
	// "there is no binding" and "there is a binding we could not read" must
	// never render alike.
	Status string `json:"status"`

	// Path is where this host looked, set even when nothing was there.
	Path string `json:"path,omitempty"`

	// Slug, ProjectName and OrganizationName are what the file recorded, and
	// are advisory: CircleCI's own project record supersedes them the moment
	// GET /api/project-context returns one, and that rule is unchanged.
	Slug             string `json:"slug,omitempty"`
	ProjectName      string `json:"projectName,omitempty"`
	OrganizationName string `json:"organizationName,omitempty"`

	// Problem is the host's own sentence naming why a file that exists could
	// not be used. Present only for "malformed".
	Problem string `json:"problem,omitempty"`

	// Description is the host's own prose for this binding, shown verbatim (in
	// the file switcher, and in the top bar's tooltip) so the two sides cannot
	// disagree about what the file is -- the same rule configReason follows.
	Description string `json:"description"`

	// DisagreesWithEnvironment is true when the binding and the CLI-injected
	// environment name different projects, which is issue #198's symptom seen
	// from the inside: a renamed repository leaves the remote-derived
	// environment naming a repository that no longer exists. The binding wins;
	// EnvironmentSlug carries the loser so a client can name both rather than
	// silently discarding one.
	DisagreesWithEnvironment bool   `json:"disagreesWithEnvironment,omitempty"`
	EnvironmentSlug          string `json:"environmentSlug,omitempty"`
}

// configResponse is the JSON shape returned by GET /api/config.
type configResponse struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
	Exists   bool   `json:"exists"`
}

// configWriteRequest is the JSON shape accepted by PUT /api/config.
type configWriteRequest struct {
	Contents *string `json:"contents"`
}

// configWriteResponse is the JSON shape returned by PUT /api/config.
type configWriteResponse struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

// configFileEntry is one entry of GET /api/config-files's "files" array.
type configFileEntry struct {
	Path    string `json:"path"`
	RelPath string `json:"relPath"`
	Size    int64  `json:"size"`
	// IsPrimary marks the one file this host resolved at startup (or via
	// --config) -- the file every other API this app already shipped
	// (GET/PUT /api/config with no ?path=, POST /api/validate, the AI
	// pane's context before this issue) treats as "the" config. It stays
	// meaningful once other files can be opened too: it is what the AI
	// pane's directory context (issue #102) and the validation badge's
	// asymmetry note (issue #106) key off of.
	IsPrimary bool `json:"isPrimary"`
	// Contents holds the file's raw text, present only when the request
	// asked for it (?contents=1) and the file is not larger than
	// maxIndexedFileBytes. Omitted (not empty-string) when contents were
	// not requested, so a caller can't confuse "empty file" with "contents
	// not fetched".
	Contents *string `json:"contents,omitempty"`
	// Omitted is true when contents were requested but this file exceeded
	// maxIndexedFileBytes -- so a caller can report it as "skipped: too
	// large" rather than mistaking a missing Contents for a zero-byte file.
	Omitted bool `json:"omitted,omitempty"`
	// IsConfig is whether this file structurally looks like a CircleCI
	// config (issue #135: a `.circleci` directory routinely holds YAML that
	// isn't one -- the reported case was goss's `goss.yaml`). Always
	// present, never inferred by the client: the switcher hides
	// non-configs by default and states ConfigReason when one is revealed
	// or opened, so both sides say the same thing about the same file.
	//
	// Note that a non-config is still *listed*, and still openable through
	// ?path= -- see ClassifyConfigContents and ListConfigDir on why a
	// misclassified real config must stay one click away rather than
	// becoming unreachable.
	IsConfig bool `json:"isConfig"`
	// ConfigReason is the host's own human-readable reason for IsConfig,
	// e.g. "Declares version: 2.1." or "No CircleCI structure: ...".
	ConfigReason string `json:"configReason"`
	// KnownRole names what this file is *for* when it is not a config but the
	// host recognises it anyway -- today only knownRoleProjectBinding, for
	// `.circleci/info.yml`. Empty for everything else.
	//
	// Issue #198's item 4: the classifier is right that `info.yml` is not a
	// CircleCI config (no `version: 2.x`, none of the structural keys), but
	// leaving it at that lists a *meaningful* file among unexplained other
	// YAML. A file the host can name should be named.
	KnownRole string `json:"knownRole,omitempty"`
	// KnownRoleSummary is the host's own prose for KnownRole, shown in place
	// of ConfigReason. Same reason ConfigReason exists rather than being
	// re-derived in the browser: one file, one description.
	KnownRoleSummary string `json:"knownRoleSummary,omitempty"`
}

// knownRoleProjectBinding marks `.circleci/info.yml` in the directory listing.
//
// A machine token alongside the prose, not instead of it: the switcher keys its
// treatment off this (a named file is not "unexplained other YAML") while
// rendering KnownRoleSummary verbatim.
const knownRoleProjectBinding = "projectBinding"

// configFilesResponse is the JSON shape returned by GET /api/config-files.
type configFilesResponse struct {
	// Dir is the absolute directory that was indexed -- normally the
	// `.circleci` directory, but see ListConfigDir's caller in server.go for
	// the (rare) case of an explicit --config path outside one.
	Dir         string            `json:"dir"`
	PrimaryPath string            `json:"primaryPath"`
	Files       []configFileEntry `json:"files"`
}

// healthzResponse is the JSON shape returned by GET /api/healthz.
type healthzResponse struct {
	Status string `json:"status"`
}

// writeJSON writes v as a JSON response body with the given status code and
// the appropriate Content-Type header.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// Encoding errors here would mean a bug in a response type; there is
	// nothing more useful to do than drop the (partial) write at this point.
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes a JSON error envelope with the given status code and
// message.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorEnvelope{Error: errorBody{Message: message}})
}

// handleMeta serves GET /api/meta.
func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	_, exists, err := s.configFile.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read config file")
		return
	}

	// Read per request rather than cached at startup (issue #214): the user can
	// switch branches while the editor is open, so a reload should pick the new
	// one up. Two short-lived `git` invocations, both bounded and both
	// degrading to empty -- see LoadGitInfo.
	git := LoadGitInfo(s.gitAnchorDir())
	branch, branchSource := s.env.Branch, ""
	if branch != "" {
		branchSource = "environment"
	}
	if git.Branch != "" {
		branch, branchSource = git.Branch, "checkout"
	}

	// Read per request for the same reason the git info above is (issue #214):
	// `circleci project link` can be run in another terminal while the editor is
	// open, and a reload should pick the new binding up. One small file read.
	identity := s.projectIdentity()

	writeJSON(w, http.StatusOK, metaResponse{
		Version:      s.opts.Version,
		ConfigPath:   s.configFile.Path,
		ConfigExists: exists,
		ConfigFound:  s.configFound,
		// The resolved identity, not s.env.ProjectSlug(): issue #198's item 1 in
		// one line. See ProjectIdentity for the precedence and why it is the
		// CLI's.
		ProjectSlug:       identity.Slug,
		ProjectSlugSource: identity.Source,
		ProjectBinding:    bindingPayload(identity),
		CSRFToken:         s.csrfToken,
		HasToken:          s.env.HasToken(),
		Host:              s.env.Host,
		Cwd:               s.opts.WorkDir,
		ProjectWebURL:     s.env.ProjectWebURLForSlug(identity.Slug),
		Branch:            branch,
		BranchSource:      branchSource,
		EnvBranch:         s.env.Branch,
		RepoWebURL:        git.RemoteURL,
		RepoName:          git.RemoteRepo,
		RepoHost:          git.RemoteHost,
	})
}

// bindingPayload renders a resolved identity's binding half for GET /api/meta.
func bindingPayload(identity ProjectIdentity) projectBindingPayload {
	binding := identity.Binding
	payload := projectBindingPayload{
		Status:                   binding.Status,
		Path:                     binding.Path,
		Problem:                  binding.Problem,
		Description:              binding.Description(),
		DisagreesWithEnvironment: identity.Disagrees(),
		EnvironmentSlug:          identity.EnvironmentSlug,
	}
	if b := binding.Binding; b != nil {
		payload.Slug = b.EffectiveSlug()
		payload.ProjectName = b.ProjectName
		payload.OrganizationName = b.OrganizationName
	}
	return payload
}

// projectIdentity resolves which CircleCI project this host's config belongs to,
// reading `.circleci/info.yml` fresh each time.
//
// Not cached on the Server, deliberately. The file is small, the read is local,
// and it can change under a running editor -- `circleci project link` is a thing a
// user runs *because* the editor just told them to. GET /api/project-context's
// cache is keyed by slug, so a binding that starts naming a different project
// misses that cache rather than being masked by it.
func (s *Server) projectIdentity() ProjectIdentity {
	binding := LoadProjectBinding(ProjectBindingPath(s.configFile.Path, s.opts.WorkDir))
	return ResolveProjectIdentity(s.env, binding)
}

// gitAnchorDir is the directory git questions are asked from: the directory
// holding the config file being edited, falling back to the server's working
// directory.
//
// The config file's own directory is the more faithful anchor -- `--config`
// can point at a checkout that is not the one the process was started in, and
// it is the file's repository the user is editing. `git` resolves the
// enclosing repository from any subdirectory, so `.circleci/` is a fine place
// to ask from.
func (s *Server) gitAnchorDir() string {
	// Guarded on the *path*, not on configDir()'s result: filepath.Dir("")
	// returns ".", which would silently anchor on the process's cwd rather
	// than on WorkDir.
	//
	// And guarded on the directory actually existing: when no config was found
	// the server still carries the path it *would* write (`<workdir>/.circleci/
	// config.yml`), and `git` in a directory that isn't there simply fails --
	// which would have reported "not a checkout" for every repository that has
	// yet to gain a `.circleci/`.
	if s.configFile.Path != "" {
		dir := s.configDir()
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	return s.opts.WorkDir
}

// handleConfig serves GET and PUT /api/config.
func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleConfigGet(w, r)
	case http.MethodPut:
		s.handleConfigPut(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// resolveConfigTarget resolves the file GET/PUT /api/config should act on:
// the server's primary configFile when the request supplies no ?path=
// (byte-for-byte the original, single-file behaviour every existing test
// and caller already depends on), otherwise the requested path -- but only
// once resolveIndexedPath has confirmed it is genuinely inside this
// server's indexed directory and, for anything other than the primary
// path itself, already exists there. See resolveIndexedPath's own doc
// comment for why that check lives at this boundary rather than being
// trusted from the frontend.
//
// The primary-file branch has its own, narrower check alongside it:
// discoveredRepoRoot reports a repository root only when the primary path
// was *found* by walking up from WorkDir, never for an explicit --config
// value, and RefuseEscapingPrimarySymlink is a no-op for anything that
// isn't itself a symlink escaping that root. Both together mean this branch
// is unaffected for the overwhelming majority of requests: no --config, and
// an ordinary (non-symlink) config.yml, is nothing new here at all.
func (s *Server) resolveConfigTarget(requestedPath string) (ConfigFile, error) {
	if requestedPath == "" || requestedPath == s.configFile.Path {
		if root := s.discoveredRepoRoot(); root != "" {
			if err := s.configFile.RefuseEscapingPrimarySymlink(root); err != nil {
				return ConfigFile{}, err
			}
		}
		return s.configFile, nil
	}
	resolved, err := resolveIndexedPath(s.configDir(), requestedPath, s.configFile.Path)
	if err != nil {
		return ConfigFile{}, err
	}
	return ConfigFile{Path: resolved}, nil
}

// discoveredRepoRoot returns the repository root -- the directory
// containing `.circleci`, not `.circleci` itself -- when this server's
// primary config file was located by FindConfigFile's walk-up, or "" when
// an explicit --config value was given instead.
//
// The "" case matters as much as the real one: it is what tells
// resolveConfigTarget to skip RefuseEscapingPrimarySymlink entirely for an
// explicit path, which is the user's own consent for that exact file and
// must never be second-guessed by a check meant for a path this host chose
// on the user's behalf.
//
// Safe to assume the walk-up shape (<root>/.circleci/config.yml or
// .../config.yaml) whenever ConfigPath is empty: that is the only shape
// FindConfigFile's own walk-up ever returns, found or not (see its own doc
// comment on the not-found fallback).
func (s *Server) discoveredRepoRoot() string {
	if s.opts.ConfigPath != "" {
		return ""
	}
	return filepath.Dir(s.configDir())
}

// configDir returns the directory GET /api/config-files indexes: the
// directory containing this server's primary config file. Normally that is
// a `.circleci` directory (FindConfigFile only ever looks there), but an
// explicit --config pointed elsewhere is respected as-is -- the sibling
// files worth showing are whatever else lives alongside the file this host
// was actually told to open, regardless of that directory's name.
func (s *Server) configDir() string {
	return filepath.Dir(s.configFile.Path)
}

func (s *Server) handleConfigGet(w http.ResponseWriter, r *http.Request) {
	target, err := s.resolveConfigTarget(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	contents, exists, err := target.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read config file")
		return
	}

	writeJSON(w, http.StatusOK, configResponse{
		Path:     target.Path,
		Contents: contents,
		Exists:   exists,
	})
}

func (s *Server) handleConfigPut(w http.ResponseWriter, r *http.Request) {
	// The one handler in this package that changes a file the user owns, so
	// the one that must be able to say "not now" to the last-client exit
	// (issue #177). Held across the whole handler, body read included: a
	// save that is still arriving is as much a write in flight as one
	// already calling ConfigFile.Write, and the realistic sequence -- the
	// page fires its save and is then closed -- disconnects the heartbeat
	// stream while this request is mid-flight. Releasing the hold also
	// restarts the grace period, so a write finishing is never immediately
	// followed by an exit that was already overdue. See clientTracker.hold.
	release := s.clients.hold()
	defer release()

	target, err := s.resolveConfigTarget(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req configWriteRequest
	if decodeErr := decodeJSONBody(r, &req); decodeErr != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}

	if req.Contents == nil {
		writeError(w, http.StatusBadRequest, "missing required field: contents")
		return
	}

	n, err := target.Write(*req.Contents)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write config file")
		return
	}

	writeJSON(w, http.StatusOK, configWriteResponse{
		Path:  target.Path,
		Bytes: n,
	})
}

// handleConfigFiles serves GET /api/config-files: the directory index
// behind issue #106 (open any config in `.circleci/`) and issue #102 (send
// the whole directory to the AI as context) -- landed once, here, per both
// issues' own "land the indexing once" instruction, so the file switcher
// and the AI pane's directory context read the identical listing.
//
// ?contents=1 additionally inlines each file's text (bounded by
// maxIndexedFileBytes -- see configFileEntry.Omitted) so the AI pane can
// assemble its read-only directory context in one round trip instead of
// one request per file.
func (s *Server) handleConfigFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	dir := s.configDir()
	rawEntries, err := ListConfigDir(dir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list config directory")
		return
	}

	withContents := r.URL.Query().Get("contents") == "1"

	// Resolved once for the whole listing: at most one indexed file is the
	// project binding, and describing it means describing what this host made of
	// it (issue #198), which is the same read GET /api/meta does.
	bindingPath := ProjectBindingPath(s.configFile.Path, s.opts.WorkDir)

	files := make([]configFileEntry, 0, len(rawEntries)+1)
	sawPrimary := false
	for _, e := range rawEntries {
		entry := configFileEntry{
			Path:      e.Path,
			RelPath:   e.RelPath,
			Size:      e.Size,
			IsPrimary: e.Path == s.configFile.Path,
		}
		if entry.IsPrimary {
			sawPrimary = true
		}
		// Compared by path rather than by name, so a nested `info.yml` a
		// directory down -- which binds nothing, since the CLI only ever reads
		// the one beside `config.yml` -- is not mislabelled as the binding.
		if bindingPath != "" && e.Path == bindingPath {
			entry.KnownRole = knownRoleProjectBinding
			entry.KnownRoleSummary = LoadProjectBinding(bindingPath).Description()
		}

		// Both the classification (issue #135) and ?contents=1 need the
		// file's text, so it is read once, here -- bounded by the same
		// maxIndexedFileBytes cap that already governs what this endpoint
		// is willing to send, so classification never becomes a reason to
		// slurp more of a file than the endpoint already would.
		var contents string
		haveContents := false
		if e.Size <= maxIndexedFileBytes {
			if text, exists, readErr := (ConfigFile{Path: e.Path}).Read(); readErr == nil && exists {
				contents, haveContents = text, true
			}
		}
		entry.IsConfig, entry.ConfigReason = classifyIndexedEntry(entry.IsPrimary, e.Size, contents, haveContents)

		if withContents {
			if e.Size > maxIndexedFileBytes {
				entry.Omitted = true
			} else if haveContents {
				entry.Contents = &contents
			}
		}
		files = append(files, entry)
	}

	// The primary file might not exist on disk yet (ConfigFound == false):
	// ListConfigDir only ever reports files that are actually there, so it
	// is deliberately still surfaced here (with Size 0, no Contents) --
	// otherwise a brand-new project's file switcher would show nothing at
	// all for the one file GET/PUT /api/config with no ?path= already
	// operates on.
	if !sawPrimary && s.configFile.Path != "" {
		files = append(files, configFileEntry{
			Path:         s.configFile.Path,
			RelPath:      filepath.Base(s.configFile.Path),
			IsPrimary:    true,
			IsConfig:     true,
			ConfigReason: primaryFileConfigReason,
		})
	}

	sort.Slice(files, func(i, j int) bool { return files[i].RelPath < files[j].RelPath })

	writeJSON(w, http.StatusOK, configFilesResponse{
		Dir:         dir,
		PrimaryPath: s.configFile.Path,
		Files:       files,
	})
}

// handleHealthz serves GET /api/healthz.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, healthzResponse{Status: "ok"})
}

// handleAPINotFound serves any /api/ path that does not match a known
// endpoint, returning JSON (rather than falling through to the SPA HTML
// fallback).
func handleAPINotFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not found")
}
