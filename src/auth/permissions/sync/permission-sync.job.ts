import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { PERMISSION_SYNC_MS, PermissionSync } from './permission-sync.service';

/**
 * Suite spec 0013, AC-29: every 60 s, one tick of the matrix sync, plus one at startup so a fresh
 * database gets its matrix without waiting a minute. A tick still running is not overlapped in
 * this process; across copies the lease decides.
 */
@Injectable()
export class PermissionSyncJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSyncJob.name);
  private running = false;

  constructor(private readonly sync: PermissionSync) {}

  onApplicationBootstrap() {
    void this.run();
  }

  @Interval(PERMISSION_SYNC_MS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sync.tick();
    } catch (error) {
      this.logger.warn(
        `Permission matrix sync tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportJobFailure('permission-sync', error);
    } finally {
      this.running = false;
    }
  }
}
