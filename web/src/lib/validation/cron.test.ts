import { describe, expect, it } from 'vitest';

import { validateCron, type CronCheck } from './cron';

/** `check.reason`, or `''` for the one variant (`'valid'`) that has none -- lets every assertion below call `expect` unconditionally instead of guarding on `check.state` first (oxlint's `no-conditional-expect`). */
function reasonOf(check: CronCheck): string {
  return check.state === 'valid' ? '' : check.reason;
}

describe('validateCron', () => {
  it('accepts a plain five-field cron', () => {
    expect(validateCron('0 0 * * *')).toEqual({ state: 'valid' });
  });

  it('accepts lists, ranges, and steps within bounds', () => {
    expect(validateCron('*/15 0-6 1,15 * 1-5')).toEqual({ state: 'valid' });
  });

  it('accepts day-of-week 7 (Sunday, the alternate POSIX form)', () => {
    expect(validateCron('0 0 * * 7')).toEqual({ state: 'valid' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(validateCron('  0 0 * * *  ')).toEqual({ state: 'valid' });
  });

  it('rejects an empty string', () => {
    const result = validateCron('');
    expect(result.state).toBe('invalid');
  });

  it('rejects a string of only whitespace', () => {
    const result = validateCron('   ');
    expect(result.state).toBe('invalid');
  });

  it('rejects the wrong number of fields', () => {
    const tooFew = validateCron('0 0 * *');
    expect(tooFew.state).toBe('invalid');
    expect(reasonOf(tooFew)).toMatch(/5 fields/);

    const tooMany = validateCron('0 0 * * * *');
    expect(tooMany.state).toBe('invalid');
  });

  it('rejects an out-of-range minute', () => {
    const result = validateCron('60 0 * * *');
    expect(result.state).toBe('invalid');
    expect(reasonOf(result)).toMatch(/minute/);
  });

  it('rejects an out-of-range hour', () => {
    const result = validateCron('0 24 * * *');
    expect(result.state).toBe('invalid');
    expect(reasonOf(result)).toMatch(/hour/);
  });

  it('rejects day-of-month 0', () => {
    const result = validateCron('0 0 0 * *');
    expect(result.state).toBe('invalid');
    expect(reasonOf(result)).toMatch(/day of month/);
  });

  it('rejects month 13', () => {
    const result = validateCron('0 0 * 13 *');
    expect(result.state).toBe('invalid');
    expect(reasonOf(result)).toMatch(/month/);
  });

  it('rejects a backwards range', () => {
    const result = validateCron('10-5 0 * * *');
    expect(result.state).toBe('invalid');
  });

  it('rejects a non-numeric step', () => {
    const result = validateCron('*/x 0 * * *');
    expect(result.state).toBe('invalid');
  });

  it('rejects a zero step', () => {
    const result = validateCron('*/0 0 * * *');
    expect(result.state).toBe('invalid');
  });

  it('rejects more than one "/" in a field', () => {
    const result = validateCron('1/2/3 0 * * *');
    expect(result.state).toBe('invalid');
  });

  it('rejects an empty comma entry', () => {
    const result = validateCron('1,,2 0 * * *');
    expect(result.state).toBe('invalid');
  });

  it('treats a pipeline-parameter substitution as unknown, not invalid', () => {
    const result = validateCron('<< pipeline.parameters.cron-schedule >>');
    expect(result.state).toBe('unknown');
  });

  it('treats a cron with an embedded pipeline value as unknown', () => {
    const result = validateCron('0 << pipeline.parameters.hour >> * * *');
    expect(result.state).toBe('unknown');
  });

  it('treats a month/day-of-week name as unknown, not invalid', () => {
    const result = validateCron('0 0 * JAN *');
    // 5 fields, but the 4th is a name this checker declines to judge.
    expect(result.state).toBe('unknown');
  });

  it('never returns valid when any field is unknown', () => {
    const result = validateCron('0 0 * * MON');
    expect(result.state).not.toBe('valid');
  });
});
