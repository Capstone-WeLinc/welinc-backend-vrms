import type { Prisma, RepairPriority } from '@prisma/client';
import {
  auditData,
  expediteDecidedEvent,
  stampedAt,
  systemActor,
} from '../../vrms/audit-events';
import { enqueueDelivery } from '../deliveries/enqueue-delivery';

// Spec 0029 (child 0003), AC-19: VRMS's answer to a BMS expedite request, and the auto decline
// when a ticket closes or is cancelled. Both run inside the transaction that decides the request.

export type ExpediteDecision = {
  requestId: string;
  repairTicketId: string;
  repairTicketNumber: string;
  decision: 'ACCEPTED' | 'DECLINED';
  reason: string | null;
  priority: RepairPriority | null;
  expectedReturnAt: Date | null;
};

/** The answer to BMS, queued behind earlier BMS messages for the same ticket. */
export async function queueExpediteAnswer(
  tx: Prisma.TransactionClient,
  answer: ExpediteDecision,
): Promise<string> {
  const [{ at }] = await tx.$queryRaw<
    { at: Date }[]
  >`SELECT clock_timestamp() AS at`;
  return enqueueDelivery(tx, {
    kind: 'EXPEDITE_ANSWER',
    repairTicketId: answer.repairTicketId,
    expediteRequestId: answer.requestId,
    payload: {
      requestId: answer.requestId,
      repairTicketNumber: answer.repairTicketNumber,
      decision: answer.decision,
      reason: answer.reason,
      priority: answer.priority,
      expectedReturnAt: answer.expectedReturnAt?.toISOString() ?? null,
      occurredAt: at.toISOString(),
    },
  });
}

export const AUTO_DECLINE_REASON = {
  CLOSED: 'Repair finished',
  CANCELLED: 'Repair cancelled',
} as const;

/**
 * AC-19: on the move to Closed or Cancelled, every waiting request on the ticket is declined by
 * VRMS with the reason, audited, and answered. Called after the move's own repair update, under
 * the ticket's row lock, so the answers follow the update in send order. Answers how many.
 */
export async function declineWaitingExpedites(
  tx: Prisma.TransactionClient,
  repairTicketId: string,
  finished: keyof typeof AUTO_DECLINE_REASON,
  now: Date,
): Promise<number> {
  const reason = AUTO_DECLINE_REASON[finished];
  // Ticket first, then its requests: the same lock order as intake and accept
  const waiting = await tx.$queryRaw<{ id: string; jobOrderNumber: string }[]>`
    SELECT id, job_order_number AS "jobOrderNumber"
    FROM expedite_requests
    WHERE repair_ticket_id = ${repairTicketId}::uuid AND status = 'WAITING'
    ORDER BY received_at, id
    FOR UPDATE
  `;
  if (waiting.length === 0) return 0;
  const ticket = await tx.repairTicket.findUniqueOrThrow({
    where: { id: repairTicketId },
    select: { id: true, repairNumber: true },
  });
  for (const [i, request] of waiting.entries()) {
    await tx.expediteRequest.update({
      where: { id: request.id },
      data: { status: 'DECLINED', responseReason: reason, decidedAt: now },
    });
    await tx.auditLog.create({
      data: {
        repairTicketId: ticket.id,
        ...auditData(
          systemActor('VRMS'),
          expediteDecidedEvent('DECLINED', request.jobOrderNumber, reason),
          // After the move's own row, 1 ms apart (spec 0021, AC-3b)
          stampedAt(now, i + 1),
        ),
      },
    });
    await queueExpediteAnswer(tx, {
      requestId: request.id,
      repairTicketId: ticket.id,
      repairTicketNumber: ticket.repairNumber,
      decision: 'DECLINED',
      reason,
      priority: null,
      expectedReturnAt: null,
    });
  }
  return waiting.length;
}
