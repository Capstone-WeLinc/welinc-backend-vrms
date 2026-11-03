import { ConflictException, Logger } from '@nestjs/common';
import { Prisma, RepairStatus, VehicleStatus } from '@prisma/client';
import {
  Actor,
  AuditEventData,
  auditData,
  statusEvent,
  whoName,
} from './audit-events';
import {
  livePhotoCounts,
  photoNeedOf,
  photoNeedUnmet,
  photoRequired,
  PhotoSwitches,
} from './photo-rules';
import { STALE_TICKET } from './ticket-knowledge';
import { isFinished } from './ticket-statuses';
import { vehicleStatusChange } from './vehicles/vehicle-status';
import type { TicketMove } from './ticket-transitions';

// Spec 0014, AC-1, AC-7, AC-9, AC-10 and AC-12: every effect of one status move, inside the
// caller's transaction. Later features call it with their own trigger's move.

const logger = new Logger('applyStatusMove');

/** Spec 0018: the statuses whose first entry means work has started (M3 and M9). */
const WORK_STARTS: RepairStatus[] = [
  RepairStatus.IN_PROGRESS,
  RepairStatus.OUTSOURCED,
];

/** Spec 0018: one helper decides whether work has started on a ticket. */
export function workStarted(ticket: { workStartedAt: Date | null }): boolean {
  return ticket.workStartedAt !== null;
}

/** What a move needs to know about the ticket, as loaded before the transaction. */
export type MovingTicket = {
  id: string;
  repairStatus: RepairStatus;
  updatedAt: Date;
  vehicleId: string;
  odometer: number;
  /** Spec 0016, AC-9: the truck's status before the ticket was created; null on old tickets. */
  priorVehicleStatus: VehicleStatus | null;
};

export type MoveOptions = {
  /** Extra scalar fields the caller writes with the move (remarks, cancel reason, costs). */
  data?: Prisma.RepairTicketUpdateManyMutationInput;
  /** Per issue writes, such as the resolutions of Send for verification (AC-11). */
  issues?: { id: string; data: Prisma.RepairIssueUpdateInput }[];
  /** The audit row to write instead of STATUS_CHANGE (the unassign release keeps its own). */
  audit?: AuditEventData;
  /**
   * Spec 0018, AC-7: the photo switches, passed only by the status endpoint. Other callers (the
   * mechanic release) leave it out, so no photo rule ever runs for them.
   */
  photoRules?: PhotoSwitches;
};

export async function applyStatusMove(
  tx: Prisma.TransactionClient,
  ticket: MovingTicket,
  move: TicketMove,
  actor: Actor,
  note: string | null | undefined,
  now: Date,
  options: MoveOptions = {},
): Promise<void> {
  // Never write a move the table does not hold from this status
  if (!move.from.includes(ticket.repairStatus)) {
    throw new Error(
      `Move ${move.id} does not start from ${ticket.repairStatus}`,
    );
  }

  const closes = move.to === RepairStatus.CLOSED;
  // 1. The conditional ticket update: only the loaded updatedAt may move on (AC-12)
  const { count } = await tx.repairTicket.updateMany({
    where: { id: ticket.id, updatedAt: ticket.updatedAt },
    data: {
      ...options.data,
      repairStatus: move.to,
      updatedAt: now,
      lastActivityAt: now,
      statusChangedAt: now, // spec 0015, AC-7: written with every status move
      isUnlocked: false,
      ...(isFinished(move.to) && { closedAt: now }),
      // Whoever closes the ticket verified it; cancelling records no verifier (AC-7, AC-10)
      ...(closes && {
        verifiedByUserId: actor.sub,
        verifiedByName: whoName(actor),
        verifiedAt: now,
      }),
    },
  });
  if (count === 0) throw new ConflictException(STALE_TICKET);

  // Spec 0018, AC-7: the photo rule, counted after the update above took the ticket row lock.
  // Upload, remove and move take the same lock, so the count is the one at commit; a failure
  // throws and the caller's transaction rolls the move back.
  if (options.photoRules && photoNeedOf(move, options.photoRules)) {
    const unmet = photoNeedUnmet(
      move,
      options.photoRules,
      await livePhotoCounts(tx, ticket.id),
    );
    if (unmet) throw photoRequired(move, unmet);
  }

  // Spec 0018: the first move into a started status (M3, or M9) records when work started. Only
  // a null column is written, under the row lock just taken, so it is set once and never cleared.
  if (WORK_STARTS.includes(move.to)) {
    await tx.repairTicket.updateMany({
      where: { id: ticket.id, workStartedAt: null },
      data: { workStartedAt: now, updatedAt: now },
    });
  }

  // 2. Issue writes: the caller's, then the backward rule (AC-9)
  for (const issue of options.issues ?? []) {
    await tx.repairIssue.update({ where: { id: issue.id }, data: issue.data });
  }
  if (move.to === RepairStatus.IN_PROGRESS) {
    // Ticks, notes, hours and the followed choice stay; only resolvedAt is cleared
    await tx.repairIssue.updateMany({
      where: { repairTicketId: ticket.id },
      data: { resolvedAt: null },
    });
  }

  // 3. The audit row
  await tx.auditLog.create({
    data: {
      repairTicketId: ticket.id,
      ...auditData(
        actor,
        options.audit ?? statusEvent(ticket.repairStatus, move.to, note),
        now,
      ),
    },
  });

  // 4. The truck goes back to the fleet on a move into a finished status
  if (isFinished(move.to)) {
    // Spec 0020, AC-7: read without a lock on purpose. The toggle is refused while this ticket is
    // open, and the move above holds the ticket row, so nothing else changes the truck meanwhile.
    const vehicle = await tx.vehicle.findUniqueOrThrow({
      where: { id: ticket.vehicleId },
      select: { odometer: true, status: true },
    });
    // On close, the ticket's reading wins when it is higher (as before)
    const odometer =
      closes && ticket.odometer > vehicle.odometer ? ticket.odometer : null;
    // A truck that was Disabled before the repair goes back to Disabled (spec 0016, AC-9), with
    // its history row when the status changes (spec 0020, AC-7)
    await vehicleStatusChange(tx, {
      vehicleId: ticket.vehicleId,
      before: vehicle.status,
      after:
        ticket.priorVehicleStatus === VehicleStatus.DISABLED
          ? VehicleStatus.DISABLED
          : VehicleStatus.AVAILABLE,
      actor,
      note: null,
      repairTicketId: ticket.id,
      also: odometer !== null ? { odometer } : undefined,
    });
    if (odometer !== null) {
      logger.log(
        `Odometer synced for vehicle ${ticket.vehicleId}: ${vehicle.odometer} → ${odometer} km`,
      );
    }
  }
}
