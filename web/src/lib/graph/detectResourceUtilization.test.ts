import { describe, expect, it } from 'vitest';

import { parseConfig } from '~/lib/yaml/documentUtils';

import {
  findResourceUtilizationFindings,
  HIGH_RAM_THRESHOLD_PCT,
  LOW_CPU_THRESHOLD_PCT,
  MIN_SAMPLE_RUNS,
  type JobUtilizationSummary,
  type ResourceClassCatalog,
} from './detectResourceUtilization';

function parse(text: string) {
  const { doc, error } = parseConfig(text);
  if (!doc) throw new Error(`fixture failed to parse: ${error}`);
  return doc;
}

function job(overrides: Partial<JobUtilizationSummary>): JobUtilizationSummary {
  return {
    jobName: 'build',
    resourceClass: 'large',
    executor: 'docker',
    operatingSystem: 'linux',
    runs: MIN_SAMPLE_RUNS,
    avgMedianCpuPct: 60,
    avgMaxCpuPct: 70,
    maxMaxCpuPct: 75,
    avgMedianRamPct: 40,
    avgMaxRamPct: 50,
    maxMaxRamPct: 55,
    computeCredits: 1,
    totalCredits: 1,
    ...overrides,
  };
}

const CONFIG = `jobs:
  build:
    resource_class: large
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`;

describe('findResourceUtilizationFindings', () => {
  it('flags a job with low median CPU utilisation', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ avgMedianCpuPct: LOW_CPU_THRESHOLD_PCT - 1 })];
    const findings = findResourceUtilizationFindings(doc, jobs, 7);
    expect(findings).toEqual([
      {
        kind: 'low-cpu',
        jobName: 'build',
        resourceClass: 'large',
        executor: 'docker',
        runs: MIN_SAMPLE_RUNS,
        windowDays: 7,
        metricPct: LOW_CPU_THRESHOLD_PCT - 1,
        suggestedClass: undefined,
      },
    ]);
  });

  it('does not flag a job at or above the CPU threshold', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ avgMedianCpuPct: LOW_CPU_THRESHOLD_PCT })];
    expect(findResourceUtilizationFindings(doc, jobs, 7)).toEqual([]);
  });

  it('flags a job with a max RAM run near the ceiling', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ maxMaxRamPct: HIGH_RAM_THRESHOLD_PCT })];
    const findings = findResourceUtilizationFindings(doc, jobs, 14);
    expect(findings).toEqual([
      {
        kind: 'high-ram',
        jobName: 'build',
        resourceClass: 'large',
        executor: 'docker',
        runs: MIN_SAMPLE_RUNS,
        windowDays: 14,
        metricPct: HIGH_RAM_THRESHOLD_PCT,
        suggestedClass: undefined,
      },
    ]);
  });

  it('under- and over-utilisation are independent -- a job can trigger both', () => {
    const doc = parse(CONFIG);
    const jobs = [
      job({
        avgMedianCpuPct: LOW_CPU_THRESHOLD_PCT - 1,
        maxMaxRamPct: HIGH_RAM_THRESHOLD_PCT,
      }),
    ];
    const findings = findResourceUtilizationFindings(doc, jobs, 7);
    expect(findings.map((f) => f.kind).sort()).toEqual(['high-ram', 'low-cpu']);
  });

  it('says nothing when there are not enough runs to mean anything', () => {
    const doc = parse(CONFIG);
    const jobs = [
      job({
        avgMedianCpuPct: 1,
        maxMaxRamPct: 99,
        runs: MIN_SAMPLE_RUNS - 1,
      }),
    ];
    expect(findResourceUtilizationFindings(doc, jobs, 7)).toEqual([]);
  });

  it('says nothing about a job that no longer exists in the config', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ jobName: 'renamed-or-removed', avgMedianCpuPct: 1 })];
    expect(findResourceUtilizationFindings(doc, jobs, 7)).toEqual([]);
  });

  it('never suggests a target class when no catalog is supplied', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ avgMedianCpuPct: 1 })];
    const findings = findResourceUtilizationFindings(doc, jobs, 7);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedClass).toBeUndefined();
  });

  it('names the nearest smaller class for a low-cpu finding, from the catalog', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ avgMedianCpuPct: 1, resourceClass: 'large' })];
    const catalog: ResourceClassCatalog = {
      smallerClasses: (executor, current) => {
        expect(executor).toBe('docker');
        expect(current).toBe('large');
        return ['medium', 'small'];
      },
      largerClasses: () => [],
    };
    const findings = findResourceUtilizationFindings(doc, jobs, 7, catalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedClass).toBe('medium');
  });

  it('names the nearest larger class for a high-ram finding, from the catalog', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ maxMaxRamPct: 99, resourceClass: 'medium' })];
    const catalog: ResourceClassCatalog = {
      smallerClasses: () => [],
      largerClasses: (executor, current) => {
        expect(executor).toBe('docker');
        expect(current).toBe('medium');
        return ['large', 'xlarge'];
      },
    };
    const findings = findResourceUtilizationFindings(doc, jobs, 7, catalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedClass).toBe('large');
  });

  it('never suggests a target when the catalog says none exists', () => {
    const doc = parse(CONFIG);
    const jobs = [job({ avgMedianCpuPct: 1 })];
    const catalog: ResourceClassCatalog = {
      smallerClasses: () => [], // already the smallest available for this platform.
      largerClasses: () => [],
    };
    const findings = findResourceUtilizationFindings(doc, jobs, 7, catalog);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggestedClass).toBeUndefined();
  });
});
