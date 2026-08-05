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

package host

import (
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
)

// appBrowserCandidates lists, per OS, the browser binaries that support a
// chromeless "--app=<url>" window, in order of preference. Absolute paths
// (macOS app bundle executables) are checked directly; bare names
// (Linux/Windows) are resolved against PATH. exec.LookPath handles both
// cases uniformly: a name containing a path separator is tried directly
// without consulting PATH.
var appBrowserCandidates = map[string][]string{
	"darwin": {
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	},
	"linux": {
		"google-chrome-stable",
		"google-chrome",
		"chromium-browser",
		"chromium",
		"microsoft-edge-stable",
		"microsoft-edge",
		"brave-browser",
	},
	"windows": {
		"chrome.exe",
		"msedge.exe",
		"brave.exe",
	},
}

// OpenURL opens rawURL in the user's browser. rawURL must point at
// 127.0.0.1 or localhost over plain HTTP; any other URL is rejected to
// avoid ever shelling out with an attacker-controlled URL.
//
// When appMode is true, OpenURL first tries to launch a known Chromium-family
// browser in chromeless "app" mode (--app=<url>); if none is found, it falls
// back to the platform's normal URL opener.
func OpenURL(rawURL string, appMode bool) error {
	if err := validateLocalURL(rawURL); err != nil {
		return err
	}

	if appMode {
		if bin, ok := findAppBrowser(); ok {
			return runDetached(bin, "--app="+rawURL)
		}
	}

	return openDefault(rawURL)
}

// validateLocalURL rejects any URL that is not plain HTTP to 127.0.0.1 or
// localhost, so that OpenURL can never be used to exec an
// attacker-controlled command line.
func validateLocalURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("host: parse url: %w", err)
	}
	if parsed.Scheme != "http" {
		return fmt.Errorf("host: refusing to open non-http url %q", rawURL)
	}
	switch parsed.Hostname() {
	case "127.0.0.1", "localhost":
		return nil
	default:
		return fmt.Errorf("host: refusing to open non-local url %q", rawURL)
	}
}

// findAppBrowser returns the path (or command name) of the first available
// Chromium-family browser for the current OS, if any.
func findAppBrowser() (string, bool) {
	for _, candidate := range appBrowserCandidates[runtime.GOOS] {
		if resolveBrowserBinary(candidate) {
			return candidate, true
		}
	}
	return "", false
}

// resolveBrowserBinary reports whether candidate refers to an executable
// that exists: a path (containing a separator) is checked directly, and a
// bare command name is resolved via the PATH.
func resolveBrowserBinary(candidate string) bool {
	_, err := exec.LookPath(candidate)
	return err == nil
}

// openDefault opens rawURL with the platform's default URL handler.
func openDefault(rawURL string) error {
	switch runtime.GOOS {
	case "darwin":
		return runDetached("open", rawURL)
	case "linux":
		return runDetached("xdg-open", rawURL)
	case "windows":
		return runDetached("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		return fmt.Errorf("host: unsupported platform %q", runtime.GOOS)
	}
}

// runDetached starts name with args (never via a shell) and reaps it in the
// background without blocking the caller on its exit.
func runDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...) // #nosec G204 -- name/args come from a fixed allowlist or validated URL, never raw shell input.
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("host: start %s: %w", name, err)
	}
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}
