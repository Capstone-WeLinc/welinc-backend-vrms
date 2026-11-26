import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, ReferralStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { decodeCursor, encodeCursor } from '../../vrms/audit-events';
import { OPEN_STATUSES } from '../../vrms/ticket-statuses';
import type { StoredFinding } from './referral-intake';

// Spec 0029 (child 0002), AC-7: the Referrals tab's reads, for holders of integration.respond.

export type ReferralListQuery = {
  status?: ReferralStatus;
  cursor?: string;
  limit?: number;
};

@Injectable()
export class ReferralsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first; `status` defaults to WAITING. `waitingCount` is for the tab label. */
  async list(query: ReferralListQuery) {
    const status = query.status ?? 'WAITING';
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const where: Prisma.ReferralWhereInput = {
      status,
      ...(after
        ? {
            OR: [
              { receivedAt: { lt: after.createdAt } },
              { receivedAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    };
    const [rows, waitingCount] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          receivedAt: true,
          vehiclePlate: true,
          workOrderNumber: true,
          findings: true,
          status: true,
          repairTicket: { select: { id: true, repairNumber: true } },
        },
      }),
      this.prisma.referral.count({ where: { status: 'WAITING' } }),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        receivedAt: r.receivedAt.toISOString(),
        vehiclePlate: r.vehiclePlate,
        workOrderNumber: r.workOrderNumber,
        findingsCount: (r.findings as StoredFinding[]).length,
        status: r.status,
        repairTicket: r.repairTicket,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.receivedAt, id: last.id })
          : null,
      waitingCount,
    };
  }

  /** One referral with its truck: garage and open ticket decide the side panel's action. */
  async detail(id: string) {
    const referral = await this.prisma.referral.findUnique({
      where: { id },
      include: {
        vehicle: {
          select: {
            id: true,
            plateNumber: true,
            model: true,
            isActive: true,
            garage: { select: { id: true, name: true } },
            repairTickets: {
              where: { repairStatus: { in: OPEN_STATUSES } },
              select: { id: true, repairNumber: true, repairStatus: true },
              take: 1,
            },
          },
        },
        repairTicket: { select: { id: true, repairNumber: true } },
      },
    });
    if (!referral) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'REFERRAL_NOT_FOUND',
        message: 'This referral was not found.',
      });
    }
    const { vehicle } = referral;
    return {
      id: referral.id,
      status: referral.status,
      receivedAt: referral.receivedAt.toISOString(),
      workOrderNumber: referral.workOrderNumber,
      odometerReading: referral.odometerReading,
      findings: referral.findings as StoredFinding[],
      chiefMechanicRemarks: referral.chiefMechanicRemarks,
      rejectionReason: referral.rejectionReason,
      decidedByName: referral.decidedByName,
      decidedAt: referral.decidedAt?.toISOString() ?? null,
      repairTicket: referral.repairTicket,
      vehicle: {
        id: vehicle.id,
        plateNumber: vehicle.plateNumber,
        model: vehicle.model,
        isActive: vehicle.isActive,
        garage: vehicle.garage,
        openTicket: vehicle.repairTickets[0] ?? null,
      },
    };
  }
}
