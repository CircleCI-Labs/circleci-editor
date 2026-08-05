import { describe, expect, it } from 'vitest';

import {
  isDraggingOrbKind,
  readOrbDragPayload,
  setOrbDragPayload,
} from './dragPayload';
import type { OrbElement } from './types';

/** A minimal `DataTransfer` stand-in: jsdom's own doesn't implement `setData`/`getData` reliably in this Vitest environment. */
class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  effectAllowed = 'none';

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) ?? '';
  }

  get types(): string[] {
    return Array.from(this.data.keys());
  }
}

const COMMAND: OrbElement = {
  name: 'install-packages',
  kind: 'command',
  description: 'Installs packages',
  parameters: [],
};

describe('orb drag payload', () => {
  it('round-trips a payload through set/read for the matching kind', () => {
    const dt = new FakeDataTransfer() as unknown as DataTransfer;
    setOrbDragPayload(dt, 'circleci/node@5.2.0', COMMAND);

    expect(isDraggingOrbKind(dt, 'command')).toBe(true);
    expect(isDraggingOrbKind(dt, 'job')).toBe(false);
    expect(isDraggingOrbKind(dt, 'executor')).toBe(false);

    const payload = readOrbDragPayload(dt, 'command');
    expect(payload).toEqual({
      kind: 'command',
      orbRef: 'circleci/node@5.2.0',
      element: COMMAND,
    });
  });

  it('readOrbDragPayload for the wrong kind returns undefined', () => {
    const dt = new FakeDataTransfer() as unknown as DataTransfer;
    setOrbDragPayload(dt, 'circleci/node@5.2.0', COMMAND);

    expect(readOrbDragPayload(dt, 'job')).toBeUndefined();
    expect(readOrbDragPayload(dt, 'executor')).toBeUndefined();
  });

  it('readOrbDragPayload returns undefined when nothing was set', () => {
    const dt = new FakeDataTransfer() as unknown as DataTransfer;
    expect(readOrbDragPayload(dt, 'command')).toBeUndefined();
  });
});
