import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import type { AuthUser } from '../../auth/account-check';
import { auditData, mechanicUnassignedEvent } from './audit-events';
import { MechanicRoster } from './mechanic-roster.service';
import { OPEN_STATUSES } from './ticket-statuses';
import { applyStatusMove } from './apply-status-move';
import { findMove } from './ticket-transitions';

/** M2: the last mechanic removed sends an Assigned ticket back to Open (spec 0014). */
const UNASSIGN_RELEASE = findMove(RepairStatus.ASSIGNED, RepairStatus.OPEN)!;

// Spec 0011, AC-32 and AC-33: what a person still holds when they leave VRMS, and how an Admin
// moves it back to the queue.

export type ReleaseReason = 'DEACTIVATED' | 'ROLE_REMOVED';

/** Tickets a release changes. FOR_VERIFICATION and later are the verifier's and are left alone. */
const RELEASABLE_STATUSES: RepairStatus[] = [
  RepairStatus.OPEN,
  RepairStatus.ASSIGNED,
  RepairStatus.IN_PROGRESS,
  RepairStatus.ON_HOLD,
];

@Injectable()
export class MechanicWorkService {
  private readonly logger = new Logger(MechanicWorkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: MechanicRoster,
  ) {}

  /** Open tickets assigned to that person, by status, with every open status present (zeros included). */
  async openWork(authUserId: string) {
    const byStatus = Object.fromEntries(
      OPEN_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    const groups = await this.prisma.repairTicket.groupBy({
      by: ['repairStatus'],
      where: {
        repairStatus: { in: OPEN_STATUSES },
        assignments: { some: { mechanic: { authUserId } } },
      },
      _count: { _all: true },
    });
    let total = 0;
    for (const g of groups) {
      byStatus[g.repairStatus] = g._count._all;
      total += g._count._all;
    }
    return { total, byStatus };
  }

  async release(
    authUserId: string,
    reason: ReleaseReason,
    user: AuthUser,
    token: string,
  ) {
    const mechanic = await this.roster.refreshOne(token, authUserId);
    if (!mechanic) throw new NotFoundException('Mechanic not found');
    if (mechanic.stillActive) {
      throw new ConflictException('They still have access to VRMS.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const person = await tx.mechanic.findUniqueOrThrow({
        where: { id: mechanic.mechanicId },
        select: { id: true, name: true },
      });
      const tickets = await tx.repairTicket.findMany({
        where: {
          repairStatus: { in: RELEASABLE_STATUSES },
          assignments: { some: { mechanicId: person.id } },
        },
        select: {
          id: true,
          repairStatus: true,
          updatedAt: true,
          vehicleId: true,
          odometer: true,
          priorVehicleStatus: true,
          _count: { select: { assignments: true } },
        },
      });

      const now = new Date();
      let released = 0;
      let reopened = 0;
      for (const t of tickets) {
        const { count } = await tx.ticketAssignment.deleteMany({
          where: { repairTicketId: t.id, mechanicId: person.id },
        });
        if (count === 0) continue;
        const goesBack =
          t.repairStatus === RepairStatus.ASSIGNED && t._count.assignments <= 1;
        const event = mechanicUnassignedEvent(person.name, reason, goesBack);
        if (goesBack) {
          // M2 through the one status helper; its MECHANIC_UNASSIGNED row already records the
          // status change, so no STATUS_CHANGE row is added (spec 0014, AC-1)
          await applyStatusMove(tx, t, UNASSIGN_RELEASE, user, null, now, {
            audit: event,
          });
        } else {
          await tx.repairTicket.update({
            where: { id: t.id },
            data: { lastActivityAt: now },
          });
          await tx.auditLog.create({
            data: { repairTicketId: t.id, ...auditData(user, event, now) },
          });
        }
        released++;
        if (goesBack) reopened++;
      }
      return { released, reopened };
    });

    this.logger.log(
      `Released ${result.released} tickets from ${authUserId} (${reason}) by ${user.email}`,
    );
    return result;
  }
}
