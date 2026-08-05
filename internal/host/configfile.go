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
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ErrConfigNotFound is returned by FindConfigFile when no existing
// .circleci/config.yml (or config.yaml) could be located by walking up from
// the start directory. Callers may still use the returned ConfigFile's Path
// to offer creating a new config file there.
var ErrConfigNotFound = errors.New("host: no .circleci/config.yml found")

// configFileNames lists the file names checked, in order of preference,
// inside a candidate .circleci directory.
var configFileNames = []string{"config.yml", "config.yaml"}

// defaultConfigRelPath is the path (relative to a project root) used when no
// existing config file can be found.
const defaultConfigRelPath = ".circleci/config.yml"

// ConfigFile identifies the location of a CircleCI config file on disk.
type ConfigFile struct {
	// Path is the absolute path to the config file.
	Path string
}

// FindConfigFile locates the CircleCI config file to edit.
//
// If explicitPath is non-empty, it is used directly (made absolute relative
// to startDir if it is not already absolute); no existence check is
// performed on that path here.
//
// Otherwise, FindConfigFile walks upward from startDir looking for
// .circleci/config.yml or .circleci/config.yaml. The walk stops as soon as a
// match is found, or after checking the directory containing a .git entry
// (inclusive), or upon reaching the filesystem root.
//
// If no existing config file is found, FindConfigFile returns a ConfigFile
// whose Path is <startDir>/.circleci/config.yml together with
// ErrConfigNotFound, so callers can still offer to create the file there.
func FindConfigFile(startDir, explicitPath string) (ConfigFile, error) {
	if explicitPath != "" {
		abs := explicitPath
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(startDir, abs)
		}
		return ConfigFile{Path: filepath.Clean(abs)}, nil
	}

	origin, err := filepath.Abs(startDir)
	if err != nil {
		return ConfigFile{}, fmt.Errorf("host: resolve start directory: %w", err)
	}

	dir := origin
	for {
		for _, name := range configFileNames {
			candidate := filepath.Join(dir, ".circleci", name)
			if fileExists(candidate) {
				return ConfigFile{Path: candidate}, nil
			}
		}

		isRepoRoot := dirExists(filepath.Join(dir, ".git"))

		parent := filepath.Dir(dir)
		if isRepoRoot || parent == dir {
			break
		}
		dir = parent
	}

	// Nothing found anywhere along the walk: fall back to a default path
	// under the original start directory, not wherever the walk stopped.
	return ConfigFile{Path: filepath.Join(origin, defaultConfigRelPath)}, ErrConfigNotFound
}

// fileExists reports whether path exists and is a regular file (or at least
// not a directory).
func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// dirExists reports whether path exists and is a directory.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// RefuseEscapingPrimarySymlink is the primary-config counterpart of
// resolveIndexedPath's containment check, for the one file that check never
// covers: the server's own primary configFile, which resolveConfigTarget
// hands back for a request with no `?path=` *without* ever consulting
// ListConfigDir or resolveIndexedPath at all (that early return is the
// whole reason the primary file exists as a concept -- it is "the" config
// even before a `.circleci` directory exists to index).
//
// If c.Path does not exist, or exists but is not a symlink, there is
// nothing to refuse and this returns nil -- the common case, costing one
// extra Lstat. If it is a symlink, its fully-resolved target must land
// inside root or this returns a descriptive error that the caller is
// expected to surface as-is (it is written to be read on screen, not just
// logged): a refusal in this codebase has always had to explain itself
// rather than look like breakage, and "the editor won't open my config" is
// exactly the kind of thing a user needs the *reason* for.
//
// root is the repository root -- the directory containing `.circleci`, not
// `.circleci` itself -- deliberately wider than resolveIndexedPath's own
// boundary. Symlinking a config that is shared across a monorepo's several
// projects is a legitimate pattern (a `.circleci/config.yml` that points at
// `../../shared/config.yml`, say), and narrowing this to `.circleci` would
// refuse that alongside the actual attack, which is a symlink escaping the
// repository entirely. See ListConfigDir's own doc comment for the sibling
// decision on secondary files, which stays intentionally narrower than this
// one: every *other* file this host serves is already required to live
// inside the indexed `.circleci` directory to be reachable at all, so there
// is no equivalent monorepo case to protect there.
//
// Callers must only invoke this for a primary path that was *discovered* by
// walking up from a start directory (FindConfigFile with no explicitPath).
// An explicit `--config` value is the user naming that exact file
// themselves -- consent, not an escape this function has any business
// second-guessing -- and may legitimately sit outside any repository, or be
// a symlink to one, without that ever being this host's concern.
func (c ConfigFile) RefuseEscapingPrimarySymlink(root string) error {
	// #nosec G703 -- gosec's taint analysis flags c.Path here because this
	// method is exported and ConfigFile.Path is a public field: from the
	// analyzer's view, any caller could construct one with an arbitrary
	// string (and, concretely, this one specific caller's c.Path traces
	// back to `--config`, i.e. a command-line argument). That is real
	// provenance, not a false positive to wave away -- but this Lstat is
	// not a bypass of the check gosec wants; it *is* the check, or at
	// least its unavoidable first step. Whether c.Path is even a symlink
	// cannot be known -- let alone validated against root below -- without
	// asking the filesystem first; there is no already-validated form of
	// the path this could run on instead. Lstat also neither follows the
	// link nor reads any content, so nothing is disclosed by this call in
	// isolation: the disclosure this function exists to prevent only
	// happens if a later line lets an escaping target through, which the
	// containment comparison a few lines down is what actually stops.
	lst, err := os.Lstat(c.Path)
	if err != nil || lst.Mode()&fs.ModeSymlink == 0 {
		// Missing entirely (nothing written yet -- ConfigFile.Read's own
		// fs.ErrNotExist handling takes it from here) or an ordinary file:
		// either way there is no symlink target to evaluate.
		return nil
	}

	// #nosec G703 -- root is flagged for the identical structural reason
	// as c.Path above (an exported method's parameter). Resolving it
	// establishes one side of the containment boundary this function
	// checks against; it is not a sink that discloses anything about
	// root's contents, and it cannot be skipped, since the comparison
	// below needs root in the same fully-resolved form as target for
	// "inside root" to mean anything at all.
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		// The repository root itself failing to resolve is not this
		// function's problem to diagnose -- fall back to its lexical form
		// so the containment check below still has something to compare
		// against, erring toward refusing rather than silently trusting a
		// root it could not verify.
		resolvedRoot = root
	}
	resolvedRoot = filepath.Clean(resolvedRoot)

	// #nosec G703 -- resolving c.Path's target is the other half of the
	// same containment check the Lstat above starts: knowing *where* the
	// symlink points is exactly what the target == resolvedRoot /
	// strings.HasPrefix comparison below decides on. This is the
	// validation itself, not a read of the target's content --
	// EvalSymlinks only follows the link chain to a path string, and if
	// that string escapes root this function returns an error before
	// anything else in this package ever opens the file it names.
	target, err := filepath.EvalSymlinks(c.Path)
	if err != nil {
		return fmt.Errorf(
			"host: %s is a symlink that could not be resolved: %w; refusing to open it",
			c.Path, err,
		)
	}

	if target == resolvedRoot || strings.HasPrefix(target, resolvedRoot+string(filepath.Separator)) {
		return nil
	}

	return fmt.Errorf(
		"host: %s is a symlink to %s, which is outside the repository (%s); refusing to open it",
		c.Path, target, root,
	)
}

// Read returns the contents of the config file. If the file does not exist,
// Read returns exists=false and a nil error rather than an error.
//
// The read is capped at maxIndexedFileBytes (configdir.go's own limit for
// GET /api/config-files' inlined contents -- reused rather than duplicated,
// so the two endpoints can never quietly disagree on how much of a file they
// are willing to hand back). Before this cap existed, this was the one read
// path host package had with no size limit at all: GET /api/config?path=
// reaches it directly, and combined with a symlink resolving to a device
// file (already excluded from the directory listing by ListConfigDir, but
// still reachable if c.Path is the server's own primary config path, which
// bypasses that listing entirely) an unbounded os.ReadFile is an unbounded
// read. The cap is enforced against bytes actually read, not a stat'd size,
// because a character device such as /dev/zero commonly reports size 0 while
// still yielding unlimited bytes on read.
func (c ConfigFile) Read() (contents string, exists bool, err error) {
	f, err := os.Open(c.Path) // #nosec G304 -- path is either FindConfigFile's own result, or one already validated by resolveIndexedPath/ListConfigDir (both of which resolve symlink targets and re-check containment); never raw user input.
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("host: read config file: %w", err)
	}
	defer func() { _ = f.Close() }()

	// Read one byte past the cap so a file that is exactly maxIndexedFileBytes
	// long is accepted while one byte over is caught -- io.ReadAll
	// stops exactly at the LimitReader's bound with no error of its own, so
	// the only way to tell "fit" from "truncated" apart is to ask for one more
	// byte than the limit and check what came back.
	data, err := io.ReadAll(io.LimitReader(f, maxIndexedFileBytes+1))
	if err != nil {
		return "", false, fmt.Errorf("host: read config file: %w", err)
	}
	if len(data) > maxIndexedFileBytes {
		return "", true, fmt.Errorf("host: read config file: exceeds %d byte limit", maxIndexedFileBytes)
	}
	return string(data), true, nil
}

// Write atomically replaces the contents of the config file, creating the
// parent .circleci directory (mode 0o755) if it does not already exist. The
// file is written via a temporary file in the same directory followed by a
// rename, so readers never observe a partially written file. The mode of an
// existing file is preserved; new files are created with mode 0o644.
//
// Write returns the number of bytes written on success.
func (c ConfigFile) Write(contents string) (int, error) {
	dir := filepath.Dir(c.Path)

	mode := os.FileMode(0o644)
	if info, err := os.Stat(c.Path); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return 0, fmt.Errorf("host: stat config file: %w", err)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // 0o755 matches typical repo directory permissions.
		return 0, fmt.Errorf("host: create config directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".config-*.yml.tmp")
	if err != nil {
		return 0, fmt.Errorf("host: create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	// cleanup removes the temp file; it is a no-op once the rename below
	// succeeds because the file will no longer exist at tmpPath.
	cleanup := func() {
		_ = os.Remove(tmpPath)
	}

	n, err := tmp.WriteString(contents)
	if err != nil {
		_ = tmp.Close()
		cleanup()
		return 0, fmt.Errorf("host: write temp file: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return 0, fmt.Errorf("host: sync temp file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		cleanup()
		return 0, fmt.Errorf("host: close temp file: %w", err)
	}

	if err := os.Chmod(tmpPath, mode); err != nil { //nolint:gosec // tmpPath is our own os.CreateTemp output, not user input.
		cleanup()
		return 0, fmt.Errorf("host: chmod temp file: %w", err)
	}

	if err := os.Rename(tmpPath, c.Path); err != nil { //nolint:gosec // tmpPath is our own os.CreateTemp output, not user input.
		cleanup()
		return 0, fmt.Errorf("host: rename temp file: %w", err)
	}

	return n, nil
}
