import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RepairStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import type { AuthUser } from '../../auth/account-check';
import {
  SYSTEM_ACTOR,
  auditData,
  mechanicUnassignedEvent,
  type RowActor,
} from './audit-events';
import {
  permanentRoles,
  type DirectoryUser,
} from './directory/auth-directory.client';
import { UserRole } from '../../auth/roles';
import { MechanicRoster } from './mechanic-roster.service';
import { OPEN_STATUSES } from './ticket-statuses';
import { applyStatusMove } from './apply-status-move';
import { findMove } from './ticket-transitions';
import { openStatusRank, workloadOf, type Workload } from './mechanic-workload';
import type { MechanicRole } from './mechanic-roster.service';

/** M2: the last mechanic removed sends an Assigned ticket back to Open (spec 0014). */
const UNASSIGN_RELEASE = findMove(RepairStatus.ASSIGNED, RepairStatus.OPEN)!;

// Spec 0011, AC-32 and AC-33: what a person still holds when they leave VRMS, and how an Admin
// moves it back to the queue.

export type ReleaseReason = 'DELETED' | 'DEACTIVATED' | 'ROLE_REMOVED';

/** One row of a person's open tickets on the Users page (feature 57). */
export type OpenTicket = {
  id: string;
  repairNumber: string;
  repairStatus: RepairStatus;
  /** Sent back as lastUpdatedAt on unassign or reassign, for the stale check. */
  updatedAt: string;
  plateNumber: string;
  mechanics: { id: string; name: string }[];
};

/** The stored role as the API's type; the CHECK constraint allows only these two or null. */
function asMechanicRole(role: string | null): MechanicRole | null {
  return role === 'MECHANIC' || role === 'CHIEF_MECHANIC' ? role : null;
}

/** One person on the Chief dashboard's Team section (spec 0022, AC-2). */
export type RosterRow = {
  authUserId: string;
  /** The mechanics.id that ticket assignments use, so the Team section joins on it, never the name. */
  mechanicId: string;
  name: string;
  email: string | null;
  role: MechanicRole | null;
  isActive: boolean;
} & Workload;

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

  /** Every roster row with the statuses of its open assignments, one entry per assignment. */
  private async rosterWithOpenStatuses() {
    const rows = await this.prisma.mechanic.findMany({
      select: {
        id: true,
        authUserId: true,
        name: true,
        email: true,
        isActive: true,
        role: true,
        assignments: {
          where: { repairTicket: { repairStatus: { in: OPEN_STATUSES } } },
          select: { repairTicket: { select: { repairStatus: true } } },
        },
      },
    });
    return rows.map(({ assignments, ...row }) => ({
      ...row,
      ...workloadOf(assignments.map((a) => a.repairTicket.repairStatus)),
    }));
  }

  /**
   * Feature 57: every mechanic's open work, keyed by welinc-auth user id, for the Users page.
   * Inactive rows are included: a person who left can still hold tickets an Admin kept.
   */
  async workload() {
    const rows = await this.rosterWithOpenStatuses();
    return rows.map(({ authUserId, total, byStatus, occupied }) => ({
      authUserId,
      total,
      byStatus,
      occupied,
    }));
  }

  /**
   * Spec 0022, AC-2: the Team section's roster. Every active person, plus an inactive one who
   * still holds an open ticket. Occupied comes from isOccupied through workloadOf.
   */
  async listRoster(): Promise<RosterRow[]> {
    const rows = await this.rosterWithOpenStatuses();
    return rows
      .filter((r) => r.isActive || r.total > 0)
      .map((r) => ({
        authUserId: r.authUserId,
        mechanicId: r.id,
        name: r.name,
        email: r.email,
        role: asMechanicRole(r.role),
        isActive: r.isActive,
        occupied: r.occupied,
        total: r.total,
        byStatus: r.byStatus,
      }));
  }

  /**
   * Feature 57: the person's open tickets with every mechanic on each, so the Users page can
   * unassign or reassign through PUT /vrms/repairs/:id/assignments with the stale check.
   */
  async openTickets(
    authUserId: string,
  ): Promise<{ mechanicId: string | null; tickets: OpenTicket[] }> {
    const mechanic = await this.prisma.mechanic.findUnique({
      where: { authUserId },
      select: { id: true },
    });
    if (!mechanic) return { mechanicId: null, tickets: [] };

    const tickets = await this.prisma.repairTicket.findMany({
      where: {
        repairStatus: { in: OPEN_STATUSES },
        assignments: { some: { mechanicId: mechanic.id } },
      },
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        updatedAt: true,
        vehicle: { select: { plateNumber: true } },
        assignments: {
          select: { mechanic: { select: { id: true, name: true } } },
        },
      },
      orderBy: { statusChangedAt: 'asc' },
    });

    return {
      mechanicId: mechanic.id,
      // Workflow order (In progress before For verification), oldest status change first within it
      tickets: tickets
        .map((t) => ({
          id: t.id,
          repairNumber: t.repairNumber,
          repairStatus: t.repairStatus,
          updatedAt: t.updatedAt.toISOString(),
          plateNumber: t.vehicle.plateNumber,
          mechanics: t.assignments.map((a) => a.mechanic),
        }))
        .sort(
          (a, b) =>
            openStatusRank(a.repairStatus) - openStatusRank(b.repairStatus),
        ),
    };
  }

  async release(authUserId: string, reason: ReleaseReason, user: AuthUser) {
    const mechanic = await this.roster.refreshOne(authUserId);
    if (!mechanic) throw new NotFoundException('Mechanic not found');
    if (mechanic.stillActive) {
      throw new ConflictException('They still have access to VRMS.');
    }

    // Suite spec 0012, AC-24: the feed usually got there first, so this often answers 0
    const result = await this.prisma.$transaction((tx) =>
      releaseInTx(tx, mechanic.mechanicId, reason, user, new Date()),
    );

    this.logger.log(
      `Released ${result.released} tickets from ${authUserId} (${reason}) by ${user.email}`,
    );
    return result;
  }
}

/** Why a person's tickets go back, read from a directory snapshot, first match wins (AC-24). */
export function leaveReason(user: DirectoryUser): ReleaseReason | null {
  if (user.deleted) return 'DELETED';
  if (!user.isActive) return 'DEACTIVATED';
  const works = permanentRoles(user).some(
    (role) => role === UserRole.MECHANIC || role === UserRole.CHIEF_MECHANIC,
  );
  return works ? null : 'ROLE_REMOVED';
}

/**
 * Suite spec 0012, AC-24: after the roster takes a directory change, a person who is deleted,
 * inactive or without a mechanic role in VRMS leaves every ticket in a releasable status, inside
 * the same transaction as the cursor. Keys on the snapshot's state, never the change type, so a
 * replay changes nothing more. No mechanics row: nothing to release.
 */
export async function releaseLeaver(
  tx: Prisma.TransactionClient,
  user: DirectoryUser,
  now = new Date(),
): Promise<{ released: number; reopened: number }> {
  const reason = leaveReason(user);
  if (!reason) return { released: 0, reopened: 0 };
  const row = await tx.mechanic.findUnique({
    where: { authUserId: user.id },
    select: { id: true },
  });
  if (!row) return { released: 0, reopened: 0 };
  return releaseInTx(tx, row.id, reason, SYSTEM_ACTOR, now);
}

/**
 * The body of a release, inside the caller's transaction: the person leaves every ticket in
 * RELEASABLE_STATUSES, one MECHANIC_UNASSIGNED row each, and an Assigned ticket left with no
 * mechanic goes back to Open (spec 0011, AC-33; suite spec 0012, AC-24).
 */
export async function releaseInTx(
  tx: Prisma.TransactionClient,
  mechanicId: string,
  reason: ReleaseReason,
  actor: RowActor,
  now: Date,
): Promise<{ released: number; reopened: number }> {
  const person = await tx.mechanic.findUniqueOrThrow({
    where: { id: mechanicId },
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
      await applyStatusMove(tx, t, UNASSIGN_RELEASE, actor, null, now, {
        audit: event,
      });
    } else {
      await tx.repairTicket.update({
        where: { id: t.id },
        data: { lastActivityAt: now },
      });
      await tx.auditLog.create({
        data: { repairTicketId: t.id, ...auditData(actor, event, now) },
      });
    }
    released++;
    if (goesBack) reopened++;
  }
  return { released, reopened };
}
