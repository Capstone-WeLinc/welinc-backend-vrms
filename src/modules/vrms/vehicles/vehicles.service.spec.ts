import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesService } from './vehicles.service';

// Spec 0029, AC-4: Settings, Vehicles is read only, lists only trucks linked to VMMS, and
// shows when the fleet sync last wrote each one.

const SYNCED = new Date('2026-11-27T02:00:00.000Z');

function setup(rows: unknown[]) {
  const prisma = { vehicle: { findMany: jest.fn().mockResolvedValue(rows) } };
  return {
    prisma,
    service: new VehiclesService(prisma as unknown as PrismaService),
  };
}

describe('VehiclesService.list', () => {
  it('reads only active trucks linked to VMMS, by plate', async () => {
    const { prisma, service } = setup([]);
    await service.list();
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          deletedAt: null,
          vmmsVehicleId: { not: null },
        },
        orderBy: { plateNumber: 'asc' },
      }),
    );
  });

  it('answers the VMMS facts, the garage, syncedAt and the open ticket', async () => {
    const { service } = setup([
      {
        id: 'v1',
        plateNumber: 'NBC 1234',
        model: 'Elf',
        make: 'Isuzu',
        truckSizeCategory: '6 wheeler',
        status: 'UNDER_MAINTENANCE',
        syncedAt: SYNCED,
        updatedAt: SYNCED,
        vehicleType: { id: 't1', name: '6 wheeler' },
        garage: { id: 'g1', name: 'Valenzuela' },
        repairTickets: [{ id: 'r1', repairNumber: 'REP-1' }],
      },
    ]);
    expect(await service.list()).toEqual([
      {
        id: 'v1',
        plateNumber: 'NBC 1234',
        model: 'Elf',
        make: 'Isuzu',
        truckSizeCategory: '6 wheeler',
        status: 'UNDER_MAINTENANCE',
        type: { id: 't1', name: '6 wheeler' },
        garage: { id: 'g1', name: 'Valenzuela' },
        syncedAt: SYNCED,
        updatedAt: SYNCED,
        openTicket: { id: 'r1', repairNumber: 'REP-1' },
      },
    ]);
  });
});
