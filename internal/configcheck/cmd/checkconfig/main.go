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

// Command checkconfig is the CLI front end for internal/configcheck: it
// runs that package's offline structural checks against one config file
// and exits non-zero if any were found.
//
// It exists as its own small `go run`-able binary (the same shape as
// internal/guides/cmd/refresh-snapshot) rather than a subcommand of
// cmd/circleci-editor, because it has nothing to do with that binary's job
// of serving the editor UI -- see internal/configcheck's package doc
// comment for what this actually checks and why.
//
// Usage:
//
//	go run ./internal/configcheck/cmd/checkconfig <path/to/config.yml>
package main

import (
	"fmt"
	"os"

	"github.com/CircleCI-Labs/circleci-editor/internal/configcheck"
)

func main() {
	if len(os.Args) != 2 {
		//nolint:gosec // G705: this is a CLI writing its own usage line to stderr, not an HTTP response -- there is no XSS context for gosec's taint analysis to be warning about.
		fmt.Fprintf(os.Stderr, "usage: %s <path/to/config.yml>\n", os.Args[0])
		os.Exit(2)
	}
	path := os.Args[1]

	contents, err := os.ReadFile(path) //nolint:gosec // reading the exact path the caller named is this tool's entire purpose, not an attacker-controlled inclusion; gosec has flagged this under both G304 and G703 across versions, so this suppresses the rule generically rather than chasing whichever code the installed version currently uses.
	if err != nil {
		//nolint:gosec // G705: see the identical usage-line comment above.
		fmt.Fprintf(os.Stderr, "checkconfig: %s: %s\n", path, err)
		os.Exit(2)
	}

	issues, err := configcheck.Check(contents)
	if err != nil {
		// This package failed on its own terms (e.g. the embedded
		// schema.json didn't parse) -- a bug in the checker, not a finding
		// about path. Exit 2, the same code used above for a usage error,
		// to keep that distinct from exit 1 ("this config has a real
		// problem").
		fmt.Fprintf(os.Stderr, "checkconfig: %s\n", err)
		os.Exit(2)
	}

	if len(issues) == 0 {
		fmt.Printf("OK: %s -- no offline structural issues found\n", path)
		fmt.Println("(this is not a substitute for CircleCI's own compile-config-with-defaults: " +
			"orb resolution, config policies and anything else that needs the API were not checked.)")
		return
	}

	fmt.Printf("FAILED: %s -- %d offline structural issue(s) found:\n", path, len(issues))
	for _, issue := range issues {
		fmt.Printf("  - %s\n", issue.Message)
	}
	os.Exit(1)
}
