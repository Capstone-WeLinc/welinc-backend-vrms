import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import type { AuthUser } from '../../../auth/account-check';
import {
  decodeCursor,
  encodeCursor,
  olderThan,
  whoName,
} from '../audit-events';
import type { SetVehicleStatusDto } from '../dto/set-vehicle-status.dto';
import {
  VEHICLE_CHANGES_PAGE,
  type VehicleChangesQueryDto,
} from '../dto/vehicle-changes-query.dto';
import type { UpdateVehicleDto } from '../dto/update-vehicle.dto';
import { VEHICLE_TYPE_LIST } from '../lookups/lookup-lists';
import { OPEN_STATUSES } from '../ticket-statuses';
import { vehicleStatusChange } from './vehicle-status';

export const STALE_VEHICLE =
  'This truck changed. Check the type and save again.';

/** Spec 0020, AC-5: the toggle's own stale answer (the type edit keeps STALE_VEHICLE). */
function staleStatus() {
  return new ConflictException({
    statusCode: 409,
    code: 'STALE_VEHICLE',
    message: 'This truck changed. Reload and try again.',
  });
}

const rowSelect = {
  id: true,
  plateNumber: true,
  model: true,
  status: true,
  updatedAt: true,
  vehicleType: { select: { id: true, name: true } },
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
    status: row.status,
    type: row.vehicleType,
    updatedAt: row.updatedAt,
    openTicket: row.repairTickets[0] ?? null,
  };
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every active vehicle, by plate. */
  async list() {
    const rows = await this.prisma.vehicle.findMany({
      where: { isActive: true, deletedAt: null },
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

  /** Sets or clears a truck's type; one VehicleChange row in the same transaction. */
  async update(id: string, dto: UpdateVehicleDto, user: AuthUser) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: rowSelect,
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.updatedAt.toISOString() !== dto.updatedAt) {
      throw new ConflictException(STALE_VEHICLE);
    }

    let next: { id: string; name: string } | null = null;
    if (dto.vehicleTypeId !== null) {
      next = await this.prisma.lookupValue.findFirst({
        where: {
          id: dto.vehicleTypeId,
          list: VEHICLE_TYPE_LIST,
          isActive: true,
        },
        select: { id: true, name: true },
      });
      if (!next) {
        throw new BadRequestException(
          'Choose an active vehicle type from the list.',
        );
      }
    }
    if ((vehicle.vehicleType?.id ?? null) === (next?.id ?? null)) {
      return present(vehicle);
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // The stale check again inside the transaction
      const { count } = await tx.vehicle.updateMany({
        where: { id, updatedAt: vehicle.updatedAt },
        data: { vehicleTypeId: next?.id ?? null, updatedAt: now },
      });
      if (count === 0) throw new ConflictException(STALE_VEHICLE);
      await tx.vehicleChange.create({
        data: {
          vehicleId: id,
          field: 'vehicleType',
          before: vehicle.vehicleType ?? Prisma.JsonNull,
          after: next ?? Prisma.JsonNull,
          actorUserId: user.sub,
          actorName: whoName(user),
          actorEmail: user.email,
        },
      });
      return tx.vehicle.findUniqueOrThrow({ where: { id }, select: rowSelect });
    });
    return present(updated);
  }

  /**
   * Spec 0020, AC-1 to AC-5a: an Admin sets a truck Available or Disabled with a reason. The
   * checks run in the AC-5a order; the status and its history row are written together.
   */
  async setStatus(id: string, dto: SetVehicleStatusDto, user: AuthUser) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { updatedAt: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    const loaded = new Date(dto.updatedAt).getTime();
    // Fast fail before the transaction
    if (vehicle.updatedAt.getTime() !== loaded) throw staleStatus();

    const target = dto.status as VehicleStatus;
    const updated = await this.prisma.$transaction(async (tx) => {
      // The same row lock ticket create takes, so a toggle and a new ticket can't both win
      const locked = await tx.$queryRaw<
        { status: VehicleStatus; updated_at: Date }[]
      >(
        Prisma.sql`SELECT status::text AS status, updated_at FROM vehicles
          WHERE id = ${id}::uuid AND is_active AND deleted_at IS NULL
          FOR UPDATE`,
      );
      if (locked.length === 0) throw new NotFoundException('Vehicle not found');
      const { status: before, updated_at: lockedAt } = locked[0];
      if (lockedAt.getTime() !== loaded) throw staleStatus();
      if (before === VehicleStatus.UNDER_MAINTENANCE) {
        throw new ConflictException({
          statusCode: 409,
          code: 'VEHICLE_STATUS_LOCKED',
          message: "This truck's status is set by maintenance.",
        });
      }
      const open = await tx.repairTicket.findFirst({
        where: { vehicleId: id, repairStatus: { in: OPEN_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, repairNumber: true },
      });
      if (open) {
        throw new ConflictException({
          statusCode: 409,
          code: 'OPEN_TICKET_EXISTS',
          message: `This truck has an open repair, ${open.repairNumber}. Change its status after the repair is closed or cancelled.`,
          ticket: open,
        });
      }
      // The screen showed an old status
      if (before === target) throw staleStatus();

      await vehicleStatusChange(tx, {
        vehicleId: id,
        before,
        after: target,
        actor: user,
        note: dto.reason,
        repairTicketId: null,
      });
      return tx.vehicle.findUniqueOrThrow({ where: { id }, select: rowSelect });
    });
    return present(updated);
  }
}
