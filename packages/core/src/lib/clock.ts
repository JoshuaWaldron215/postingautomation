/**
 * Clock abstraction. Real execution uses wall-clock time. Demo/simulation can apply a
 * per-organization offset stored in the database so every process (dashboard, scheduler,
 * worker protocol) observes the same simulated "now".
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class OffsetClock implements Clock {
  constructor(private readonly offsetMs: number) {}
  now() {
    return new Date(Date.now() + this.offsetMs);
  }
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now() {
    return new Date(this.current);
  }
  set(d: Date) {
    this.current = new Date(d);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
