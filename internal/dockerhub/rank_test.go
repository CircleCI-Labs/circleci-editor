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

package dockerhub_test

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
)

func TestRankVersionTags(t *testing.T) {
	tests := []struct {
		name string
		tags []string // newest-first, as Client.ListTags returns them.
		max  int
		want []string
	}{
		{
			name: "collapses variant duplicates onto the bare version",
			tags: []string{
				"20.11.0-browsers", "20.11.0-node", "20.11.0",
				"20.10.0-browsers", "20.10.0",
			},
			max:  8,
			want: []string{"20.11.0", "20.10.0"},
		},
		{
			name: "keeps only one entry per major.minor, newest first",
			tags: []string{"3.13.5", "3.13.4", "3.13.3", "3.12.9"},
			max:  8,
			want: []string{"3.13.5", "3.12.9"},
		},
		{
			name: "drops non-version tags entirely",
			tags: []string{"latest", "current", "edge", "20.11.0"},
			max:  8,
			want: []string{"20.11.0"},
		},
		{
			name: "falls back to the newest tag in a group with no bare version",
			// A hypothetical scheme (like elixir/clojure's real
			// "-erlang-X.Y.Z"/"-openjdk-X.Y" suffixes) that never publishes
			// an unsuffixed tag for a given major.minor at all.
			tags: []string{"1.15.7-erlang-26.0.2", "1.14.6-erlang-25.3.2"},
			max:  8,
			want: []string{"1.15.7-erlang-26.0.2", "1.14.6-erlang-25.3.2"},
		},
		{
			name: "prefers a later-seen bare tag over an earlier variant in the same group",
			// Docker Hub's own ordering doesn't guarantee the bare tag is
			// pushed (and thus returned) before its variants -- the ranker
			// must still find it wherever it appears in the group.
			tags: []string{"20.11.0-browsers", "20.11.0-node", "20.11.0", "20.11.0-node"},
			max:  8,
			want: []string{"20.11.0"},
		},
		{
			name: "truncates to max",
			tags: []string{"5.0.0", "4.0.0", "3.0.0", "2.0.0", "1.0.0"},
			max:  2,
			want: []string{"5.0.0", "4.0.0"},
		},
		{
			name: "groups by major only when there's no minor component",
			tags: []string{"17", "17-node", "11"},
			max:  8,
			want: []string{"17", "11"},
		},
		{
			name: "empty input",
			tags: nil,
			max:  8,
			want: []string{},
		},
		{
			name: "zero max returns nil",
			tags: []string{"1.0.0"},
			max:  0,
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := dockerhub.RankVersionTags(tc.tags, tc.max)
			assert.DeepEqual(t, got, tc.want)
		})
	}
}
