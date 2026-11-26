import { applyFleetGarage, applyFleetVehicle } from './fleet-apply';
import type { FleetGarage, FleetVehicle } from './vmms-fleet.client';

// Spec 0029 (child 0001), AC-1 to AC-3: the pickers hide rows with `deletedAt` set, so a truck or
// garage VMMS lists must come back from the sync with it cleared (found by /check verify).

const NOW = new Date('2026-11-27T03:00:00.000Z');

const truck: FleetVehicle = {
  id: 'v-1',
  plateNumber: 'PXW 382',
  make: 'Toyota',
  model: 'Hilux',
  year: 2021,
  truckSizeCategory: null,
  capacity: 1000,
  odometer: 18000,
  status: 'AVAILABLE',
  garageId: null,
  updatedAt: NOW.toISOString(),
};

const garage: FleetGarage = { id: 'g-1', name: 'Marikina' };

const snapshot = {
  plateNumber: 'PXW 382',
  model: 'Hilux',
  make: 'Toyota',
  capacity: 1000,
  truckSizeCategory: null,
  status: 'AVAILABLE',
  isActive: true,
  garage: null,
};

function fakeTx(localId: string | null) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(localId ? [{ id: localId }] : []),
    vehicle: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(snapshot),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
    },
    garage: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ name: 'Marikina', isActive: true }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
    },
    lookupValue: { findUnique: jest.fn() },
    vehicleChange: { create: jest.fn() },
  };
}

describe('applyFleetVehicle and deletedAt', () => {
  it('clears deletedAt on a linked truck, so the picker lists it again', async () => {
    const tx = fakeTx('local-1');
    await applyFleetVehicle(tx as never, truck, NOW);
    const [call] = tx.vehicle.update.mock.calls as [[{ data: object }]];
    expect(call[0].data).toMatchObject({ deletedAt: null, isActive: true });
  });
});

describe('applyFleetGarage and deletedAt', () => {
  it('clears deletedAt on a linked garage, so the picker lists it again', async () => {
    const tx = fakeTx('local-g');
    await applyFleetGarage(tx as never, garage, NOW);
    const [call] = tx.garage.update.mock.calls as [[{ data: object }]];
    expect(call[0].data).toMatchObject({ deletedAt: null, isActive: true });
  });
});
