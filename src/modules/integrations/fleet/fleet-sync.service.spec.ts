import { reportJobFailure } from '../../../monitoring/job-failure';
import type { PrismaService } from '../../../shared/prisma.service';
import { FakeSettings } from '../../../settings/settings.fake';
import {
  applyFleetGarage,
  applyFleetVehicle,
  deactivateFleetGarage,
  deactivateFleetVehicle,
} from './fleet-apply';
import { FleetReconcileJob } from './fleet-reconcile.job';
import { FleetSyncService, guardReason } from './fleet-sync.service';
import type { FleetVehicle } from './vmms-fleet.client';
import { FakeFleet } from './vmms-fleet.fake';

// Spec 0029 (child 0001), AC-2 and AC-3: the change receiver's fresh read and the reconcile with
// its guard. The row writes themselves live in fleet-apply.ts; here only when they are called.

jest.mock('../../../monitoring/job-failure', () => ({
  reportJobFailure: jest.fn(),
}));
jest.mock('./fleet-apply', () => ({
  applyFleetGarage: jest.fn(),
  applyFleetVehicle: jest.fn(),
  deactivateFleetGarage: jest.fn().mockResolvedValue(true),
  deactivateFleetVehicle: jest.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-11-27T03:00:00.000Z');

const truck = (id: string, plateNumber = `PLT ${id}`): FleetVehicle => ({
  id,
  plateNumber,
  make: 'Isuzu',
  model: 'Elf',
  year: 2021,
  truckSizeCategory: '6 wheeler',
  capacity: 4000,
  odometer: 1000,
  status: 'AVAILABLE',
  garageId: 'g-1',
  updatedAt: NOW.toISOString(),
});

function setup(local: { garages?: string[]; vehicles?: string[] } = {}) {
  const tx = {};
  const prisma = {
    $transaction: jest.fn((run: (t: unknown) => unknown) => run(tx)),
    garage: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (local.garages ?? []).map((id) => ({ vmmsGarageId: id })),
        ),
    },
    vehicle: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (local.vehicles ?? []).map((id) => ({ vmmsVehicleId: id })),
        ),
      findFirst: jest.fn().mockResolvedValue({ id: 'v1' }),
    },
  };
  const fleet = new FakeFleet();
  const sync = new FleetSyncService(
    prisma as unknown as PrismaService,
    fleet.asClient(),
  );
  return { tx, prisma, fleet, sync };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(applyFleetVehicle)
    .mockResolvedValue({ localId: 'v', created: false, changed: [] });
  jest
    .mocked(applyFleetGarage)
    .mockResolvedValue({ localId: 'g', created: false, changed: [] });
});

describe('guardReason', () => {
  it('trips on an empty list and on more than 20% missing, never at exactly 20%', () => {
    expect(guardReason('truck', 0, 0, 5)).toMatch(/empty truck list/);
    expect(guardReason('truck', 9, 2, 10)).toBeNull();
    expect(guardReason('truck', 8, 3, 10)).toMatch(/3 of 10 active trucks/);
    expect(guardReason('garage', 3, 0, 3)).toBeNull();
  });
});

describe('FleetSyncService.refreshVehicle (AC-2)', () => {
  it('applies the record read fresh, never the message', async () => {
    const { fleet, sync, tx } = setup();
    fleet.truck = truck('v-1');
    await sync.refreshVehicle('v-1', NOW);
    expect(fleet.reads).toEqual(['v-1']);
    expect(applyFleetVehicle).toHaveBeenCalledWith(tx, fleet.truck, NOW);
    expect(deactivateFleetVehicle).not.toHaveBeenCalled();
  });

  it('deactivates on a 404 and never deletes', async () => {
    const { fleet, sync, tx } = setup();
    fleet.truck = null;
    await sync.refreshVehicle('v-gone', NOW);
    expect(deactivateFleetVehicle).toHaveBeenCalledWith(tx, 'v-gone', NOW);
    expect(applyFleetVehicle).not.toHaveBeenCalled();
  });

  it('reports a plate clash and still returns normally', async () => {
    const { fleet, sync } = setup();
    fleet.truck = truck('v-1', 'ABC 123');
    jest.mocked(applyFleetVehicle).mockResolvedValueOnce({
      localId: 'v',
      created: false,
      changed: ['model'],
      clash: 'plate',
    });
    await sync.refreshVehicle('v-1', NOW);
    expect(reportJobFailure).toHaveBeenCalledWith(
      'fleet-reconcile',
      expect.objectContaining({
        message: expect.stringContaining('truck ABC 123') as unknown,
      }),
    );
  });

  it('leaves a failed read for the reconcile: receive never throws', async () => {
    const { sync } = setup();
    // FakeFleet answers "unavailable" by default
    expect(() =>
      sync.receive({
        eventId: 'e1',
        entityType: 'VEHICLE',
        entityId: 'v-1',
        changeType: 'VEHICLE_UPDATED',
        occurredAt: NOW.toISOString(),
      }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(applyFleetVehicle).not.toHaveBeenCalled();
  });
});

describe('FleetSyncService.refreshGarage (AC-2)', () => {
  it('applies the garage from the list, and deactivates one the list lacks', async () => {
    const { fleet, sync, tx } = setup();
    fleet.garageList = [{ id: 'g-1', name: 'Valenzuela' }];
    await sync.refreshGarage('g-1', NOW);
    expect(applyFleetGarage).toHaveBeenCalledWith(
      tx,
      { id: 'g-1', name: 'Valenzuela' },
      NOW,
    );
    await sync.refreshGarage('g-2', NOW);
    expect(deactivateFleetGarage).toHaveBeenCalledWith(tx, 'g-2', NOW);
  });

  it('changes nothing on an empty garage list', async () => {
    const { sync } = setup();
    await sync.refreshGarage('g-1', NOW);
    expect(applyFleetGarage).not.toHaveBeenCalled();
    expect(deactivateFleetGarage).not.toHaveBeenCalled();
  });
});

describe('FleetSyncService.reconcile (AC-3)', () => {
  it('upserts garages before trucks, then deactivates the rows VMMS stopped listing', async () => {
    const order: string[] = [];
    jest.mocked(applyFleetGarage).mockImplementation(() => {
      order.push('garage');
      return Promise.resolve({ localId: 'g', created: false, changed: [] });
    });
    jest.mocked(applyFleetVehicle).mockImplementation(() => {
      order.push('truck');
      return Promise.resolve({ localId: 'v', created: false, changed: [] });
    });
    const ids = ['1', '2', '3', '4', '5', '6'];
    const { fleet, sync, tx } = setup({
      garages: ['g-1'],
      vehicles: [...ids, 'gone'],
    });
    fleet.garageList = [{ id: 'g-1', name: 'Valenzuela' }];
    fleet.vehicleList = ids.map((id) => truck(id));

    const report = await sync.reconcile(NOW);

    expect(order).toEqual(['garage', ...ids.map(() => 'truck')]);
    expect(deactivateFleetVehicle).toHaveBeenCalledTimes(1);
    expect(deactivateFleetVehicle).toHaveBeenCalledWith(tx, 'gone', NOW);
    expect(report).toMatchObject({ deactivated: 1, guard: null });
    expect(reportJobFailure).not.toHaveBeenCalled();
  });

  it('deactivates nothing and reports when the truck list comes back empty; upserts still apply', async () => {
    const { fleet, sync } = setup({ garages: ['g-1'], vehicles: ['1', '2'] });
    fleet.garageList = [{ id: 'g-1', name: 'Valenzuela' }];

    const report = await sync.reconcile(NOW);

    expect(applyFleetGarage).toHaveBeenCalledTimes(1);
    expect(deactivateFleetVehicle).not.toHaveBeenCalled();
    expect(deactivateFleetGarage).not.toHaveBeenCalled();
    expect(report.guard).toMatch(/empty truck list/);
    expect(reportJobFailure).toHaveBeenCalledWith(
      'fleet-reconcile',
      expect.objectContaining({
        message: expect.stringContaining('Deactivated nothing') as unknown,
      }),
    );
  });

  it('deactivates nothing when more than 20% of the active trucks would go at once', async () => {
    const { fleet, sync } = setup({
      garages: ['g-1'],
      vehicles: ['1', '2', '3', '4', '5'],
    });
    fleet.garageList = [{ id: 'g-1', name: 'Valenzuela' }];
    fleet.vehicleList = [truck('1'), truck('2'), truck('3')];

    const report = await sync.reconcile(NOW);

    expect(applyFleetVehicle).toHaveBeenCalledTimes(3);
    expect(deactivateFleetVehicle).not.toHaveBeenCalled();
    expect(report.guard).toMatch(/2 of 5 active trucks/);
  });
});

describe('FleetReconcileJob (AC-3)', () => {
  function job(linked = true) {
    const sync = {
      linked: jest.fn().mockResolvedValue(linked),
      reconcile: jest.fn().mockResolvedValue({
        garages: { listed: 1, missing: 0 },
        vehicles: { listed: 6, missing: 0 },
        deactivated: 0,
        guard: null,
        clashes: [],
      }),
    };
    const settings = new FakeSettings();
    return {
      sync,
      settings,
      job: new FleetReconcileJob(sync as unknown as FleetSyncService, settings),
    };
  }

  it('runs at once, then waits fleet.reconcileMinutes (a setting, not a constant)', async () => {
    const { job: j, sync, settings } = job();
    settings.set('fleet.reconcileMinutes', 15);
    const start = NOW.getTime();
    await j.run(start);
    await j.run(start + 14 * 60_000);
    expect(sync.reconcile).toHaveBeenCalledTimes(1);
    await j.run(start + 15 * 60_000);
    expect(sync.reconcile).toHaveBeenCalledTimes(2);
  });

  it('waits for fleet:link: nothing runs while no truck is linked', async () => {
    const { job: j, sync } = job(false);
    await j.run(NOW.getTime());
    expect(sync.reconcile).not.toHaveBeenCalled();
  });

  it('reports a failure and never rethrows', async () => {
    const { job: j, sync } = job();
    sync.reconcile.mockRejectedValueOnce(new Error('VMMS down'));
    await expect(j.run(NOW.getTime())).resolves.toBeUndefined();
    expect(reportJobFailure).toHaveBeenCalledWith(
      'fleet-reconcile',
      expect.any(Error),
    );
  });
});
