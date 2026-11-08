import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DIRECTORY_POLL_MS, DirectorySync } from './directory-sync.service';

/**
 * Spec 0005, AC-12: every 30 s, one tick of the directory sync. A tick still running when the
 * next one is due is not overlapped in this process; across copies the lease decides (AC-16).
 */
@Injectable()
export class DirectoryPollJob {
  private running = false;

  constructor(private readonly sync: DirectorySync) {}

  @Interval(DIRECTORY_POLL_MS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sync.tick();
    } finally {
      this.running = false;
    }
  }
}
