/** Injectable clock. Every time-dependent rule (deadlines, due dates, token expiry) reads from here. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A controllable clock for tests and for the demo's "time travel" control. */
export class ManualClock implements Clock {
  #t: number;
  constructor(start: Date | string = new Date()) {
    this.#t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#t);
  }
  set(t: Date | string): void {
    this.#t = new Date(t).getTime();
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}

/** A clock offset from real time; used by the demo so seeded deadlines stay relative to "today". */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

export const iso = (d: Date): string => d.toISOString();
export const DAY_MS = 24 * 60 * 60 * 1000;
