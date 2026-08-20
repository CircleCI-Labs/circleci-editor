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

// Command check-tools is the drift detector for internal/ai/circlecimcp's
// toolClassifications map. Run it via `task mcp:check-tools`.
//
// It calls the live CircleCI hosted MCP server's tools/list and diffs the
// names it returns against everything circlecimcp.AllClassifiedTools()
// knows about, in both directions:
//
//   - a tool the server advertises that this package has never classified
//     -- the dangerous direction, because a new destructive tool lands here
//     silently until a human reviews and adds it to toolClassifications;
//   - a tool this package classifies that the server no longer advertises
//     -- the bug this command exists to catch by name. A renamed or removed
//     tool produces no error at request time (see mcpToolset in
//     internal/ai/anthropic/anthropic.go: naming a tool the server does not
//     recognise just enables nothing), so nothing short of a diff against
//     the live server would ever surface it.
//
// It exits non-zero when either set is non-empty, so a maintainer running it
// gets a clear pass/fail rather than output they have to read closely to
// notice drift in.
//
// This is a human-run, credentialed check against a live third-party
// server, not a CI gate: see mcp:check-tools's own Taskfile.yml comment for
// why it is deliberately excluded from `task check`.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/circlecimcp"
)

// requestTimeout bounds the single HTTP call this command makes. There is
// no retry policy here (unlike internal/circleci.Client) because this is a
// maintainer running one command by hand, not a background path a user is
// waiting on -- a failed attempt is rerun by rerunning the command.
const requestTimeout = 30 * time.Second

func main() {
	// os.Exit skips deferred calls, so stop() is called explicitly on both
	// paths rather than deferred (gocritic's exitAfterDefer), matching
	// internal/guides/cmd/refresh-snapshot's own main().
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx)
	stop()
	if err != nil {
		fmt.Fprintf(os.Stderr, "check-tools: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	token := os.Getenv("CIRCLE_TOKEN")
	if token == "" {
		return errors.New("CIRCLE_TOKEN is not set -- this command authenticates to the live MCP server with it")
	}

	serverTools, err := fetchServerTools(ctx, token)
	if err != nil {
		return err
	}
	fmt.Printf("live server (%s) advertises %d tools\n", circlecimcp.URL, len(serverTools))

	serverNames := make(map[string]bool, len(serverTools))
	for _, t := range serverTools {
		serverNames[t.Name] = true
	}

	classified := make(map[string]bool)
	for _, name := range circlecimcp.AllClassifiedTools() {
		classified[name] = true
	}

	var unclassified []string // in the server, not in toolClassifications
	for _, t := range serverTools {
		if !classified[t.Name] {
			unclassified = append(unclassified, t.Name)
		}
	}
	sort.Strings(unclassified)

	var stale []string // in toolClassifications, not in the server
	for name := range classified {
		if !serverNames[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)

	if len(unclassified) == 0 && len(stale) == 0 {
		fmt.Println("in sync: every tool the server advertises is classified in internal/ai/circlecimcp, and every classified tool is still advertised")
		return nil
	}

	if len(unclassified) > 0 {
		fmt.Println("\nthe server advertises tools this package does not classify (review and add to toolClassifications -- a write tool landing here unreviewed is the risk this exists to catch):")
		readOnly := make(map[string]bool, len(serverTools))
		for _, t := range serverTools {
			readOnly[t.Name] = t.ReadOnlyHint
		}
		for _, name := range unclassified {
			fmt.Printf("  + %-32s readOnlyHint=%v\n", name, readOnly[name])
		}
	}
	if len(stale) > 0 {
		fmt.Println("\nthis package classifies tools the server no longer advertises (likely renamed or removed upstream -- see if a similarly-named tool appeared in the list above):")
		for _, name := range stale {
			fmt.Printf("  - %s\n", name)
		}
	}
	return fmt.Errorf("tool list drift: %d unclassified, %d stale", len(unclassified), len(stale))
}

// serverTool is the subset of one tools/list entry this command reads.
type serverTool struct {
	Name         string
	ReadOnlyHint bool // false both when the server says so and when it omits the hint entirely -- IsReadOnly treats an absent hint the same way, see the package doc.
}

// fetchServerTools calls the live MCP server's tools/list and returns every
// tool it names. A bare tools/list call works without an initialize
// handshake first (verified live alongside the rest of this file's
// classification, see circlecimcp's package doc) -- one request, no
// session to establish or tear down.
func fetchServerTools(ctx context.Context, token string) ([]serverTool, error) {
	reqBody, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/list",
		"params":  map[string]any{},
	})
	if err != nil {
		return nil, fmt.Errorf("encode tools/list request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, circlecimcp.URL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// The MCP spec requires offering both; the server has been observed to
	// answer with either a plain JSON body or an SSE stream depending on
	// its mood, and this command has to handle whichever it picks (see
	// decodeToolsList below).
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	httpReq.Header.Set("Circle-Token", token)

	resp, err := http.DefaultClient.Do(httpReq) //nolint:gosec // G704: the request URL is circlecimcp.URL, a hardcoded package constant, never request input or anything else this command's own input could steer -- there is no SSRF surface here for gosec's taint analysis to actually be catching.
	if err != nil {
		return nil, fmt.Errorf("call tools/list: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tools/list: unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return decodeToolsList(body)
}

// toolsListPayload is the JSON-RPC 2.0 envelope tools/list returns, once
// unwrapped from whichever transport (plain JSON or SSE) delivered it.
type toolsListPayload struct {
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Result struct {
		Tools []struct {
			Name        string `json:"name"`
			Annotations struct {
				ReadOnlyHint bool `json:"readOnlyHint"`
			} `json:"annotations"`
		} `json:"tools"`
	} `json:"result"`
}

// decodeToolsList extracts the JSON-RPC payload from body, which is either
// a plain JSON response body or an SSE stream carrying it on one or more
// "data: " lines -- the server has been observed to send either, and
// nothing in the request controls which. A plain body is tried first since
// it is the cheaper check; falling through to SSE parsing only when that
// fails avoids misreading an SSE framing line as if it were the payload.
func decodeToolsList(body []byte) ([]serverTool, error) {
	var payload toolsListPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		data, findErr := firstSSEDataLine(body)
		if findErr != nil {
			return nil, fmt.Errorf("response is neither valid JSON nor an SSE stream with a data line: %w", err)
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, fmt.Errorf("decode SSE data line: %w", err)
		}
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("server returned a JSON-RPC error: %s", payload.Error.Message)
	}

	tools := make([]serverTool, 0, len(payload.Result.Tools))
	for _, t := range payload.Result.Tools {
		tools = append(tools, serverTool{Name: t.Name, ReadOnlyHint: t.Annotations.ReadOnlyHint})
	}
	return tools, nil
}

// firstSSEDataLine scans body line by line and returns the payload of the
// first "data: " (or "data:" with no space) line found. tools/list is a
// single request/response exchange, not a multi-event stream a caller needs
// to keep reading, so the first data line is the whole answer.
func firstSSEDataLine(body []byte) ([]byte, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	// A live tools/list response was observed at ~44KB on one SSE data
	// line (24 tools' worth of names, descriptions, and input schemas) --
	// under bufio.Scanner's default 64KiB line limit today, but close
	// enough to it that a handful more tools would cross it. Raising the
	// cap now, rather than waiting for that to happen, trades an unused
	// buffer for not debugging a "token too long" scanner error the next
	// time CircleCI adds a tool.
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data: "):
			return []byte(strings.TrimPrefix(line, "data: ")), nil
		case strings.HasPrefix(line, "data:"):
			return []byte(strings.TrimPrefix(line, "data:")), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("no data line found")
}
