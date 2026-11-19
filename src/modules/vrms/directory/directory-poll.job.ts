import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DirectoryPollMonitor } from '../../../monitoring/directory-poll-monitor';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { DIRECTORY_POLL_MS, DirectorySync } from './directory-sync.service';

/**
 * Spec 0005, AC-12: every 30 s, one tick of the directory sync. A tick still running when the
 * next one is due is not overlapped in this process; across copies the lease decides (AC-16).
 * Spec 0025, AC-10: each run checks in to the Sentry cron monitor (throttled), and a tick that
 * throws is reported here, never rethrown into the scheduler.
 */
@Injectable()
export class DirectoryPollJob {
  private readonly logger = new Logger(DirectoryPollJob.name);
  private readonly monitor: DirectoryPollMonitor;
  private running = false;

  constructor(
    private readonly sync: DirectorySync,
    // Not a provider: Nest passes undefined and the real monitor is used; tests pass a fake
    @Optional() monitor?: DirectoryPollMonitor,
  ) {
    this.monitor = monitor ?? new DirectoryPollMonitor();
  }

  @Interval(DIRECTORY_POLL_MS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const outcome = await this.sync.tick();
      switch (outcome.kind) {
        case 'failing':
        case 'error':
          this.monitor.error();
          break;
        case 'skipped': // another copy holds the lease and checks in itself
        case 'stopped': // the lease moved to another copy mid tick
          break;
        default:
          this.monitor.ok();
      }
    } catch (error) {
      // The lease claim or release itself failed (the database is down, for example)
      this.logger.error(
        `Directory poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportJobFailure('directory-poll', error);
      this.monitor.error();
    } finally {
      this.running = false;
    }
  }
}
