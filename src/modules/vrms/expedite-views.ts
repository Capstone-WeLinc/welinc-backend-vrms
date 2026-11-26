import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma.service';
import type { ExpediteRequestView } from './dto/expedite-decisions.dto';

// Spec 0029 (child 0003): how a BMS expedite request is shown, on the ticket page banner and the
// Admin dashboard list. Apart from the decisions service so the ticket presenter can read it.

export const requestSelect = {
  id: true,
  jobOrderNumber: true,
  reason: true,
  neededBy: true,
  receivedAt: true,
  repairTicketId: true,
  repairTicket: {
    select: {
      repairNumber: true,
      priority: true,
      vehicle: { select: { plateNumber: true } },
    },
  },
} satisfies Prisma.ExpediteRequestSelect;

export type RequestRow = Prisma.ExpediteRequestGetPayload<{
  select: typeof requestSelect;
}>;

export function expediteView(row: RequestRow): ExpediteRequestView {
  return {
    id: row.id,
    jobOrderNumber: row.jobOrderNumber,
    reason: row.reason,
    neededBy: row.neededBy?.toISOString().slice(0, 10) ?? null,
    receivedAt: row.receivedAt.toISOString(),
    repairTicketId: row.repairTicketId,
    repairNumber: row.repairTicket.repairNumber,
    vehiclePlate: row.repairTicket.vehicle.plateNumber,
    ticketPriority: row.repairTicket.priority,
  };
}

/** The waiting requests on one ticket, oldest first (the ticket page banner). */
export async function waitingExpedites(
  prisma: PrismaService,
  repairTicketId: string,
): Promise<ExpediteRequestView[]> {
  const rows = await prisma.expediteRequest.findMany({
    where: { repairTicketId, status: 'WAITING' },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: requestSelect,
  });
  return rows.map(expediteView);
}
