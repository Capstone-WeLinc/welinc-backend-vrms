import type { Prisma } from '@prisma/client';
import { enqueueDelivery } from './deliveries/enqueue-delivery';

/**
 * Spec 0029 (child 0002), AC-10: tells VMMS a referral was sent back, in the transaction that
 * rejects it. Not tied to a ticket, so it waits behind nothing in the outbox.
 */
export async function queueReferralRejected(
  tx: Prisma.TransactionClient,
  referral: { id: string; rejectionReason: string },
): Promise<string> {
  const [{ at }] = await tx.$queryRaw<
    { at: Date }[]
  >`SELECT clock_timestamp() AS at`;
  return enqueueDelivery(tx, {
    kind: 'REFERRAL_REJECTED',
    referralId: referral.id,
    payload: {
      referralId: referral.id,
      eventType: 'REJECTED',
      reason: referral.rejectionReason,
      occurredAt: at.toISOString(),
    },
  });
}
