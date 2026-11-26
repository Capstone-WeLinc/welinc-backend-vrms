import { randomUUID } from 'node:crypto';
import type { DeliveryKind, Prisma } from '@prisma/client';
import { KIND_ROUTES } from './delivery-kinds';

export type EnqueueInput = {
  kind: DeliveryKind;
  /** The message as the other system reads it, minus `eventId` (set here) and `eventVersion` (set at send). */
  payload: Record<string, unknown>;
  repairTicketId?: string;
  referralId?: string;
  expediteRequestId?: string;
};

/**
 * Spec 0029 (child 0004), AC-21: the only insert into the outbox. Always called with the
 * transaction of the change it reports, so the change and its message commit together or not at
 * all. Answers the new row's id, which is also the `eventId` the other system dedupes on.
 */
export async function enqueueDelivery(
  tx: Prisma.TransactionClient,
  input: EnqueueInput,
): Promise<string> {
  const id = randomUUID();
  await tx.delivery.create({
    data: {
      id,
      target: KIND_ROUTES[input.kind].target,
      kind: input.kind,
      payload: { ...input.payload, eventId: id },
      repairTicketId: input.repairTicketId,
      referralId: input.referralId,
      expediteRequestId: input.expediteRequestId,
    },
  });
  return id;
}
