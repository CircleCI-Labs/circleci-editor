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

package circleci

import (
	"context"
	"net/http"
)

// compileConfigPath is the CircleCI API v2 endpoint used to validate and
// expand (compile) a config.
//
// A v3 equivalent exists -- POST /api/v3/configs/compile, taking
// {"data":{"attributes":{"config":"<yaml>"},"references":{"org":{"id":"<uuid>"}}}}
// and returning {"data":{"id":...,"attributes":{"phase":"ended",
// "outcome":"succeeded","compiled_config":"<yaml>"}}} -- and it does accept
// an organization: at data.references.org.id, echoed back the same way GET
// /api/v3/orb/packages echoes a namespace at data.references.namespace.id
// (see orbPackagesResponse in orbs.go). Confirmed against the live API: a
// config using a URL orb gated by an org allow-list succeeds when
// references.org.id names that org, and fails with the expected "not
// permitted by the organization's URL orb allow-list" for a different org's
// UUID -- the field is read, not ignored.
//
// An earlier version of this comment said the opposite: that four
// placements -- data.attributes.owner_id, data.attributes.org_id, a
// JSON:API-style data.relationships.org, and top-level owner_id -- were all
// tried and all silently ignored, and concluded v3 could not carry an
// organization at all. That conclusion was wrong. The mistake was assuming
// JSON:API's "relationships" spelling; v3 uses its own "references"
// envelope instead, for both requests (here) and responses (orbs.go
// already), so the evidence that the right shape existed was sitting
// alongside the wrong guess the whole time.
//
// We still call v2 today regardless: nobody has done the migration work, not
// because v3 can't carry an organization -- CompileRequest.OwnerID (#67/#72)
// would need a home in the v3 request shape, and every caller and test that
// assumes v2's request/response wire format would need updating alongside
// it. Until that happens, v2 remains what's wired up.
const compileConfigPath = "/api/v2/compile-config-with-defaults"

// CompileRequest is the input to CompileConfig.
type CompileRequest struct {
	// ConfigYAML is the raw .circleci/config.yml contents to compile.
	ConfigYAML string

	// OwnerID is the CircleCI organization ID (UUID) to compile the config
	// on behalf of. It affects resolution of private orbs and org-scoped
	// contexts/parameters. May be left empty for basic validation.
	OwnerID string

	// UseNextCompiler requests CircleCI's next-generation config compiler
	// instead of the default one.
	UseNextCompiler bool

	// PipelineValues, if non-nil, supplies pipeline values (e.g.
	// "pipeline.git.branch") available to the config during compilation.
	PipelineValues map[string]any

	// PipelineParameters, if non-nil, supplies values for the config's
	// top-level "parameters" during compilation.
	PipelineParameters map[string]any
}

// CompileError describes a single problem found while compiling a config.
type CompileError struct {
	// Message is a human-readable description of the problem.
	Message string `json:"message"`
}

// CompileResult is the outcome of successfully calling
// compile-config-with-defaults. A CompileResult with Valid==false is not an
// error condition from CompileConfig's point of view: it means the API call
// itself succeeded and CircleCI determined the submitted config is invalid.
// See CompileConfig's doc comment for the full valid-call-vs-Go-error
// distinction.
type CompileResult struct {
	// Valid reports whether the submitted config compiled successfully.
	Valid bool

	// SourceYAML is the original config as CircleCI echoes it back.
	SourceYAML string

	// OutputYAML is the fully expanded ("compiled") config, with orbs
	// resolved and defaults applied. Only meaningful when Valid is true.
	OutputYAML string

	// Errors describes why compilation failed. Only populated when Valid
	// is false.
	Errors []CompileError
}

// compileWireRequest is the JSON request body for compile-config-with-defaults.
type compileWireRequest struct {
	ConfigYAML string             `json:"config_yaml"`
	Options    compileWireOptions `json:"options"`
}

// compileWireOptions is the nested "options" object of the compile request.
// Each field is omitted when it holds its zero value, per the API's
// convention of defaulting unset options.
type compileWireOptions struct {
	OwnerID            string         `json:"owner_id,omitempty"`
	Next               bool           `json:"next,omitempty"`
	PipelineValues     map[string]any `json:"pipeline_values,omitempty"`
	PipelineParameters map[string]any `json:"pipeline_parameters,omitempty"`
}

// compileWireResponse is the JSON response body from
// compile-config-with-defaults. Note the hyphenated field names — unlike
// most of the rest of the CircleCI API, this endpoint uses "source-yaml" and
// "output-yaml" rather than camelCase or snake_case, which is easy to get
// wrong without explicit struct tags.
type compileWireResponse struct {
	Valid      bool           `json:"valid"`
	SourceYAML string         `json:"source-yaml"`
	OutputYAML string         `json:"output-yaml"`
	Errors     []CompileError `json:"errors"`
}

// CompileConfig calls CircleCI's POST /api/v2/compile-config-with-defaults
// to validate and expand req.ConfigYAML.
//
// Important: an invalid config is a *successful* API call. CompileConfig
// returns a nil error and a CompileResult with Valid==false and Errors
// populated in that case. A non-nil error from CompileConfig always
// indicates a transport, authentication, or CircleCI-server-side problem
// (network failure, 401, 429 after retries, 5xx after retries, a malformed
// response, or ctx cancellation) — never a merely-invalid config. Callers
// must check CompileResult.Valid to learn whether the config itself is
// valid.
func (c *Client) CompileConfig(ctx context.Context, req CompileRequest) (*CompileResult, error) {
	wireReq := compileWireRequest{
		ConfigYAML: req.ConfigYAML,
		Options: compileWireOptions{
			OwnerID:            req.OwnerID,
			Next:               req.UseNextCompiler,
			PipelineValues:     req.PipelineValues,
			PipelineParameters: req.PipelineParameters,
		},
	}

	var wireResp compileWireResponse
	if err := c.do(ctx, http.MethodPost, compileConfigPath, wireReq, &wireResp); err != nil {
		return nil, err
	}

	return &CompileResult{
		Valid:      wireResp.Valid,
		SourceYAML: wireResp.SourceYAML,
		OutputYAML: wireResp.OutputYAML,
		Errors:     wireResp.Errors,
	}, nil
}
