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

package usage_test

import (
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/usage"
)

// realHeader is the header row of a real completed usage export, captured
// live against the CircleCI API (issue #307) -- kept verbatim (trimmed to
// the columns Reduce reads plus a representative sample of the many it
// ignores) so the column-name lookups in Reduce are tested against the
// upstream's actual choices, not a guess at them.
const realHeader = `"PROJECT_ID","PROJECT_NAME","VCS_NAME","JOB_NAME","JOB_ID","JOB_RUN_DATE","JOB_BUILD_STATUS","RESOURCE_CLASS","OPERATING_SYSTEM","EXECUTOR","PARALLELISM","JOB_RUN_SECONDS","MEDIAN_CPU_UTILIZATION_PCT","MAX_CPU_UTILIZATION_PCT","MEDIAN_RAM_UTILIZATION_PCT","MAX_RAM_UTILIZATION_PCT","COMPUTE_CREDITS","DLC_CREDITS","TOTAL_CREDITS"`

func csvRow(fields ...string) string {
	return strings.Join(fields, ",")
}

func TestReduce_ParsesRealColumnNames(t *testing.T) {
	csv := realHeader + "\n" +
		csvRow(`"proj-1"`, `"my-project"`, `"github"`, `"build"`, `"job-1"`, `"2026-07-15"`, `"success"`, `"large"`, `"linux"`, `"docker"`, `"1"`, `"120"`, `"18.5"`, `"25.0"`, `"40.0"`, `"55.0"`, `"0.2"`, `"0"`, `"0.2"`) + "\n"

	buckets, err := usage.Reduce(strings.NewReader(csv))
	assert.NilError(t, err)

	jobs := buckets["2026-07-15"]
	assert.Assert(t, jobs != nil)
	key := usage.JobKey{ProjectID: "proj-1", JobName: "build", ResourceClass: "large", Executor: "docker", OperatingSystem: "linux"}
	agg, ok := jobs[key]
	assert.Assert(t, ok)
	assert.Equal(t, agg.Runs, 1)
	assert.Equal(t, agg.ProjectName, "my-project")
	assert.Equal(t, agg.SumMedianCPUPct, 18.5)
	assert.Equal(t, agg.SumMaxCPUPct, 25.0)
	assert.Equal(t, agg.MaxOfMaxCPUPct, 25.0)
	assert.Equal(t, agg.SumMedianRAMPct, 40.0)
	assert.Equal(t, agg.SumMaxRAMPct, 55.0)
	assert.Equal(t, agg.RunSeconds, 120.0)
	assert.Equal(t, agg.ComputeCredits, 0.2)
	assert.Equal(t, agg.TotalCredits, 0.2)
}

func TestReduce_SkipsRowsMissingUtilization(t *testing.T) {
	// A canceled or too-short job run CircleCI never profiled: the
	// utilization columns are empty. This row must not be counted at all --
	// not as a run with 0% utilization, which would understate the job.
	csv := realHeader + "\n" +
		csvRow(`"proj-1"`, `"my-project"`, `"github"`, `"build"`, `"job-1"`, `"2026-07-15"`, `"canceled"`, `"large"`, `"linux"`, `"docker"`, `"1"`, `"2"`, `""`, `""`, `""`, `""`, `"0"`, `"0"`, `"0"`) + "\n"

	buckets, err := usage.Reduce(strings.NewReader(csv))
	assert.NilError(t, err)
	assert.Equal(t, len(buckets), 0)
}

func TestReduce_SkipsRowsMissingKeyFields(t *testing.T) {
	csv := realHeader + "\n" +
		csvRow(`""`, `"my-project"`, `"github"`, `"build"`, `"job-1"`, `"2026-07-15"`, `"success"`, `"large"`, `"linux"`, `"docker"`, `"1"`, `"120"`, `"18.5"`, `"25.0"`, `"40.0"`, `"55.0"`, `"0.2"`, `"0"`, `"0.2"`) + "\n"

	buckets, err := usage.Reduce(strings.NewReader(csv))
	assert.NilError(t, err)
	assert.Equal(t, len(buckets), 0)
}

func TestReduce_MergesMultipleRunsOfTheSameJobOnTheSameDay(t *testing.T) {
	csv := realHeader + "\n" +
		csvRow(`"proj-1"`, `"my-project"`, `"github"`, `"build"`, `"job-1"`, `"2026-07-15"`, `"success"`, `"large"`, `"linux"`, `"docker"`, `"1"`, `"100"`, `"10"`, `"20"`, `"30"`, `"40"`, `"0.1"`, `"0"`, `"0.1"`) + "\n" +
		csvRow(`"proj-1"`, `"my-project"`, `"github"`, `"build"`, `"job-2"`, `"2026-07-15"`, `"success"`, `"large"`, `"linux"`, `"docker"`, `"1"`, `"200"`, `"30"`, `"40"`, `"50"`, `"60"`, `"0.2"`, `"0"`, `"0.2"`) + "\n"

	buckets, err := usage.Reduce(strings.NewReader(csv))
	assert.NilError(t, err)

	key := usage.JobKey{ProjectID: "proj-1", JobName: "build", ResourceClass: "large", Executor: "docker", OperatingSystem: "linux"}
	agg := buckets["2026-07-15"][key]
	assert.Equal(t, agg.Runs, 2)
	assert.Equal(t, agg.SumMedianCPUPct, 40.0) // 10 + 30
	assert.Equal(t, agg.MaxOfMaxCPUPct, 40.0)  // max(20, 40)
	assert.Equal(t, agg.MaxOfMaxRAMPct, 60.0)  // max(40, 60)
}

func TestReduce_IgnoresUnknownExtraColumns(t *testing.T) {
	header := `"PROJECT_ID","PROJECT_NAME","JOB_NAME","JOB_RUN_DATE","RESOURCE_CLASS","OPERATING_SYSTEM","EXECUTOR","JOB_RUN_SECONDS","MEDIAN_CPU_UTILIZATION_PCT","MAX_CPU_UTILIZATION_PCT","MEDIAN_RAM_UTILIZATION_PCT","MAX_RAM_UTILIZATION_PCT","COMPUTE_CREDITS","TOTAL_CREDITS","A_FUTURE_COLUMN_THIS_PARSER_HAS_NEVER_HEARD_OF"`
	csv := header + "\n" +
		csvRow(`"proj-1"`, `"my-project"`, `"build"`, `"2026-07-15"`, `"large"`, `"linux"`, `"docker"`, `"120"`, `"18.5"`, `"25.0"`, `"40.0"`, `"55.0"`, `"0.2"`, `"0.2"`, `"anything at all"`) + "\n"

	buckets, err := usage.Reduce(strings.NewReader(csv))
	assert.NilError(t, err)
	assert.Equal(t, len(buckets), 1)
}

func TestSummarize_AveragesAcrossRunsNotDays(t *testing.T) {
	// Day 1 has 3 runs at 10% CPU; day 2 has 1 run at 100% CPU. A per-day
	// (not per-run) average would say (10+100)/2 = 55%; the correct per-run
	// average is (10*3 + 100)/4 = 32.5%.
	buckets := usage.DayBuckets{
		"2026-07-14": {
			{ProjectID: "p", JobName: "j", ResourceClass: "large"}: {Runs: 3, SumMedianCPUPct: 30, MaxOfMaxCPUPct: 15},
		},
		"2026-07-15": {
			{ProjectID: "p", JobName: "j", ResourceClass: "large"}: {Runs: 1, SumMedianCPUPct: 100, MaxOfMaxCPUPct: 100},
		},
	}

	summaries := usage.Summarize(buckets)
	assert.Equal(t, len(summaries), 1)
	assert.Equal(t, summaries[0].Runs, 4)
	assert.Equal(t, summaries[0].AvgMedianCPUPct, 32.5)
	assert.Equal(t, summaries[0].MaxMaxCPUPct, 100.0)
}

func TestDayBuckets_Range(t *testing.T) {
	b := usage.DayBuckets{}
	_, _, ok := b.Range()
	assert.Assert(t, !ok)

	b = usage.DayBuckets{
		"2026-07-10": {},
		"2026-07-15": {},
		"2026-07-12": {},
	}
	start, end, ok := b.Range()
	assert.Assert(t, ok)
	assert.Equal(t, start, time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC))
	assert.Equal(t, end, time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)) // exclusive: the day *after* the latest bucket.
}

func TestDayBuckets_Prune(t *testing.T) {
	b := usage.DayBuckets{
		"2026-07-01": {},
		"2026-07-10": {},
		"2026-07-20": {},
	}
	b.Prune(time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC), time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC))

	_, has01 := b["2026-07-01"]
	_, has10 := b["2026-07-10"]
	_, has20 := b["2026-07-20"]
	assert.Assert(t, !has01)
	assert.Assert(t, has10)
	assert.Assert(t, !has20)
}

func TestDayBuckets_Merge(t *testing.T) {
	key := usage.JobKey{ProjectID: "p", JobName: "j", ResourceClass: "large"}
	a := usage.DayBuckets{"2026-07-01": {key: {Runs: 1, SumMedianCPUPct: 10}}}
	b := usage.DayBuckets{"2026-07-01": {key: {Runs: 1, SumMedianCPUPct: 20}}, "2026-07-02": {key: {Runs: 1, SumMedianCPUPct: 5}}}

	a.Merge(b)
	assert.Equal(t, a["2026-07-01"][key].Runs, 2)
	assert.Equal(t, a["2026-07-01"][key].SumMedianCPUPct, 30.0)
	assert.Equal(t, a["2026-07-02"][key].Runs, 1)
}

func TestIsValidWindowDays(t *testing.T) {
	assert.Assert(t, usage.IsValidWindowDays(7))
	assert.Assert(t, usage.IsValidWindowDays(14))
	assert.Assert(t, usage.IsValidWindowDays(30))
	assert.Assert(t, is.Equal(usage.IsValidWindowDays(1), false))
	assert.Assert(t, is.Equal(usage.IsValidWindowDays(31), false))
}
