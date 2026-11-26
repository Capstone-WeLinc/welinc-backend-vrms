import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { BmsScheduleClient, type BmsTrip } from './bms-schedule.client';

/** `{ available: false }` when BMS can't answer; the web says "BMS can't be reached". */
export type UpcomingTrips =
  { available: true; items: BmsTrip[] } | { available: false };

/**
 * Spec 0029 (child 0003), AC-16: a truck's upcoming trips and Job Orders, read live from BMS for
 * the new ticket form and the ticket page. Never stored. Any failure answers unavailable, so
 * neither page waits on BMS longer than the client's 3 s.
 */
@Injectable()
export class UpcomingTripsService {
  private readonly logger = new Logger(UpcomingTripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bms: BmsScheduleClient,
  ) {}

  async forVehicle(vehicleId: string): Promise<UpcomingTrips> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { vmmsVehicleId: true },
    });
    // BMS knows trucks only by VMMS's id; a truck not linked yet can't be asked about
    if (!vehicle?.vmmsVehicleId) return { available: false };
    const items = await this.bms.upcomingTrips(vehicle.vmmsVehicleId);
    if (!items) {
      this.logger.warn(`BMS schedule unavailable for vehicle ${vehicleId}`);
      return { available: false };
    }
    return { available: true, items };
  }
}
