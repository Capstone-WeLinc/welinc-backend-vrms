import * as Sentry from '@sentry/nestjs';

/** VRMS spec 0025, AC-10: the one Sentry cron monitor, on the 30 s directory poll. */
export const DIRECTORY_POLL_MONITOR = 'vrms-directory-poll';

/** Sentry schedules count in minutes, so the poll checks in `ok` at most every 5 minutes. */
export const OK_CHECK_IN_EVERY_MS = 5 * 60 * 1000;

const MONITOR_CONFIG = {
  schedule: { type: 'interval', value: 5, unit: 'minute' },
  checkinMargin: 5,
  maxRuntime: 2,
} as const;

type CheckIn = typeof Sentry.captureCheckIn;

/**
 * Throttled check ins for the directory poll. `ok` goes out on the first good run after a boot
 * (nothing sent yet), after a failure, and then when 5 minutes have passed since the last `ok`;
 * `error` goes out at once on every failing run. No `in_progress` check ins. The SDK creates the
 * monitor on the first check in and tags each one with the environment. Never throws.
 */
export class DirectoryPollMonitor {
  private lastOkAt: number | null = null;

  constructor(
    private readonly send: CheckIn = Sentry.captureCheckIn,
    private readonly now: () => number = Date.now,
  ) {}

  ok(): void {
    const at = this.now();
    if (this.lastOkAt !== null && at - this.lastOkAt < OK_CHECK_IN_EVERY_MS)
      return;
    if (this.checkIn('ok')) this.lastOkAt = at;
  }

  error(): void {
    this.checkIn('error');
    // The first good run after a failure checks in at once, so the monitor recovers promptly
    this.lastOkAt = null;
  }

  private checkIn(status: 'ok' | 'error'): boolean {
    try {
      this.send(
        { monitorSlug: DIRECTORY_POLL_MONITOR, status },
        MONITOR_CONFIG,
      );
      return true;
    } catch {
      return false;
    }
  }
}
