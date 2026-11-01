import { Injectable, NotFoundException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { OPEN_STATUSES } from '../ticket-statuses';
import { vehicleOdometerFloor } from '../odometer';
import type { AppAbility } from '../../../auth/permissions/ability.factory';

@Injectable()
export class ConfigService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Garages ────────────────────────────────────────────────────────────────

  async listGarages() {
    const garages = await this.prisma.garage.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return garages;
  }

  // ─── Vehicles ───────────────────────────────────────────────────────────────

  async listVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, plateNumber: true, model: true, status: true },
      orderBy: { plateNumber: 'asc' },
    });
    return vehicles;
  }

  // ─── Vehicle summary (spec 0016, AC-11) ─────────────────────────────────────

  /** What the system knows about a truck, for the new ticket form after a pick. */
  async vehicleSummary(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: {
        id: true,
        plateNumber: true,
        model: true,
        status: true,
        vehicleType: { select: { id: true, name: true } },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const [lastOdometer, lastClosed, lastTicket, openTicket] =
      await Promise.all([
        vehicleOdometerFloor(this.prisma, id),
        this.prisma.repairTicket.aggregate({
          _max: { closedAt: true },
          where: { vehicleId: id, repairStatus: RepairStatus.CLOSED },
        }),
        this.prisma.repairTicket.findFirst({
          where: {
            vehicleId: id,
            repairStatus: { not: RepairStatus.CANCELLED },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            driver: {
              select: {
                id: true,
                name: true,
                licenseNumber: true,
                isActive: true,
                deletedAt: true,
              },
            },
          },
        }),
        this.prisma.repairTicket.findFirst({
          where: { vehicleId: id, repairStatus: { in: OPEN_STATUSES } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, repairNumber: true, repairStatus: true },
        }),
      ]);

    const driver = lastTicket?.driver;
    const lastDriver =
      driver && driver.isActive && !driver.deletedAt
        ? {
            id: driver.id,
            name: driver.name,
            licenseNumber: driver.licenseNumber,
          }
        : null;

    return {
      id: vehicle.id,
      plateNumber: vehicle.plateNumber,
      model: vehicle.model,
      status: vehicle.status,
      type: vehicle.vehicleType,
      lastOdometer,
      lastRepairAt: lastClosed._max.closedAt,
      lastDriver,
      openTicket,
    };
  }

  // ─── Available In-house Mechanics ───────────────────────────────────────────

  async listAvailableMechanics() {
    // Every Mechanic row is an in house mechanic linked to a welinc-auth user (spec 0010)
    const all = await this.prisma.mechanic.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        // The Users page matches a mechanic to an account by authUserId (spec 0009, AC-9)
        authUserId: true,
        email: true,
        assignments: {
          where: { repairTicket: { repairStatus: { in: OPEN_STATUSES } } },
          select: { repairTicket: { select: { repairStatus: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Spec 0016, AC-14: openCount and busy let the picker show who is least loaded
    return all.map((mechanic) => ({
      id: mechanic.id,
      name: mechanic.name,
      isAvailable: mechanic.assignments.length === 0,
      openCount: mechanic.assignments.length,
      busy: mechanic.assignments.some(
        (a) => a.repairTicket.repairStatus === RepairStatus.IN_PROGRESS,
      ),
      email: mechanic.email,
      authUserId: mechanic.authUserId,
    }));
  }

  // ─── Drivers (for autocomplete) ─────────────────────────────────────────────

  /**
   * Active drivers matching `q` on name or license, up to 20 by name (spec 0016, AC-13). The
   * license number goes only to a caller who may create tickets; it is personal data.
   */
  async listDrivers(q: string | undefined, ability: AppAbility) {
    const term = q?.trim();
    const rows = await this.prisma.driver.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ...(term && {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { licenseNumber: { contains: term, mode: 'insensitive' } },
          ],
        }),
      },
      select: { id: true, name: true, licenseNumber: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
    if (ability.can('create', 'RepairTicket')) return rows;
    return rows.map(({ id, name }) => ({ id, name }));
  }
}
