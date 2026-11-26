import { UserRole } from '../../auth/roles';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { applyFleetVehicle } from '../integrations/fleet/fleet-apply';
import type { FleetVehicle } from '../integrations/fleet/vmms-fleet.client';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { RepairsService } from './repairs.service';
import type { CreateRepairDto } from './dto/create-repair.dto';

// Spec 0029: the VMMS repair event has its own tests (repairs.referral.spec.ts)
jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn().mockResolvedValue({ skipped: 'NOT_LINKED' }),
}));
// The apply itself is tested with the fleet sync; here only when and with what it is called
jest.mock('../integrations/fleet/fleet-apply', () => ({
  applyFleetVehicle: jest.fn(() => {
    order.push('applyFleetVehicle');
    return Promise.resolve({ localId: 'v1', created: false, changed: [] });
  }),
}));

// Spec 0029 (child 0001), AC-4 and AC-5: ticket create reads the truck fresh from VMMS and
// applies it under the truck's lock; a truck VMMS doesn't have refuses the ticket; when VMMS
// can't be reached the copy is used and the answer says so. Create never writes the truck's
// status (spec 0020's Under repair row is retired: VMMS owns the status).

let order: string[] = [];

const admin = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};

const dto = {
  vehiclePlate: 'ABC 123',
  garageLocation: 'Sta. Rosa',
  driverId: '00000000-0000-4000-8000-0000000000d1',
  accountType: 'ONLINE',
  odometerReading: 1000,
  priority: 'LOW',
  issues: [],
} as unknown as CreateRepairDto;

const FRESH: FleetVehicle = {
  id: 'vmms-v1',
  plateNumber: 'ABC 123',
  make: 'Isuzu',
  model: 'Elf',
  year: 2021,
  truckSizeCategory: '6 wheeler',
  capacity: 4000,
  odometer: 900,
  status: 'UNDER_MAINTENANCE',
  garageId: null,
  updatedAt: '2026-11-27T00:00:00.000Z',
};

function setup(truck: FakeFleet['truck']) {
  order = [];
  const prisma = {
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'v1', vmmsVehicleId: 'vmms-v1' }),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 0 }),
    },
    vehicleChange: { create: jest.fn() },
    garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
    issueCategory: { findMany: jest.fn().mockResolvedValue([]) },
    knowledgeEntry: { findMany: jest.fn().mockResolvedValue([]) },
    driver: {
      findFirst: jest.fn().mockResolvedValue({ id: 'd1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'd1' }),
      update: jest.fn().mockResolvedValue({ id: 'd1' }),
    },
    mechanic: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn(() => {
      order.push('lock');
      return Promise.resolve([{ id: 'v1' }]);
    }),
    repairTicket: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn(() => {
        order.push('odometerFloor');
        return Promise.resolve({ _max: { odometer: null } });
      }),
      create: jest.fn(() => {
        order.push('repairTicket.create');
        return Promise.resolve({
          id: 't1',
          repairNumber: 'REP-20261127-TEST',
          repairStatus: 'OPEN',
          issues: [],
        });
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const fleet = new FakeFleet();
  fleet.truck = truck;
  const service = new RepairsService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
    new FakeEmbeddings().asService(),
    fleet.asClient(),
  );
  // The response mapper reads photos and more; it is not what these tests are about
  jest
    .spyOn(
      service as unknown as { present: (t: unknown) => unknown },
      'present',
    )
    .mockImplementation((ticket: unknown) => Promise.resolve(ticket));
  return { prisma, fleet, service };
}

describe('RepairsService.create with the VMMS fleet (spec 0029, AC-4, AC-5)', () => {
  beforeEach(() => jest.mocked(applyFleetVehicle).mockClear());

  it('reads the truck fresh by its VMMS id and applies it under the lock, before the odometer floor', async () => {
    const { fleet, prisma, service } = setup(FRESH);
    const out = await service.create(dto, admin, defaultAbility(admin));

    expect(fleet.reads).toEqual(['vmms-v1']);
    expect(applyFleetVehicle).toHaveBeenCalledWith(
      prisma,
      FRESH,
      expect.any(Date),
    );
    expect(order.indexOf('lock')).toBeLessThan(
      order.indexOf('applyFleetVehicle'),
    );
    expect(order.indexOf('applyFleetVehicle')).toBeLessThan(
      order.indexOf('odometerFloor'),
    );
    expect((out as { fleetStale: boolean }).fleetStale).toBe(false);
  });

  it('opens a ticket for a truck under maintenance in VMMS, and never writes the truck status (AC-4)', async () => {
    const { prisma, service } = setup(FRESH);
    await service.create(dto, admin, defaultAbility(admin));

    expect(prisma.repairTicket.create).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.vehicleChange.create).not.toHaveBeenCalled();
    const data = (
      prisma.repairTicket.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).not.toHaveProperty('priorVehicleStatus');
  });

  it('answers 422 VEHICLE_NOT_IN_VMMS and writes nothing when VMMS no longer has the truck', async () => {
    const { prisma, service } = setup(null);
    await expect(
      service.create(dto, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'VEHICLE_NOT_IN_VMMS' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('uses the copy and says fleetStale when VMMS cannot be reached', async () => {
    const { prisma, service } = setup('unavailable');
    const out = await service.create(dto, admin, defaultAbility(admin));

    expect(applyFleetVehicle).not.toHaveBeenCalled();
    expect(prisma.repairTicket.create).toHaveBeenCalledTimes(1);
    expect((out as { fleetStale: boolean }).fleetStale).toBe(true);
  });

  it('refuses a truck that is not linked to VMMS as not found, without a VMMS read', async () => {
    const { fleet, prisma, service } = setup(FRESH);
    prisma.vehicle.findFirst.mockResolvedValue(null);
    await expect(
      service.create(dto, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ status: 400 });
    expect(fleet.reads).toEqual([]);
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        vmmsVehicleId: { not: null },
      }) as unknown,
    });
  });
});
