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
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// ProjectBindingFileName is the name of the file, inside a `.circleci`
// directory, in which `circleci project link` records which CircleCI project a
// checkout belongs to.
//
// The CLI spells the whole path as one constant --
// `projectref.FilePath = ".circleci/info.yml"` -- but this host already has the
// `.circleci` directory resolved (ConfigFile.Dir, and the directory
// ListConfigDir indexes), so only the leaf is needed here.
const ProjectBindingFileName = "info.yml"

// Project binding statuses. Three, not two, and that is the whole point: issue
// #198's constraint is that "there is no binding" and "there is a binding and we
// could not read it" must never render identically, so the absence of a file and
// the failure to parse one are separate states carrying separate prose.
const (
	// ProjectBindingAbsent means no `.circleci/info.yml` exists. The ordinary
	// case, and never an error: most checkouts have never been linked.
	ProjectBindingAbsent = "absent"

	// ProjectBindingPresent means the file was read and carries a project
	// slug.
	ProjectBindingPresent = "present"

	// ProjectBindingMalformed means a file exists and this host could not
	// use it: unreadable, not YAML, or missing the one field the CLI itself
	// treats as required (`project.slug`). Deliberately loud -- see
	// ProjectBindingResult.
	ProjectBindingMalformed = "malformed"
)

// ProjectBinding is the content of `.circleci/info.yml`: the project a checkout
// is bound to, as recorded by `circleci project link`.
//
// The field names and the YAML shape are the CircleCI CLI's own, copied from
// `internal/projectref/projectref.go` rather than inferred from a sample file:
//
//	organization:
//	  id: <uuid>          # optional in practice; written when link verified it
//	  name: <string>      # optional
//	project:
//	  id: <uuid>          # optional in practice
//	  slug: <string>      # required
//	  name: <string>      # optional
//
// Why this file rather than the git remote (issue #198): a remote goes stale the
// moment a repository is renamed, and GitHub's permanent redirect hides that --
// `git push` keeps working while the name no longer identifies anything. The
// reported case was a checkout whose remote said `example-org/flakey-todo-list`
// for a project CircleCI calls `flaky-todo-list`. The recorded binding does not
// rot that way, and it additionally carries **IDs**, which survive a rename
// outright.
//
// This host never writes this file. It is committed alongside
// `.circleci/config.yml` (the CLI's own `#nosec` comment says so, and writes it
// 0644 for that reason), so creating or changing it is a change to the user's
// repository, not a local preference. The only remedy this host offers is to
// suggest the command that owns it -- see projectBindingSuggestions.
type ProjectBinding struct {
	OrganizationID   string
	OrganizationName string
	ProjectID        string
	ProjectSlug      string
	ProjectName      string
}

// projectBindingFile is the wire shape of `.circleci/info.yml`, kept separate
// from ProjectBinding so that the flattened field names this package uses are not
// forced on the file's own nesting -- and so that the type with the YAML tags is
// unexported and has no marshaller anywhere, which is one small structural reason
// this host cannot write the user's file back out.
type projectBindingFile struct {
	Organization struct {
		ID   string `yaml:"id"`
		Name string `yaml:"name"`
	} `yaml:"organization"`
	Project struct {
		ID   string `yaml:"id"`
		Slug string `yaml:"slug"`
		Name string `yaml:"name"`
	} `yaml:"project"`
}

// EffectiveSlug returns the slug to address this project by when calling the
// CircleCI API.
//
// This is the CLI's `(*projectref.Info).EffectiveSlug` rule, copied verbatim
// including its guard, because getting the guard wrong produces a confident 404:
//
//   - A **CircleCI-native** project -- one whose recorded slug already starts
//     `circleci/` -- is addressed as `circleci/<orgID>/<projectID>` when both IDs
//     are known, so the lookup survives a VCS-side rename.
//   - **Anything else** is addressed by its recorded slug as-is.
//
// The guard is not caution for its own sake. `GET /api/v2/project/circleci/
// <orgID>/<projectID>` answers **404** for a classic VCS project even when both
// IDs are valid and `circleci project link` recorded them -- verified against the
// live API with this repository's own project (org `4ada2c32-…`, project
// `93d2dc11-…`, slug `gh/CircleCI-Labs/circleci-editor`), which returns
// `{"message":"Project not found"}`. The CLI's own doc comment says the same. So
// the ID form is *not* a generally better address; it is the right address for
// exactly one kind of project.
func (b ProjectBinding) EffectiveSlug() string {
	if strings.HasPrefix(b.ProjectSlug, "circleci/") && b.ProjectID != "" && b.OrganizationID != "" {
		return "circleci/" + b.OrganizationID + "/" + b.ProjectID
	}
	return b.ProjectSlug
}

// ProjectBindingResult is what this host knows about a checkout's recorded
// project binding: which of the three states it is in, and -- when something is
// wrong -- what specifically.
//
// Status is always set. Binding is non-nil only for ProjectBindingPresent, and
// Problem non-empty only for ProjectBindingMalformed, so a caller cannot read a
// half-populated success.
type ProjectBindingResult struct {
	// Status is one of ProjectBindingAbsent, ProjectBindingPresent or
	// ProjectBindingMalformed.
	Status string

	// Path is the absolute path this host looked at, set in every state
	// including absence -- "we looked here and there was nothing" is a more
	// useful thing to be able to say than "there was nothing".
	Path string

	// Binding is the recorded binding, or nil.
	Binding *ProjectBinding

	// Problem is one short sentence naming why a file that exists could not
	// be used. It names the *shape* of the failure and never quotes the
	// file's contents: this file holds no secrets, but "do not echo a file
	// you read back out" is the rule the rest of this package follows (see
	// describeUpstreamError) and there is no reason to make an exception.
	Problem string
}

// Slug returns the recorded project's effective slug, or "" when there is no
// usable binding.
func (r ProjectBindingResult) Slug() string {
	if r.Binding == nil {
		return ""
	}
	return r.Binding.EffectiveSlug()
}

// ProjectBindingPath returns the absolute path of the `info.yml` that binds the
// checkout containing configPath, or "" when there is nowhere sensible to look.
//
// The CLI resolves this as `<cwd>/.circleci/info.yml` and never walks. This host
// anchors on the config file it actually opened instead, which is the same file
// in every ordinary case and the *right* file in one case the CLI's rule gets
// wrong for us: `--config` can point at a checkout that is not the directory
// this process was started in, and it is that checkout's binding that describes
// the config on screen.
//
// Two shapes, in this order:
//
//   - The config lives in a directory named `.circleci`: the binding is its
//     sibling. This covers both discovery (FindConfigFile walks up looking for
//     exactly that directory) and an explicit `--config` pointing into one.
//   - Anything else -- an explicit `--config` at a path of the user's own
//     choosing: fall back to `<workDir>/.circleci/info.yml`, which is the CLI's
//     own anchor, because a bare directory of YAML is not a checkout layout this
//     host can reason about.
func ProjectBindingPath(configPath, workDir string) string {
	if configPath != "" {
		dir := filepath.Dir(configPath)
		if filepath.Base(dir) == ".circleci" {
			return filepath.Join(dir, ProjectBindingFileName)
		}
	}
	if workDir == "" {
		return ""
	}
	return filepath.Join(workDir, ".circleci", ProjectBindingFileName)
}

// LoadProjectBinding reads the binding at path, and never returns an error: a
// missing file is a state, not a failure.
//
// Malformed *is* reported, though, and that is the deliberate difference from
// "best effort, empty on failure" (the rule LoadGitInfo follows). A git remote
// that cannot be read costs a link; an `info.yml` that cannot be read costs the
// project's identity, and silently falling back to the environment-derived slug
// would present a guess with the same confidence as the user's own recorded
// answer. The CLI draws the line in the same place -- `gitremote.Detect`
// surfaces a malformed `info.yml` as a real error rather than falling through to
// the remote.
func LoadProjectBinding(path string) ProjectBindingResult {
	result := ProjectBindingResult{Status: ProjectBindingAbsent, Path: path}
	if path == "" {
		return result
	}

	// #nosec G304 -- path comes from ProjectBindingPath, which composes it from
	// the config path this host resolved at startup and a constant file name;
	// no request can influence it.
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return result
	case err != nil:
		result.Status = ProjectBindingMalformed
		result.Problem = "This host could not read the file: " + classifyFileReadError(err) + "."
		return result
	}

	var file projectBindingFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		result.Status = ProjectBindingMalformed
		result.Problem = "The file is not parseable as YAML."
		return result
	}

	// `project.slug` is the one field the CLI itself treats as required, and it
	// rejects a file without one. Matching that keeps the two tools' idea of
	// "usable binding" identical -- a file this host accepted and the CLI
	// refused would be the disagreement issue #198 exists to prevent.
	if strings.TrimSpace(file.Project.Slug) == "" {
		result.Status = ProjectBindingMalformed
		result.Problem = "The file has no project.slug, which is the one field this binding must carry."
		return result
	}

	result.Status = ProjectBindingPresent
	result.Binding = &ProjectBinding{
		OrganizationID:   strings.TrimSpace(file.Organization.ID),
		OrganizationName: strings.TrimSpace(file.Organization.Name),
		ProjectID:        strings.TrimSpace(file.Project.ID),
		ProjectSlug:      normalizeBindingSlug(file.Project.Slug),
		ProjectName:      strings.TrimSpace(file.Project.Name),
	}
	return result
}

// classifyFileReadError names why a file that exists could not be read, without
// quoting the OS error string -- which embeds the path (already reported
// separately, as ProjectBindingResult.Path) and can carry locale-dependent prose.
//
// Two classes are worth naming and the rest are not. "Permission denied" is
// actionable; "it is a directory" is the one shape a `.circleci/info.yml` can
// take that looks like a corrupt file and isn't. Matched on the error string for
// the directory case because the errno constant differs per platform (EISDIR on
// Unix, ERROR_ACCESS_DENIED-adjacent on Windows) while the wrapped message does
// not, and being wrong here costs one word of a diagnostic rather than any
// behaviour.
func classifyFileReadError(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "permission denied"
	case strings.Contains(err.Error(), "is a directory"):
		return "it is a directory, not a file"
	default:
		return "the read failed"
	}
}

// normalizeBindingSlug normalizes a recorded slug the same way the CircleCI
// CLI does: the VCS segment is normalised to CircleCI's canonical short
// spelling (#182).
//
// A no-op for every file `circleci project link` writes -- it records `gh/...`
// or `circleci/...` already -- so this exists for a hand-edited file, and for the
// same reason ProjectSlug normalises the injected environment: one dialect in one
// process. `circleci` passes through CanonicalVCSSegment intact, which is what
// keeps an ID-addressed slug addressable.
//
// Anything that is not three slash-separated segments is returned untouched. This
// host does not get to decide that a slug the CLI wrote and the API accepts is
// malformed because it has an unexpected number of segments.
func normalizeBindingSlug(slug string) string {
	slug = strings.TrimSpace(slug)
	segments := strings.Split(slug, "/")
	if len(segments) != 3 {
		return slug
	}
	vcs := CanonicalVCSSegment(segments[0])
	if vcs == "" {
		return slug
	}
	return vcs + "/" + segments[1] + "/" + segments[2]
}

// Description is one or two sentences naming what `.circleci/info.yml` is and
// what this host made of it -- the prose the file switcher shows in place of
// "not a CircleCI config" (issue #198 item 4), and the prose the top bar uses to
// say where the project's identity came from.
//
// Written host-side rather than in the browser for the reason configReason
// already is (issue #135): the host is the only party that read the file, and two
// descriptions of one file are two things that can drift apart.
//
// Each status gets its own wording, which is the honest-degrade rule applied to
// the smallest surface it has: absent, present and malformed must not read alike.
func (r ProjectBindingResult) Description() string {
	const what = "Records which CircleCI project this checkout is bound to, written by `circleci project link`"

	switch r.Status {
	case ProjectBindingPresent:
		summary := what + ". It names " + r.Slug()
		if name := r.Binding.OrganizationName; name != "" {
			summary += " in " + name
		}
		return summary + "."
	case ProjectBindingMalformed:
		return what + ", but this host could not use it: " + r.Problem +
			" The project's identity falls back to what the CircleCI CLI passed in, which a repository rename can leave out of date."
	default:
		return what + "."
	}
}

// projectBindingSuggestions returns what to do about a project CircleCI does not
// recognise, in the CircleCI CLI's own words.
//
// The three sentences are the CLI's verbatim output for this exact failure --
// confirmed both in the terminal (quoted in issue #198) and as string literals in
// the released `circleci` binary:
//
//	Suggestions:
//	  • Run 'circleci project link' to bind this repository to a CircleCI project
//	  • Check the project slug and try again
//	  • Use 'circleci project list' to see followed projects
//
// Borrowed rather than reworded on purpose. Issue #198's instruction is not to
// invent a parallel mechanism: the file belongs to `circleci project link`, so
// the remedy should be the command that owns it, phrased the way its own tool
// phrases it, so that a user who searches for the sentence finds the CLI's
// documentation rather than ours.
//
// The one case that needs different words is a binding that *exists* and still
// 404s -- "run project link" is wrong advice there, because the CLI preserves an
// existing file unless `--force` is passed (its own `--help` says so). So that
// case names `--force`, and says why, without this host ever going near the file.
func projectBindingSuggestions(binding ProjectBindingResult) []string {
	switch binding.Status {
	case ProjectBindingPresent:
		return []string{
			"This project came from " + ProjectBindingFileName + " in this directory. If that binding is out of date, " +
				"re-record it with `circleci project link --force` — the CLI preserves an existing file otherwise.",
			"Check the project slug and try again.",
			"Use `circleci project list` to see followed projects.",
		}
	case ProjectBindingMalformed:
		return []string{
			"Fix or replace " + ProjectBindingFileName + " in this directory: " + binding.Problem,
			"Run `circleci project link --force` to re-record it — the CLI preserves an existing file otherwise.",
			"Use `circleci project list` to see followed projects.",
		}
	default:
		return []string{
			"Run `circleci project link` to bind this repository to a CircleCI project.",
			"Check the project slug and try again.",
			"Use `circleci project list` to see followed projects.",
		}
	}
}

// Project identity sources, reported by ProjectIdentity.Source.
const (
	// ProjectIdentityFromBinding means the project came from
	// `.circleci/info.yml`.
	ProjectIdentityFromBinding = "binding"

	// ProjectIdentityFromEnvironment means the project came from the
	// CIRCLE_* variables the CircleCI CLI injected.
	ProjectIdentityFromEnvironment = "environment"
)

// ProjectIdentity is this host's answer to "which CircleCI project does the
// config on screen belong to", resolved once from every source there is.
//
// ## Precedence, and why it matches the CLI's
//
// The CLI's documented order (`circleci project link --help`, and
// `gitremote.Detect`) is: `--project` flag, then `.circleci/info.yml`, then the
// git remote, then an interactive prompt. This host's chain is the same one with
// the two ends filled in by what this host actually has:
//
//  1. **No `--project` equivalent.** This editor takes no project flag, so the
//     slot is empty rather than invented. Nothing here forecloses adding one.
//  2. **The recorded binding** (`.circleci/info.yml`), read here.
//  3. **The CLI-injected environment** in place of the git remote. That is not a
//     substitution so much as the same source one step downstream: the CLI
//     derives CIRCLE_VCS_TYPE/CIRCLE_PROJECT_USERNAME/CIRCLE_PROJECT_REPONAME by
//     splitting `gitremote.Detect`'s slug, which itself prefers `info.yml` over
//     the remote (`internal/extension/manifest.go`). So when the editor is
//     launched through the CLI *from the checkout root*, the environment already
//     agrees with the binding, and reading the binding here can only ever
//     confirm it.
//  4. **The prompt** becomes advice: this host cannot prompt for a project, and
//     must not guess one, so a slug CircleCI does not recognise produces the
//     CLI's own suggestion to run `circleci project link` (see
//     projectBindingSuggestions).
//
// The two cases where reading the binding ourselves changes the answer are worth
// naming, because they are the reason this is not dead code:
//
//   - **The editor was not launched through the CLI.** No CIRCLE_* variables at
//     all, so before this the project was simply unknown; now the committed
//     binding answers.
//   - **The CLI's anchor and ours differ.** `gitremote.Detect` reads `info.yml`
//     relative to the CLI's own working directory; this host reads it beside the
//     config it opened (see ProjectBindingPath), which is the binding that
//     describes the file on screen when `--config` points elsewhere. And a
//     malformed `info.yml` makes the CLI's overlay silently inject *nothing* --
//     which would reach this host as "not a CircleCI project" if it did not look
//     for itself.
type ProjectIdentity struct {
	// Slug is the project slug to use, in CircleCI's canonical spelling, or
	// "" when no source produced one.
	Slug string

	// Source is ProjectIdentityFromBinding or
	// ProjectIdentityFromEnvironment, and "" when Slug is empty.
	Source string

	// EnvironmentSlug is what the injected environment claimed, kept even
	// when the binding won, so a disagreement can be *reported* rather than
	// silently resolved. See Disagrees.
	EnvironmentSlug string

	// ProjectID and OrganizationID are the recorded UUIDs, empty when there
	// is no binding or it carried none. An ID survives a rename that a slug
	// does not, which is why they are carried at all -- see
	// fetchProjectContext for where they are preferred.
	ProjectID      string
	OrganizationID string

	// ProjectName and OrganizationName are the recorded display names,
	// which `circleci project link` populates from the API when it can.
	// Advisory only: CircleCI's own project record supersedes them the
	// moment it arrives, the same rule this file applies to the slug.
	ProjectName      string
	OrganizationName string

	// Binding is the full binding result, including the absent and malformed
	// states, so a caller can explain itself.
	Binding ProjectBindingResult
}

// Disagrees reports whether the recorded binding and the injected environment
// name different projects.
//
// True is the interesting case and is exactly issue #198's symptom seen from the
// inside: a repository renamed on the VCS side leaves the remote (and therefore
// the CLI's derived environment) naming a repository that no longer exists,
// while the recorded binding still names the project. The binding wins -- but
// silently preferring it would throw away the single most diagnostic fact
// available, so callers say so instead.
func (i ProjectIdentity) Disagrees() bool {
	return i.Source == ProjectIdentityFromBinding &&
		i.EnvironmentSlug != "" &&
		i.EnvironmentSlug != i.Slug
}

// ResolveProjectIdentity applies the precedence documented on ProjectIdentity.
//
// A malformed binding deliberately does *not* stop the environment being used:
// falling back is the right behaviour (the editor should keep working), and what
// must not happen is falling back *silently*. The malformed status travels along
// in Binding for every caller that renders or reports this identity.
func ResolveProjectIdentity(env Environment, binding ProjectBindingResult) ProjectIdentity {
	identity := ProjectIdentity{
		EnvironmentSlug: env.ProjectSlug(),
		Binding:         binding,
	}

	if b := binding.Binding; b != nil {
		identity.ProjectID = b.ProjectID
		identity.OrganizationID = b.OrganizationID
		identity.ProjectName = b.ProjectName
		identity.OrganizationName = b.OrganizationName
		if slug := b.EffectiveSlug(); slug != "" {
			identity.Slug = slug
			identity.Source = ProjectIdentityFromBinding
			return identity
		}
	}

	if identity.EnvironmentSlug != "" {
		identity.Slug = identity.EnvironmentSlug
		identity.Source = ProjectIdentityFromEnvironment
	}
	return identity
}

// OrgSlug returns the "<vcs>/<org>" owner slug implied by this identity, for the
// organization-scoped lookups (contexts) that have no project to key off.
//
// Derived from Slug rather than from the environment when the binding won, so
// the organization and the project cannot come from different sources. Empty for
// an ID-addressed `circleci/<orgID>/<projectID>` slug, whose middle segment is an
// organization *ID* and not part of any owner slug -- callers have
// OrganizationID for that case, which is the better key anyway.
func (i ProjectIdentity) OrgSlug() string {
	segments := strings.Split(i.Slug, "/")
	if len(segments) != 3 {
		return ""
	}
	vcs := CanonicalVCSSegment(segments[0])
	if vcs == "" || vcs == "circleci" || segments[1] == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s", vcs, segments[1])
}

// uuidLength and uuidHyphenPositions describe the canonical 8-4-4-4-12 form.
const uuidLength = 36

var uuidHyphenPositions = [4]int{8, 13, 18, 23}

// looksLikeUUID reports whether s has the shape of a canonical UUID.
//
// This is a *guard*, not validation, and it exists because of one observed API
// behaviour: `GET /api/v3/projects/{id}/settings` answers **HTTP 400**
// (`invalid_path_param`, "The value provided is not a valid UUID") rather than
// 404 for an id that is not one -- verified against the live API. The CLI's own
// `gitremote.ProjectInfo` warns that a recorded ID's "form is whatever link
// persisted (a UUID, or a compact base62 ID); consumers that need a UUID must
// parse and fall back on failure", so a recorded ID really can be the other
// shape. Sending it anyway would turn "we have no project ID" into a 400 the
// user cannot act on, reported as "the CircleCI API returned an unexpected
// status" -- which is precisely the uninformative message issue #150 was about.
func looksLikeUUID(s string) bool {
	if len(s) != uuidLength {
		return false
	}
	for i := range uuidHyphenPositions {
		if s[uuidHyphenPositions[i]] != '-' {
			return false
		}
	}
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '-':
			if i != uuidHyphenPositions[0] && i != uuidHyphenPositions[1] &&
				i != uuidHyphenPositions[2] && i != uuidHyphenPositions[3] {
				return false
			}
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}
