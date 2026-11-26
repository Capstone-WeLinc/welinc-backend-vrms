import type { Prisma } from '@prisma/client';
import { isFinished, STATUS_LABELS } from '../../vrms/ticket-statuses';
import { enqueueDelivery } from '../deliveries/enqueue-delivery';
import type { QueuedEvent } from '../vmms-repair-events';

// Spec 0029 (child 0003), AC-17: the one writer of repair updates to BMS. Called inside the
// transaction of the change, with the ticket row locked (or just inserted), from the same places
// as queueVmmsRepairEvent plus setDueAt. The payload is frozen here; the worker adds eventVersion.

export const NOT_DIAGNOSED = 'Not yet diagnosed';

/** The change reasons the callers pass, so BMS reads the same words every time. */
export const CHANGE_REASON = {
  opened: 'Repair opened',
  status: (label: string) => `Status changed to ${label}`,
  finished: 'Repair finished',
  cancelled: 'Repair cancelled',
  /** A VMMS referral's findings joined the ticket, which can change the reason BMS shows. */
  referralAdded: (workOrderNumber: string) =>
    `Issues added from VMMS ${workOrderNumber}`,
  resent: 'Resent after a failed delivery',
} as const;

type IssueForReason = {
  category: { name: string; sortOrder: number } | null;
};

/**
 * The reason BMS shows: the distinct category names of the ticket's issues, in the categories'
 * sortOrder, joined with ", ". Never issue text, notes or people (AC-20).
 */
export function repairReason(issues: IssueForReason[]): string {
  const byName = new Map<string, number>();
  for (const { category } of issues) {
    if (category && !byName.has(category.name)) {
      byName.set(category.name, category.sortOrder);
    }
  }
  if (byName.size === 0) return NOT_DIAGNOSED;
  return [...byName.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
    .join(', ');
}

export const REASON_ISSUES = {
  select: { category: { select: { name: true, sortOrder: true } } },
} as const;

export async function queueBmsRepairUpdate(
  tx: Prisma.TransactionClient,
  repairTicketId: string,
  changeReason: string,
): Promise<QueuedEvent> {
  const ticket = await tx.repairTicket.findUniqueOrThrow({
    where: { id: repairTicketId },
    select: {
      repairNumber: true,
      repairStatus: true,
      dueAt: true,
      vehicle: { select: { vmmsVehicleId: true, plateNumber: true } },
      issues: REASON_ISSUES,
    },
  });
  // BMS knows trucks only by VMMS's id; a truck not linked yet has none
  const vmmsVehicleId = ticket.vehicle.vmmsVehicleId;
  if (!vmmsVehicleId) return { skipped: 'NOT_LINKED' };

  // clock_timestamp, not now(): see queueVmmsRepairEvent
  const [{ at }] = await tx.$queryRaw<
    { at: Date }[]
  >`SELECT clock_timestamp() AS at`;
  const finished = isFinished(ticket.repairStatus);
  const deliveryId = await enqueueDelivery(tx, {
    kind: 'REPAIR_UPDATE',
    repairTicketId,
    payload: {
      vmmsVehicleId,
      vehiclePlate: ticket.vehicle.plateNumber,
      repairTicketId,
      repairTicketNumber: ticket.repairNumber,
      repairStatus: ticket.repairStatus,
      repairStatusLabel: STATUS_LABELS[ticket.repairStatus],
      reason: repairReason(ticket.issues),
      expectedReturnAt:
        finished || !ticket.dueAt ? null : ticket.dueAt.toISOString(),
      changeReason,
      occurredAt: at.toISOString(),
    },
  });
  return { deliveryId };
}
