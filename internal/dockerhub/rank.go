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

package dockerhub

import (
	"regexp"
	"strings"
)

// versionPrefixPattern matches the leading run of dot-separated digits at
// the start of a tag name -- "20.11.0" in full, "20.11" out of
// "20.11-browsers", "2026.07" out of "2026.07.1-ndk", nothing at all out of
// "latest" or "current".
var versionPrefixPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)*`)

// versionGroupKey returns the major.minor component of tag's leading numeric
// prefix (truncated to at most two dot-separated components), and whether it
// has one at all. Tags with no leading digit ("latest", "edge", ...) are not
// version tags in the sense this package cares about and are excluded from
// ranking entirely -- they're not what "which version can I pin" is asking
// about, and cimg/* doesn't publish any (its moving-tag mechanism is the
// MACHINE_IMAGES family in images.ts, a different image kind).
func versionGroupKey(tag string) (string, bool) {
	prefix := versionPrefixPattern.FindString(tag)
	if prefix == "" {
		return "", false
	}
	parts := strings.Split(prefix, ".")
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return strings.Join(parts, "."), true
}

// isBareVersionTag reports whether tag is *exactly* its own numeric version
// prefix, with nothing appended -- "20.11.0" but not "20.11.0-browsers" or
// "1.15.7-erlang-26.0.2".
func isBareVersionTag(tag string) bool {
	return versionPrefixPattern.FindString(tag) == tag
}

// RankVersionTags reduces tags (which must already be newest-first, as
// Client.ListTags returns them) to at most maxTags representative version tags,
// newest-first, suitable for offering someone picking a tag to pin.
//
// The problem this solves: a cimg/* repo's tag list is not a list of
// versions, it's a list of (version x variant) pairs, going back years --
// cimg/node alone has published 300+ tags at the time of writing. Showing
// all of them (issue #77's "steer toward best practices" requirement,
// echoed by user feedback on the completion source specifically -- see the
// PR description) would bury the handful of *recent* versions someone
// should actually consider under a wall of ancient patch releases and
// `-browsers`/`-node` duplicates of versions already shown.
//
// The reduction:
//
//  1. Tags with no leading version number ("latest", "current", ...) are
//     dropped -- not version tags at all (see versionGroupKey).
//  2. Remaining tags are grouped by their major.minor version (so
//     "20.11.0", "20.11.0-browsers", and "20.11.2" all collapse toward one
//     entry representing "20.11").
//  3. Each group's representative is the *bare* tag (no variant suffix) if
//     one appears anywhere in that group -- that's the exact string someone
//     should type before optionally appending a variant themselves (the
//     existing cimgImageCandidates flow in images.ts already does the
//     latter once a version is chosen). If a group never publishes a bare
//     tag (true of some images' auxiliary versioning schemes), the group's
//     newest tag stands in instead, since it's still a real, pinnable tag.
//  4. Groups are kept in first-seen order (i.e. newest-first, since the
//     input already is) and truncated to maxTags.
//
// This is this project's own heuristic, not a CircleCI-documented ranking --
// there is no published "recommended cimg version" the way there is for
// MACHINE_IMAGES' moving tags (see images.ts's provenance comment). Callers
// must not present these as anything more authoritative than "recently
// published," and the UI (DockerImagePicker.tsx) labels them "Latest," not
// "Recommended," for exactly that reason.
func RankVersionTags(tags []string, maxTags int) []string {
	if maxTags <= 0 {
		return nil
	}

	type group struct {
		key           string
		best          string
		bestIsBareTag bool
	}

	order := make([]string, 0, maxTags)
	groups := make(map[string]*group)

	for _, tag := range tags {
		key, ok := versionGroupKey(tag)
		if !ok {
			continue
		}

		g, seen := groups[key]
		if !seen {
			groups[key] = &group{key: key, best: tag, bestIsBareTag: isBareVersionTag(tag)}
			order = append(order, key)
			continue
		}
		if !g.bestIsBareTag && isBareVersionTag(tag) {
			g.best = tag
			g.bestIsBareTag = true
		}
	}

	result := make([]string, 0, maxTags)
	for _, key := range order {
		if len(result) >= maxTags {
			break
		}
		result = append(result, groups[key].best)
	}
	return result
}

// VersionTags returns every version-shaped tag in tags, in the order given
// (newest-first, as Client.ListTags returns them), deduplicated and truncated to
// maxTags.
//
// The complement of RankVersionTags rather than a replacement for it, and both
// are served (see Result.Tags and Result.AllTags) because issue #213 changed
// *how* the image picker offers tags without changing what it recommends. A
// combobox you type into is only useful over the full list: ranking collapses
// `20.11.0`, `20.11.2` and `20.11.0-browsers` into one representative, so a user
// who knows they want `20.11.2` would type it and be told nothing matches. A wall
// of hundreds of options is equally useless as a *recommendation*. So the ranked
// handful stays, as the group the control shows first, and this is what
// type-to-filter searches.
//
// Non-version tags are still dropped, for the reason versionGroupKey gives and
// because CircleCI's own documentation tells users to avoid mutable tags like
// `latest` ("Mutable tags often lead to unexpected changes in your job
// environment" -- using-docker.adoc). Offering `latest` as an option would be
// this project recommending against upstream's own advice. Typing it stays
// possible -- the field is free text -- and the picker says why it is a bad idea
// when you do.
func VersionTags(tags []string, maxTags int) []string {
	if maxTags <= 0 {
		return nil
	}
	seen := make(map[string]bool, len(tags))
	out := make([]string, 0, maxTags)
	for _, tag := range tags {
		if _, ok := versionGroupKey(tag); !ok {
			continue
		}
		if seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
		if len(out) >= maxTags {
			break
		}
	}
	return out
}
