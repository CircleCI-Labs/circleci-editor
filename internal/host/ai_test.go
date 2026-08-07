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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/circlecimcp"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// aiSentinelKey stands in for a real provider API key across every test in
// this file. It must never appear in an HTTP response body or in anything
// written to the standard logger -- that is exactly what several tests
// below assert.
const aiSentinelKey = "sk-ant-host-test-sentinel-should-never-leak-anywhere"

// fakeKeyStore is an in-memory keystore.Store, so these tests never touch a
// real OS keychain or write a file -- and so a test can inspect exactly
// what was stored without going through the HTTP API it's also testing.
type fakeKeyStore struct {
	mu   sync.Mutex
	keys map[string]secret.String
}

func newFakeKeyStore() *fakeKeyStore {
	return &fakeKeyStore{keys: map[string]secret.String{}}
}

func (f *fakeKeyStore) Get(_ context.Context, provider string) (secret.String, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.keys[provider]
	return v, ok, nil
}

func (f *fakeKeyStore) Set(_ context.Context, provider string, key secret.String) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keys[provider] = key
	return nil
}

func (f *fakeKeyStore) Delete(_ context.Context, provider string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.keys, provider)
	return nil
}

func (f *fakeKeyStore) Backend() keystore.Backend { return keystore.BackendFile }
func (f *fakeKeyStore) Location() string          { return "/fake/keys.json" }

// fakeProvider is an ai.Provider whose Complete is supplied by the test, so
// no test in this file ever makes a real network call.
type fakeProvider struct {
	name     string
	label    string
	model    string
	complete func(ctx context.Context, key secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error)
}

func (f *fakeProvider) Name() string         { return f.name }
func (f *fakeProvider) Label() string        { return f.label }
func (f *fakeProvider) DefaultModel() string { return f.model }
func (f *fakeProvider) Complete(ctx context.Context, key secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
	return f.complete(ctx, key, model, req)
}

// newAITestServer builds a host.Server wired to store and providers (test
// doubles the caller constructs), wrapped in an httptest.Server. Reuses
// api_test.go's doRequest helper (same package) for making requests against
// it.
//
// clearCircleEnv first, deliberately: since issue #11, host.New's own
// LoadEnvironment call determines whether CircleCI's MCP server is attached
// to every /api/ai/chat request in this file, and this suite's assertions
// on gotReq.MCPServers's length must hold regardless of whether the machine
// actually running these tests happens to have a real CIRCLE_TOKEN set (see
// CONTRIBUTING.md: this binary may itself be running inside a CircleCI
// job). newAITestServerWithToken below is the one helper that deliberately
// sets it back.
func newAITestServer(t *testing.T, store *fakeKeyStore, providers ai.Registry) *httptest.Server {
	t.Helper()
	clearCircleEnv(t)
	srv, err := host.New(host.Options{
		WorkDir:     t.TempDir(),
		Version:     "test-version",
		AIStore:     store,
		AIProviders: providers,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// newAITestServerWithToken is newAITestServer plus a CIRCLE_TOKEN, for the
// issue #11 tests that need CircleCI's MCP server to actually attach.
//
// The token must be set *before* host.New runs, not after: host.New's own
// LoadEnvironment call reads the environment exactly once, at construction,
// into the immutable s.env every later request reads from -- setting
// CIRCLE_TOKEN afterwards would change nothing about an already-built
// Server. So this does not delegate to newAITestServer, which would
// construct the server first and leave no correct place to set the token.
func newAITestServerWithToken(t *testing.T, store *fakeKeyStore, providers ai.Registry, token string) *httptest.Server {
	t.Helper()
	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", token)
	srv, err := host.New(host.Options{
		WorkDir:     t.TempDir(),
		Version:     "test-version",
		AIStore:     store,
		AIProviders: providers,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// doAIRequest is a thin alias for api_test.go's doRequest, named separately
// only for grep-ability within this file; both make the exact same request.
func doAIRequest(t *testing.T, ts *httptest.Server, method, path string, body []byte) (int, string) {
	t.Helper()
	return doRequest(t, ts, method, path, body)
}

func TestServer_AIStatus_ReportsUnconfiguredProviderAndStorageLocation(t *testing.T) {
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "claude-test-model"}})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Providers []struct {
			ID         string `json:"id"`
			Label      string `json:"label"`
			Configured bool   `json:"configured"`
			Model      string `json:"model"`
		} `json:"providers"`
		Storage struct {
			Backend  string `json:"backend"`
			Location string `json:"location"`
		} `json:"storage"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Providers), 1)
	assert.Equal(t, got.Providers[0].ID, "anthropic")
	assert.Equal(t, got.Providers[0].Configured, false)
	assert.Equal(t, got.Providers[0].Model, "claude-test-model")
	assert.Equal(t, got.Storage.Backend, "file")
	assert.Equal(t, got.Storage.Location, "/fake/keys.json")
}

// TestServer_AIStatus_ReportsSourceStore_WhenOnlyStored pins the ordinary
// case: a key in the store, nothing in the environment, so Source and
// StoredKeyShadowed must say exactly that -- neither field existed before
// issue #7, and the whole fix rests on them being right in every branch.
func TestServer_AIStatus_ReportsSourceStore_WhenOnlyStored(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)

	got := decodeAIStatus(t, body)
	assert.Equal(t, len(got.Providers), 1)
	p := got.Providers[0]
	assert.Equal(t, p.Configured, true)
	assert.Equal(t, p.Source, "store")
	assert.Equal(t, p.StoredKeyShadowed, false)
}

// TestServer_AIStatus_ReportsSourceEnvironment_NothingStored is issue #7's
// first broken case: before this fix, this state (an environment variable
// supplying the key, nothing ever stored) looked identical over the wire to
// "a key is stored" -- both were just `"configured":true`. A pane cannot
// honestly offer to remove a key that was never stored, and it cannot do
// that without this distinction on the wire.
func TestServer_AIStatus_ReportsSourceEnvironment_NothingStored(t *testing.T) {
	envVar := keystore.KeyEnvVar("anthropic")
	t.Setenv(envVar, aiSentinelKey)
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, aiSentinelKey), "status response leaked the environment key: %s", body)

	got := decodeAIStatus(t, body)
	assert.Equal(t, len(got.Providers), 1)
	p := got.Providers[0]
	assert.Equal(t, p.Configured, true)
	assert.Equal(t, p.Source, "environment")
	assert.Equal(t, p.EnvVar, envVar)
	assert.Equal(t, p.StoredKeyShadowed, false)
}

// TestServer_AIStatus_ReportsSourceEnvironment_ShadowingAStoredKey is issue
// #7's second broken case, and the one the "Remove" button actually acts
// on: a key is genuinely stored, but an environment variable is currently
// overriding it. StoredKeyShadowed=true is what tells the pane "there is
// something real to delete here, but deleting it will not change what's in
// effect" -- the honest version of the state that used to render as plain
// "Configured" with nothing to distinguish it from the environment-only case
// above.
func TestServer_AIStatus_ReportsSourceEnvironment_ShadowingAStoredKey(t *testing.T) {
	envVar := keystore.KeyEnvVar("anthropic")
	t.Setenv(envVar, "sk-ant-env-wins")
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)

	got := decodeAIStatus(t, body)
	assert.Equal(t, len(got.Providers), 1)
	p := got.Providers[0]
	assert.Equal(t, p.Configured, true)
	assert.Equal(t, p.Source, "environment")
	assert.Equal(t, p.EnvVar, envVar)
	assert.Equal(t, p.StoredKeyShadowed, true)
}

// aiStatusPayload/decodeAIStatus mirror GET /api/ai/status's shape for
// these tests -- kept out of TestServer_AIStatus_ReportsUnconfigured...'s own
// anonymous struct because every source-provenance test below needs the
// same fields.
type aiStatusPayload struct {
	Providers []struct {
		ID                string `json:"id"`
		Configured        bool   `json:"configured"`
		Source            string `json:"source"`
		EnvVar            string `json:"envVar"`
		StoredKeyShadowed bool   `json:"storedKeyShadowed"`
	} `json:"providers"`
}

func decodeAIStatus(t *testing.T, body string) aiStatusPayload {
	t.Helper()
	var got aiStatusPayload
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	return got
}

func TestServer_AIStatus_WrongMethod(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

func TestServer_AIKey_Put_StoresTheKeyAndNeverEchoesIt(t *testing.T) {
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	var logBuf bytes.Buffer
	withCapturedLog(t, &logBuf, func() {
		body, err := json.Marshal(map[string]string{"provider": "anthropic", "key": aiSentinelKey})
		assert.NilError(t, err)

		status, respBody := doAIRequest(t, base, http.MethodPut, "/api/ai/key", body)
		assert.Equal(t, status, http.StatusOK)
		assert.Assert(t, !strings.Contains(respBody, aiSentinelKey), "PUT response leaked the key: %s", respBody)

		var got struct {
			Provider   string `json:"provider"`
			Configured bool   `json:"configured"`
		}
		assert.NilError(t, json.Unmarshal([]byte(respBody), &got))
		assert.Equal(t, got.Provider, "anthropic")
		assert.Equal(t, got.Configured, true)
	})
	assert.Assert(t, !strings.Contains(logBuf.String(), aiSentinelKey), "server logs leaked the key: %s", logBuf.String())

	stored, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, stored.Reveal(), aiSentinelKey, "the key must actually have been persisted")

	// GET /api/ai/status now reports it configured, still never revealing it.
	status, statusBody := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(statusBody, aiSentinelKey))
	assert.Assert(t, is.Contains(statusBody, `"configured":true`))
}

func TestServer_AIKey_Put_UnknownProvider(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	body, err := json.Marshal(map[string]string{"provider": "does-not-exist", "key": "x"})
	assert.NilError(t, err)
	status, respBody := doAIRequest(t, base, http.MethodPut, "/api/ai/key", body)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, is.Contains(respBody, `"error"`))
}

func TestServer_AIKey_Put_MissingKey(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	body, err := json.Marshal(map[string]string{"provider": "anthropic"})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/key", body)
	assert.Equal(t, status, http.StatusBadRequest)
}

func TestServer_AIKey_Delete_RemovesAConfiguredKey(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	status, body := doAIRequest(t, base, http.MethodDelete, "/api/ai/key?provider=anthropic", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, is.Contains(body, `"configured":false`))

	_, ok, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)
}

// TestServer_AIKey_Delete_HonestlyReportsStillConfigured_WhenEnvVarShadowsTheDeletedKey
// is issue #7's core repro: DELETE always deletes from the store (that half
// was never broken -- the store really does end up empty), but the response
// used to hardcode Configured=false regardless of what was actually still in
// effect. With CIRCLECI_EDITOR_AI_KEY_ANTHROPIC set, the key remains fully usable after
// this call, and the response must say so -- exactly the "a control that
// reports success and changes nothing" failure the issue names, now fixed by
// reporting the true post-delete state instead of assuming one.
func TestServer_AIKey_Delete_HonestlyReportsStillConfigured_WhenEnvVarShadowsTheDeletedKey(t *testing.T) {
	envVar := keystore.KeyEnvVar("anthropic")
	t.Setenv(envVar, "sk-ant-env-wins")
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	base := newAITestServer(t, store, ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	status, body := doAIRequest(t, base, http.MethodDelete, "/api/ai/key?provider=anthropic", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Configured        bool   `json:"configured"`
		Source            string `json:"source"`
		EnvVar            string `json:"envVar"`
		StoredKeyShadowed bool   `json:"storedKeyShadowed"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	// The store really was emptied...
	_, stored, err := store.Get(context.Background(), "anthropic")
	assert.NilError(t, err)
	assert.Equal(t, stored, false)
	// ...but the key this delete "removed" is still in effect, because the
	// environment variable never went away, and the response must not claim
	// otherwise.
	assert.Equal(t, got.Configured, true)
	assert.Equal(t, got.Source, "environment")
	assert.Equal(t, got.EnvVar, envVar)
	assert.Equal(t, got.StoredKeyShadowed, false, "nothing is stored any more, so it cannot still be shadowed")
}

// TestServer_AIKey_Put_ReportsShadowed_WhenEnvVarAlreadySet is PUT's half of
// the same honesty rule: storing a key while CIRCLECI_EDITOR_AI_KEY_ANTHROPIC is set
// really does write to the store (Set is never intercepted -- see
// keystore.WithEnvOverride's doc comment), but the key just stored is not
// the one that will be used, and the response must say so rather than
// implying the save just took effect.
func TestServer_AIKey_Put_ReportsShadowed_WhenEnvVarAlreadySet(t *testing.T) {
	envVar := keystore.KeyEnvVar("anthropic")
	t.Setenv(envVar, "sk-ant-env-wins")
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	body, err := json.Marshal(map[string]string{"provider": "anthropic", "key": aiSentinelKey})
	assert.NilError(t, err)
	status, respBody := doAIRequest(t, base, http.MethodPut, "/api/ai/key", body)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Configured        bool   `json:"configured"`
		Source            string `json:"source"`
		StoredKeyShadowed bool   `json:"storedKeyShadowed"`
	}
	assert.NilError(t, json.Unmarshal([]byte(respBody), &got))
	assert.Equal(t, got.Configured, true)
	assert.Equal(t, got.Source, "environment")
	assert.Equal(t, got.StoredKeyShadowed, true)
}

func TestServer_AIKey_Delete_UnknownProvider(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})
	status, _ := doAIRequest(t, base, http.MethodDelete, "/api/ai/key?provider=nope", nil)
	assert.Equal(t, status, http.StatusBadRequest)
}

func TestServer_AIChat_NoKeyConfigured_IsAvailableFalse(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	assert.NilError(t, err)

	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, false)
	assert.Assert(t, is.Contains(got.Reason, "Anthropic"))
}

func TestServer_AIChat_UnknownProvider(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})
	reqBody, err := json.Marshal(map[string]any{"provider": "nope", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusBadRequest)
}

func TestServer_AIChat_MissingMessages(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})
	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{}})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusBadRequest)
}

func TestServer_AIChat_TooManyMessages(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{"anthropic": &fakeProvider{name: "anthropic", label: "Anthropic", model: "m"}})

	msgs := make([]map[string]string, 201)
	for i := range msgs {
		msgs[i] = map[string]string{"role": "user", "content": "hi"}
	}
	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": msgs})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusBadRequest)
}

func TestServer_AIChat_Success_SendsKeyToProviderAndNeverLeaksItBack(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotKey secret.String
	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "claude-test-model",
		complete: func(_ context.Context, key secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotKey = key
			gotReq = req
			return ai.CompleteResult{Content: "the answer", Model: model, InputTokens: 5, OutputTokens: 7}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	var logBuf bytes.Buffer
	var status int
	var body string
	withCapturedLog(t, &logBuf, func() {
		reqBody, err := json.Marshal(map[string]any{
			"provider": "anthropic",
			"messages": []map[string]string{{"role": "user", "content": "what does the build job do?"}},
			"context": map[string]any{
				"configPath":       "/repo/.circleci/config.yml",
				"configText":       "version: 2.1\njobs:\n  build:\n    docker: []\n",
				"jobNames":         []string{"build"},
				"workflowNames":    []string{"main"},
				"validationErrors": []string{"job \"build\" has no steps"},
			},
		})
		assert.NilError(t, err)
		status, body = doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	})

	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, aiSentinelKey), "chat response leaked the key: %s", body)
	assert.Assert(t, !strings.Contains(logBuf.String(), aiSentinelKey), "server logs leaked the key: %s", logBuf.String())

	var got struct {
		Available bool   `json:"available"`
		Content   string `json:"content"`
		Model     string `json:"model"`
		Usage     struct {
			InputTokens  int `json:"inputTokens"`
			OutputTokens int `json:"outputTokens"`
		} `json:"usage"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Content, "the answer")
	assert.Equal(t, got.Usage.InputTokens, 5)
	assert.Equal(t, got.Usage.OutputTokens, 7)

	// The provider really was handed the real key (proving the round trip
	// works end to end), even though it never appears in any response.
	assert.Equal(t, gotKey.Reveal(), aiSentinelKey)

	// The repo-aware context made it into the system prompt.
	assert.Assert(t, is.Contains(gotReq.System, "build"))
	assert.Assert(t, is.Contains(gotReq.System, "main"))
	assert.Assert(t, is.Contains(gotReq.System, "no steps"))
	assert.Assert(t, is.Contains(gotReq.System, "/repo/.circleci/config.yml"))
	assert.Equal(t, len(gotReq.Messages), 1)
	assert.Equal(t, gotReq.Messages[0].Content, "what does the build job do?")
}

// TestServer_AIChat_DirectoryContext_OtherFilesAndSkippedFilesReachTheSystemPrompt
// covers issue #102: the sibling files the frontend's directory-context
// assembler decided to include (otherFiles) and the ones it decided to
// leave out (skippedFiles, e.g. over its token budget) must both be named
// in the system prompt -- and the prompt must say plainly that only the
// open config file (ConfigPath) can be the target of a proposed action, so
// the model never proposes editing a read-only sibling.
func TestServer_AIChat_DirectoryContext_OtherFilesAndSkippedFilesReachTheSystemPrompt(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "claude-test-model",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "what does continue-config.yml do?"}},
		"context": map[string]any{
			"configPath": "/repo/.circleci/config.yml",
			"configText": "version: 2.1\nsetup: true\n",
			"otherFiles": []map[string]string{
				{"path": "/repo/.circleci/continue-config.yml", "text": "version: 2.1\njobs:\n  test:\n    docker: []\n"},
			},
			"skippedFiles": []map[string]string{
				{"path": "/repo/.circleci/huge-generated.yml", "reason": "token budget exceeded"},
			},
		},
	})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK, body)

	assert.Assert(t, is.Contains(gotReq.System, "continue-config.yml"))
	assert.Assert(t, is.Contains(gotReq.System, "test"))
	assert.Assert(t, is.Contains(gotReq.System, "huge-generated.yml"))
	assert.Assert(t, is.Contains(gotReq.System, "token budget exceeded"))
	// The action protocol must confine itself to the open file, by name.
	assert.Assert(t, is.Contains(gotReq.System, "applies only to the currently open file"))
}

// TestServer_AIChat_NoDirectoryContext_PromptUnchanged pins the
// no-siblings case to byte-for-byte the same shape as before issue #102:
// a single-file `.circleci` directory (or a request from an older/simpler
// frontend build that never populates otherFiles/skippedFiles) must not
// gain an empty "Other files..." section.
func TestServer_AIChat_NoDirectoryContext_PromptUnchanged(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "claude-test-model",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
		"context":  map[string]any{"configPath": "/repo/.circleci/config.yml", "configText": "version: 2.1\n"},
	})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)

	assert.Assert(t, !strings.Contains(gotReq.System, "Other files in this directory"))
	assert.Assert(t, !strings.Contains(gotReq.System, "not sent"))
	assert.Assert(t, !strings.Contains(gotReq.System, "config-policy violations"))
}

// TestServer_AIChat_PolicyViolations_ReachTheSystemPromptAsADifferentAxis
// covers issue #247 item 6: "make sure the AI chat has access to those
// policies... so if someone needs help editing a config to be compliant
// we'd actually know how to help them." The rule name and CircleCI's own
// reason must both reach the model, verbatim, and a blocking violation must
// say plainly that it would refuse a pipeline -- the same fact PolicyStrip
// states, never merged with (or worded like) a compile error.
func TestServer_AIChat_PolicyViolations_ReachTheSystemPromptAsADifferentAxis(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "claude-test-model",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{"role": "user", "content": "how do I make this config compliant?"}},
		"context": map[string]any{
			"configPath": "/repo/.circleci/config.yml",
			"configText": "version: 2.1\n",
			"policyViolations": []map[string]any{
				{
					"rule":     "required_jobs_in_workflow",
					"reason":   "Job 'security-scan' is enforced by your Security Team but missing from this workflow",
					"blocking": true,
				},
				{
					"rule":     "use_official_docker_image",
					"reason":   "nginx:latest is not an approved Docker image",
					"blocking": false,
				},
			},
		},
	})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK, body)

	assert.Assert(t, is.Contains(gotReq.System, "config-policy violations"))
	assert.Assert(t, is.Contains(gotReq.System, "required_jobs_in_workflow"))
	assert.Assert(t, is.Contains(gotReq.System, "Job 'security-scan' is enforced by your Security Team"))
	assert.Assert(t, is.Contains(gotReq.System, "blocking -- would refuse a pipeline"))
	assert.Assert(t, is.Contains(gotReq.System, "use_official_docker_image"))
	assert.Assert(t, is.Contains(gotReq.System, "non-blocking"))
	// Kept a distinct section from compile validation -- a policy violation
	// is not stated as a validation error.
	assert.Assert(t, !strings.Contains(gotReq.System, "Current validation errors"))
}

func TestServer_AIChat_ProviderAuthError_MapsTo502WithoutLeakingTheKey(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(context.Context, secret.String, string, ai.CompleteRequest) (ai.CompleteResult, error) {
			return ai.CompleteResult{}, &ai.AuthError{Provider: "anthropic"}
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, !strings.Contains(body, aiSentinelKey))
	assert.Assert(t, is.Contains(body, "rejected"))
}

func TestServer_AIChat_ProviderNetworkError_MapsTo502(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(context.Context, secret.String, string, ai.CompleteRequest) (ai.CompleteResult, error) {
			return ai.CompleteResult{}, assertNetworkError()
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, !strings.Contains(body, aiSentinelKey))
}

// aiMCPSentinelToken stands in for a real MCP server bearer token across
// every test below, the same role aiSentinelKey plays for provider keys --
// it must never leak into a response body or the server log.
const aiMCPSentinelToken = "mcp-token-host-test-sentinel-should-never-leak-anywhere"

// mcpStatusPayload mirrors the host's own unexported aiMCPStatusResponse --
// this file is package host_test (external), so it decodes the JSON shape
// rather than importing the type, same as every other AI response struct
// already declared inline in this file.
type mcpStatusPayload struct {
	Configured bool   `json:"configured"`
	URL        string `json:"url"`
	HasToken   bool   `json:"hasToken"`
}

func TestServer_AIMCP_Get_NoneConfigured(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/mcp", nil)
	assert.Equal(t, status, http.StatusOK)

	var got mcpStatusPayload
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Configured, false)
	assert.Equal(t, got.URL, "")
	assert.Equal(t, got.HasToken, false)
}

func TestServer_AIMCP_Put_StoresURLAndTokenButNeverEchoesTheToken(t *testing.T) {
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{})

	var logBuf bytes.Buffer
	var status int
	var body string
	withCapturedLog(t, &logBuf, func() {
		reqBody, err := json.Marshal(map[string]string{
			"url":   "https://circleci.mcp.kapa.ai/sse",
			"token": aiMCPSentinelToken,
		})
		assert.NilError(t, err)
		status, body = doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", reqBody)
	})
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, aiMCPSentinelToken), "PUT response leaked the token: %s", body)
	assert.Assert(t, !strings.Contains(logBuf.String(), aiMCPSentinelToken), "server logs leaked the token: %s", logBuf.String())

	var got mcpStatusPayload
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Configured, true)
	assert.Equal(t, got.URL, "https://circleci.mcp.kapa.ai/sse")
	assert.Equal(t, got.HasToken, true)

	// The token really was stored (proving the round trip works), even
	// though it never appears in any response.
	stored, ok, err := store.Get(context.Background(), "mcp-docs-token")
	assert.NilError(t, err)
	assert.Equal(t, ok, true)
	assert.Equal(t, stored.Reveal(), aiMCPSentinelToken)
}

func TestServer_AIMCP_Put_RejectsNonHTTPSURL(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})

	reqBody, err := json.Marshal(map[string]string{"url": "http://insecure.example.com/sse"})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", reqBody)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, is.Contains(body, "https://"))
}

func TestServer_AIMCP_Put_MissingURL(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})

	reqBody, err := json.Marshal(map[string]string{"token": "irrelevant"})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", reqBody)
	assert.Equal(t, status, http.StatusBadRequest)
}

// TestServer_AIMCP_Put_EmptyTokenClearsAPreviouslyStoredOne covers
// aiMCPPutRequest's documented "empty token clears the stored one" rule --
// a second PUT with no token must leave the server unauthenticated, not
// silently keep the first request's token around.
func TestServer_AIMCP_Put_EmptyTokenClearsAPreviouslyStoredOne(t *testing.T) {
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{})

	first, err := json.Marshal(map[string]string{"url": "https://circleci.mcp.kapa.ai/sse", "token": aiMCPSentinelToken})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", first)
	assert.Equal(t, status, http.StatusOK)

	second, err := json.Marshal(map[string]string{"url": "https://circleci.mcp.kapa.ai/sse"})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", second)
	assert.Equal(t, status, http.StatusOK)

	var got mcpStatusPayload
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.HasToken, false)

	_, ok, err := store.Get(context.Background(), "mcp-docs-token")
	assert.NilError(t, err)
	assert.Equal(t, ok, false, "the previously stored token must have been deleted")
}

func TestServer_AIMCP_Delete_RemovesAConfiguredServer(t *testing.T) {
	store := newFakeKeyStore()
	base := newAITestServer(t, store, ai.Registry{})

	put, err := json.Marshal(map[string]string{"url": "https://circleci.mcp.kapa.ai/sse", "token": aiMCPSentinelToken})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", put)
	assert.Equal(t, status, http.StatusOK)

	status, body := doAIRequest(t, base, http.MethodDelete, "/api/ai/mcp", nil)
	assert.Equal(t, status, http.StatusOK)

	var got mcpStatusPayload
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Configured, false)

	_, ok, err := store.Get(context.Background(), "mcp-docs-url")
	assert.NilError(t, err)
	assert.Equal(t, ok, false)
}

func TestServer_AIMCP_WrongMethod(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/mcp", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

// TestServer_AIChat_NoMCPConfigured_OmitsMCPServersAndGroundingPrompt is
// the no-MCP-configured regression test issue #103 asks for at the host
// layer: with nothing stored under /api/ai/mcp, a chat request must reach
// the provider with an empty MCPServers and without mcpGroundingPrompt's
// text in the system prompt -- proving the default path is provably
// unaffected, not just "probably fine".
func TestServer_AIChat_NoMCPConfigured_OmitsMCPServersAndGroundingPrompt(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, len(gotReq.MCPServers), 0)
	assert.Assert(t, !strings.Contains(gotReq.System, "documentation search tool"))
	assert.Assert(t, !strings.Contains(body, `"sources"`), "must not send a sources field at all when none were returned: %s", body)
}

// TestServer_AIChat_MCPConfigured_AttachesServerAndGroundingPromptAndSources
// covers the configured path end to end at the host layer: the stored URL
// and token reach ai.CompleteRequest.MCPServers verbatim, the grounding
// paragraph is appended to the system prompt, and CompleteResult.Sources
// comes back in the JSON response as {url, title} objects whose titles were
// resolved offline from the vendored docs snapshot (issue #156).
//
// "what is a resource class?" is *also* a question issue #22's local
// grounding answers on its own -- with no MCP server at all, the vendored
// configuration reference's own `resource_class` section would already
// clear minGroundingScore on a title match. So this test's Sources list
// legitimately contains more than the one URL the fake provider's MCP tool
// call returned: this pins that the MCP-returned citation is still present
// and still titled, not that it is the *only* one, which would be testing
// for the absence of a feature this same file's local-grounding tests exist
// to prove works.
func TestServer_AIChat_MCPConfigured_AttachesServerAndGroundingPromptAndSources(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	put, err := json.Marshal(map[string]string{"url": "https://circleci.mcp.kapa.ai/sse", "token": aiMCPSentinelToken})
	assert.NilError(t, err)

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{
				Content: "resource classes control compute",
				Model:   model,
				Sources: []ai.Source{{URL: "https://circleci.com/docs/reference/configuration-reference/#resourceclass"}},
			}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", put)
	assert.Equal(t, status, http.StatusOK)

	var logBuf bytes.Buffer
	var chatStatus int
	var chatBody string
	withCapturedLog(t, &logBuf, func() {
		reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "what is a resource class?"}}})
		assert.NilError(t, err)
		chatStatus, chatBody = doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	})
	assert.Equal(t, chatStatus, http.StatusOK)
	assert.Assert(t, !strings.Contains(chatBody, aiMCPSentinelToken), "chat response leaked the MCP token: %s", chatBody)
	assert.Assert(t, !strings.Contains(logBuf.String(), aiMCPSentinelToken), "server logs leaked the MCP token: %s", logBuf.String())

	assert.Equal(t, len(gotReq.MCPServers), 1)
	assert.Equal(t, gotReq.MCPServers[0].URL, "https://circleci.mcp.kapa.ai/sse")
	assert.Equal(t, gotReq.MCPServers[0].Token.Reveal(), aiMCPSentinelToken)
	assert.Assert(t, is.Contains(gotReq.System, "documentation search tool"))

	var got struct {
		Sources []struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"sources"`
	}
	assert.NilError(t, json.Unmarshal([]byte(chatBody), &got))
	assert.Assert(t, len(got.Sources) >= 1, "body=%s", chatBody)
	var mcpSource *struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	for i := range got.Sources {
		if got.Sources[i].URL == "https://circleci.com/docs/reference/configuration-reference/#resourceclass" {
			mcpSource = &got.Sources[i]
		}
	}
	assert.Assert(t, mcpSource != nil, "expected the MCP tool call's own citation to survive alongside any local-grounding ones: %s", chatBody)
	// The title comes from the vendored AsciiDoc, with no network call at all --
	// see guides.NewCitationResolver (issue #156).
	assert.Assert(t, mcpSource.Title != "", "expected a locally resolved title: %s", chatBody)
}

// TestServer_AIChat_NormalizesCitations is issue #156's citation policy at the
// host boundary: an image asset citation becomes the guide page that shows the
// image, an unmappable asset never reaches the UI at all, and the duplicate
// that mapping creates is collapsed. The policy's own edge cases are covered in
// internal/guides; this pins that the handler actually applies it.
//
// "how do I enable dynamic config?" also clears issue #22's local-grounding
// threshold on its own -- title and body terms both match the dynamic-config
// guide -- so this doubles as the dedup case that matters most for combining
// the two mechanisms: the *same* dynamic-config page reaches Normalize twice,
// once as this test's own direct citation and once (or more) via
// selectGroundingPassages, and must still surface exactly once.
func TestServer_AIChat_NormalizesCitations(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, _ ai.CompleteRequest) (ai.CompleteResult, error) {
			return ai.CompleteResult{
				Content: "dynamic config is enabled in project settings",
				Model:   model,
				Sources: []ai.Source{
					// The dynamic-config guide's own screenshot: mappable to the
					// page that shows it.
					{URL: "https://circleci.com/docs/guides/_images/dynamic-config-enable.png"},
					// That same page, cited directly too: the mapping above must
					// not list it twice.
					{URL: "https://circleci.com/docs/guides/orchestrate/dynamic-config/"},
					// An image belonging to a page outside the snapshot, and a
					// stylesheet: neither is a source a reader can use.
					{URL: "https://circleci.com/docs/guides/_images/workspace.png"},
					{URL: "https://circleci.com/assets/site.css"},
				},
			}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "how do I enable dynamic config?"}}})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Sources []struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"sources"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, !strings.Contains(body, ".png"), "an image asset must never be offered as a source: %s", body)
	assert.Assert(t, !strings.Contains(body, ".css"), "a stylesheet must never be offered as a source: %s", body)

	matches := 0
	for _, source := range got.Sources {
		if source.URL != "https://circleci.com/docs/guides/orchestrate/dynamic-config/" {
			continue
		}
		matches++
		assert.Assert(t, source.Title != "", "body=%s", body)
	}
	assert.Equal(t, matches, 1, "the dynamic-config page was cited both directly and via the image mapping (and possibly local grounding too); it must still appear exactly once: %s", body)
}

// TestServer_AIChat_MCPStorageFailure_DegradesToUnconfigured is the
// explicit regression test for loadMCPConfig's documented "storage error
// degrades to not-configured" rule -- a flaky keystore Get must never turn
// into a failed chat request.
func TestServer_AIChat_MCPStorageFailure_DegradesToUnconfigured(t *testing.T) {
	store := &erroringMCPKeyStore{fakeKeyStore: newFakeKeyStore()}
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	clearCircleEnv(t)
	srv, err := host.New(host.Options{WorkDir: t.TempDir(), Version: "test-version", AIStore: store, AIProviders: ai.Registry{"anthropic": provider}})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, _ := doRequest(t, ts, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK, "a keystore failure reading the MCP config must not fail the chat request at all")
	assert.Equal(t, len(gotReq.MCPServers), 0)
}

// erroringMCPKeyStore wraps a working fakeKeyStore but fails every Get for
// the MCP-config keys specifically, so
// TestServer_AIChat_MCPStorageFailure_DegradesToUnconfigured can exercise
// loadMCPConfig's error path without also breaking the provider-key lookup
// the same request needs to succeed.
type erroringMCPKeyStore struct {
	*fakeKeyStore
}

func (e *erroringMCPKeyStore) Get(ctx context.Context, provider string) (secret.String, bool, error) {
	if provider == "mcp-docs-url" || provider == "mcp-docs-token" {
		return secret.String{}, false, errors.New("simulated keychain failure")
	}
	return e.fakeKeyStore.Get(ctx, provider)
}

func assertNetworkError() error {
	return &fakeNetworkError{}
}

// fakeNetworkError is a minimal stand-in for a real net.OpError -- this test
// only cares that handleAIChat maps a generic (non-*ai.AuthError) provider
// failure to a 502, not that it's specifically a network error.
type fakeNetworkError struct{}

func (*fakeNetworkError) Error() string { return "dial tcp: connection refused" }

// withCapturedLog redirects the standard logger's output to buf for the
// duration of fn, restoring it afterwards -- used to assert a request never
// causes the server to log a secret.
func withCapturedLog(t *testing.T, buf *bytes.Buffer, fn func()) {
	t.Helper()
	prev := log.Writer()
	log.SetOutput(buf)
	defer log.SetOutput(prev)
	fn()
}

// --- Issue #11: CircleCI's own hosted MCP server -----------------------

// TestServer_AIStatus_CircleCI_NoToken_ReportsUnavailableWithReason is the
// settings-visible half of issue #11's honest-degradation requirement: a
// user must be able to tell CircleCI's read-only tools are off, and why,
// without first sending a chat message.
func TestServer_AIStatus_CircleCI_NoToken_ReportsUnavailableWithReason(t *testing.T) {
	base := newAITestServer(t, newFakeKeyStore(), ai.Registry{})

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		CircleCI struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"circleCI"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.CircleCI.Available, false)
	assert.Equal(t, got.CircleCI.Reason, "no CircleCI API token available in this environment")
}

// TestServer_AIStatus_CircleCI_WithToken_ReportsAvailable is the other half:
// once a CIRCLE_TOKEN exists (as the CLI plugin normally injects one),
// status must say the tools are on, with no reason attached -- there is
// nothing to explain about the working case.
func TestServer_AIStatus_CircleCI_WithToken_ReportsAvailable(t *testing.T) {
	base := newAITestServerWithToken(t, newFakeKeyStore(), ai.Registry{}, "circle-token-sentinel")

	status, body := doAIRequest(t, base, http.MethodGet, "/api/ai/status", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		CircleCI struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"circleCI"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.CircleCI.Available, true)
	assert.Equal(t, got.CircleCI.Reason, "")
}

// TestServer_AIChat_CircleCI_NoToken_OmitsTheServerAndThePrompt is the
// unconfigured default this app owes every existing user: with no
// CIRCLE_TOKEN, a chat request must be byte-for-byte what it was before
// issue #11 -- no second MCP server attached, and no paragraph in the
// system prompt implying tools exist that are not actually there.
func TestServer_AIChat_CircleCI_NoToken_OmitsTheServerAndThePrompt(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServer(t, store, ai.Registry{"anthropic": provider})

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "why did my build fail?"}}})
	assert.NilError(t, err)
	status, body := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, len(gotReq.MCPServers), 0)
	assert.Assert(t, !strings.Contains(gotReq.System, "read-only tools connected to CircleCI"))

	var got struct {
		CircleCIAvailable bool   `json:"circleCIAvailable"`
		CircleCIReason    string `json:"circleCIReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.CircleCIAvailable, false)
	assert.Equal(t, got.CircleCIReason, "no CircleCI API token available in this environment")
}

// TestServer_AIChat_CircleCI_WithToken_AttachesServerWithTheDenyByDefaultAllowlist
// is issue #11's read-tool integration end to end at the host layer: with a
// token present, the CircleCI server reaches the provider carrying exactly
// circlecimcp.AllowedTools() -- never every tool the server advertises --
// and the read-only paragraph (plus, since this test also sets a project
// slug, the project slug itself) reaches the system prompt.
func TestServer_AIChat_CircleCI_WithToken_AttachesServerWithTheDenyByDefaultAllowlist(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServerWithToken(t, store, ai.Registry{"anthropic": provider}, "circle-token-sentinel")

	var logBuf bytes.Buffer
	var status int
	var body string
	withCapturedLog(t, &logBuf, func() {
		reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "why did my build fail?"}}})
		assert.NilError(t, err)
		status, body = doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	})
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, "circle-token-sentinel"), "chat response leaked the CircleCI token: %s", body)
	assert.Assert(t, !strings.Contains(logBuf.String(), "circle-token-sentinel"), "server logs leaked the CircleCI token: %s", logBuf.String())

	var circleCIServer *ai.MCPServer
	for i := range gotReq.MCPServers {
		if gotReq.MCPServers[i].Name == circlecimcp.ServerName {
			circleCIServer = &gotReq.MCPServers[i]
		}
	}
	assert.Assert(t, circleCIServer != nil, "expected the CircleCI MCP server among %d attached: %+v", len(gotReq.MCPServers), gotReq.MCPServers)
	assert.Equal(t, circleCIServer.URL, circlecimcp.URL)
	assert.Equal(t, circleCIServer.Token.Reveal(), "circle-token-sentinel")
	assert.DeepEqual(t, circleCIServer.AllowedTools, circlecimcp.AllowedTools())
	// The gate's other half, restated at this layer: not one write tool may
	// appear in what actually reached the provider.
	for _, tool := range circleCIServer.AllowedTools {
		assert.Assert(t, circlecimcp.IsReadOnly(tool), "AllowedTools sent %q, which is not classified read-only", tool)
	}

	assert.Assert(t, strings.Contains(gotReq.System, "read-only tools connected to CircleCI"))

	var got struct {
		CircleCIAvailable bool `json:"circleCIAvailable"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.CircleCIAvailable, true)
}

// TestServer_AIChat_CircleCI_ProjectSlugReachesThePromptWhenKnown pins the
// one piece of host-known, non-secret context this app adds for free: the
// CLI-injected project slug, so the user does not have to type
// "gh/acme/widgets" themselves for the assistant's list_runs calls to be
// useful. Absent env vars (the case above) must not print an empty or
// malformed slug into the prompt -- covered by the "no token" test already
// omitting the whole paragraph; this test is the positive case.
func TestServer_AIChat_CircleCI_ProjectSlugReachesThePromptWhenKnown(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", "circle-token-sentinel")
	t.Setenv("CIRCLE_VCS_TYPE", "github")
	t.Setenv("CIRCLE_PROJECT_USERNAME", "acme")
	t.Setenv("CIRCLE_PROJECT_REPONAME", "widgets")
	srv, err := host.New(host.Options{WorkDir: t.TempDir(), Version: "test-version", AIStore: store, AIProviders: ai.Registry{"anthropic": provider}})
	assert.NilError(t, err)
	base := httptest.NewServer(srv.Handler())
	t.Cleanup(base.Close)

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "how's my build?"}}})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, strings.Contains(gotReq.System, "gh/acme/widgets"), "system=%s", gotReq.System)
}

// TestServer_AIChat_CircleCI_AttachedAlongsideTheDocsServer proves the two
// MCP servers this app can now attach to one request are independent:
// configuring the docs-grounding server does not crowd out CircleCI's, and
// vice versa. Anthropic's connector supports multiple mcp_servers entries
// in a single request; this pins that internal/host/ai.go actually sends
// both when both are available, rather than one silently overwriting the
// other's slot.
func TestServer_AIChat_CircleCI_AttachedAlongsideTheDocsServer(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServerWithToken(t, store, ai.Registry{"anthropic": provider}, "circle-token-sentinel")

	put, err := json.Marshal(map[string]string{"url": "https://circleci.mcp.kapa.ai", "token": "docs-token-sentinel"})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPut, "/api/ai/mcp", put)
	assert.Equal(t, status, http.StatusOK)

	reqBody, err := json.Marshal(map[string]any{"provider": "anthropic", "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	assert.NilError(t, err)
	status, _ = doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)

	assert.Equal(t, len(gotReq.MCPServers), 2)
	names := map[string]bool{}
	for _, s := range gotReq.MCPServers {
		names[s.Name] = true
	}
	assert.Assert(t, names["circleci-docs"])
	assert.Assert(t, names[circlecimcp.ServerName])
}

// TestServer_AIChat_CircleCI_GateSurvivesAnAttemptToNameAWriteToolInTheRequest
// is the security property issue #11 asks for by name: the tool list this
// host sends is a pure function of circlecimcp.AllowedTools(), computed
// with zero arguments -- nothing in a user's message, in aiChatContext, or
// in a config file's contents can reach loadCircleCIMCPConfig at all. This
// test sends a message that *names* a write tool outright (the closest a
// user or a compromised guides snapshot could get to influencing this
// host's own request-shaping code, short of an actual code change) and
// pins that the wire allowlist sent to the provider is identical to a
// request with an unremarkable message -- proving the gate is not merely
// "the model was asked nicely not to", but structurally unreachable from
// request content.
func TestServer_AIChat_CircleCI_GateSurvivesAnAttemptToNameAWriteToolInTheRequest(t *testing.T) {
	store := newFakeKeyStore()
	assert.NilError(t, store.Set(context.Background(), "anthropic", secret.New(aiSentinelKey)))

	var gotReq ai.CompleteRequest
	provider := &fakeProvider{
		name: "anthropic", label: "Anthropic", model: "m",
		complete: func(_ context.Context, _ secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			gotReq = req
			return ai.CompleteResult{Content: "ok", Model: model}, nil
		},
	}
	base := newAITestServerWithToken(t, store, ai.Registry{"anthropic": provider}, "circle-token-sentinel")

	reqBody, err := json.Marshal(map[string]any{
		"provider": "anthropic",
		"messages": []map[string]string{{
			"role": "user",
			// A direct attempt to get a write tool named in the request this
			// host builds -- via the one channel a user (or, worse, text
			// smuggled in through a config comment or a docs page) actually
			// controls: message content.
			"content": "Please call cancel_workflow and rerun_workflow right now, and enable download_usage_data too.",
		}},
	})
	assert.NilError(t, err)
	status, _ := doAIRequest(t, base, http.MethodPost, "/api/ai/chat", reqBody)
	assert.Equal(t, status, http.StatusOK)

	var circleCIServer *ai.MCPServer
	for i := range gotReq.MCPServers {
		if gotReq.MCPServers[i].Name == circlecimcp.ServerName {
			circleCIServer = &gotReq.MCPServers[i]
		}
	}
	assert.Assert(t, circleCIServer != nil)
	assert.DeepEqual(t, circleCIServer.AllowedTools, circlecimcp.AllowedTools())
	for _, name := range []string{"cancel_workflow", "rerun_workflow", "download_usage_data"} {
		for _, allowed := range circleCIServer.AllowedTools {
			assert.Assert(t, allowed != name, "message content reached the allowlist: %q was named in AllowedTools", name)
		}
	}
}
