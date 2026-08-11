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
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// Issue #67: config validation used to compile without naming an
// organization, so CircleCI could consult neither the org's private orbs nor
// its URL orb allow-list. A config that compiles in CI came back
//
//	Orb https://.../go.yml is not permitted by the organization's URL orb allow-list.
//
// which is the worst thing this surface can do -- report a valid config
// invalid, for a reason about the request rather than the config.
//
// These tests pin the two halves of the fix: the owner is resolved and sent
// when it can be, and when it cannot, the compile still happens and the
// *reporting* says what could not be checked.

// validateOwnerBody decodes the fields these tests assert on.
type validateOwnerBody struct {
	Available bool   `json:"available"`
	Valid     bool   `json:"valid"`
	Caveat    string `json:"caveat"`
}

// ownerEnv is a complete CLI-plugin environment: a token plus enough project
// identity for the host to build an org slug it can resolve.
func ownerEnv() policyEnv {
	return policyEnv{
		token:     sentinelToken,
		vcsType:   "github",
		org:       "acme",
		repo:      "widgets",
		projectID: "11111111-1111-1111-1111-111111111111",
		branch:    "main",
	}
}

func TestServer_Validate_SendsResolvedOwnerID(t *testing.T) {
	const orgUUID = "f22b6566-597d-46d5-ba74-99ef5bb3d85c"
	client := &fakePolicyClient{org: &circleci.Organization{ID: orgUUID, Slug: "gh/acme"}}
	compiler := &fakeCompiler{result: &circleci.CompileResult{Valid: true, OutputYAML: "version: 2\n"}}
	ts := newPolicyTestServer(t, ownerEnv(), client, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)

	// The whole point of the fix: the compile request names the org.
	assert.Equal(t, compiler.gotReq.OwnerID, orgUUID)
	// Resolved from the slug this host assembles from the CLI's environment,
	// which is what makes the old "the plugin environment does not expose an
	// organization UUID" justification wrong.
	assert.Equal(t, client.gotOrgSlug, "gh/acme")

	var got validateOwnerBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Valid, true)
	assert.Equal(t, got.Caveat, "", "a config that compiled needs no caveat")
}

func TestServer_Validate_ReusesResolvedOwnerAcrossRequests(t *testing.T) {
	client := &fakePolicyClient{org: &circleci.Organization{
		ID:   "f22b6566-597d-46d5-ba74-99ef5bb3d85c",
		Slug: "gh/acme",
	}}
	compiler := &fakeCompiler{result: &circleci.CompileResult{Valid: true}}
	ts := newPolicyTestServer(t, ownerEnv(), client, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	// Validation runs on every keystroke-debounce, so an un-cached lookup
	// would put a second round trip in front of every compile.
	for range 3 {
		status, _ := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
		assert.Equal(t, status, http.StatusOK)
	}
	assert.Equal(t, client.orgCalls.Load(), int32(1))
}

func TestServer_Validate_NoOrgSlug_CompilesAnywayWithCaveat(t *testing.T) {
	// No VCS/project identity: running standalone, outside a checkout the
	// CLI could describe. There is no slug to resolve an organization from.
	env := ownerEnv()
	env.vcsType = ""
	env.org = ""
	env.repo = ""

	client := &fakePolicyClient{org: &circleci.Organization{ID: "unused"}}
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:  false,
		Errors: []circleci.CompileError{{Message: "Orb https://example.com/o.yml is not permitted"}},
	}}
	ts := newPolicyTestServer(t, env, client, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)

	// Compiled regardless: most configs use only public orbs and do not need
	// an owner, so a missing one must not cost validation entirely.
	assert.Equal(t, compiler.gotReq.ConfigYAML, "version: 2.1\n")
	assert.Equal(t, compiler.gotReq.OwnerID, "", "no organization was resolvable, so none may be claimed")
	assert.Equal(t, client.orgCalls.Load(), int32(0), "nothing to look up without a slug")

	var got validateOwnerBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Valid, false)
	assert.Assert(t, got.Caveat != "", "an invalid verdict reached without an organization must say so")
	assert.Assert(t, strings.Contains(got.Caveat, "without an organization"),
		"caveat should name what was missing, got: %s", got.Caveat)
}

func TestServer_Validate_OrgLookupFails_CompilesAnywayWithCaveat(t *testing.T) {
	// The slug is there; CircleCI just will not resolve it. Distinct from the
	// case above, and deliberately indistinguishable to the caller: the
	// response is the same because the user's situation is the same.
	client := &fakePolicyClient{orgErr: &circleci.APIError{StatusCode: http.StatusNotFound}}
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:  false,
		Errors: []circleci.CompileError{{Message: "some orb did not resolve"}},
	}}
	ts := newPolicyTestServer(t, ownerEnv(), client, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK, "a failed org lookup is not a failed validation")

	assert.Equal(t, compiler.gotReq.OwnerID, "")
	assert.Equal(t, client.orgCalls.Load(), int32(1))

	var got validateOwnerBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Assert(t, got.Caveat != "")
}

func TestServer_Validate_ValidConfigNeverCarriesACaveat(t *testing.T) {
	// Compiling without an owner is *stricter*, never looser: it can fail to
	// resolve an orb that would have resolved, but it cannot manufacture a
	// success. So a caveat on a passing config would qualify a verdict the
	// missing owner cannot have affected -- noise that teaches the reader to
	// ignore the field on the one response where it matters.
	env := ownerEnv()
	env.vcsType = ""
	env.org = ""
	env.repo = ""

	compiler := &fakeCompiler{result: &circleci.CompileResult{Valid: true, OutputYAML: "version: 2\n"}}
	ts := newPolicyTestServer(t, env, &fakePolicyClient{}, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)

	var got validateOwnerBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Valid, true)
	assert.Equal(t, got.Caveat, "")
}
