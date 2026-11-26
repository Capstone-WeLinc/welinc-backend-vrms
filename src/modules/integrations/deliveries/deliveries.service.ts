import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  DeliveryKind,
  DeliveryStatus,
  DeliveryTarget,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import {
  type Actor,
  auditData,
  decodeCursor,
  deliveryEvent,
  encodeCursor,
  olderThan,
} from '../../vrms/audit-events';

// Spec 0029 (child 0004), AC-22: the Deliveries tab of the Audit Logs page. Reading needs
// audit.view (the route checks it); Retry and Dismiss need integration.respond.

/** A row still retrying after this many attempts shows a warning, so a missing grant is seen. */
export const WARN_AFTER_ATTEMPTS = 3;

export type DeliveryListQuery = {
  status?: DeliveryStatus;
  target?: DeliveryTarget;
  kind?: DeliveryKind;
  cursor?: string;
  limit?: number;
};

const ROW_SELECT = {
  id: true,
  createdAt: true,
  target: true,
  kind: true,
  status: true,
  attempts: true,
  lastStatusCode: true,
  lastError: true,
  repairTicket: { select: { id: true, repairNumber: true } },
  referral: { select: { id: true, workOrderNumber: true } },
} satisfies Prisma.DeliverySelect;

type Row = Prisma.DeliveryGetPayload<{ select: typeof ROW_SELECT }>;

function present(row: Row) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    target: row.target,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    ticket: row.repairTicket,
    referral: row.referral,
    warning: row.status === 'PENDING' && row.attempts >= WARN_AFTER_ATTEMPTS,
  };
}

/**
 * Failed rows come first, then the rest, each newest first. The cursor names its part ("F" or
 * "O") and the last row, so a page can end in either.
 */
function encodeListCursor(
  failed: boolean,
  row: { createdAt: Date; id: string },
) {
  return `${failed ? 'F' : 'O'}.${encodeCursor(row)}`;
}

function decodeListCursor(cursor: string) {
  const part = cursor.slice(0, 1);
  if ((part !== 'F' && part !== 'O') || cursor[1] !== '.') {
    throw new BadRequestException('Invalid cursor');
  }
  return { failed: part === 'F', at: decodeCursor(cursor.slice(2)) };
}

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(query: DeliveryListQuery) {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const cursor = query.cursor ? decodeListCursor(query.cursor) : null;
    const base: Prisma.DeliveryWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.target && { target: query.target }),
      ...(query.kind && { kind: query.kind }),
    };
    const order: Prisma.DeliveryOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    const rows: { row: Row; failed: boolean }[] = [];
    // The failed part, unless the cursor is already past it
    if (!cursor || cursor.failed) {
      const failed = await this.prisma.delivery.findMany({
        where: {
          AND: [
            base,
            { status: 'FAILED' },
            ...(cursor ? [olderThan(cursor.at)] : []),
          ],
        },
        orderBy: order,
        take: limit + 1,
        select: ROW_SELECT,
      });
      rows.push(...failed.map((row) => ({ row, failed: true })));
    }
    if (rows.length <= limit) {
      const others = await this.prisma.delivery.findMany({
        where: {
          AND: [
            base,
            { status: { not: 'FAILED' } },
            ...(cursor && !cursor.failed ? [olderThan(cursor.at)] : []),
          ],
        },
        orderBy: order,
        take: limit + 1 - rows.length,
        select: ROW_SELECT,
      });
      rows.push(...others.map((row) => ({ row, failed: false })));
    }

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const failedCount = await this.prisma.delivery.count({
      where: { status: 'FAILED' },
    });
    return {
      items: page.map((r) => present(r.row)),
      nextCursor:
        rows.length > limit && last
          ? encodeListCursor(last.failed, last.row)
          : null,
      failedCount,
    };
  }

  /** The side panel: the row, its payload and every attempt fact. */
  async detail(id: string) {
    const row = await this.prisma.delivery.findUnique({
      where: { id },
      select: {
        ...ROW_SELECT,
        payload: true,
        firstAttemptAt: true,
        lastAttemptAt: true,
        nextAttemptAt: true,
        sentAt: true,
        manualRetryCount: true,
        dismissReason: true,
      },
    });
    if (!row) throw notFound();
    return {
      ...present(row),
      payload: row.payload,
      firstAttemptAt: row.firstAttemptAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      manualRetryCount: row.manualRetryCount,
      dismissReason: row.dismissReason,
    };
  }

  /** A failed row starts a fresh retry window, sent on the worker's next tick. */
  async retry(id: string, user: Actor) {
    await this.decide(id, user, 'DELIVERY_RETRIED', null, (now) => ({
      status: 'PENDING',
      attempts: 0,
      firstAttemptAt: null,
      nextAttemptAt: now,
      lastAttemptAt: null,
      manualRetryCount: { increment: 1 },
    }));
    return this.detail(id);
  }

  /**
   * A failed row is set aside with a reason, which unblocks the later rows for its ticket. No
   * version number is used up, since versions are assigned at send.
   */
  async dismiss(id: string, reason: string, user: Actor) {
    await this.decide(id, user, 'DELIVERY_DISMISSED', reason, () => ({
      status: 'DISMISSED',
      dismissReason: reason,
    }));
    // Dismissing a BMS repair update also queues a fresh one with the ticket's current state
    // (child 0003); that kind is written from flow 3 on, with bmsEventVersion
    return this.detail(id);
  }

  private async decide(
    id: string,
    user: Actor,
    action: 'DELIVERY_RETRIED' | 'DELIVERY_DISMISSED',
    note: string | null,
    data: (now: Date) => Prisma.DeliveryUpdateManyMutationInput,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.delivery.findUnique({
        where: { id },
        select: { kind: true, target: true, repairTicketId: true },
      });
      if (!row) throw notFound();
      // Only a FAILED row moves: the worker never touches one, so this can't race a send
      const { count } = await tx.delivery.updateMany({
        where: { id, status: 'FAILED' },
        data: data(now),
      });
      if (count === 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'NOT_FAILED',
          message: 'Only a failed message can be retried or dismissed.',
        });
      }
      await tx.auditLog.create({
        data: {
          repairTicketId: row.repairTicketId,
          ...auditData(user, deliveryEvent(action, row, note), now),
        },
      });
    });
    this.logger.log(`Delivery ${id}: ${action} by ${user.email}`);
  }
}

function notFound() {
  return new NotFoundException({
    statusCode: 404,
    code: 'DELIVERY_NOT_FOUND',
    message: 'This message was not found.',
  });
}
