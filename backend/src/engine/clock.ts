// The engine's only source of time and timers, so tests can run a 150 s replay instantly.

export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * A manual clock for tests. advance(ms) fires due timers in time order and, after each one,
 * lets pending promises (e.g. a fake Sender's result) settle before moving on.
 */
export class FakeClock implements Clock {
  private t = 0;
  private nextId = 1;
  private timers = new Map<number, { fn: () => void; ms: number; due: number }>();

  now(): number {
    return this.t;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, due: this.t + ms });
    return id;
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: { fn: () => void; ms: number; due: number } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.due <= end && (!next || timer.due < next.due)) (next = timer), (nextId = id);
      }
      if (!next) break;
      this.t = next.due;
      next.due += next.ms;
      if (this.timers.has(nextId)) next.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.t = end;
    await new Promise<void>((r) => setImmediate(r));
  }
}
