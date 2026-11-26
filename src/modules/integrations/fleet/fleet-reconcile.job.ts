import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { SettingsService } from '../../../settings/settings.service';
import { FleetSyncService } from './fleet-sync.service';

/** The job checks this often whether `fleet.reconcileMinutes` has passed since its last run. */
export const RECONCILE_CHECK_MS = 60_000;

/**
 * Spec 0029 (child 0001), AC-3: the full read of VMMS's trucks and garages, every
 * `fleet.reconcileMinutes` (a setting, so it changes without a deploy). It waits until
 * `fleet:link` has linked at least one truck, so a fresh environment is never filled before the
 * link plan runs. Never rethrows.
 */
@Injectable()
export class FleetReconcileJob {
  private readonly logger = new Logger(FleetReconcileJob.name);
  private running = false;
  private lastRunAt = 0;

  constructor(
    private readonly sync: FleetSyncService,
    private readonly settings: SettingsService,
  ) {}

  @Interval(RECONCILE_CHECK_MS)
  async run(now = Date.now()): Promise<void> {
    if (this.running) return;
    const every = this.settings.get('fleet.reconcileMinutes') * 60_000;
    if (now - this.lastRunAt < every) return;
    this.running = true;
    try {
      if (!(await this.sync.linked())) return;
      this.lastRunAt = now;
      const report = await this.sync.reconcile(new Date(now));
      this.logger.log(
        `Fleet reconcile: ${report.vehicles.listed} trucks and ${report.garages.listed} garages read, ${report.deactivated} deactivated${report.guard ? ` (guard: ${report.guard})` : ''}`,
      );
    } catch (error) {
      this.logger.error(
        `Fleet reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportJobFailure('fleet-reconcile', error);
    } finally {
      this.running = false;
    }
  }
}
