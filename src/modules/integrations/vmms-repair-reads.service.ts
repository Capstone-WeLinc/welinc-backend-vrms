import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { vmmsRepairStatus } from './vmms-repair-events';

// Spec 0029 (child 0002), AC-14 and AC-15: the two reads VMMS calls. VMMS sees ticket numbers,
// statuses, the outside shop, issue text, parts as text, mechanic names and the total; never part
// prices, notes, remarks, drivers or photos.

export const HISTORY_DEFAULT_LIMIT = 50;

type HistoryCursor = { createdAt: Date; id: string };

/** Base64url of `{ createdAt, id }`, opaque to VMMS. */
export function encodeHistoryCursor(row: HistoryCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeHistoryCursor(cursor: string): HistoryCursor {
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { createdAt?: unknown; id?: unknown };
    const createdAt = new Date(String(raw.createdAt));
    if (
      typeof raw.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(raw.id) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error('bad cursor');
    }
    return { createdAt, id: raw.id };
  } catch {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_CURSOR',
      message: 'Invalid cursor',
    });
  }
}

/** The shop VMMS sees: only while the mapped status is OUTSOURCED, else null. */
function shopFor(status: string, shop: string | null): string | null {
  return status === 'OUTSOURCED' ? shop : null;
}

@Injectable()
export class VmmsRepairReadsService {
  constructor(private readonly prisma: PrismaService) {}

  /** AC-14 */
  async status(repairTicketId: string) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id: repairTicketId },
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        outsideShopName: true,
      },
    });
    if (!ticket) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'REPAIR_NOT_FOUND',
        message: 'No repair ticket has this id.',
      });
    }
    const status = vmmsRepairStatus(ticket.repairStatus);
    return {
      repairTicketId: ticket.id,
      repairTicketNumber: ticket.repairNumber,
      status,
      outsideShopName: shopFor(status, ticket.outsideShopName),
    };
  }

  /**
   * AC-15: the truck's tickets except cancelled ones, newest first by (createdAt, id). An unknown
   * truck answers no items, never 404.
   */
  async history(
    vmmsVehicleId: string,
    limit = HISTORY_DEFAULT_LIMIT,
    cursor?: string,
  ) {
    const after = cursor ? decodeHistoryCursor(cursor) : null;
    const where: Prisma.RepairTicketWhereInput = {
      vehicle: { vmmsVehicleId },
      repairStatus: { not: 'CANCELLED' },
      ...(after && {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }),
    };
    const rows = await this.prisma.repairTicket.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        createdAt: true,
        closedAt: true,
        outsideShopName: true,
        totalCost: true,
        issues: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { description: true, category: { select: { name: true } } },
        },
        repairParts: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { description: true, quantity: true },
        },
        assignments: {
          orderBy: { assignedAt: 'asc' },
          select: { mechanic: { select: { name: true } } },
        },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((t) => ({
        repairTicketId: t.id,
        repairTicketNumber: t.repairNumber,
        openedAt: t.createdAt.toISOString(),
        closedAt: t.closedAt?.toISOString() ?? null,
        status: vmmsRepairStatus(t.repairStatus),
        issues: t.issues.map((i) => issueLine(i.description, i.category?.name)),
        partsUsed: t.repairParts.map((p) => `${p.description} x${p.quantity}`),
        repairPersonnel: [
          ...new Set(t.assignments.map((a) => a.mechanic.name)),
        ],
        provider: t.outsideShopName,
        totalRepairCost: t.totalCost?.toString() ?? null,
      })),
      nextCursor:
        rows.length > limit && last ? encodeHistoryCursor(last) : null,
    };
  }
}

/**
 * "<category name>: <description>". The stored description already starts with "[System] "
 * (spec 0019), which is replaced by the category name VMMS reads.
 */
export function issueLine(
  description: string,
  category?: string | null,
): string {
  const text = description.replace(/^\[[^\]]*\]\s*/, '');
  return category ? `${category}: ${text}` : text;
}
