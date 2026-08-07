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
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// Issue #22: local grounding needs no credential and no MCP server, so
// these tests exercise it through a *fixed*, hand-built guides corpus
// (fakeGuidesCache, already defined in guides_test.go) rather than the real
// vendored snapshot -- the same reason internal/guides/citations_test.go's
// fakeGuides exists alongside its own real-snapshot test: pinning exact
// wording to prose a snapshot refresh can reword would make this file flake
// on a change that has nothing to do with grounding. Selection *against the
// real snapshot* is covered in internal/guides/grounding_test.go; this file
// covers the host's wiring of it into the system prompt and the response.
func groundingTestGuides() []guides.Guide {
	return []guides.Guide{
		{
			ID:     "configuration-reference",
			Title:  "Configuration reference",
			Origin: guides.OriginCircleCI,
			URL:    "https://circleci.com/docs/reference/configuration-reference/",
			Sections: []guides.Section{
				{
					ID:    "resourceclass",
					Title: "resource_class",
					URL:   "https://circleci.com/docs/reference/configuration-reference/#resourceclass",
					Keys:  []string{"resource_class"},
					Blocks: []guides.Block{
						{
							Kind: guides.KindParagraph,
							Spans: []guides.Span{
								{Kind: guides.SpanText, Text: "The resource_class feature allows you to configure CPU and RAM resources for each job."},
							},
						},
					},
				},
			},
		},
	}
}

// newAITestServerWithGuides is newAITestServer plus a guides cache the test
// controls -- ai_test.go's own helper always builds a real guides.Cache
// (parsing the actual embedded snapshot), which is right for tests about
// providers and keys but wrong here: these tests need to pin exactly which
// sections exist and exactly how old they are.
func newAITestServerWithGuides(t *testing.T, store *fakeKeyStore, providers ai.Registry, cache *fakeGuidesCache) *httptest.Server {
	t.Helper()
	// See newAITestServer's own doc comment (ai_test.go): CircleCI's MCP
	// server (issue #11) is attached based on the ambient CIRCLE_TOKEN
	// unless cleared, and this suite's assertions must not depend on
	// whether the machine running them happens to have a real one.
	clearCircleEnv(t)
	srv, err := host.New(host.Options{
		WorkDir:     t.TempDir(),
		Version:     "test-version",
		AIStore:     store,
		AIProviders: providers,
		GuidesCache: cache,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func freshProvenance() guides.Provenance {
	return guides.Provenance{
		Repo:        "circleci/circleci-docs",
		Ref:         "main",
		Commit:      "abc123def456",
		CommittedAt: time.Now().Add(-2 * 24 * time.Hour),
		FetchedAt:   time.Now().Add(-2 * 24 * time.Hour),
		Source:      guides.SourceVendored,
	}
}

// TestServer_AIChat_Grounding_SelectsAndCitesVendoredPassages_WithNoMCPConfigured
// is issue #22's central claim end to end: with no MCP server configured at
// all (so gotReq.MCPServers is empty -- no credential and no network were
// used), a question naming a documented, config-set key still reaches the
// model with the matching vendored passage in its system prompt, cited to a
// URL that comes back in the response's own Sources list with the offline-
// resolved title.
func TestServer_AIChat_Grounding_SelectsAndCitesVendoredPassages_WithNoMCPConfigured(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	cache := &fakeGuidesCache{guides: groundingTestGuides(), provenance: freshProvenance()}

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "resource_class controls compute", Model: model}, nil
		},
	}
	base := newAITestServerWithGuides(t, store, ai.Registry{"anthropic": provider}, cache)

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "What does resource_class control?"}},
		"context":  map[string]any{"configText": "version: 2.1\njobs:\n  build:\n    resource_class: large\n"},
	})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK, body)

	assert.Equal(t, len(gotReq.MCPServers), 0, "no MCP server was configured; local grounding must not need one")
	assert.Assert(t, is.Contains(gotReq.System, "Documentation context"))
	assert.Assert(t, is.Contains(gotReq.System, "resource_class feature allows you to configure CPU and RAM"))
	assert.Assert(t, is.Contains(gotReq.System, "Source: https://circleci.com/docs/reference/configuration-reference/#resourceclass"))

	var got struct {
		Sources []struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"sources"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, is.Len(got.Sources, 1), "body=%s", body)
	assert.Equal(t, got.Sources[0].URL, "https://circleci.com/docs/reference/configuration-reference/#resourceclass")
	assert.Equal(t, got.Sources[0].Title, "resource_class")
}

// TestServer_AIChat_Grounding_NoMatchOmitsTheSectionEntirely pins the other
// half of "selection, not stuffing": a corpus is loaded and ready, but a
// question and config that share nothing with it must produce no
// "Documentation context" section and no grounding-sourced citation at all
// -- never the nearest sections regardless of relevance.
func TestServer_AIChat_Grounding_NoMatchOmitsTheSectionEntirely(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	cache := &fakeGuidesCache{guides: groundingTestGuides(), provenance: freshProvenance()}

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "hello", Model: model}, nil
		},
	}
	base := newAITestServerWithGuides(t, store, ai.Registry{"anthropic": provider}, cache)

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK, body)

	assert.Assert(t, !strings.Contains(gotReq.System, "Documentation context"))
	assert.Assert(t, !strings.Contains(body, `"sources"`), "must not send a sources field at all when nothing was selected: %s", body)
}

// TestServer_AIChat_Grounding_StaleSnapshotSaysSo is issue #22's own
// caveat: "the snapshot has an age, and an answer grounded on a stale page
// should be able to say so". Same question, same corpus, differing only in
// how long ago the served copy was last confirmed current -- and the
// prompt's own wording must differ with it.
func TestServer_AIChat_Grounding_StaleSnapshotSaysSo(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	question := map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "What does resource_class control?"}},
	}
	reqBody, err := json.Marshal(question)
	assert.NilError(t, err)

	staleProvenance := freshProvenance()
	staleProvenance.FetchedAt = time.Now().Add(-30 * 24 * time.Hour)

	for name, prov := range map[string]guides.Provenance{"fresh": freshProvenance(), "stale": staleProvenance} {
		t.Run(name, func(t *testing.T) {
			cache := &fakeGuidesCache{guides: groundingTestGuides(), provenance: prov}
			var gotReq ai.CompleteRequest
			provider := &fakeProvider{
				name: "anthropic", label: "Anthropic", model: "m",
				complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
					gotReq = req
					return ai.CompleteResult{Content: "ok", Model: model}, nil
				},
			}
			base := newAITestServerWithGuides(t, store, ai.Registry{"anthropic": provider}, cache)

			status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
			assert.Equal(t, status, http.StatusOK, body)

			staleNotice := "has not been checked against upstream in over a week"
			if name == "stale" {
				assert.Assert(t, is.Contains(gotReq.System, staleNotice))
				assert.Assert(t, is.Contains(gotReq.System, "treat it as the best available copy rather than necessarily current"))
			} else {
				assert.Assert(t, !strings.Contains(gotReq.System, staleNotice))
			}
			// Both cases still state where and when the snapshot was pinned --
			// staleness changes whether a caveat is added, never whether the
			// underlying facts are stated at all.
			assert.Assert(t, is.Contains(gotReq.System, "circleci/circleci-docs"))
		})
	}
}
