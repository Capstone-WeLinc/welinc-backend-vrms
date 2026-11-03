import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, RepairStatus } from '@prisma/client';
import { Actor, whoName } from './audit-events';
import { STALE_TICKET } from './ticket-knowledge';
import { isFinished } from './ticket-statuses';

// Spec 0019: the rules every edit after create shares. Pure where it can be, so they test
// without a database.

export const TICKET_LOCKED_MESSAGE =
  'Closed and Cancelled tickets are locked. An Admin must unlock this ticket first.';

/**
 * AC-2 and AC-3: the audit note an edit carries. Open statuses need none (null). A Closed or
 * Cancelled ticket must be unlocked, and then the edit needs a reason of 5 to 500 characters
 * after trimming, which becomes the note.
 */
export function editNote(
  ticket: { repairStatus: RepairStatus; isUnlocked: boolean },
  reason: string | undefined,
): string | null {
  if (!isFinished(ticket.repairStatus)) return null;
  if (!ticket.isUnlocked) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'TICKET_LOCKED',
      message: TICKET_LOCKED_MESSAGE,
    });
  }
  const text = reason?.trim() ?? '';
  if (text.length < 5 || text.length > 500) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'REASON_REQUIRED',
      message:
        'Say why this closed ticket is being changed (5 to 500 characters).',
    });
  }
  return text;
}

/** AC-18: the body's lastUpdatedAt must match the loaded ticket, else the usual 409. */
export function assertFresh(
  ticket: { updatedAt: Date },
  lastUpdatedAt: string,
): void {
  if (ticket.updatedAt.toISOString() !== lastUpdatedAt) {
    throw new ConflictException(STALE_TICKET);
  }
}

/**
 * AC-19: the first write of every edit transaction. Only the loaded updatedAt may move on, and
 * the same write carries the edit stamp, so two saves at once can't both pass. `data` is any
 * scalar change the edit makes to the ticket itself.
 */
export async function stampEdit(
  tx: Prisma.TransactionClient,
  ticket: { id: string; updatedAt: Date },
  user: Actor,
  now: Date,
  data: Prisma.RepairTicketUpdateManyMutationInput = {},
  /** Spec 0021, AC-3b: the newest audit row the edit writes, when it writes several. */
  activityAt: Date = now,
): Promise<void> {
  const { count } = await tx.repairTicket.updateMany({
    where: { id: ticket.id, updatedAt: ticket.updatedAt },
    data: {
      ...data,
      editedAt: now,
      editedByUserId: user.sub,
      editedByName: whoName(user),
      updatedAt: now,
      lastActivityAt: activityAt,
    },
  });
  if (count === 0) throw new ConflictException(STALE_TICKET);
}
