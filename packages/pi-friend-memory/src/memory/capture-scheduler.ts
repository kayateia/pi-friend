/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/** Schedules capture after settled-run count or post-settlement idle time. */
export class AutoCaptureScheduler {
  private readonly everyTurns: number;
  private readonly idleTimeoutMs: number;
  private readonly isIdle: () => boolean;
  private readonly capture: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settledRuns = 0;
  private inFlight = false;
  private stopped = false;

  constructor(options: {
    everyTurns: number;
    idleTimeoutMs: number;
    isIdle: () => boolean;
    capture: () => Promise<void>;
  }) {
    this.everyTurns = options.everyTurns;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.isIdle = options.isIdle;
    this.capture = options.capture;
  }

  /**
   * Records one settled run and starts or resets the idle debounce.
   *
   * Count-triggered capture is awaited so Pi settlement includes it. Timer
   * capture runs in the background after the session is confirmed idle.
   */
  async onSettled(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.clearTimer();
    this.settledRuns += 1;
    if (this.settledRuns >= this.everyTurns) {
      this.settledRuns = 0;
      await this.runCapture();
      return;
    }
    this.scheduleTimer();
  }

  /** Cancels pending timer work and prevents a later capture. */
  shutdown(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Starts one post-settlement debounce for idle capture. */
  private scheduleTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || this.inFlight || !this.isIdle()) {
        return;
      }
      this.settledRuns = 0;
      void this.runCapture();
    }, this.idleTimeoutMs);
  }

  /** Runs capture with a single-flight guard. */
  private async runCapture(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.capture();
    } finally {
      this.inFlight = false;
    }
  }

  /** Clears the pending idle timer. */
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
