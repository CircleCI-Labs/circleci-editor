/**
 * Shared, session-cached accessor for CircleCI's live machine-image catalog
 * (issue #305) -- modelled on `useResourceClasses`, for the same reason: a
 * picker that can remount (a dialog closing and reopening) should not cost a
 * second request for data that changes on the order of a day
 * (`internal/offerings`' `cacheTTL`), not every render.
 *
 * # Three states, mirroring `useResourceClasses`
 *
 *  - `undefined` -- the one fetch is in flight. `MachineImagePicker` renders
 *    its own unfiltered fallback in this state, never a spinner: this
 *    populates a picker inside a dialog that has already opened.
 *  - `available: true` -- a real catalog, fetched now or served from the
 *    host's cache (possibly `stale`, which the caller shows rather than
 *    hides -- see `MachineOfferingsState.stale`).
 *  - `available: false` -- nothing to filter or flag with. The caller falls
 *    back to `images.ts`'s hand-curated `MACHINE_IMAGES` literal, fully
 *    unfiltered -- exactly the offline floor already established, amended by
 *    this issue rather than replaced.
 */
import { useEffect, useState } from 'react';

import { getMachineOfferings } from '~/lib/rpc/client';

import type { MachineOfferingsResponse } from './types';

/** What this module hands every caller -- never the raw wire response, so a defaulted, always-present shape is the only one any consumer has to handle. */
export interface MachineOfferingsState {
  available: boolean;
  reason?: string;
  linux: Readonly<Record<string, readonly string[]>>;
  windows: Readonly<Record<string, readonly string[]>>;
  macos: Readonly<Record<string, readonly string[]>>;
  deprecated: Readonly<Record<string, readonly string[]>>;
  fetchedAt?: string;
  live: boolean;
  stale: boolean;
}

const UNAVAILABLE: MachineOfferingsState = {
  available: false,
  linux: {},
  windows: {},
  macos: {},
  deprecated: {},
  live: false,
  stale: false,
};

function toState(response: MachineOfferingsResponse): MachineOfferingsState {
  if (!response.available) {
    return { ...UNAVAILABLE, reason: response.reason };
  }
  return {
    available: true,
    reason: response.reason,
    linux: response.linux ?? {},
    windows: response.windows ?? {},
    macos: response.macos ?? {},
    deprecated: response.deprecated ?? {},
    fetchedAt: response.fetchedAt,
    live: response.live ?? false,
    stale: response.stale ?? false,
  };
}

/**
 * Resolves to `UNAVAILABLE` rather than rejecting, on the same reasoning as
 * `imageTags.ts`'s `fetchCimgTags`: a caller that forgets to handle the
 * offline case still degrades to the picker's static fallback instead of an
 * unhandled rejection.
 */
function unreachableHostResponse(): MachineOfferingsState {
  return {
    ...UNAVAILABLE,
    reason:
      "This app's own local server didn't return a machine-image catalog, so only the built-in list is offered here.",
  };
}

let cached: Promise<MachineOfferingsState> | null = null;

function load(): Promise<MachineOfferingsState> {
  cached ??= getMachineOfferings()
    .then(toState)
    .catch(() => unreachableHostResponse());
  return cached;
}

/** Test-only escape hatch, mirroring `__resetResourceClassesCacheForTests`. */
export function __resetMachineOfferingsCacheForTests(): void {
  cached = null;
}

/** `undefined` while the at-most-once fetch is in flight; the resolved state after. */
export function useMachineOfferings(): MachineOfferingsState | undefined {
  const [state, setState] = useState<MachineOfferingsState | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    load().then((resolved) => {
      if (!cancelled) setState(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Forces a live re-fetch, bypassing the host's own cacheTTL, for the
 * picker's manual "check now" affordance (issue #285, extended by #305).
 * Replaces the shared module cache with the fresh result, so a picker
 * closed and reopened afterward sees it too -- mirroring
 * `imageTags.ts`'s `refreshCimgTags`, at the whole-catalog scope this data
 * has rather than per-repo.
 *
 * Never rejects, for the same reason `load` doesn't.
 */
export function refreshMachineOfferings(): Promise<MachineOfferingsState> {
  const request = getMachineOfferings(true)
    .then(toState)
    .catch(() => unreachableHostResponse());
  cached = request;
  return request;
}
