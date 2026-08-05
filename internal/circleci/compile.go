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
// expand (compile) a config. Note that config compilation is only available
// on API v2 — it has no v3 equivalent — unlike orb endpoints, which are v3
// only.
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
