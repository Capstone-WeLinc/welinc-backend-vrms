import { BadRequestException } from '@nestjs/common';
import { AttachmentKind, Prisma } from '@prisma/client';
import type { TicketMove } from './ticket-transitions';

// Spec 0018, AC-4 to AC-7: the photo a status move needs while its Admin switch is on. One
// definition, read both by the check inside applyStatusMove and by `moves[].blockedBy`, so the
// button and the server never disagree.

export type PhotoNeed = 'beforePhoto' | 'afterPhoto';

/** The three switches, as read from SettingsService for one request. */
export type PhotoSwitches = {
  requireBeforeToStart: boolean;
  requireAfterToSend: boolean;
  requireAfterToClose: boolean;
};

/** Live (not soft deleted) photos on a ticket, per group. */
export type PhotoCounts = { before: number; after: number };

/** The photo kind each need counts. */
const NEED_KIND: Record<PhotoNeed, AttachmentKind> = {
  beforePhoto: AttachmentKind.VEHICLE_PHOTO,
  afterPhoto: AttachmentKind.PROOF,
};

const NEED_CODE: Record<PhotoNeed, string> = {
  beforePhoto: 'BEFORE_PHOTO_REQUIRED',
  afterPhoto: 'AFTER_PHOTO_REQUIRED',
};

/** The reason text per move, the same words the web shows next to the disabled button. */
const MOVE_MESSAGE: Record<string, string> = {
  M3: 'Add a before photo first.',
  M4: 'Add an after photo first.',
  M5: 'Add an after photo before closing.',
};

/**
 * The photo this move needs under the current switches, or null. Only M3, M4 and M5 carry a
 * photo rule (AC-8); every other move, including the mechanic release, needs none.
 */
export function photoNeedOf(
  move: Pick<TicketMove, 'id'>,
  switches: PhotoSwitches,
): PhotoNeed | null {
  switch (move.id) {
    case 'M3':
      return switches.requireBeforeToStart ? 'beforePhoto' : null;
    case 'M4':
      return switches.requireAfterToSend ? 'afterPhoto' : null;
    case 'M5':
      return switches.requireAfterToClose ? 'afterPhoto' : null;
    default:
      return null;
  }
}

/** The need this move has that the ticket's live photos do not meet, or null. */
export function photoNeedUnmet(
  move: Pick<TicketMove, 'id'>,
  switches: PhotoSwitches,
  counts: PhotoCounts,
): PhotoNeed | null {
  const need = photoNeedOf(move, switches);
  if (!need) return null;
  const count = need === 'beforePhoto' ? counts.before : counts.after;
  return count > 0 ? null : need;
}

/** Live photos per group on one ticket. */
export async function livePhotoCounts(
  db: Prisma.TransactionClient,
  ticketId: string,
): Promise<PhotoCounts> {
  const rows = await db.attachment.groupBy({
    by: ['kind'],
    where: {
      repairTicketId: ticketId,
      kind: { in: Object.values(NEED_KIND) },
      deletedAt: null,
    },
    _count: { _all: true },
  });
  const of = (kind: AttachmentKind) =>
    rows.find((r) => r.kind === kind)?._count._all ?? 0;
  return {
    before: of(NEED_KIND.beforePhoto),
    after: of(NEED_KIND.afterPhoto),
  };
}

/** The 400 a move answers when its photo need is unmet (AC-4 to AC-6). */
export function photoRequired(
  move: Pick<TicketMove, 'id'>,
  need: PhotoNeed,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: NEED_CODE[need],
    message: MOVE_MESSAGE[move.id] ?? 'Add a photo first.',
  });
}
