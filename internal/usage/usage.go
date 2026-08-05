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

// Package usage maintains a locally-cached, background-warmed summary of
// per-job CPU/RAM utilisation and credit spend, read from CircleCI's Usage
// Export API, so the editor's palette can suggest right-sizing a job's
// resource_class (issue #307).
//
// The export endpoint (see internal/circleci's CreateUsageExportJob) is
// org-wide and date-ranged only -- it has no project filter, confirmed live
// -- so a single export always names every project in the organisation.
// This package never persists that raw response. It reduces every completed
// export to per-job, per-UTC-day aggregates (Runs, average/max CPU and RAM
// utilisation, credits) via Reduce, and Cache (cache.go) persists only that
// reduced form to disk -- see Cache's own doc comment for why.
package usage

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// dayLayout is the bucket-key format used throughout this package: a plain
// UTC calendar date, matching the CSV's own JOB_RUN_DATE column (a DATE
// column with no time-of-day component) once parsed.
const dayLayout = "2006-01-02"

// JobKey identifies one distinct "shape" of job this cache tracks
// utilisation for: the same job name can appear under this key more than
// once over time only if it changed resource class, executor, or operating
// system, each of which is its own row in the suggestions this data feeds.
type JobKey struct {
	ProjectID       string
	JobName         string
	ResourceClass   string
	Executor        string
	OperatingSystem string
}

// DayAggregate is one JobKey's aggregated Usage Export rows for a single UTC
// calendar day. It is the unit this package persists to disk (see Cache) --
// derived and small, never the raw per-run rows a large org's export can run
// to hundreds of thousands of.
//
// Only rows with parseable CPU *and* RAM utilisation are folded in (see
// Reduce): a job run CircleCI could not profile is excluded from Runs
// entirely rather than counted with zeroed-out utilisation, which would
// silently understate it.
type DayAggregate struct {
	// ProjectName is carried alongside ProjectID purely for display -- the
	// last non-empty value seen for this bucket wins, since it does not
	// vary within a project's own rows.
	ProjectName string

	Runs int

	SumMedianCPUPct float64
	SumMaxCPUPct    float64
	MaxOfMaxCPUPct  float64

	SumMedianRAMPct float64
	SumMaxRAMPct    float64
	MaxOfMaxRAMPct  float64

	RunSeconds     float64
	ComputeCredits float64
	TotalCredits   float64
}

// merge folds other into d, returning the combined aggregate. Both operands
// are for the same JobKey and the same day; merge exists so a delta fetch
// that happens to re-cover part of an already-held day (should not normally
// happen given Cache's day-boundary trailing edge, but is safe either way)
// combines rather than silently picks one side.
func (d DayAggregate) merge(other DayAggregate) DayAggregate {
	name := d.ProjectName
	if name == "" {
		name = other.ProjectName
	}
	return DayAggregate{
		ProjectName:     name,
		Runs:            d.Runs + other.Runs,
		SumMedianCPUPct: d.SumMedianCPUPct + other.SumMedianCPUPct,
		SumMaxCPUPct:    d.SumMaxCPUPct + other.SumMaxCPUPct,
		MaxOfMaxCPUPct:  maxFloat(d.MaxOfMaxCPUPct, other.MaxOfMaxCPUPct),
		SumMedianRAMPct: d.SumMedianRAMPct + other.SumMedianRAMPct,
		SumMaxRAMPct:    d.SumMaxRAMPct + other.SumMaxRAMPct,
		MaxOfMaxRAMPct:  maxFloat(d.MaxOfMaxRAMPct, other.MaxOfMaxRAMPct),
		RunSeconds:      d.RunSeconds + other.RunSeconds,
		ComputeCredits:  d.ComputeCredits + other.ComputeCredits,
		TotalCredits:    d.TotalCredits + other.TotalCredits,
	}
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// DayBuckets is the disk- and memory-resident shape of everything this
// package holds: UTC calendar day (dayLayout) -> JobKey -> that job's
// aggregated stats for that one day. Keeping the day dimension explicit
// (rather than only ever storing one rolled-up total) is what lets Cache
// prune data older than its configured window without re-fetching anything
// -- see cache.go's pruning step.
type DayBuckets map[string]map[JobKey]DayAggregate

// Merge folds other into b in place, day by day, job by job -- used to fold
// a freshly-fetched export's buckets into whatever Cache already holds.
func (b DayBuckets) Merge(other DayBuckets) {
	for day, jobs := range other {
		existing := b[day]
		if existing == nil {
			existing = make(map[JobKey]DayAggregate, len(jobs))
			b[day] = existing
		}
		for key, agg := range jobs {
			if prior, ok := existing[key]; ok {
				existing[key] = prior.merge(agg)
			} else {
				existing[key] = agg
			}
		}
	}
}

// Prune removes every day bucket outside [from, to) (to's own day excluded),
// in place. from and to are truncated to their UTC calendar day before
// comparing, so callers can pass either a day boundary or any time within
// the day they mean.
func (b DayBuckets) Prune(from, to time.Time) {
	fromDay := from.UTC().Format(dayLayout)
	toDay := to.UTC().Format(dayLayout)
	for day := range b {
		if day < fromDay || day >= toDay {
			delete(b, day)
		}
	}
}

// Range reports the earliest and latest UTC calendar day present in b, and
// ok=false when b is empty. end is the day *after* the latest bucket
// (exclusive), matching how Cache's fetch ranges are always [start, end).
func (b DayBuckets) Range() (start, end time.Time, ok bool) {
	if len(b) == 0 {
		return time.Time{}, time.Time{}, false
	}
	var minDay, maxDay string
	for day := range b {
		if minDay == "" || day < minDay {
			minDay = day
		}
		if maxDay == "" || day > maxDay {
			maxDay = day
		}
	}
	start, err := time.ParseInLocation(dayLayout, minDay, time.UTC)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	last, err := time.ParseInLocation(dayLayout, maxDay, time.UTC)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	return start, last.AddDate(0, 0, 1), true
}

// JobSummary is one JobKey's rolled-up stats across every day bucket
// currently held -- what Cache.Summaries exposes and what the /api/usage
// endpoint (internal/host/usage.go) reports to the browser.
type JobSummary struct {
	JobKey
	ProjectName string

	// Runs is the sample size: how many individual job runs over the
	// window contributed usable (parseable CPU and RAM) utilisation data.
	// Callers must treat a small Runs as "not enough to say anything" --
	// see the frontend's MinSampleRuns.
	Runs int

	AvgMedianCPUPct float64
	AvgMaxCPUPct    float64
	MaxMaxCPUPct    float64

	AvgMedianRAMPct float64
	AvgMaxRAMPct    float64
	MaxMaxRAMPct    float64

	RunSeconds     float64
	ComputeCredits float64
	TotalCredits   float64
}

// Summarize rolls b up into one JobSummary per JobKey, averaging each
// per-run stat across every contributing run (not just every day -- a day
// with 40 runs must not weigh the same as a day with 1).
func Summarize(b DayBuckets) []JobSummary {
	totals := make(map[JobKey]DayAggregate)
	for _, jobs := range b {
		for key, agg := range jobs {
			if prior, ok := totals[key]; ok {
				totals[key] = prior.merge(agg)
			} else {
				totals[key] = agg
			}
		}
	}

	out := make([]JobSummary, 0, len(totals))
	for key, agg := range totals {
		if agg.Runs == 0 {
			continue
		}
		n := float64(agg.Runs)
		out = append(out, JobSummary{
			JobKey:          key,
			ProjectName:     agg.ProjectName,
			Runs:            agg.Runs,
			AvgMedianCPUPct: agg.SumMedianCPUPct / n,
			AvgMaxCPUPct:    agg.SumMaxCPUPct / n,
			MaxMaxCPUPct:    agg.MaxOfMaxCPUPct,
			AvgMedianRAMPct: agg.SumMedianRAMPct / n,
			AvgMaxRAMPct:    agg.SumMaxRAMPct / n,
			MaxMaxRAMPct:    agg.MaxOfMaxRAMPct,
			RunSeconds:      agg.RunSeconds,
			ComputeCredits:  agg.ComputeCredits,
			TotalCredits:    agg.TotalCredits,
		})
	}
	return out
}

// usageCSVColumns are the header names Reduce looks up, by exact match
// against the CSV's own header row -- so column order, and any extra column
// CircleCI adds to the export later, never affect parsing. Verified live
// against a real completed export (issue #307): the real header carries many
// more columns than these (pipeline/workflow identifiers, VCS metadata, and
// so on); everything not named here is read past and ignored.
const (
	colProjectID       = "PROJECT_ID"
	colProjectName     = "PROJECT_NAME"
	colJobName         = "JOB_NAME"
	colResourceClass   = "RESOURCE_CLASS"
	colExecutor        = "EXECUTOR"
	colOperatingSystem = "OPERATING_SYSTEM"
	colJobRunDate      = "JOB_RUN_DATE"
	colJobRunSeconds   = "JOB_RUN_SECONDS"
	colMedianCPUPct    = "MEDIAN_CPU_UTILIZATION_PCT"
	colMaxCPUPct       = "MAX_CPU_UTILIZATION_PCT"
	colMedianRAMPct    = "MEDIAN_RAM_UTILIZATION_PCT"
	colMaxRAMPct       = "MAX_RAM_UTILIZATION_PCT"
	colComputeCredits  = "COMPUTE_CREDITS"
	colTotalCredits    = "TOTAL_CREDITS"
)

// Reduce parses one usage-export CSV (already gzip-decompressed) and folds
// every row into per-day, per-JobKey aggregates.
//
// A row is skipped -- not an error, just excluded -- when:
//   - PROJECT_ID, JOB_NAME, or RESOURCE_CLASS is empty (nothing to key it by);
//   - JOB_RUN_DATE does not parse (nothing to bucket it under);
//   - either utilisation pair (median+max CPU, median+max RAM) does not
//     parse as a number. This is the common, expected case for a job run
//     CircleCI never profiled (canceled before starting, too short to
//     sample, etc.) -- counting it with a fabricated 0% would understate
//     the job's real utilisation rather than just having one fewer sample.
//
// Reduce reads the whole CSV into memory (via csv.Reader, which itself
// streams row by row) but never retains the raw rows once folded into the
// returned DayBuckets -- satisfying issue #307's "never persist raw
// org-wide rows" constraint at the point data first enters this program's
// memory, not just at the point it is written to disk.
func Reduce(r io.Reader) (DayBuckets, error) {
	cr := csv.NewReader(bufio.NewReader(r))
	// The export can legitimately carry more columns than any one version of
	// this parser names (see usageCSVColumns' own comment); a fixed field
	// count would make an upstream schema addition a hard failure instead of
	// an ignored column.
	cr.FieldsPerRecord = -1

	header, err := cr.Read()
	if err != nil {
		if err == io.EOF {
			return DayBuckets{}, nil
		}
		return nil, fmt.Errorf("usage: read CSV header: %w", err)
	}
	col := make(map[string]int, len(header))
	for i, name := range header {
		col[strings.TrimSpace(name)] = i
	}

	get := func(row []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[i])
	}

	buckets := DayBuckets{}
	for {
		row, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("usage: read CSV row: %w", err)
		}

		key := JobKey{
			ProjectID:       get(row, colProjectID),
			JobName:         get(row, colJobName),
			ResourceClass:   get(row, colResourceClass),
			Executor:        get(row, colExecutor),
			OperatingSystem: get(row, colOperatingSystem),
		}
		if key.ProjectID == "" || key.JobName == "" || key.ResourceClass == "" {
			continue
		}

		day, ok := parseRunDate(get(row, colJobRunDate))
		if !ok {
			continue
		}

		medianCPU, ok1 := parsePercent(get(row, colMedianCPUPct))
		maxCPU, ok2 := parsePercent(get(row, colMaxCPUPct))
		medianRAM, ok3 := parsePercent(get(row, colMedianRAMPct))
		maxRAM, ok4 := parsePercent(get(row, colMaxRAMPct))
		if !ok1 || !ok2 || !ok3 || !ok4 {
			continue
		}

		runSeconds, _ := strconv.ParseFloat(get(row, colJobRunSeconds), 64)
		computeCredits, _ := strconv.ParseFloat(get(row, colComputeCredits), 64)
		totalCredits, _ := strconv.ParseFloat(get(row, colTotalCredits), 64)

		agg := DayAggregate{
			ProjectName:     get(row, colProjectName),
			Runs:            1,
			SumMedianCPUPct: medianCPU,
			SumMaxCPUPct:    maxCPU,
			MaxOfMaxCPUPct:  maxCPU,
			SumMedianRAMPct: medianRAM,
			SumMaxRAMPct:    maxRAM,
			MaxOfMaxRAMPct:  maxRAM,
			RunSeconds:      runSeconds,
			ComputeCredits:  computeCredits,
			TotalCredits:    totalCredits,
		}

		dayKey := day.Format(dayLayout)
		jobs := buckets[dayKey]
		if jobs == nil {
			jobs = make(map[JobKey]DayAggregate)
			buckets[dayKey] = jobs
		}
		if prior, ok := jobs[key]; ok {
			jobs[key] = prior.merge(agg)
		} else {
			jobs[key] = agg
		}
	}

	return buckets, nil
}

// parseRunDate parses JOB_RUN_DATE, tolerating both a bare date
// ("2026-07-30", the documented DATE-column shape) and a full timestamp (in
// case a future export version widens the column) by taking only its date
// portion. ok is false when v is empty or matches neither.
func parseRunDate(v string) (time.Time, bool) {
	if v == "" {
		return time.Time{}, false
	}
	if t, err := time.ParseInLocation(dayLayout, v, time.UTC); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC().Truncate(24 * time.Hour), true
	}
	return time.Time{}, false
}

// parsePercent parses one of the four *_UTILIZATION_PCT columns. ok is false
// for an empty string or anything that does not parse as a number -- see
// Reduce's doc comment for why that is treated as "no data", not "0%".
func parsePercent(v string) (float64, bool) {
	if v == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}
