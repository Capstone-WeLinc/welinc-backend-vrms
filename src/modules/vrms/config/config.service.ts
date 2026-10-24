import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { RepairStatus } from '@prisma/client';

const ACTIVE_STATUSES: RepairStatus[] = [
  RepairStatus.PENDING,
  RepairStatus.IN_PROGRESS,
  RepairStatus.FOR_VERIFICATION,
];

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
    // Fetch all active in-house mechanics (non-outsourced, linked to a user)
    const all = await this.prisma.mechanic.findMany({
      where: {
        isActive: true,
        isOutsourced: false,
      },
      select: {
        id: true,
        name: true,
        // The linked login's email, so the Users page can match a mechanic to an account (spec 0006).
        user: { select: { email: true } },
        repairTickets: {
          where: {
            repairStatus: { in: ACTIVE_STATUSES },
          },
          select: { id: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return all.map((mechanic) => ({
      id: mechanic.id,
      name: mechanic.name,
      isAvailable: mechanic.repairTickets.length === 0,
      email: mechanic.user?.email ?? null,
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
