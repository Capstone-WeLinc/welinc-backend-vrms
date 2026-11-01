import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import type { AuthUser } from '../../../auth/account-check';
import { whoName } from '../audit-events';
import type { UpdateVehicleDto } from '../dto/update-vehicle.dto';
import { VEHICLE_TYPE_LIST } from '../lookups/lookup-lists';

export const STALE_VEHICLE =
  'This truck changed. Check the type and save again.';

const rowSelect = {
  id: true,
  plateNumber: true,
  model: true,
  status: true,
  updatedAt: true,
  vehicleType: { select: { id: true, name: true } },
} as const;

type Row = Prisma.VehicleGetPayload<{ select: typeof rowSelect }>;

/** The row the Settings section shows (spec 0016, AC-21). */
function present(row: Row) {
  return {
    id: row.id,
    plateNumber: row.plateNumber,
    model: row.model,
    status: row.status,
    type: row.vehicleType,
    updatedAt: row.updatedAt,
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
}
