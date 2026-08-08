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

package host_test

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// clearCircleEnv unsets every CIRCLE_* variable LoadEnvironment reads, so
// each test starts from a clean slate regardless of the ambient environment
// (this binary may itself be running inside a CircleCI job).
func clearCircleEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"CIRCLE_TOKEN",
		// Cleared for the same reason as CIRCLE_TOKEN, and easy to forget: the
		// CircleCI CLI sets this for a plugin, so any test asserting "no token"
		// would silently pick one up when run under `circleci editor` -- or in
		// any environment that happens to export it.
		"CIRCLECI_TOKEN",
		"CIRCLE_HOST",
		"CIRCLE_PROJECT_ID",
		"CIRCLE_VCS_TYPE",
		"CIRCLE_PROJECT_USERNAME",
		"CIRCLE_PROJECT_REPONAME",
		"CIRCLE_BRANCH",
		"CIRCLE_DEFAULT_BRANCH",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadEnvironment_HostDefault(t *testing.T) {
	tests := []struct {
		name     string
		hostEnv  string
		wantHost string
	}{
		{name: "unset defaults to circleci.com", hostEnv: "", wantHost: "https://circleci.com"},
		{name: "explicit host is preserved", hostEnv: "https://circleci.example.com", wantHost: "https://circleci.example.com"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_HOST", tc.hostEnv)

			env := host.LoadEnvironment()
			assert.Equal(t, env.Host, tc.wantHost)
		})
	}
}

func TestEnvironment_HasToken(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		wantToken bool
	}{
		{name: "empty token", token: "", wantToken: false},
		{name: "present token", token: "sentinel-token-value", wantToken: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_TOKEN", tc.token)

			env := host.LoadEnvironment()
			assert.Equal(t, env.HasToken(), tc.wantToken)
		})
	}
}

// TestEnvironment_ProjectSlug pins the normalisation issue #182 introduced: the
// CLI injects the long VCS spelling, and every slug this host builds uses the
// short one the CircleCI CLI itself emits (gh/bb/gl) and the API reports back.
func TestEnvironment_ProjectSlug(t *testing.T) {
	tests := []struct {
		name     string
		vcsType  string
		org      string
		repo     string
		wantSlug string
	}{
		{name: "all present", vcsType: "github", org: "acme", repo: "widgets", wantSlug: "gh/acme/widgets"},
		{
			// The CLI's own mapping, in the CLI's own order.
			name: "bitbucket normalises to bb", vcsType: "bitbucket", org: "acme", repo: "widgets",
			wantSlug: "bb/acme/widgets",
		},
		{
			name: "gitlab normalises to gl", vcsType: "gitlab", org: "acme", repo: "widgets",
			wantSlug: "gl/acme/widgets",
		},
		{
			name: "an already-short spelling is left alone", vcsType: "gh", org: "acme", repo: "widgets",
			wantSlug: "gh/acme/widgets",
		},
		{
			// CircleCI capitalises vcs_provider, and a self-hosted remote host
			// is spelled github.example.com; the CLI matches by substring for
			// exactly these reasons, so this host does too.
			name: "matching is case- and suffix-insensitive", vcsType: "GitHub.example.com",
			org: "acme", repo: "widgets", wantSlug: "gh/acme/widgets",
		},
		{
			// GitLab and GitHub App projects. Nothing to shorten, and mangling
			// it would produce a spelling no API knows.
			name: "an unrecognised vcs type passes through", vcsType: "circleci",
			org: "acme", repo: "widgets", wantSlug: "circleci/acme/widgets",
		},
		{name: "missing repo", vcsType: "github", org: "acme", repo: "", wantSlug: ""},
		{name: "missing org", vcsType: "github", org: "", repo: "widgets", wantSlug: ""},
		{name: "missing vcs type", vcsType: "", org: "acme", repo: "widgets", wantSlug: ""},
		{name: "all missing", vcsType: "", org: "", repo: "", wantSlug: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_VCS_TYPE", tc.vcsType)
			t.Setenv("CIRCLE_PROJECT_USERNAME", tc.org)
			t.Setenv("CIRCLE_PROJECT_REPONAME", tc.repo)

			env := host.LoadEnvironment()
			assert.Equal(t, env.ProjectSlug(), tc.wantSlug)
		})
	}
}

// TestEnvironment_TokenFallsBackToCIRCLECI_TOKEN pins the fix for the bug that
// made running as a CLI plugin lose every token-gated feature: the CircleCI CLI
// passes its credentials to a plugin as CIRCLECI_TOKEN, and this host read only
// CIRCLE_TOKEN.
func TestEnvironment_TokenFallsBackToCIRCLECI_TOKEN(t *testing.T) {
	clearCircleEnv(t)
	t.Setenv("CIRCLECI_TOKEN", "from-the-cli")

	env := host.LoadEnvironment()
	assert.Assert(t, env.HasToken(), "the CLI's own variable must supply a token")
}

// TestEnvironment_CIRCLE_TOKEN_WinsOverCIRCLECI_TOKEN pins the precedence: the
// variable a user exports on purpose outranks the one they inherited.
func TestEnvironment_CIRCLE_TOKEN_WinsOverCIRCLECI_TOKEN(t *testing.T) {
	clearCircleEnv(t)
	t.Setenv("CIRCLECI_TOKEN", "from-the-cli")
	t.Setenv("CIRCLE_TOKEN", "exported-by-hand")

	env := host.LoadEnvironment()
	assert.Assert(t, env.HasToken())
	assert.Equal(t, env.Token, "exported-by-hand")
}

// TestEnvironment_NeitherTokenSet keeps the honest "no token" path intact, since
// the whole point of the banner warning is that it is accurate.
func TestEnvironment_NeitherTokenSet(t *testing.T) {
	clearCircleEnv(t)

	env := host.LoadEnvironment()
	assert.Assert(t, !env.HasToken())
}
