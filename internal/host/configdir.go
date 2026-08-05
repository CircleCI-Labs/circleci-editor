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
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// maxIndexedFileBytes bounds how large a file's contents this host will
// ever hand back over GET /api/config-files?contents=1. A `.circleci`
// directory can legitimately contain a large generated/vendored config;
// this is not a correctness limit (the file is still listed, just without
// its contents) so a caller (the AI directory-context assembler, issue
// #102) can report it as "present but skipped: too large" rather than the
// host silently sending an enormous response over localhost.
const maxIndexedFileBytes = 2 << 20 // 2 MiB

// configDirFileExtensions lists the extensions ListConfigDir will index at
// all. Matches the pair FindConfigFile itself already prefers
// (configFileNames), generalized to any file in the directory, not just the
// top-level config.
//
// This is the *indexing* filter, not the classification: whether an indexed
// file is actually a CircleCI config is ClassifyConfigContents' job (issue
// #135), decided from its structure rather than its name.
var configDirFileExtensions = []string{".yml", ".yaml"}

// ConfigDirEntry describes one YAML file found under a directory indexed by
// ListConfigDir.
type ConfigDirEntry struct {
	// Path is the absolute path to the file.
	Path string
	// RelPath is Path relative to the indexed directory, using forward
	// slashes regardless of OS (so the same relative path displays
	// identically in the browser UI on every platform).
	RelPath string
	// Size is the file's size in bytes.
	Size int64
}

// hasConfigDirExtension reports whether name ends in one of
// configDirFileExtensions, case-sensitively -- matching configFileNames'
// own case sensitivity, since CircleCI itself only ever looks for a
// lowercase `config.yml`/`config.yaml`.
func hasConfigDirExtension(name string) bool {
	for _, ext := range configDirFileExtensions {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	return false
}

// circleCIConfigKeys lists the top-level keys that, on their own, identify
// a file as a CircleCI config (issue #135). Every one of them is a key the
// CircleCI config schema defines at the top level and that no other common
// tool's YAML puts there.
//
// `commands` is the sharp edge of this list, and the reason every lookup
// below matches keys *exactly*, never by prefix or substring: goss -- the
// server-validation tool whose `goss.yaml` prompted this issue -- has a
// top-level `command:` block of its own. Singular versus plural is the only
// thing that distinguishes goss's key from CircleCI's, so a "starts with
// command" test would classify every goss file in every `.circleci`
// directory as a config.
//
// `parameters` is deliberately absent: it is far too generic (goss, Ansible,
// CloudFormation, countless generators all use it) to carry the decision on
// its own. It still comes along for free in any real config, which will have
// `jobs`/`workflows`/`version` too.
//
// `job-groups` was added by issue #220. It qualifies on exactly the terms the
// rest of this list does -- the config schema defines it at the top level
// (internal/schema/schema.json), CircleCI's own configuration reference
// documents it, and no other common tool puts a hyphenated `job-groups` at the
// root of a YAML file. Its absence was visible in two places: a config
// fragment whose only CircleCI key is `job-groups:` was classified as "not a
// config", and the user-facing reason string enumerates this list verbatim, so
// it also *told* the user that `job-groups` was not a CircleCI key.
var circleCIConfigKeys = []string{"jobs", "workflows", "orbs", "executors", "commands", "setup", "job-groups"}

// circleCIConfigVersions lists the accepted values of a top-level
// `version:` key. Compared against the YAML scalar's own source text, which
// makes the number/string distinction irrelevant: unquoted `2.1` parses as
// a float and quoted `"2.1"` as a string, but yaml.v3 preserves `2.1` as
// the node's value either way.
var circleCIConfigVersions = []string{"2", "2.0", "2.1"}

// ConfigClassification records whether one indexed `.yml`/`.yaml` file
// structurally looks like a CircleCI config, and the human-readable reason
// for that verdict.
//
// The reason travels on GET /api/config-files so the UI can state the
// host's actual reason instead of re-deriving one that could drift from it
// (issue #135). Reasons are complete sentences, phrased to be shown as-is
// after a file name.
type ConfigClassification struct {
	// IsConfig is true when the file looks like a CircleCI config.
	IsConfig bool
	// Reason explains the verdict, e.g. "Declares version: 2.1." or "No
	// CircleCI structure: ...".
	Reason string
}

// Reasons for the three classifications that are decided by a file's
// circumstances rather than by its contents. Each biases deliberately:
//
//   - The primary file is *always* a config, whatever is in it. It is the
//     file this host opened and every pre-#106 API already acts on; hiding
//     it from its own switcher (a brand-new, still-empty `config.yml`
//     would otherwise classify as "empty") would be absurd.
//   - A file too large to inspect is treated as a config. A multi-megabyte
//     YAML in `.circleci/` is overwhelmingly a generated or vendored
//     config, and being wrong in that direction only costs a listed row.
//   - A file that cannot be read is not treated as a config, since there is
//     nothing to support the claim that it is. It stays listed and
//     revealable, so nothing becomes unreachable either way.
const (
	primaryFileConfigReason  = "The config file this editor opened; always treated as a config."
	unreadableFileNotAConfig = "Could not be read, so it is not treated as a config."
)

// oversizeFileConfigReason is built from maxIndexedFileBytes rather than
// spelling the number out, so the size the UI quotes cannot drift from the
// cap actually being applied.
var oversizeFileConfigReason = fmt.Sprintf(
	"Too large to inspect (over %d MiB); listed as a config rather than hidden.",
	maxIndexedFileBytes>>20,
)

// classifyIndexedEntry answers "is this listed file a CircleCI config, and
// why" for one entry of GET /api/config-files, folding the circumstantial
// cases (see the reason constants above) in around
// ClassifyConfigContents' structural test.
func classifyIndexedEntry(isPrimary bool, size int64, contents string, haveContents bool) (bool, string) {
	switch {
	case isPrimary:
		return true, primaryFileConfigReason
	case size > maxIndexedFileBytes:
		return true, oversizeFileConfigReason
	case !haveContents:
		return false, unreadableFileNotAConfig
	default:
		c := ClassifyConfigContents(contents)
		return c.IsConfig, c.Reason
	}
}

// ClassifyConfigContents decides whether contents is a CircleCI config by
// looking for structural telltales, and never by whether the file is
// *valid*. That distinction is the whole point (issue #135): a continuation
// config committed for a setup workflow to select is legitimately not valid
// on its own -- it can lack `version:` entirely, and compiling it
// standalone fails for reasons that are not the user's problem. Issue #106
// already records that asymmetry and the "Not independently valid" wording
// it drives; gating this listing on validity would hide real configs while
// doing nothing structural inspection cannot do better.
//
// A file is a config when either:
//
//  1. it has a top-level `version:` of 2, 2.0 or 2.1 (which admits an
//     otherwise-sparse setup config), or
//  2. it has at least one top-level key from circleCIConfigKeys (which
//     admits a continuation config that has `jobs:`/`workflows:` but no
//     `version:` at all).
//
// ...unless it first matches one of foreignToolShape's two exactly-keyed
// exclusions.
//
// Parsing here is strictly read-only: it inspects a yaml.Node tree and
// never re-emits, reformats or writes anything -- the YAML document is the
// single source of truth and is never regenerated.
//
// Unparseable YAML is simply not a config -- deliberately not an error.
// One malformed file must never fail the whole directory listing, because
// that listing is what the file switcher renders.
func ClassifyConfigContents(contents string) ConfigClassification {
	if strings.TrimSpace(contents) == "" {
		return ConfigClassification{Reason: "The file is empty."}
	}

	// Decoding into a yaml.Node rather than a map is what keeps this
	// tolerant: a node tree accepts duplicate keys, anchors and unknown
	// tags that decoding into a Go map would reject, so "this parses, and
	// here are its top-level keys" stays answerable for files a stricter
	// decode would refuse.
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(contents), &doc); err != nil {
		return ConfigClassification{Reason: "Not parseable as YAML."}
	}

	root := documentRoot(&doc)
	if root == nil || root.Kind != yaml.MappingNode {
		return ConfigClassification{Reason: "Its top level is not a YAML mapping."}
	}

	keys := topLevelKeys(root)
	matched := matchedCircleCIKeys(keys)

	if reason, foreign := foreignToolShape(keys, matched); foreign {
		return ConfigClassification{Reason: reason}
	}

	if version, ok := keys["version"]; ok && isCircleCIConfigVersion(version) {
		return ConfigClassification{
			IsConfig: true,
			Reason:   fmt.Sprintf("Declares version: %s.", version),
		}
	}

	if len(matched) > 0 {
		return ConfigClassification{
			IsConfig: true,
			Reason:   fmt.Sprintf("Has CircleCI top-level keys: %s.", strings.Join(matched, ", ")),
		}
	}

	return ConfigClassification{
		Reason: fmt.Sprintf(
			"No CircleCI structure: no top-level version: 2, 2.0 or 2.1, and none of %s.",
			strings.Join(circleCIConfigKeys, ", "),
		),
	}
}

// matchedCircleCIKeys returns the circleCIConfigKeys present in keys, in
// circleCIConfigKeys' own order so the reason string is stable.
func matchedCircleCIKeys(keys map[string]string) []string {
	matched := make([]string, 0, len(circleCIConfigKeys))
	for _, key := range circleCIConfigKeys {
		if _, ok := keys[key]; ok {
			matched = append(matched, key)
		}
	}
	return matched
}

// foreignToolShape recognises the two other tools whose YAML would
// otherwise satisfy the rule above, and is checked *before* it. Both tests
// key off exact top-level keys a CircleCI config never has, so neither can
// reject a real one:
//
//   - A GitHub Actions workflow has a top-level `jobs:` -- a CircleCI key --
//     so it needs the `on:` trigger block alongside it to be ruled out.
//     (`on` stays a plain string key in yaml.v3, not a YAML 1.1 boolean.)
//   - A Docker Compose file of the v2 era declares `version: "2.1"`, which
//     would satisfy the version rule outright. Its `services:` key is the
//     tell, and is only trusted when no CircleCI key is present at all, so
//     a genuine config that happens to define `services` somewhere is
//     unaffected -- CircleCI has no top-level `services:`.
//
// Nothing beyond these two: `name:`/`runs-on:`/`image:` sniffing would
// start guessing, and the point of the whole rule is that it does not.
func foreignToolShape(keys map[string]string, matchedCircleCI []string) (string, bool) {
	_, hasOn := keys["on"]
	_, hasJobs := keys["jobs"]
	if hasOn && hasJobs {
		return "Looks like a GitHub Actions workflow: a top-level on: trigger alongside jobs:.", true
	}

	if _, hasServices := keys["services"]; hasServices && len(matchedCircleCI) == 0 {
		return "Looks like a Docker Compose file: a top-level services: block and no CircleCI keys.", true
	}

	return "", false
}

// documentRoot returns the root value node of a parsed YAML document, or
// nil when there is none (an all-comments file parses successfully to a
// node with no content at all). Only the first document is considered: a
// CircleCI config is always a single document, and a multi-document file's
// later documents cannot change what the first one is.
func documentRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return nil
		}
		return doc.Content[0]
	}
	return doc
}

// topLevelKeys returns the scalar keys of a top-level mapping, mapped to
// their value's own scalar text (empty for a nested mapping or sequence
// value, which is all the caller needs -- only `version:`'s value matters).
//
// A top-level YAML merge key (`<<: *anchor`) is not expanded: its keys are
// not reported. That is an accepted limitation, not an oversight -- a real
// config that leans on a top-level merge still spells out `version:` or
// `jobs:` literally, so it is classified correctly anyway.
func topLevelKeys(mapping *yaml.Node) map[string]string {
	keys := make(map[string]string, len(mapping.Content)/2)
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		key, value := mapping.Content[i], mapping.Content[i+1]
		if key.Kind != yaml.ScalarNode {
			continue
		}
		keys[key.Value] = value.Value
	}
	return keys
}

// isCircleCIConfigVersion reports whether a top-level `version:` value is
// one this editor recognises as a CircleCI config version.
func isCircleCIConfigVersion(value string) bool {
	for _, v := range circleCIConfigVersions {
		if value == v {
			return true
		}
	}
	return false
}

// ListConfigDir walks dir (recursively) and returns every `.yml`/`.yaml`
// file found, sorted by RelPath for a stable, deterministic listing. It
// returns an empty, nil-error slice if dir does not exist (the common case
// before a first save creates a `.circleci` directory at all -- ConfigFound
// already tracks whether *any* config file was found, this just mustn't
// itself turn "no directory yet" into an error).
//
// Symlinked *directories* are never descended into -- that much genuinely is
// filepath.WalkDir's own default (fs.DirEntry.IsDir on a symlink reports the
// link itself, not its target, so WalkDir treats it as a leaf). A symlinked
// *directory* named `.circleci` therefore is not indexed, matching "scoped to
// the .circleci folder" (issue #106's own framing).
//
// A symlinked *file*, however, is not covered by that default at all: it is
// walked exactly like an ordinary entry, and an earlier version of this
// comment claimed otherwise. This function closes that gap itself, rather
// than relying on any implicit behaviour from WalkDir: each symlinked file is
// resolved with filepath.EvalSymlinks and excluded from the listing -- not
// merely left unreadable -- when the resolved target escapes dir, is itself
// a directory, or the symlink is broken. "Excluded from the listing" matters
// because this function is also resolveIndexedPath's allowlist: a file it
// never reports can never be opened via ?path=, deliberately-crafted request
// or not.
//
// The alternative design -- listing a symlinked file whenever its target
// happens to still be inside dir -- was considered and rejected in favor of
// following the target's containment, which is what's implemented: a
// same-directory symlink (e.g. one continuation config aliasing another) is
// harmless and stays listed, while one that reaches outside dir is excluded
// outright. A future change must not "simplify" this back to trusting the
// symlink's own lexical path -- that lexical trust is the vulnerability this
// comment used to (wrongly) claim didn't exist.
//
// Also deliberately *not* depth-limited, which issue #135 asked to
// reconsider (a `.circleci/` with nested tool directories is a real shape,
// and every YAML inside them is noise). Two reasons the descent stays
// unbounded:
//
//   - This listing is also the allowlist resolveIndexedPath enforces, so a
//     file it does not report cannot be opened at all -- not even
//     deliberately. A depth cap would therefore be an *unrecoverable*
//     filter, while a classification mistake costs one click in the
//     switcher's "other YAML files" reveal. Monorepo dynamic-config
//     layouts really do keep continuation configs a directory or two down.
//   - The noise the issue was actually filed about is answered at the right
//     layer by ClassifyConfigContents: what a file *contains*, not where it
//     sits. A nested `goss.yaml` is filtered out by content just as a
//     top-level one is.
//
// Entries are still reported with their full relative path, so a deeply
// nested file remains identifiable as such in the UI.
func ListConfigDir(dir string) ([]ConfigDirEntry, error) {
	var entries []ConfigDirEntry

	// #nosec G703 -- gosec's taint analysis cannot see that `dir` never
	// originates from a request. It is the `.circleci` directory the host
	// itself resolved at startup (ConfigFile.Dir, from configfile.go's
	// walk-up), and every request-supplied path is resolved *against* this
	// listing by resolveIndexedPath rather than being walked. Traversal is
	// prevented at that boundary, which is the one an attacker can reach;
	// widening this call's own input is not something a client can do.
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && path == dir {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !hasConfigDirExtension(d.Name()) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return infoErr
		}

		if info.Mode()&fs.ModeSymlink != 0 {
			resolved, resolveErr := resolveWithinDir(dir, path)
			if resolveErr != nil {
				// Broken symlink, a symlink loop, or (resolveWithinDir's own
				// job) a target outside dir: excluded from the listing
				// entirely rather than merely left unreadable -- see the
				// doc comment above for why that distinction matters here.
				return nil
			}
			// #nosec G703 -- resolved is filepath.EvalSymlinks' own output
			// for a path already proven (by resolveWithinDir, just above)
			// to be inside dir; gosec's taint analysis can't see that
			// proof, but nothing request-supplied reaches this Stat.
			targetInfo, statErr := os.Stat(resolved)
			if statErr != nil {
				return nil
			}
			if targetInfo.IsDir() {
				// A `.yml`/`.yaml`-named symlink whose target is a
				// directory is not a file this listing can serve; excluded
				// for the same reason a broken symlink is.
				return nil
			}
			// The target's real size governs the maxIndexedFileBytes cap
			// and classification below -- the symlink's own Lstat size is
			// just the length of the link text, not useful for either.
			info = targetInfo
		}

		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}

		entries = append(entries, ConfigDirEntry{
			Path:    path,
			RelPath: filepath.ToSlash(rel),
			Size:    info.Size(),
		})
		return nil
	})
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("host: list config directory: %w", err)
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].RelPath < entries[j].RelPath })
	return entries, nil
}

// resolveIndexedPath validates that requested (an absolute or
// startDir-relative path supplied by a client) is safe to read or write:
// it must resolve to a path lexically inside dir, and -- unless it is
// exactly allowedCreate (the server's own primary config path, which may
// not exist on disk yet -- see ConfigFile.Write) -- it must already be one
// of ListConfigDir's entries. This is what makes "never write to a file
// the user didn't open" (issue #106) and "a proposed action must never
// target a file that isn't the open one" (issue #102) true at the host's
// own boundary, not just by frontend convention: even a buggy or malicious
// client cannot use ?path= to read or write anything outside the indexed
// directory, nor create a brand-new file the directory listing never
// offered.
//
// The lexical check above is deliberately not the only one: it runs first,
// cheaply, to reject the common case (`..`, an absolute path elsewhere) with
// a plain string comparison, but a symlink can sit lexically inside dir while
// its target reads from anywhere on disk. Once a requested path matches one
// of ListConfigDir's own entries -- which by then have already excluded a
// symlink whose target escapes dir, see that function's doc comment -- this
// still re-resolves the match with resolveWithinDir before returning it. That
// second, independent filesystem read is what closes the TOCTOU window
// between ListConfigDir's read of the directory and this path actually being
// opened by the caller: a file swapped for an escaping symlink in between
// would otherwise pass on the strength of a listing that is, by then, stale.
func resolveIndexedPath(dir, requested, allowedCreate string) (string, error) {
	abs := requested
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(dir, abs)
	}
	abs = filepath.Clean(abs)

	cleanDir := filepath.Clean(dir)
	if abs != cleanDir && !strings.HasPrefix(abs, cleanDir+string(filepath.Separator)) {
		return "", fmt.Errorf("host: path %q is outside %q", requested, dir)
	}

	if abs == filepath.Clean(allowedCreate) {
		return abs, nil
	}

	entries, err := ListConfigDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.Path != abs {
			continue
		}
		if _, err := resolveWithinDir(dir, abs); err != nil {
			return "", fmt.Errorf("host: %q does not resolve inside %q: %w", requested, dir, err)
		}
		return abs, nil
	}
	return "", fmt.Errorf("host: %q is not an indexed config file", requested)
}

// resolveWithinDir resolves every symlink in both dir and path (via
// filepath.EvalSymlinks) and confirms path's fully-resolved target is still
// inside dir's own fully-resolved form -- the check that a purely lexical
// containment test (Clean + HasPrefix on the path's own spelling, as done
// above and in ListConfigDir) cannot perform: a symlink can sit lexically
// inside dir while its target reads from anywhere on disk.
//
// Returns an error for a broken symlink, a symlink loop, a dir that itself
// cannot be resolved, or a resolved target outside dir -- callers treat all
// four the same way (exclude / reject), so they are not distinguished here.
func resolveWithinDir(dir, path string) (string, error) {
	resolvedDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("host: resolve %q: %w", dir, err)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("host: resolve %q: %w", path, err)
	}
	resolvedDir = filepath.Clean(resolvedDir)
	if resolved != resolvedDir && !strings.HasPrefix(resolved, resolvedDir+string(filepath.Separator)) {
		return "", fmt.Errorf("host: %q resolves outside %q", path, dir)
	}
	return resolved, nil
}
