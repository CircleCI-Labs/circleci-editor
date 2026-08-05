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

package ai_test

import (
	"context"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// fakeProvider is a minimal ai.Provider used only to exercise Registry --
// see internal/ai/anthropic for a real implementation's own tests.
type fakeProvider struct{ name string }

func (f fakeProvider) Name() string         { return f.name }
func (f fakeProvider) Label() string        { return f.name }
func (f fakeProvider) DefaultModel() string { return "fake-model" }
func (f fakeProvider) Complete(context.Context, secret.String, string, ai.CompleteRequest) (ai.CompleteResult, error) {
	return ai.CompleteResult{}, nil
}

func TestRegistry_Get_FindsARegisteredProvider(t *testing.T) {
	reg := ai.Registry{"anthropic": fakeProvider{name: "anthropic"}}

	p, ok := reg.Get("anthropic")
	assert.Equal(t, ok, true)
	assert.Equal(t, p.Name(), "anthropic")
}

func TestRegistry_Get_UnknownProvider(t *testing.T) {
	reg := ai.Registry{"anthropic": fakeProvider{name: "anthropic"}}

	_, ok := reg.Get("does-not-exist")
	assert.Equal(t, ok, false)
}

func TestRegistry_Providers_SortedById(t *testing.T) {
	reg := ai.Registry{
		"zeta":  fakeProvider{name: "zeta"},
		"alpha": fakeProvider{name: "alpha"},
		"mu":    fakeProvider{name: "mu"},
	}

	got := reg.Providers()
	ids := make([]string, len(got))
	for i, p := range got {
		ids[i] = p.Name()
	}
	assert.DeepEqual(t, ids, []string{"alpha", "mu", "zeta"})
}

func TestAuthError_Error_NeverIncludesAKey(t *testing.T) {
	err := &ai.AuthError{Provider: "anthropic"}
	assert.Equal(t, err.Error(), `ai: anthropic rejected the configured API key`)
}
