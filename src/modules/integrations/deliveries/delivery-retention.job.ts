import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { PrismaService } from '../../../shared/prisma.service';
import { SettingsService } from '../../../settings/settings.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Spec 0029 (child 0004), AC-23: every night, deletes sent and dismissed messages older than
 * `integration.deliveryRetentionDays`. Pending and failed rows are never deleted.
 */
@Injectable()
export class DeliveryRetentionJob {
  private readonly logger = new Logger(DeliveryRetentionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Cron('0 30 3 * * *', { timeZone: 'Asia/Manila' })
  async run(now = new Date()): Promise<number> {
    try {
      const days = this.settings.get('integration.deliveryRetentionDays');
      const { count } = await this.prisma.delivery.deleteMany({
        where: {
          status: { in: ['SENT', 'DISMISSED'] },
          createdAt: { lt: new Date(now.getTime() - days * DAY_MS) },
        },
      });
      if (count > 0) this.logger.log(`Deleted ${count} old deliveries`);
      return count;
    } catch (error) {
      this.logger.error('Delivery retention failed', error as Error);
      reportJobFailure('delivery-retention', error);
      return 0;
    }
  }
}
