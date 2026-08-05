/**
 * Local, offline validation for a workflow trigger's `schedule.cron` string
 * (issue #288). Nothing about a schedule trigger is checked by
 * `POST /api/validate` today -- the compiler accepts any string there and
 * only CircleCI's scheduler, much later, discovers a cron that doesn't
 * parse -- which is exactly the owner's complaint: *"a wrong cron is
 * silently wrong until it fails to fire."* This gives the inspector
 * something to say before that.
 *
 * # The certainty model
 *
 * A cron string can be in one of three states, and they are kept distinct on
 * purpose -- collapsing "wrong" and "we can't tell" into one is exactly the
 * failure this project's certainty model exists to avoid: *"a thing we can't
 * evaluate must not render like a thing we know is wrong."*
 *
 *  - `'valid'` -- every field is a plain number, `*`, range, list, or step
 *    this checker fully understands, and each is in bounds. Confidently
 *    fine.
 *  - `'invalid'` -- structurally wrong in a way this checker is certain
 *    about: not five fields, an out-of-range number, a malformed range.
 *    Confidently wrong, and `reason` says which field and why.
 *  - `'unknown'` -- contains something this checker does not attempt to
 *    resolve, most commonly a `<< pipeline.parameters.* >>` substitution (a
 *    schedule trigger is not compiled per-pipeline the way a workflow's own
 *    `when:` is, but nothing stops a user from writing one, and this must
 *    not call it wrong for that). Also covers day/month *names* (`MON`,
 *    `JAN`) -- common in cron implementations generally, but CircleCI's own
 *    docs point at "POSIX crontab syntax" and POSIX itself is numeric-only,
 *    so this checker declines to vouch for them either way rather than
 *    guessing.
 *
 * Never blocks: this module only classifies a string, and the inspector
 * renders `'invalid'`/`'unknown'` as warnings, never as a refused edit --
 * see the issue's own "do not block on a cron you can't parse".
 */

export type CronCheck =
  | { state: 'valid' }
  | { state: 'invalid'; reason: string }
  | { state: 'unknown'; reason: string };

interface FieldBounds {
  label: string;
  min: number;
  max: number;
}

/** Minute, hour, day-of-month, month, day-of-week -- in that order, matching every cron field's fixed position. */
const FIELD_BOUNDS: readonly FieldBounds[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day of week', min: 0, max: 7 }, // both 0 and 7 mean Sunday
];

type FieldCheck =
  | { ok: true }
  | { ok: false; unknown: true; reason: string }
  | { ok: false; unknown: false; reason: string };

/** Validates one `/`-delimited step suffix (the `/n` in a wildcard-step or range-step field), or reports there wasn't one. */
function checkStep(
  stepPart: string | undefined,
  bounds: FieldBounds,
  wholeField: string,
): string | null {
  if (stepPart === undefined) return null;
  if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) {
    return `${bounds.label} "${wholeField}" has a step that isn't a positive whole number`;
  }
  return null;
}

/** Validates one comma-separated element of a field: `*`, a bare number, or an `a-b` range -- the three base shapes a step can apply to. */
function checkBase(
  base: string,
  bounds: FieldBounds,
  wholeField: string,
): FieldCheck {
  if (base === '*') return { ok: true };

  const range = /^(\d+)-(\d+)$/.exec(base);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo < bounds.min || hi > bounds.max || lo > hi) {
      return {
        ok: false,
        unknown: false,
        reason: `${bounds.label} range "${wholeField}" must be within ${bounds.min}-${bounds.max} with the low end first`,
      };
    }
    return { ok: true };
  }

  if (/^\d+$/.test(base)) {
    const n = Number(base);
    if (n < bounds.min || n > bounds.max) {
      return {
        ok: false,
        unknown: false,
        reason: `${bounds.label} "${wholeField}" must be within ${bounds.min}-${bounds.max}`,
      };
    }
    return { ok: true };
  }

  // Letters (day/month names), a pipeline-parameter fragment that survived
  // the `<<` short-circuit below, or anything else this checker has no rule
  // for. Not confidently wrong -- just not confidently anything.
  return {
    ok: false,
    unknown: true,
    reason: `${bounds.label} "${wholeField}" isn't a plain number, range, list, or step this checker recognizes`,
  };
}

/** Validates one whitespace-delimited cron field (which may itself be a comma-separated list). */
function checkField(raw: string, bounds: FieldBounds): FieldCheck {
  if (raw === '') {
    return { ok: false, unknown: false, reason: `${bounds.label} is empty` };
  }
  for (const part of raw.split(',')) {
    if (part === '') {
      return {
        ok: false,
        unknown: false,
        reason: `${bounds.label} "${raw}" has an empty entry between commas`,
      };
    }
    const slashCount = part.split('/').length - 1;
    if (slashCount > 1) {
      return {
        ok: false,
        unknown: false,
        reason: `${bounds.label} "${part}" has more than one "/"`,
      };
    }
    const [base, stepPart] = part.split('/');
    const stepProblem = checkStep(stepPart, bounds, part);
    if (stepProblem) return { ok: false, unknown: false, reason: stepProblem };
    const baseResult = checkBase(base ?? '', bounds, part);
    if (!baseResult.ok) return baseResult;
  }
  return { ok: true };
}

/**
 * Classifies `cron` (the raw string a `schedule.cron:` field holds) into
 * `'valid'`/`'invalid'`/`'unknown'` -- see the module comment for what each
 * means and why they're kept apart. Pure and synchronous: no network call,
 * so the inspector can show this on every keystroke without a debounce.
 */
export function validateCron(cron: string): CronCheck {
  const trimmed = cron.trim();
  if (trimmed === '') {
    return { state: 'invalid', reason: 'A cron expression is required.' };
  }

  // A pipeline-value substitution can appear anywhere in the string (even
  // spanning what would otherwise be field boundaries, e.g.
  // `<< pipeline.parameters.schedule >>` alone) and this checker has no way
  // to know what it resolves to -- so the whole expression is `'unknown'`
  // rather than attempting (and likely failing) to split it into five
  // fields first.
  if (trimmed.includes('<<')) {
    return {
      state: 'unknown',
      reason:
        'This cron expression references a pipeline value, which this checker cannot resolve ahead of time -- CircleCI validates the substituted value when the schedule runs.',
    };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      state: 'invalid',
      reason: `A cron expression has 5 fields (minute hour day-of-month month day-of-week), separated by whitespace; this has ${fields.length}.`,
    };
  }

  let unknownReason: string | null = null;
  for (let i = 0; i < fields.length; i++) {
    const bounds = FIELD_BOUNDS[i];
    const field = fields[i];
    if (!bounds || field === undefined) continue; // unreachable: fields.length === 5 === FIELD_BOUNDS.length
    const result = checkField(field, bounds);
    if (result.ok) continue;
    if (!result.unknown) return { state: 'invalid', reason: result.reason };
    unknownReason = result.reason;
  }

  return unknownReason
    ? { state: 'unknown', reason: unknownReason }
    : { state: 'valid' };
}
