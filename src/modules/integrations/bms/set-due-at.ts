import type { DueAtSource, Prisma } from '@prisma/client';
import {
  auditData,
  dueDateEvent,
  type RowActor,
} from '../../vrms/audit-events';
import { queueBmsRepairUpdate } from './bms-repair-updates';

// Spec 0029 (child 0003): the one writer of RepairTicket.dueAt and dueAtSource. Every change
// writes its audit row and reaches BMS as a repair update with the reason. Spec 0030 (feature 42)
// routes every due date write through it: create, the recomputes in due-dates.ts, the hand change
// and reset, the expedite and the backfill.

export type DueAtChange = {
  dueAt: Date | null;
  /** Set and cleared together with dueAt; ignored when dueAt is null. */
  source: DueAtSource;
  /** The audit note and BMS's changeReason, for example "Expedite JO-2026-0142". */
  reason: string;
};

/**
 * Writes the ticket's due date inside the caller's transaction, which already holds the
 * ticket's row lock. Answers whether anything changed: the same date writes nothing.
 */
export async function setDueAt(
  tx: Prisma.TransactionClient,
  ticket: { id: string; dueAt: Date | null; dueAtSource?: DueAtSource | null },
  change: DueAtChange,
  actor: RowActor,
  at: Date,
  /** Spec 0030: only for a path that queues its own BMS update right after (create, referral). */
  options: { skipBmsUpdate?: boolean } = {},
): Promise<boolean> {
  const before = ticket.dueAt?.getTime() ?? null;
  const after = change.dueAt?.getTime() ?? null;
  if (before === after) {
    // Same date, other rule (a reset that lands on the hand date): keep the source honest.
    // BMS never sees the source and the date did not move, so no audit row and no update.
    if (
      change.dueAt &&
      'dueAtSource' in ticket &&
      ticket.dueAtSource !== change.source
    ) {
      await tx.repairTicket.update({
        where: { id: ticket.id },
        data: { dueAtSource: change.source },
      });
    }
    return false;
  }
  await tx.repairTicket.update({
    where: { id: ticket.id },
    data: {
      dueAt: change.dueAt,
      dueAtSource: change.dueAt ? change.source : null,
    },
  });
  await tx.auditLog.create({
    data: {
      repairTicketId: ticket.id,
      ...auditData(
        actor,
        dueDateEvent(ticket.dueAt, change.dueAt, change.reason),
        at,
      ),
    },
  });
  if (!options.skipBmsUpdate) {
    await queueBmsRepairUpdate(tx, ticket.id, change.reason);
  }
  return true;
}
