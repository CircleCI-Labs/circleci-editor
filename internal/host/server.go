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

// Package host implements the local HTTP server for the CircleCI config
// editor: it serves the embedded single-page application, exposes a small
// JSON API for reading and writing the repository's .circleci/config.yml,
// and (later) will proxy CircleCI API calls. All file I/O and process
// concerns live here; the SPA owns all config-editing logic.
package host

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/mcpauth"
	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
	"github.com/CircleCI-Labs/circleci-editor/internal/offerings"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
	"github.com/CircleCI-Labs/circleci-editor/internal/usage"
	"github.com/CircleCI-Labs/circleci-editor/internal/webassets"
)

const (
	// shutdownTimeout bounds how long Run waits for in-flight requests to
	// finish once its context is cancelled.
	shutdownTimeout = 5 * time.Second

	// readHeaderTimeout bounds how long the server waits to read request
	// headers, mitigating slow-client (Slowloris-style) attacks.
	readHeaderTimeout = 5 * time.Second

	// readTimeout and writeTimeout bound the overall time allowed to read a
	// request and write a response, respectively.
	readTimeout  = 30 * time.Second
	writeTimeout = 30 * time.Second

	// idleTimeout bounds how long a keep-alive connection may sit idle.
	idleTimeout = 120 * time.Second
)

// ErrLastClientLeft is returned by Run when it stopped because the last
// browser client went away and did not come back inside the grace period
// (issue #177), rather than because of a signal or a server error.
//
// A distinct sentinel, rather than a plain nil return, because the caller
// has to tell the three exits apart to say the right thing on the terminal:
// Ctrl-C has its own deliberately calm line (issue #67; that wording is
// load-bearing and must not change), this exit needs a different
// explanation, and a real failure needs neither.
var ErrLastClientLeft = errors.New("host: last browser client left")

// Options configures a Server.
type Options struct {
	// Port is the TCP port to listen on. If zero, a free port is chosen
	// automatically via ChooseFreePort.
	Port int

	// ConfigPath, if non-empty, is used as the CircleCI config file path
	// instead of discovering one by walking up from WorkDir.
	ConfigPath string

	// OpenBrowser controls whether Run opens the user's browser once the
	// server is listening.
	OpenBrowser bool

	// AppMode requests a chromeless app-style browser window (see
	// OpenURL) rather than a normal browser tab.
	AppMode bool

	// Debug turns on this host's progress and bookkeeping output (issue
	// #216). Off by default, which is the point: without it the terminal
	// shows the CLI's startup banner and then nothing until something
	// actionable happens or the process stops.
	//
	// It never gates a failure, a warning that names a fix, or either exit
	// line -- see internal/host/logging.go for the two levels and the test
	// for which one a line belongs to -- and it never causes anything
	// sensitive to be logged, because nothing sensitive is logged at any
	// verbosity.
	Debug bool

	// StopOnLastClient makes Run exit, returning ErrLastClientLeft, once
	// every browser client has been gone for LastClientGrace (issue #177:
	// closing the editor window should stop the process, not leave it
	// running in a terminal the user has stopped looking at).
	//
	// Off by default at this layer, and deliberately not inferred from
	// AppMode/OpenBrowser here: the policy -- which modes it applies to,
	// and the --keep-alive escape hatch -- belongs to the CLI that owns the
	// flags, and a library caller embedding this Server should not have its
	// process exit because of a decision this package made for it. See
	// cmd/circleci-editor's stopOnLastClient.
	StopOnLastClient bool

	// LastClientGrace overrides how long Run waits, after the last client
	// disconnects, before treating the editor as closed. Zero (the normal
	// case) selects lastClientGrace, which is the same in every mode and
	// documented at length in internal/host/clients.go. Non-zero values
	// exist for tests, which would otherwise have to sleep for real
	// seconds.
	LastClientGrace time.Duration

	// Version is the editor's version string, surfaced via GET /api/meta.
	Version string

	// WorkDir is the directory config discovery starts from, and the value
	// reported as the server's working directory. It defaults to the
	// process's current directory when empty.
	WorkDir string

	// Compiler overrides the CircleCI config-compiler client used by
	// POST /api/validate. It exists so tests can substitute a fake;
	// production callers should leave it nil, in which case New
	// constructs a real circleci.Client from the loaded Environment.
	Compiler configCompiler

	// OrbCache overrides the searchable orb cache used by
	// GET /api/orbs/search. It exists so tests can substitute a fake;
	// production callers should leave it nil, in which case New
	// constructs a real orbs.Cache (and, unlike a test fake, has New also
	// arrange for Run to warm it — see cacheWarmer).
	OrbCache orbCache

	// OrbClient overrides the CircleCI client used by
	// GET /api/orbs/source to resolve an orb name to its source YAML. It
	// exists so tests can substitute a fake; production callers should
	// leave it nil.
	OrbClient orbSourceClient

	// AIStore overrides the keystore.Store used by the /api/ai/key and
	// /api/ai/chat endpoints to persist/read provider API keys. It exists
	// so tests can substitute a fake (never touching a real OS keychain or
	// file) without an env var dance; production callers should leave it
	// nil, in which case New calls keystore.Open().
	AIStore keystore.Store

	// AIProviders overrides the ai.Registry of available AI providers.
	// It exists so tests can substitute a fake provider (making no real
	// network calls); production callers should leave it nil, in which
	// case New registers the real Anthropic provider.
	AIProviders ai.Registry

	// MCPAuthClient overrides the OAuth client used by the
	// /api/ai/mcp/oauth endpoints to sign in to a docs-grounding MCP server
	// (issue #103). It exists so tests can point the whole flow -- discovery,
	// dynamic client registration, token exchange, refresh -- at an
	// httptest TLS server, using deliberately invalid credentials and never
	// a real one. Production callers should leave it nil, in which case
	// mcpAuthClient builds a real client per call.
	//
	// A TLS test server specifically, not a plain http one: internal/ai/mcpauth
	// rejects every non-https endpoint a metadata document hands it, and
	// that check is load-bearing enough that a test seam which bypasses it
	// would be testing something this app never does.
	MCPAuthClient *mcpauth.Client
	// DockerTagsCache overrides the cache used by GET /api/docker-tags to
	// resolve a `cimg/*` image's recent version tags. It exists so tests
	// can substitute a fake without making any real Docker Hub requests;
	// production callers should leave it nil, in which case New constructs
	// a real dockerhub.Cache. Unlike OrbCache, this needs no CIRCLE_TOKEN
	// gating (Docker Hub's tag-listing API is public) and no startup
	// warming (dockerhub.Cache fetches lazily, per-repo, on first request --
	// see its own doc comment for why eagerly warming ~20 repos on every
	// launch would be wasted work most sessions never need).
	DockerTagsCache dockerTagsCache

	// GuidesCache overrides the cache backing GET /api/guides (issue #104).
	// It exists so tests can substitute a fake without parsing the whole
	// vendored snapshot or making any network request; production callers
	// should leave it nil, in which case New constructs a real
	// guides.Cache and Run starts it. Like DockerTagsCache this needs no
	// CIRCLE_TOKEN, and unlike OrbCache it is *always* startable: its first
	// stage parses an embedded snapshot and touches no network at all.
	GuidesCache guidesCache
	// OfferingsCache overrides the cache backing GET /api/machine-offerings
	// (issue #305): CircleCI's live machine-image catalog. It exists so
	// tests can substitute a fake without making any real network request;
	// production callers should leave it nil, in which case New constructs
	// a real offerings.Cache. Like DockerTagsCache this needs no
	// CIRCLE_TOKEN (the upstream endpoint answers unauthenticated -- see
	// internal/circleci.GetOfferings) and no startup warming (the cache
	// fetches lazily, on first use -- see internal/offerings' own doc
	// comment for why).
	OfferingsCache offeringsCache
	// ProjectClient overrides the CircleCI client used by
	// GET /api/project-context (and its /variables sibling) to read
	// read-only project authoring metadata: contexts, environment variable
	// names and project settings. It exists so tests can substitute a fake
	// -- which matters more here than elsewhere, because the real endpoints
	// return secret *metadata* and no test should ever be in a position to
	// fetch any. Production callers should leave it nil.
	ProjectClient projectMetadataClient
	// PolicyClient overrides the CircleCI client used by
	// POST /api/policy/decide to evaluate a config against the
	// organization's config-policy bundle (issue #215). It exists for the
	// same reason ProjectClient does, one step further: no test should be in
	// a position to post a real config to CircleCI. Production callers
	// should leave it nil.
	PolicyClient policyDecider
	// RunClient overrides the CircleCI client used by POST /api/run to
	// trigger a one-shot pipeline with an uncommitted config (issue #194).
	//
	// It exists for a stronger version of the reason PolicyClient does. A
	// test that reached the real endpoint would not merely leak a config: it
	// would start a build in somebody's organization, spend their credits and
	// appear in their dashboard. Every test in this package that can reach
	// this endpoint must set it. Production callers should leave it nil.
	RunClient pipelineRunner

	// UsageCache overrides the background-warmed Usage Export summary used
	// by GET /api/usage to power resource-class right-sizing suggestions
	// (issue #307). It exists so tests can substitute a fake without
	// creating a real usage-export job against any organization -- doing so
	// for real downloads and reads every project's usage, which no test may
	// do. Production callers should leave it nil, in which case New
	// constructs a real usage.Cache (only when a token and a resolvable
	// organization slug are both available -- see buildCircleCIClients) and
	// Run warms it the same way it warms the orb registry.
	UsageCache usageCache
}

// pipelineRunner is the subset of *circleci.Client that handleRun and
// handleRunAvailability need.
//
// The read methods are here because availability is *checked* before a run is
// offered and again before one is fired; the write method is the one thing in
// this whole host that spends the user's money.
//
// TriggerPipelineWithConfig, and no plain TriggerPipeline. The endpoint behind
// it is CircleCI's ordinary trigger endpoint -- omitting the config field
// builds whatever is committed to the branch -- and this interface names no
// method that could do that. Running the config in front of you is authoring
// feedback; re-running the committed config is an operational act this
// editor hands to the web UI. Same technique as
// projectMetadataClient's absent writes and policyDecider's absent `policy
// push`, with higher stakes: the wrong call here would not exceed scope
// quietly, it would bill someone.
type pipelineRunner interface {
	GetProject(ctx context.Context, projectSlug string) (*circleci.Project, error)
	GetProjectSettings(ctx context.Context, projectID string) (*circleci.ProjectSettings, error)
	GetOrgSettings(ctx context.Context, orgID string) (*circleci.OrgSettings, error)

	// ListPipelineDefinitions supplies the routing evidence: a definition's
	// `config_source.provider` is what decides which of the two trigger
	// endpoints will actually honour an inline config.
	ListPipelineDefinitions(ctx context.Context, projectID string) ([]circleci.PipelineDefinition, error)

	// The two trigger endpoints. Both are here because neither serves every
	// project: the legacy one is the only one that honours an inline config
	// on a classic GitHub OAuth project, and the newer one is the only one
	// that serves GitHub App and GitLab projects at all. See
	// circleci.ConfigRoute.
	TriggerPipelineWithConfig(ctx context.Context, req circleci.TriggerPipelineWithConfigRequest) (*circleci.Pipeline, error)
	TriggerPipelineRunWithConfig(ctx context.Context, req circleci.TriggerPipelineWithConfigRequest) (*circleci.Pipeline, error)

	// GetPipelineConfig reads back the config a pipeline actually ran, so a
	// silently ignored inline config is caught rather than reported as a
	// success. Routing is the primary defence; this checks it was right.
	GetPipelineConfig(ctx context.Context, pipelineID string) (*circleci.PipelineConfig, error)
}

// policyDecider is the subset of *circleci.Client that handlePolicyDecide
// needs: resolve the org slug to the UUID the policy API is keyed by, then
// ask for a decision.
//
// Both methods are reads, and that is the point rather than a coincidence.
// CircleCI's policy API also creates, replaces and deletes policy bundles
// (`circleci policy push` and friends); not naming any of those here means no
// handler in this package can reach one, which is the read-only boundary
// issue #215 requires expressed as a type — the same technique
// projectMetadataClient uses for context writes.
type policyDecider interface {
	GetOrganization(ctx context.Context, slug string) (*circleci.Organization, error)
	DecidePolicy(ctx context.Context, req circleci.PolicyDecisionRequest) (*circleci.PolicyDecision, error)
}

// configCompiler is the subset of *circleci.Client that handleValidate
// needs. It is defined here (rather than depended on directly) so tests can
// substitute a fake without making any HTTP calls.
type configCompiler interface {
	CompileConfig(ctx context.Context, req circleci.CompileRequest) (*circleci.CompileResult, error)
}

// orbCache is the subset of *orbs.Cache that handleOrbsSearch needs.
//
// SearchFiltered rather than Search: the handler always has a filter to apply
// (orbs.FilterAll when the request named none) and always needs the match
// counts that come back with it, so there is nothing left for the unfiltered
// form to serve here.
//
// Refresh (issue #285) is here rather than on a separate interface: the one
// handler that can trigger a manual re-crawl is the same one that already
// reports Status/results, and splitting it into a second interface would only
// mean a second fake for every test that wants to assert on both.
type orbCache interface {
	Status() orbs.Status
	SearchFiltered(query string, filter orbs.Filter, limit int) orbs.Page
	Refresh(ctx context.Context)
}

// orbSourceClient is the subset of *circleci.Client that handleOrbsSource
// needs to resolve an orb name (and optional version) to its raw YAML
// source.
type orbSourceClient interface {
	GetOrbPackageByName(ctx context.Context, name string) (*circleci.OrbPackage, error)
	GetOrbSource(ctx context.Context, versionID string) (string, error)
}

// guidesCache is the subset of *guides.Cache that handleGuides needs.
//
// Refresh (issue #285) is the manual "check now" counterpart to the
// background refresh Start already schedules -- kept on this interface
// rather than a separate one for the same reason orbCache's is: one handler
// needs both.
type guidesCache interface {
	Guides() ([]guides.Guide, guides.Provenance, error)
	Refresh(ctx context.Context)
}

// projectMetadataClient is the subset of *circleci.Client the
// project-context endpoints need: the read-only project authoring metadata
// behind issue #105.
//
// Every method is a read. That is not incidental -- it is this editor's scope
// boundary (author, verify and launch, never administer) expressed as a type.
// Contexts and project environment variables both have perfectly good v2
// write endpoints; deliberately not naming them here means no handler in
// this package can reach one by accident.
type projectMetadataClient interface {
	GetProject(ctx context.Context, projectSlug string) (*circleci.Project, error)
	GetProjectSettings(ctx context.Context, projectID string) (*circleci.ProjectSettings, error)
	ListContexts(ctx context.Context, owner circleci.ContextOwner) ([]circleci.Context, error)
	ListContextVariables(ctx context.Context, contextID string) ([]circleci.ContextVariable, error)
	ListContextRestrictions(ctx context.Context, contextID string) ([]circleci.ContextRestriction, error)
	ListProjectVariables(ctx context.Context, projectSlug string) ([]circleci.ProjectVariable, error)
}

// cacheWarmer is implemented by *orbs.Cache. It is kept separate from the
// orbCache interface (rather than folding Start into it) so that Run only
// ever starts warming a real cache it constructed itself — never a fake
// supplied via Options.OrbCache for tests, and never before Run (as opposed
// to New) actually begins serving.
type cacheWarmer interface {
	Start(ctx context.Context)
}

// Server serves the CircleCI config editor: the embedded SPA plus its JSON
// API.
type Server struct {
	opts            Options
	configFile      ConfigFile
	configFound     bool
	env             Environment
	compiler        configCompiler
	orbCache        orbCache
	orbClient       orbSourceClient
	orbSourceCache  *orbSourceCache
	orbWarmer       cacheWarmer // nil when OrbCache was overridden (e.g. in tests): see cacheWarmer.
	guides          guidesCache
	guidesWarmer    cacheWarmer // nil when GuidesCache was overridden for a test; see guidesWarmer's assignment in New.
	aiStore         keystore.Store
	aiProviders     ai.Registry
	port            int
	mux             http.Handler
	dockerTagsCache dockerTagsCache
	offeringsCache  offeringsCache

	// csrfToken is this launch's per-launch CSRF token (issue: confirmed CSRF
	// exposure on the local API), generated once in New via
	// generateCSRFToken and never rotated for the life of this process. See
	// csrf.go's package-level doc comment for the whole threat model; the
	// short version is that a loopback bind is not, by itself, a trust
	// boundary against the browser sitting in front of it, and this is the
	// secret that lets this host tell "the page it actually served" apart
	// from "any other page the user has open".
	csrfToken string

	// clients counts attached browser clients (open /api/heartbeat
	// streams) and is what Run's last-client exit watches. Constructed in
	// New rather than Run, and never nil, because handlers that record a
	// client or take a hold run in tests that use Handler() directly and
	// never call Run at all -- the same reason shutdownCtx starts as
	// context.Background(). With nothing watching it, tracking is simply
	// bookkeeping nobody reads.
	clients *clientTracker

	// projectClient is nil when this host has no CIRCLE_TOKEN: there is
	// nothing a project-metadata client could usefully do without one, and
	// the handlers refuse before reaching it anyway (see
	// projectContextUnavailable).
	projectClient projectMetadataClient

	// projectContextCache and contextVariablesCache are in-memory only,
	// never persisted -- see projectContextCache's doc comment for why
	// secret metadata deliberately does not get the disk treatment
	// internal/orbs.Cache gets.
	projectContextCache   *projectContextCache[projectContextResponse]
	contextVariablesCache *projectContextCache[contextVariablesResponse]

	// policyClient is nil when this host has no CIRCLE_TOKEN, for the same
	// reason projectClient is: handlePolicyDecide refuses before it would be
	// consulted, and "no token" stays one obvious state rather than a client
	// that fails every call.
	policyClient policyDecider

	// policyOwners caches org-slug-to-UUID resolutions for the policy
	// endpoint. Nothing secret and nothing large: one UUID per org, which in
	// practice means one entry.
	policyOwners *policyOwnerResolver

	// runClient is nil when this host has no CIRCLE_TOKEN, for the same
	// reason projectClient and policyClient are -- and here the nil matters
	// most, because this is the client that spends money: a run endpoint
	// holding a client that exists but cannot authenticate is a strictly
	// worse thing to have lying around than one holding nothing.
	runClient pipelineRunner

	// usageCache is nil when this host has no CIRCLE_TOKEN or no resolvable
	// organization slug -- handleUsage reports why via
	// usageUnavailableReason rather than holding a cache that could never
	// answer. usageWarmer is nil whenever usageCache was overridden via
	// Options (tests): Run must never warm a fake.
	usageCache  usageCache
	usageWarmer cacheWarmer

	// shutdownCtx is the context Run is serving under, read by
	// handleHeartbeat so a long-lived SSE connection can notice a
	// Ctrl-C/SIGTERM shutdown and return immediately instead of blocking
	// http.Server.Shutdown (see that handler's doc comment). It starts as
	// context.Background() -- never cancelled -- so a Server used directly
	// via Handler() in a test without ever calling Run (as most of this
	// package's tests do) still serves a working, if never-shutting-down,
	// heartbeat stream. Run overwrites it before the listener starts
	// accepting connections, and never again afterward, so no
	// synchronization is needed for handlers reading it -- see Run's own
	// comment at the assignment.
	shutdownCtx context.Context

	// mcpOAuthMu guards mcpOAuth, which tracks the single in-flight
	// interactive sign-in to the docs-grounding MCP server (issue #103).
	// Unlike shutdownCtx this genuinely is mutated while handlers run -- a
	// background goroutine records the flow's outcome while the SPA polls
	// GET /api/ai/mcp/oauth -- hence the mutex. See internal/host/mcpoauth.go
	// for the flow, and mcpOAuthFlow's doc comment for why exactly one flow
	// is tracked and why none of its secret state is ever persisted.
	mcpOAuthMu sync.Mutex
	mcpOAuth   *mcpOAuthFlow
	// mcpAuthOverride points the OAuth flow at a test authorization server.
	// Nil in production, where mcpAuthClient builds a fresh client per call.
	mcpAuthOverride *mcpauth.Client
}

// New constructs a Server from opts. It resolves the config file to edit
// (tolerating the case where none exists yet) and loads the CircleCI CLI
// plugin environment, but does not bind a listener; call Run to start
// serving.
func New(opts Options) (*Server, error) {
	if opts.WorkDir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("host: get working directory: %w", err)
		}
		opts.WorkDir = wd
	}
	if opts.Version == "" {
		opts.Version = "dev"
	}

	configFile, err := FindConfigFile(opts.WorkDir, opts.ConfigPath)
	configFound := true
	if err != nil {
		if !errors.Is(err, ErrConfigNotFound) {
			return nil, fmt.Errorf("host: locate config file: %w", err)
		}
		configFound = false
	}

	port := opts.Port
	if port == 0 {
		port, err = ChooseFreePort()
		if err != nil {
			return nil, fmt.Errorf("host: choose free port: %w", err)
		}
	}

	// Minted once per launch, from crypto/rand -- see csrf.go's package doc
	// comment for why this exists at all. Resolved here, before s is
	// constructed, so it can go straight into the struct literal below like
	// every other field New resolves ahead of assembly.
	csrfToken, err := generateCSRFToken()
	if err != nil {
		return nil, err
	}

	env := LoadEnvironment()

	// The two verbosity levels, resolved once (see internal/host/logging.go).
	// debugf carries progress and bookkeeping and vanishes without --debug;
	// noticef carries the lines a user is worse off not seeing and always
	// prints.
	debugf := debugLogf(opts.Debug)
	noticef := noticeLogf()

	// One shared *circleci.Client, constructed only if something actually needs
	// it, and only after every Options override has been honoured. Extracted
	// into its own function because New was over gocyclo's limit: the branching
	// here is a list of independent "did the caller supply this one?" questions
	// and reads better on its own than inline.
	clients, orbWarmer, err := buildCircleCIClients(opts, env, debugf)
	if err != nil {
		return nil, err
	}
	compiler := clients.compiler
	orbCacheImpl := clients.orbCache
	orbClientImpl := clients.orbClient
	projectClientImpl := clients.projectClient
	policyClientImpl := clients.policyClient
	runClientImpl := clients.runClient
	usageCacheImpl := clients.usageCache
	usageWarmer := clients.usageWarmer

	aiStore := opts.AIStore
	if aiStore == nil {
		// A notice, deliberately: aiStoreFromEnv logs exactly one line, and
		// it explains why the AI pane will report every provider as
		// unconfigured. Hiding that behind --debug would leave a user
		// staring at a pane that says "no key" when they have one stored.
		aiStore = aiStoreFromEnv(noticef)
	}
	aiProviders := opts.AIProviders
	if aiProviders == nil {
		aiProviders = DefaultAIProviders()
	}

	// Constructed independently of the circleci client above: Docker Hub's
	// tag-listing API needs no CircleCI token at all (see
	// internal/dockerhub's package doc comment), so this must not be gated
	// behind (or skipped alongside) the "already have every CircleCI-backed
	// dependency" check that guards the block above. It does reuse the same
	// on-disk cache *directory* orbs.Cache warms into, just a different
	// file within it -- one cache root for the whole application (see
	// orbs.DefaultCacheDir).
	dockerTagsCacheImpl := opts.DockerTagsCache
	if dockerTagsCacheImpl == nil {
		cacheDir, dirErr := orbs.DefaultCacheDir()
		if dirErr != nil {
			debugf("warning: failed to resolve cache directory, docker image tag lookups will not persist across runs: %v", dirErr)
		}
		dockerTagsCacheImpl = dockerhub.New(dockerhub.NewClient(), cacheDir)
	}

	// The machine-offerings cache (issue #305) is independent of both blocks
	// above for the same reason DockerTagsCache is: GET /api/v3/catalog/offerings
	// answers unauthenticated (verified live -- see internal/circleci.GetOfferings),
	// so this needs no CIRCLE_TOKEN and must not be skipped for a host that has
	// none. It talks to CircleCI's own API rather than Docker Hub's, though, so
	// it gets its own *circleci.Client -- built the same way buildCircleCIClients
	// builds its shared one (env.Host, env.Token, which may be empty), rather
	// than depending on that function's own token-gated construction, which a
	// tokenless host can skip building at all.
	offeringsCacheImpl := opts.OfferingsCache
	if offeringsCacheImpl == nil {
		cacheDir, dirErr := orbs.DefaultCacheDir()
		if dirErr != nil {
			debugf("warning: failed to resolve cache directory, the machine-image catalog will not persist across runs: %v", dirErr)
		}
		offeringsClient, clientErr := circleci.NewClient(circleci.Config{
			Host:      env.Host,
			Token:     env.Token,
			UserAgent: "circleci-editor/" + opts.Version,
		})
		if clientErr != nil {
			return nil, fmt.Errorf("host: construct circleci client for machine offerings: %w", clientErr)
		}
		offeringsCacheImpl = offerings.New(offeringsClient, cacheDir)
	}

	// The guides cache, like the Docker Hub one, is independent of the
	// CircleCI client: it reads public GitHub raw content and needs no token.
	// It differs from both other caches in that its *first* stage needs no
	// network either -- it parses the AsciiDoc snapshot embedded in this
	// binary -- so it is always started, and GET /api/guides is answerable
	// from the moment the server is up. See internal/guides's package doc
	// comment (issue #104).
	guidesCacheImpl := opts.GuidesCache
	var guidesWarmer cacheWarmer
	if guidesCacheImpl == nil {
		cacheDir, dirErr := orbs.DefaultCacheDir()
		if dirErr != nil {
			debugf("warning: failed to resolve cache directory, refreshed documentation guides will not persist across runs: %v", dirErr)
		}
		// Two hooks, because internal/guides.Cache is the one cache whose
		// output straddles the levels: its refresh *checks* are bookkeeping
		// ("upstream is unchanged at abc123"), but a refresh *failure* is a
		// reason the docs pane is serving a stale snapshot, and issue #216
		// names it explicitly as something that must stay visible.
		realGuides := guides.NewCache(cacheDir, debugf, noticef)
		guidesCacheImpl = realGuides
		guidesWarmer = realGuides
	}

	s := &Server{
		opts:            opts,
		configFile:      configFile,
		configFound:     configFound,
		env:             env,
		compiler:        compiler,
		orbCache:        orbCacheImpl,
		orbClient:       orbClientImpl,
		orbSourceCache:  newOrbSourceCache(orbSourceCacheMaxEntries),
		orbWarmer:       orbWarmer,
		aiStore:         aiStore,
		aiProviders:     aiProviders,
		port:            port,
		dockerTagsCache: dockerTagsCacheImpl,
		offeringsCache:  offeringsCacheImpl,
		guides:          guidesCacheImpl,
		guidesWarmer:    guidesWarmer,
		shutdownCtx:     context.Background(),
		clients:         newClientTracker(time.Now),
		csrfToken:       csrfToken,

		projectClient:         projectClientImpl,
		projectContextCache:   newProjectContextCache[projectContextResponse](projectContextCacheTTL),
		contextVariablesCache: newProjectContextCache[contextVariablesResponse](projectContextCacheTTL),
		policyClient:          policyClientImpl,
		policyOwners:          newPolicyOwnerResolver(),
		runClient:             runClientImpl,
		mcpAuthOverride:       opts.MCPAuthClient,
		usageCache:            usageCacheImpl,
		usageWarmer:           usageWarmer,
	}

	mux, err := s.buildMux()
	if err != nil {
		return nil, err
	}
	s.mux = mux

	return s, nil
}

// buildMux constructs the server's routing table: the JSON API under /api,
// and the SPA (or dev proxy) for everything else.
// circleciClients are the CircleCI-backed collaborators New assembles: one
// per endpoint group, each either the caller's override or the one shared
// *circleci.Client.
type circleciClients struct {
	compiler      configCompiler
	orbCache      orbCache
	orbClient     orbSourceClient
	projectClient projectMetadataClient
	policyClient  policyDecider
	runClient     pipelineRunner

	// usageCache and usageWarmer follow orbCache/orbWarmer's own split: the
	// cache is what handleUsage consults, the warmer is what Run starts --
	// kept separate so a fake usageCache supplied via Options is never the
	// thing Run warms. usageWarmer is nil whenever usageCache was overridden
	// (by Options.UsageCache, or because this host has no token/org to scope
	// a usage export to at all).
	usageCache  usageCache
	usageWarmer cacheWarmer
}

// buildCircleCIClients resolves every CircleCI-backed collaborator, honouring
// Options overrides first and constructing at most one real client for
// whatever is left. It also returns the orb cache warmer, which is non-nil
// only when this function built the cache itself -- Run must never warm a fake
// supplied by a test.
//
// Three of the six are left nil when there is no CIRCLE_TOKEN. That is not an
// oversight: their handlers refuse before they would be consulted, and nil
// keeps "no token" a single obvious state rather than a client that exists and
// fails every call. See the Server fields' own comments.
func buildCircleCIClients(
	opts Options, env Environment, debugf func(string, ...any),
) (circleciClients, cacheWarmer, error) {
	out := circleciClients{
		compiler:      opts.Compiler,
		orbCache:      opts.OrbCache,
		orbClient:     opts.OrbClient,
		projectClient: opts.ProjectClient,
		policyClient:  opts.PolicyClient,
		runClient:     opts.RunClient,
		usageCache:    opts.UsageCache,
	}
	var orbWarmer cacheWarmer

	// A project-metadata client is only worth constructing when there is a
	// token for it to use: without one, GET /api/project-context refuses
	// before it would ever be consulted (projectContextUnavailable).
	needProjectClient := out.projectClient == nil && env.HasToken()

	// Same rule for the config-policy client: POST /api/policy/decide
	// refuses without a token before it would reach one.
	needPolicyClient := out.policyClient == nil && env.HasToken()

	// And for the run client: POST /api/run reports "no token" as an
	// availability state before it would reach one (see runAvailability).
	needRunClient := out.runClient == nil && env.HasToken()

	// A usage cache is only worth constructing when there is both a token
	// (the export endpoint needs one) and a resolvable organization slug
	// (the export is org-scoped, and there is no organization to scope it
	// to otherwise) -- handleUsage reports the specific reason via
	// usageUnavailableReason when this leaves out.usageCache nil.
	needUsageCache := out.usageCache == nil && env.HasToken() && env.OrgSlug() != ""

	if out.compiler != nil && out.orbCache != nil && out.orbClient != nil &&
		!needProjectClient && !needPolicyClient && !needRunClient && !needUsageCache {
		return out, nil, nil
	}

	client, err := circleci.NewClient(circleci.Config{
		Host:      env.Host,
		Token:     env.Token,
		UserAgent: "circleci-editor/" + opts.Version,
	})
	if err != nil {
		return circleciClients{}, nil, fmt.Errorf("host: construct circleci client: %w", err)
	}

	if out.compiler == nil {
		out.compiler = client
	}
	if out.orbClient == nil {
		out.orbClient = client
	}
	if needProjectClient {
		out.projectClient = client
	}
	if needPolicyClient {
		out.policyClient = client
	}
	if needRunClient {
		out.runClient = client
	}
	if out.orbCache == nil {
		// Debug, not a notice: a cache that cannot persist still searches
		// correctly on every run, so this names a slower startup rather than
		// something the user has to fix.
		cacheDir, dirErr := orbs.DefaultCacheDir()
		if dirErr != nil {
			debugf("warning: failed to resolve orb cache directory, orb search will not persist across runs: %v", dirErr)
		}
		// Every line internal/orbs.Cache emits is warm progress or disk-cache
		// housekeeping -- see its logf call sites -- so the whole hook is
		// debug-level.
		realCache := orbs.New(client, cacheDir, env.Host, func(format string, args ...any) {
			debugf("orbs: "+format, args...)
		})
		out.orbCache = realCache
		orbWarmer = realCache
	}
	if needUsageCache {
		// Debug-level for the same reason the orb cache's own directory
		// failure is: a usage cache that cannot persist to disk still warms
		// and searches correctly for the life of this process, so this names
		// a slower cold start on next launch, not something to fix now.
		cacheDir, dirErr := orbs.DefaultCacheDir()
		if dirErr != nil {
			debugf("warning: failed to resolve cache directory, usage suggestions will not persist across runs: %v", dirErr)
		}
		realUsage := usage.New(client, usage.NewHTTPDownloader(), env.OrgSlug(), cacheDir, env.Host, usage.DefaultWindowDays, func(format string, args ...any) {
			debugf("usage: "+format, args...)
		})
		out.usageCache = realUsage
		out.usageWarmer = realUsage
	}

	return out, orbWarmer, nil
}

// buildMux's return type is http.Handler rather than *http.ServeMux: the
// CSRF middleware it wraps every route in (see csrf.go) is itself an
// http.Handler, not a ServeMux, and wrapping it here -- once, around the
// whole tree -- is what makes protection the default for every route
// already registered below and every one a future change adds, rather
// than something each handler must remember to opt into.
func (s *Server) buildMux() (http.Handler, error) {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/healthz", s.handleHealthz)
	mux.HandleFunc("/api/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("/api/meta", s.handleMeta)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/config-files", s.handleConfigFiles)
	mux.HandleFunc("/api/validate", s.handleValidate)
	// Kept next to /api/validate because the two are siblings the UI must
	// never merge: compile-validity and policy standing are independent axes
	// (issue #215).
	mux.HandleFunc("/api/policy/decide", s.handlePolicyDecide)
	// The one endpoint in this program that spends the user's money, and its
	// precondition report. Kept beside /api/validate and /api/policy/decide
	// because the three are the "is this config any good" ladder in order of
	// cost: compiling is free, a policy decision is free, a run is not
	// (issue #194).
	mux.HandleFunc("/api/run/availability", s.handleRunAvailability)
	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/api/orbs/search", s.handleOrbsSearch)
	mux.HandleFunc("/api/orbs/source", s.handleOrbsSource)
	mux.HandleFunc("/api/usage", s.handleUsage)
	mux.HandleFunc("/api/docker-tags", s.handleDockerTags)
	mux.HandleFunc("/api/project-context", s.handleProjectContext)
	mux.HandleFunc("/api/project-context/variables", s.handleProjectContextVariables)
	mux.HandleFunc("/api/schema", s.handleSchema)
	mux.HandleFunc("/api/guides", s.handleGuides)
	mux.HandleFunc("/api/resource-classes", s.handleResourceClasses)
	mux.HandleFunc("/api/xcode-versions", s.handleXcodeVersions)
	mux.HandleFunc("/api/machine-offerings", s.handleMachineOfferings)
	mux.HandleFunc("/api/ai/status", s.handleAIStatus)
	mux.HandleFunc("/api/ai/key", s.handleAIKey)
	mux.HandleFunc("/api/ai/mcp", s.handleAIMCP)
	// Registered before "/api/ai/mcp/oauth" would be shadowed: ServeMux
	// matches longest-pattern-first, so these two are unambiguous regardless
	// of order, but they are kept adjacent to the slot they configure.
	mux.HandleFunc("/api/ai/mcp/oauth", s.handleAIMCPOAuth)
	mux.HandleFunc("/api/ai/mcp/oauth/start", s.handleAIMCPOAuthStart)
	mux.HandleFunc("/api/ai/chat", s.handleAIChat)
	mux.HandleFunc("/api/", handleAPINotFound)

	root, err := s.newRootHandler()
	if err != nil {
		return nil, err
	}
	mux.Handle("/", root)

	return s.csrfMiddleware(mux), nil
}

// newRootHandler returns the handler for all non-API paths: a reverse proxy
// to a Vite dev server when VCE_DEV_PROXY is set, or the embedded SPA
// assets otherwise.
func (s *Server) newRootHandler() (http.Handler, error) {
	if target := os.Getenv(devProxyEnvVar); target != "" {
		return newDevProxyHandler(target)
	}

	fsys, err := webassets.FS()
	if err != nil {
		return nil, fmt.Errorf("host: load embedded web assets: %w", err)
	}
	return newAssetsHandler(fsys, webassets.Placeholder()), nil
}

// ChooseFreePort returns a currently-unused TCP port on 127.0.0.1, suitable
// for passing as Options.Port. There is an inherent (small) race between
// choosing the port and later binding it; callers that need atomicity
// should bind directly instead.
func ChooseFreePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("host: listen on free port: %w", err)
	}
	defer func() { _ = ln.Close() }()

	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("host: unexpected listener address type %T", ln.Addr())
	}
	return addr.Port, nil
}

// Addr returns the host:port the server listens on.
func (s *Server) Addr() string {
	return fmt.Sprintf("127.0.0.1:%d", s.port)
}

// URL returns the base URL of the server.
func (s *Server) URL() string {
	return "http://" + s.Addr()
}

// Handler returns the server's http.Handler, for use in tests with
// httptest.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// ConfigPath returns the resolved path of the CircleCI config file this
// server edits, whether or not it currently exists.
func (s *Server) ConfigPath() string {
	return s.configFile.Path
}

// StopsOnLastClient reports whether Run will exit once every browser client
// has been gone for ClientGrace. Exported so the startup banner can tell
// the user, up front, that the process stops when they close the window --
// behaviour a user should never have to discover by watching it happen.
func (s *Server) StopsOnLastClient() bool {
	return s.opts.StopOnLastClient
}

// ClientGrace returns how long Run waits, after the last browser client
// disconnects, before treating the editor as closed: Options.LastClientGrace
// when set, otherwise lastClientGrace -- the same in every mode since issue
// #216, so this deliberately does not consult AppMode (see clients.go).
func (s *Server) ClientGrace() time.Duration {
	if s.opts.LastClientGrace > 0 {
		return s.opts.LastClientGrace
	}
	return lastClientGrace
}

// ConfigFound reports whether an existing .circleci/config.yml (or
// config.yaml) was located during startup, as opposed to falling back to a
// default path because none was found.
func (s *Server) ConfigFound() bool {
	return s.configFound
}

// WillServePlaceholder reports whether Run would serve
// internal/webassets/placeholder.html -- the "web interface not built yet"
// page -- instead of the real single-page app, because this binary was
// compiled without the web build having run first (see issue #25: this is
// exactly what `go install` and a bare `go build ./cmd/circleci-editor`
// both produce, since neither runs the Vite build `task build` runs before
// its own `go build`).
//
// False whenever VCE_DEV_PROXY is set: that mode reverse-proxies to a
// running Vite dev server instead of reading the embedded assets at all
// (see newRootHandler), so the embed's contents are irrelevant to what a
// browser actually sees.
//
// This exists as a method the caller opts into (see
// cmd/circleci-editor/main.go's run, the only caller today), rather
// than New or Run refusing outright, so that library-style callers -- and
// every existing test in this package, none of which build the web bundle
// first -- keep the older, graceful behavior (serve the explanatory
// placeholder page rather than error) if they never call this method.
func (s *Server) WillServePlaceholder() bool {
	if os.Getenv(devProxyEnvVar) != "" {
		return false
	}
	return !webassets.HasRealBuild()
}

// Run binds a listener on 127.0.0.1 (never 0.0.0.0 — this is a local
// developer tool, not a network service) and serves requests until ctx is
// cancelled, at which point it gracefully shuts down with a bounded
// timeout. If opts.OpenBrowser is set, it opens the user's browser once the
// listener is ready.
//
// With Options.StopOnLastClient it also stops once every browser client has
// been gone for ClientGrace, returning ErrLastClientLeft so the caller can
// distinguish that from a signal (issue #177).
func (s *Server) Run(ctx context.Context) error {
	// serveCtx is cancelled by *either* reason for stopping -- the caller's
	// ctx (Ctrl-C/SIGTERM) or the last-client exit below -- which is what
	// handleHeartbeat needs: whichever reason applies, an open SSE
	// connection has to return promptly or http.Server.Shutdown will sit on
	// it until shutdownTimeout (Shutdown does not close *active*
	// connections), turning a clean stop back into the unclean-looking exit
	// issue #67 was about. Assigned before net.Listen so no handler can
	// read the field before this write: there is nothing yet to connect to.
	serveCtx, stopServing := context.WithCancel(ctx)
	defer stopServing()
	s.shutdownCtx = serveCtx

	// Warming the orb cache does *not* require a token (issue #160): the
	// public v3 orb registry answers unauthenticated, verified live against
	// the real API, so an unauthenticated crawl still populates a genuinely
	// useful cache — it simply never sees a private namespace, which is
	// exactly the scope a token was ever needed for (see the Private filter's
	// own honest explanation in web/src/panes/orbs/OrbBrowser.tsx). orbWarmer
	// is nil only when a fake orbCache was supplied via Options for tests
	// (see cacheWarmer's doc comment), which is the one case this guards
	// against. The goroutine observes ctx cancellation on its own, so no
	// separate shutdown step is needed beyond passing it the same ctx Run
	// itself shuts down on.
	if s.orbWarmer != nil {
		go s.orbWarmer.Start(serveCtx)
	}

	// Same "background, never gate a response, never in a goroutine test
	// code has to guess at" shape as the orb warmer, for issue #307's own
	// design brief. usageWarmer is nil whenever this host has no token or no
	// resolvable organization slug (see buildCircleCIClients), or a fake
	// usageCache was supplied via Options for tests.
	if s.usageWarmer != nil {
		go s.usageWarmer.Start(serveCtx)
	}

	// Unconditional, and deliberately *not* in a goroutine: the guides cache's
	// Start parses the embedded snapshot synchronously (single-digit
	// milliseconds, no network, no token) and only then decides whether to
	// launch a background refresh, so by the time the listener below accepts
	// its first request, GET /api/guides already has full content to answer
	// with. Nothing here can fail in a way that should stop the server; see
	// guides.Cache.Start.
	if s.guidesWarmer != nil {
		s.guidesWarmer.Start(serveCtx)
	}

	ln, err := net.Listen("tcp", s.Addr())
	if err != nil {
		return fmt.Errorf("host: listen on %s: %w", s.Addr(), err)
	}

	httpServer := &http.Server{
		Handler:           s.mux,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}

	// Debug-level since issue #216, because it is redundant: the CLI's
	// startup banner already prints this same URL, on its own line, labelled
	// -- see printBanner in cmd/circleci-editor. A library-style
	// caller that prints no banner of its own can pass Options.Debug (or
	// read Server.URL itself, which is how it got the address to tell its
	// user in the first place).
	s.debugf("listening on %s", s.URL())

	if s.opts.OpenBrowser {
		if err := OpenURL(s.URL(), s.opts.AppMode); err != nil {
			// Emphatically a notice: the editor is running and the user's
			// browser did not open, so this line and the banner's URL are
			// the only things standing between them and an editor they
			// cannot reach.
			log.Printf("warning: failed to open browser: %v -- open %s yourself to use the editor", err, s.URL())
		}
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpServer.Serve(ln)
	}()

	// A nil channel when the feature is off, which in a select is simply a
	// case that is never ready -- so the no-self-exit path keeps exactly
	// the shape (and behaviour) it had before issue #177.
	var lastClientGone <-chan struct{}
	if s.opts.StopOnLastClient {
		gone := make(chan struct{})
		lastClientGone = gone
		go func() {
			if s.clients.waitForLastClient(serveCtx, s.ClientGrace()) {
				close(gone)
			}
		}()
	}

	select {
	case <-ctx.Done():
		// Unchanged: Ctrl-C/SIGTERM still returns nil, and the caller still
		// keys its calm shutdown line off ctx.Err() rather than off
		// anything this function returns.
		return s.gracefulShutdown(httpServer)
	case <-lastClientGone:
		// Cancel the serving context first so any heartbeat stream opened
		// in the instant between the decision and now returns immediately
		// (see the comment on serveCtx above), then shut down exactly as a
		// signal would -- same bounded wait for in-flight requests, and
		// nothing whatsoever written to the user's config file on the way
		// out.
		stopServing()
		if err := s.gracefulShutdown(httpServer); err != nil {
			return err
		}
		return ErrLastClientLeft
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("host: serve: %w", err)
		}
		return nil
	}
}

// gracefulShutdown stops httpServer, giving in-flight requests up to
// shutdownTimeout to finish. Shared by both reasons Run stops on purpose --
// a signal and a last-client exit -- so the two can never drift into
// different shutdown behaviour.
func (s *Server) gracefulShutdown(httpServer *http.Server) error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("host: shutdown server: %w", err)
	}
	return nil
}
