import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import {
  applyFleetGarage,
  applyFleetVehicle,
  FLEET_ACTOR,
  type ApplyResult,
} from './fleet-apply';
import {
  hasDoubleClaims,
  planFleetLink,
  type LinkPlan,
} from './fleet-link-plan';
import { VmmsFleetClient } from './vmms-fleet.client';

export type LinkOutcome =
  | { kind: 'double_claim'; plan: LinkPlan }
  | { kind: 'planned'; plan: LinkPlan }
  | { kind: 'applied'; plan: LinkPlan; clashes: string[] };

/**
 * Spec 0029 (child 0001), AC-1: links VRMS's trucks and garages to VMMS once, before the sync is
 * switched on. Without `confirm` it only plans. A double claim stops it with nothing changed.
 */
@Injectable()
export class FleetLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: VmmsFleetClient,
  ) {}

  async run(confirm: boolean, now = new Date()): Promise<LinkOutcome> {
    const [garages, vehicles] = await Promise.all([
      this.fleet.garages(),
      this.fleet.vehicles(),
    ]);
    const [localGarages, localVehicles] = await Promise.all([
      this.prisma.garage.findMany({
        select: {
          id: true,
          name: true,
          vmmsGarageId: true,
          isActive: true,
          _count: { select: { repairTickets: true } },
        },
      }),
      this.prisma.vehicle.findMany({
        select: {
          id: true,
          plateNumber: true,
          vmmsVehicleId: true,
          isActive: true,
          _count: { select: { repairTickets: true } },
        },
      }),
    ]);
    const plan = planFleetLink(
      {
        garages: localGarages.map(({ _count, ...g }) => ({
          ...g,
          tickets: _count.repairTickets,
        })),
        vehicles: localVehicles.map(({ _count, ...v }) => ({
          ...v,
          tickets: _count.repairTickets,
        })),
      },
      { garages, vehicles },
    );
    if (hasDoubleClaims(plan)) return { kind: 'double_claim', plan };
    if (!confirm) return { kind: 'planned', plan };

    const clashes: string[] = [];
    const note = (what: string, result: ApplyResult) => {
      if (result.clash) clashes.push(`${what}: ${result.clash} clash, skipped`);
    };
    await this.prisma.$transaction(
      async (tx) => {
        // Garages first, so each truck finds its linked garage
        for (const { local, remote } of plan.garages.matches) {
          await tx.garage.update({
            where: { id: local.id },
            data: { vmmsGarageId: remote.id },
          });
          note(
            `garage ${remote.name}`,
            await applyFleetGarage(tx, remote, now),
          );
        }
        for (const remote of plan.garages.missing) {
          note(
            `garage ${remote.name}`,
            await applyFleetGarage(tx, remote, now),
          );
        }
        const archiveGarages = plan.garages.unmatched
          .filter((g) => g.isActive)
          .map((g) => g.id);
        await tx.garage.updateMany({
          where: { id: { in: archiveGarages } },
          data: { isActive: false },
        });

        for (const { local, remote } of plan.vehicles.matches) {
          await tx.vehicle.update({
            where: { id: local.id },
            data: { vmmsVehicleId: remote.id },
          });
          note(
            `truck ${remote.plateNumber}`,
            await applyFleetVehicle(tx, remote, now),
          );
        }
        for (const remote of plan.vehicles.missing) {
          note(
            `truck ${remote.plateNumber}`,
            await applyFleetVehicle(tx, remote, now),
          );
        }
        for (const v of plan.vehicles.unmatched.filter((x) => x.isActive)) {
          await tx.vehicle.update({
            where: { id: v.id },
            data: { isActive: false },
          });
          await tx.vehicleChange.create({
            data: {
              vehicleId: v.id,
              field: 'isActive',
              before: true,
              after: false,
              actorUserId: null,
              actorName: FLEET_ACTOR,
              note: 'Not in VMMS: archived by the fleet link (spec 0029)',
            },
          });
        }
      },
      { timeout: 5 * 60 * 1000, maxWait: 10_000 },
    );
    return { kind: 'applied', plan, clashes };
  }
}
