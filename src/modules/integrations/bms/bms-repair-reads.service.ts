import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { OPEN_STATUSES, STATUS_LABELS } from '../../vrms/ticket-statuses';
import type { ActiveRepairResponse } from './bms-integration.dto';
import { REASON_ISSUES, repairReason } from './bms-repair-updates';

/**
 * Spec 0029 (child 0003), AC-20: the truck's open repair as BMS shows it. Only the fields below
 * are selected, so costs, notes and people can't leak into the answer.
 */
@Injectable()
export class BmsRepairReadsService {
  constructor(private readonly prisma: PrismaService) {}

  async activeRepair(vmmsVehicleId: string): Promise<ActiveRepairResponse> {
    const ticket = await this.prisma.repairTicket.findFirst({
      where: {
        vehicle: { vmmsVehicleId },
        repairStatus: { in: OPEN_STATUSES },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        dueAt: true,
        createdAt: true,
        issues: {
          select: {
            resolvedAt: true,
            ...REASON_ISSUES.select,
          },
        },
      },
    });
    if (!ticket) return { repair: null };
    return {
      repair: {
        repairTicketId: ticket.id,
        repairTicketNumber: ticket.repairNumber,
        repairStatus: ticket.repairStatus,
        repairStatusLabel: STATUS_LABELS[ticket.repairStatus],
        reason: repairReason(ticket.issues),
        issuesResolved: ticket.issues.filter((i) => i.resolvedAt !== null)
          .length,
        issuesTotal: ticket.issues.length,
        expectedReturnAt: ticket.dueAt?.toISOString() ?? null,
        openedAt: ticket.createdAt.toISOString(),
      },
    };
  }
}
