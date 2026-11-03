import { Prisma, VehicleStatus } from '@prisma/client';
import { Actor, whoName } from '../audit-events';

// Spec 0020: the one writer of Vehicle.status in app code. Every status change writes exactly
// one VehicleChange row in the caller's transaction, and nothing when the status did not change.
// The toggle, ticket create and the release in applyStatusMove all come through here. Seeds are
// exempt and write no history.

export type VehicleStatusChange = {
  vehicleId: string;
  /** The status read by the caller (under the lock on toggle and create). */
  before: VehicleStatus;
  after: VehicleStatus;
  actor: Pick<Actor, 'sub' | 'name' | 'email'>;
  /** The Admin's reason on a toggle; null on automatic rows. */
  note: string | null;
  /** The ticket behind an automatic row (create and release); null on a toggle. */
  repairTicketId: string | null;
  /** Other vehicle fields written in the same update (the release's odometer). */
  also?: Prisma.VehicleUpdateInput;
};

/** Writes the status and its history row; returns false when the status did not change. */
export async function vehicleStatusChange(
  tx: Prisma.TransactionClient,
  change: VehicleStatusChange,
): Promise<boolean> {
  const also = change.also ?? {};
  if (change.before === change.after) {
    if (Object.keys(also).length > 0) {
      await tx.vehicle.update({ where: { id: change.vehicleId }, data: also });
    }
    return false;
  }
  await tx.vehicle.update({
    where: { id: change.vehicleId },
    data: { ...also, status: change.after },
  });
  await tx.vehicleChange.create({
    data: {
      vehicleId: change.vehicleId,
      field: 'status',
      before: change.before,
      after: change.after,
      note: change.note,
      repairTicketId: change.repairTicketId,
      actorUserId: change.actor.sub,
      actorName: whoName(change.actor),
      actorEmail: change.actor.email,
    },
  });
  return true;
}
