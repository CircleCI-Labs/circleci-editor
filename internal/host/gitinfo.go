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
	"context"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// gitCommandTimeout bounds each `git` invocation below. GET /api/meta is on
// the app's load path, so a git that hangs (a network-backed filesystem, a
// credential helper waiting on a prompt) must degrade to "no git info" rather
// than to a top bar that never appears.
const gitCommandTimeout = 2 * time.Second

// GitInfo is what the *checkout* says about itself, as opposed to what the
// CircleCI CLI's injected environment claims (see Environment).
//
// Issue #214 asked for the current branch and a link to the repository on the
// VCS host. The branch is available two ways that can disagree — CIRCLE_BRANCH
// from the injected environment, and the checkout's actual HEAD — and the
// checkout wins: the user is editing *this* working tree, so a stale injected
// value would be worse than none. Both are reported so the frontend can say
// which one it is showing when they differ, rather than silently picking.
//
// Everything here is best-effort and empty on failure. `git` may not be
// installed, the directory may not be a checkout at all (editing a config
// outside a repository is an ordinary thing to do — see issue #149's "not a
// CircleCI project" state), and HEAD may be detached. None of those is an
// error worth reporting: they are all "there is nothing to show".
type GitInfo struct {
	// Branch is the checked-out branch name, from `git symbolic-ref --short
	// HEAD`. Empty when HEAD is detached, when this is not a checkout, or
	// when git could not be run.
	//
	// Deliberately `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`:
	// the latter reports the literal string "HEAD" for a detached head, which
	// would be displayed as if it were a branch called HEAD.
	Branch string

	// RemoteURL is a browsable https URL for the `origin` remote's
	// repository, e.g. https://github.com/acme/web. Empty when there is no
	// origin, when its URL is a local path, or when its host is not one whose
	// web layout this code knows (see webBrowsableGitHosts) — the same rule
	// Environment.ProjectWebURLForSlug already applies to CircleCI's own URLs:
	// a link that cannot work is worse than no link.
	//
	// Any credentials embedded in the remote URL are dropped. A remote of
	// https://x-access-token:ghs_...@github.com/acme/web is entirely ordinary
	// in a CI checkout, and this value is sent to the browser.
	RemoteURL string

	// RemoteRepo is the "<owner>/<repo>" path the origin remote points at,
	// with any `.git` suffix removed. Reported even when RemoteURL is empty
	// (an unrecognised host still has a legible path), and never presented as
	// authoritative: issue #198 documented that a remote can be stale after a
	// repository rename, so this is what the checkout is *configured* to push
	// to, not what CircleCI calls the project.
	RemoteRepo string

	// RemoteHost is the remote's hostname ("github.com", "bitbucket.org", a
	// self-hosted "github.example.com"), for naming the destination in a
	// tooltip without pretending to know the provider's brand.
	RemoteHost string
}

// webBrowsableGitHosts decides whether a git remote's host serves a web UI at
// `https://<host>/<owner>/<repo>`.
//
// Substring matching on a lower-cased host, which is CircleCI's own CLI rule
// for the same problem (see CanonicalVCSSegment): a self-hosted instance is
// spelled "github.example.com". Only these three are recognised because only
// these three have a layout this code has any grounds to assume; a remote on
// "git.internal.example" gets RemoteRepo but no URL.
var webBrowsableGitHosts = []string{"github", "bitbucket", "gitlab"}

func isWebBrowsableGitHost(host string) bool {
	h := strings.ToLower(host)
	for _, known := range webBrowsableGitHosts {
		if strings.Contains(h, known) {
			return true
		}
	}
	return false
}

// LoadGitInfo reads what dir's checkout says about itself. Never returns an
// error: every failure mode is an empty field (see GitInfo).
func LoadGitInfo(dir string) GitInfo {
	if dir == "" {
		return GitInfo{}
	}
	// Checked once so a machine without git runs no subprocesses at all,
	// rather than two that both fail.
	if _, err := exec.LookPath("git"); err != nil {
		return GitInfo{}
	}

	info := GitInfo{Branch: gitOutput(dir, "symbolic-ref", "--quiet", "--short", "HEAD")}
	remote := gitOutput(dir, "config", "--get", "remote.origin.url")
	if remote == "" {
		return info
	}
	host, repo := parseGitRemote(remote)
	info.RemoteHost = host
	info.RemoteRepo = repo
	if host != "" && repo != "" && isWebBrowsableGitHost(host) {
		info.RemoteURL = "https://" + host + "/" + repo
	}
	return info
}

// gitOutput runs `git <args...>` in dir and returns its trimmed stdout, or ""
// if it failed for any reason (not a repository, no such config key, detached
// HEAD, timeout).
func gitOutput(dir string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), gitCommandTimeout)
	defer cancel()

	// #nosec G204 -- the program name and every argument are literals chosen by
	// this file; only the working directory varies, and it is a path this
	// process already resolved (not a shell string).
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// A credential helper or an editor prompt would otherwise be able to block
	// until the timeout; nothing here needs a terminal.
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// parseGitRemote splits a git remote URL into its host and its
// "<owner>/<repo>" path, returning empty strings for anything that is not a
// remote on a network host.
//
// Handles the three spellings git itself accepts for a hosted remote:
//
//	git@github.com:acme/web.git            (scp-like, the default for SSH)
//	ssh://git@github.com/acme/web.git      (explicit scheme)
//	https://github.com/acme/web.git        (and http://, with or without creds)
//
// A local path or a file:// URL yields nothing: there is no web page to open.
func parseGitRemote(remote string) (host string, repo string) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", ""
	}

	// scp-like syntax has no scheme and puts the path after a colon. Detected
	// by "there is a colon before any slash", which is what distinguishes
	// `git@host:path` from `https://host/path` and from a Windows drive path
	// (`C:\...`, whose remainder has no owner/repo shape and is rejected below).
	if !strings.Contains(remote, "://") {
		at := strings.LastIndex(remote, "@")
		colon := strings.Index(remote[at+1:], ":")
		if colon < 0 {
			return "", ""
		}
		hostPart := remote[at+1:][:colon]
		pathPart := remote[at+1:][colon+1:]
		return normalizeGitHost(hostPart), normalizeGitRepoPath(pathPart)
	}

	u, err := url.Parse(remote)
	if err != nil {
		return "", ""
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "ssh", "git":
	default:
		// file://, and anything else that is not a network remote.
		return "", ""
	}
	// u.Hostname() drops both the userinfo and the port, which is exactly what
	// must not reach the browser (see GitInfo.RemoteURL).
	return normalizeGitHost(u.Hostname()), normalizeGitRepoPath(u.Path)
}

func normalizeGitHost(host string) string {
	host = strings.TrimSpace(host)
	// Defensive: a scp-like remote's host part could still carry userinfo if
	// the address contained more than one "@".
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if strings.ContainsAny(host, "/\\ ") || !strings.Contains(host, ".") {
		return ""
	}
	return host
}

// normalizeGitRepoPath reduces a remote's path to "<owner>/<repo>", or ""
// when it does not have that shape.
//
// Deeper paths are kept whole rather than truncated to their first two
// segments: a self-hosted GitLab remote is genuinely `group/subgroup/repo`,
// and that *is* the browsable path.
func normalizeGitRepoPath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), "/")
	path = strings.TrimSuffix(path, ".git")
	path = strings.Trim(path, "/")
	if path == "" || strings.Contains(path, "\\") || strings.Contains(path, " ") {
		return ""
	}
	segments := strings.Split(path, "/")
	if len(segments) < 2 {
		return ""
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return ""
		}
	}
	return path
}
