import { Injectable, Logger } from '@nestjs/common';
import { reportJobFailure } from '../../../monitoring/job-failure';
import { PrismaService } from '../../../shared/prisma.service';
import {
  applyFleetGarage,
  applyFleetVehicle,
  deactivateFleetGarage,
  deactivateFleetVehicle,
  type ApplyResult,
} from './fleet-apply';
import type { FleetChangeDto } from './fleet-change.dto';
import { LIST_TIMEOUT_MS, VmmsFleetClient } from './vmms-fleet.client';

/** The reconcile deactivates nothing when more than this share of active linked rows is missing. */
export const MAX_DEACTIVATE_SHARE = 0.2;

export type ReconcileReport = {
  garages: { listed: number; missing: number };
  vehicles: { listed: number; missing: number };
  /** Rows set inactive; zero whenever the guard held. */
  deactivated: number;
  /** Why the guard deactivated nothing, or null when it did not trip. */
  guard: string | null;
  clashes: string[];
};

/** Thrown into Sentry (never out of a job): the guard or a clash, so someone looks. */
class FleetSyncProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetSyncProblem';
  }
}

/**
 * Whether the reconcile may deactivate the rows VMMS stopped listing (child 0001's guard): never
 * on an empty list, never when more than 20% of the active linked rows would go at once.
 */
export function guardReason(
  label: 'garage' | 'truck',
  listed: number,
  missing: number,
  activeLinked: number,
): string | null {
  if (listed === 0) return `VMMS answered an empty ${label} list`;
  if (missing > activeLinked * MAX_DEACTIVATE_SHARE) {
    return `${missing} of ${activeLinked} active ${label}s are missing from VMMS (over ${MAX_DEACTIVATE_SHARE * 100}%)`;
  }
  return null;
}

/**
 * Spec 0029 (child 0001), AC-2 and AC-3: keeps VRMS's copy of VMMS's trucks and garages current.
 * A change message reads one record fresh; the reconcile reads both full lists. Every write goes
 * through `fleet-apply.ts`, which locks the row first.
 */
@Injectable()
export class FleetSyncService {
  private readonly logger = new Logger(FleetSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: VmmsFleetClient,
  ) {}

  /**
   * AC-2: answered 202 at once by the route; this runs after. A failed read is logged and left
   * for the reconcile, never retried here.
   */
  receive(change: FleetChangeDto): void {
    const work =
      change.entityType === 'VEHICLE'
        ? this.refreshVehicle(change.entityId)
        : this.refreshGarage(change.entityId);
    work.catch((error: unknown) => {
      this.logger.warn(
        `Fleet change ${change.eventId} (${change.changeType} ${change.entityType} ${change.entityId}) left for the reconcile: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** One truck read fresh: applied, or deactivated on a 404. Never deleted. */
  async refreshVehicle(vmmsVehicleId: string, now = new Date()): Promise<void> {
    const record = await this.fleet.vehicle(vmmsVehicleId, LIST_TIMEOUT_MS);
    if (!record) {
      const done = await this.prisma.$transaction((tx) =>
        deactivateFleetVehicle(tx, vmmsVehicleId, now),
      );
      if (done) this.logger.log(`Truck ${vmmsVehicleId} removed in VMMS`);
      return;
    }
    const result = await this.prisma.$transaction((tx) =>
      applyFleetVehicle(tx, record, now),
    );
    this.reportClashes([this.clashOf(`truck ${record.plateNumber}`, result)]);
  }

  /**
   * One garage, from the garage list (VMMS has no single garage read). Missing from a non empty
   * list deactivates it; an empty list changes nothing.
   */
  async refreshGarage(vmmsGarageId: string, now = new Date()): Promise<void> {
    const garages = await this.fleet.garages();
    const record = garages.find((g) => g.id === vmmsGarageId);
    if (!record) {
      if (garages.length === 0) return;
      await this.prisma.$transaction((tx) =>
        deactivateFleetGarage(tx, vmmsGarageId, now),
      );
      return;
    }
    const result = await this.prisma.$transaction((tx) =>
      applyFleetGarage(tx, record, now),
    );
    this.reportClashes([this.clashOf(`garage ${record.name}`, result)]);
  }

  /** `fleet:link` has run: at least one truck carries a VMMS id. Until then the reconcile waits. */
  async linked(): Promise<boolean> {
    const one = await this.prisma.vehicle.findFirst({
      where: { vmmsVehicleId: { not: null } },
      select: { id: true },
    });
    return one !== null;
  }

  /**
   * AC-3: both full lists, upserted by VMMS id (garages first, so each truck finds its garage),
   * then the rows VMMS no longer lists set inactive, unless the guard holds. Each row is its own
   * short transaction, so a long run never holds many locks.
   */
  async reconcile(now = new Date()): Promise<ReconcileReport> {
    const [garages, vehicles] = await Promise.all([
      this.fleet.garages(),
      this.fleet.vehicles(),
    ]);
    const clashes: (string | null)[] = [];
    for (const record of garages) {
      const result = await this.prisma.$transaction((tx) =>
        applyFleetGarage(tx, record, now),
      );
      clashes.push(this.clashOf(`garage ${record.name}`, result));
    }
    for (const record of vehicles) {
      const result = await this.prisma.$transaction((tx) =>
        applyFleetVehicle(tx, record, now),
      );
      clashes.push(this.clashOf(`truck ${record.plateNumber}`, result));
    }

    const [localGarages, localVehicles] = await Promise.all([
      this.prisma.garage.findMany({
        where: { isActive: true, vmmsGarageId: { not: null } },
        select: { vmmsGarageId: true },
      }),
      this.prisma.vehicle.findMany({
        where: { isActive: true, vmmsVehicleId: { not: null } },
        select: { vmmsVehicleId: true },
      }),
    ]);
    const listedGarages = new Set(garages.map((g) => g.id));
    const listedVehicles = new Set(vehicles.map((v) => v.id));
    const missingGarages = localGarages
      .map((g) => g.vmmsGarageId!)
      .filter((id) => !listedGarages.has(id));
    const missingVehicles = localVehicles
      .map((v) => v.vmmsVehicleId!)
      .filter((id) => !listedVehicles.has(id));

    const guard =
      guardReason(
        'garage',
        garages.length,
        missingGarages.length,
        localGarages.length,
      ) ??
      guardReason(
        'truck',
        vehicles.length,
        missingVehicles.length,
        localVehicles.length,
      );

    let deactivated = 0;
    if (guard) {
      reportJobFailure(
        'fleet-reconcile',
        new FleetSyncProblem(`Deactivated nothing: ${guard}`),
      );
    } else {
      for (const id of missingGarages) {
        const done = await this.prisma.$transaction((tx) =>
          deactivateFleetGarage(tx, id, now),
        );
        if (done) deactivated += 1;
      }
      for (const id of missingVehicles) {
        const done = await this.prisma.$transaction((tx) =>
          deactivateFleetVehicle(tx, id, now),
        );
        if (done) deactivated += 1;
      }
    }

    const found = clashes.filter((c): c is string => c !== null);
    this.reportClashes(found);
    return {
      garages: {
        listed: garages.length,
        missing: missingGarages.length,
      },
      vehicles: {
        listed: vehicles.length,
        missing: missingVehicles.length,
      },
      deactivated,
      guard,
      clashes: found,
    };
  }

  private clashOf(what: string, result: ApplyResult): string | null {
    return result.clash
      ? `${what}: the ${result.clash === 'plate' ? 'plate' : 'name'} is held by another VRMS row, skipped`
      : null;
  }

  /** AC-3: a clash is skipped, logged and reported; the other fields already applied. */
  private reportClashes(clashes: (string | null)[]): void {
    const found = clashes.filter((c): c is string => c !== null);
    if (found.length === 0) return;
    for (const clash of found) this.logger.warn(`Fleet sync: ${clash}`);
    reportJobFailure(
      'fleet-reconcile',
      new FleetSyncProblem(`Fleet sync skipped: ${found.join('; ')}`),
    );
  }
}
