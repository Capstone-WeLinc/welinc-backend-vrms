import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { OPEN_STATUSES } from '../ticket-statuses';

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
          select: { id: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return all.map((mechanic) => ({
      id: mechanic.id,
      name: mechanic.name,
      isAvailable: mechanic.assignments.length === 0,
      email: mechanic.email,
      authUserId: mechanic.authUserId,
    }));
  }

  // ─── Drivers (for autocomplete) ─────────────────────────────────────────────

  async listDrivers() {
    return this.prisma.driver.findMany({
      select: { id: true, name: true, licenseNumber: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }
}
