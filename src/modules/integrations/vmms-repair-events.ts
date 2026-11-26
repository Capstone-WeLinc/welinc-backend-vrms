import type { Prisma, RepairStatus } from '@prisma/client';
import { enqueueDelivery } from './deliveries/enqueue-delivery';

// Spec 0029 (child 0002), AC-13: the one writer of repair events to VMMS. Called inside the
// transaction of the change, with the ticket row already locked (or just inserted), so two
// changes on one ticket queue in commit order. It assigns no version: the worker does, at send.

export type VmmsRepairEventType =
  'OPENED' | 'LINKS_UPDATED' | 'STATUS_UPDATED' | 'COMPLETED' | 'CANCELLED';

/** VRMS status → VMMS status. Pending approval is still at the outside shop. */
export function vmmsRepairStatus(status: RepairStatus): string {
  return status === 'PENDING_APPROVAL' ? 'OUTSOURCED' : status;
}

/** Referrals whose schedules and ids the ticket carries to VMMS. */
const ACCEPTED: Prisma.ReferralWhereInput = {
  status: { in: ['OPENED_TICKET', 'ADDED_TO_TICKET'] },
};

export type QueuedEvent = { deliveryId: string } | { skipped: 'NOT_LINKED' };

export async function queueVmmsRepairEvent(
  tx: Prisma.TransactionClient,
  repairTicketId: string,
  eventType: VmmsRepairEventType,
): Promise<QueuedEvent> {
  const ticket = await tx.repairTicket.findUniqueOrThrow({
    where: { id: repairTicketId },
    select: {
      repairNumber: true,
      repairStatus: true,
      outsideShopName: true,
      vehicle: { select: { vmmsVehicleId: true } },
      referrals: {
        where: ACCEPTED,
        orderBy: { receivedAt: 'asc' },
        select: { id: true, maintenanceScheduleId: true },
      },
    },
  });
  // A truck not linked to VMMS yet (before fleet:link) has no id VMMS knows
  const vmmsVehicleId = ticket.vehicle.vmmsVehicleId;
  if (!vmmsVehicleId) return { skipped: 'NOT_LINKED' };

  // clock_timestamp, not now(): now() is the transaction's start, and two locked commits on one
  // ticket must never go backwards in time, which VMMS checks
  const [{ at }] = await tx.$queryRaw<
    { at: Date }[]
  >`SELECT clock_timestamp() AS at`;
  const repairStatus =
    eventType === 'OPENED' ? 'OPEN' : vmmsRepairStatus(ticket.repairStatus);
  const payload: Record<string, unknown> = {
    repairTicketId,
    repairTicketNumber: ticket.repairNumber,
    eventType,
    repairStatus,
    vmmsVehicleId,
    maintenanceScheduleIds: [
      ...new Set(ticket.referrals.map((r) => r.maintenanceScheduleId)),
    ],
    acceptedReferralIds: ticket.referrals.map((r) => r.id),
    occurredAt: at.toISOString(),
  };
  // VMMS requires the shop with OUTSOURCED and refuses it elsewhere
  if (repairStatus === 'OUTSOURCED' && ticket.outsideShopName) {
    payload.outsideShopName = ticket.outsideShopName;
  }
  const deliveryId = await enqueueDelivery(tx, {
    kind: 'REPAIR_EVENT',
    payload,
    repairTicketId,
  });
  return { deliveryId };
}
