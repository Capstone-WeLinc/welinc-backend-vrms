import type { PrismaService } from '../../../shared/prisma.service';
import { FakeSettings } from '../../../settings/settings.fake';
import { DeliveryRetentionJob } from './delivery-retention.job';

// Spec 0029 (child 0004), AC-23.

describe('DeliveryRetentionJob (AC-23)', () => {
  it('deletes only sent and dismissed rows older than the setting', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const job = new DeliveryRetentionJob(
      { delivery: { deleteMany } } as unknown as PrismaService,
      new FakeSettings({ 'integration.deliveryRetentionDays': 30 }),
    );
    const now = new Date('2026-11-27T19:30:00.000Z');
    await expect(job.run(now)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['SENT', 'DISMISSED'] },
        createdAt: { lt: new Date('2026-10-28T19:30:00.000Z') },
      },
    });
  });

  it('never throws when the delete fails', async () => {
    const job = new DeliveryRetentionJob(
      {
        delivery: {
          deleteMany: jest.fn().mockRejectedValue(new Error('db down')),
        },
      } as unknown as PrismaService,
      new FakeSettings(),
    );
    await expect(job.run()).resolves.toBe(0);
  });
});
