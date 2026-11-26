import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { decodeCursor, encodeCursor, olderThan } from '../audit-events';
import {
  VEHICLE_CHANGES_PAGE,
  type VehicleChangesQueryDto,
} from '../dto/vehicle-changes-query.dto';
import { OPEN_STATUSES } from '../ticket-statuses';

const rowSelect = {
  id: true,
  plateNumber: true,
  model: true,
  make: true,
  truckSizeCategory: true,
  status: true,
  syncedAt: true,
  updatedAt: true,
  vehicleType: { select: { id: true, name: true } },
  garage: { select: { id: true, name: true } },
  // Spec 0020, AC-8: the truck's newest open ticket (at most one by the create rule)
  repairTickets: {
    where: { repairStatus: { in: OPEN_STATUSES } },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { id: true, repairNumber: true },
  },
} satisfies Prisma.VehicleSelect;

type Row = Prisma.VehicleGetPayload<{ select: typeof rowSelect }>;

/** The row the Settings section shows (spec 0016, AC-21); every vehicle endpoint answers with it (spec 0020, AC-8). */
function present(row: Row) {
  return {
    id: row.id,
    plateNumber: row.plateNumber,
    model: row.model,
    make: row.make,
    truckSizeCategory: row.truckSizeCategory,
    status: row.status,
    type: row.vehicleType,
    garage: row.garage,
    // Spec 0029, AC-4: when the fleet sync last wrote this truck ("Managed in VMMS")
    syncedAt: row.syncedAt,
    updatedAt: row.updatedAt,
    openTicket: row.repairTickets[0] ?? null,
  };
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every active truck linked to VMMS, by plate (spec 0029, AC-4). */
  async list() {
    const rows = await this.prisma.vehicle.findMany({
      where: { isActive: true, deletedAt: null, vmmsVehicleId: { not: null } },
      select: rowSelect,
      orderBy: { plateNumber: 'asc' },
    });
    return rows.map(present);
  }

  /**
   * Spec 0020, AC-9: a truck's status and type history, newest first, keyset paged on
   * (createdAt, id) like the audit timeline. One extra row says whether an older page exists.
   */
  async changes(id: string, query: VehicleChangesQueryDto) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    const limit = query.limit ?? VEHICLE_CHANGES_PAGE;
    const filters: Prisma.VehicleChangeWhereInput[] = [{ vehicleId: id }];
    if (query.cursor) filters.push(olderThan(decodeCursor(query.cursor)));

    const rows = await this.prisma.vehicleChange.findMany({
      where: { AND: filters },
      select: {
        id: true,
        field: true,
        before: true,
        after: true,
        note: true,
        actorName: true,
        createdAt: true,
        repairTicket: { select: { id: true, repairNumber: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ repairTicket, ...row }) => ({
        ...row,
        ticket: repairTicket,
      })),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }
}
