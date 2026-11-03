import { UserRole } from '../../auth/roles';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { RepairsService } from './repairs.service';
import type { CreateRepairDto } from './dto/create-repair.dto';

// Spec 0020, AC-6 and AC-15: ticket create writes the truck's status history row in its own
// transaction, after the ticket insert, from the status read under the row lock.

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

function setup(lockedStatus: string) {
  const order: string[] = [];
  const prisma = {
    vehicle: {
      findFirst: jest.fn().mockResolvedValue({ id: 'v1' }),
      update: jest.fn(() => {
        order.push('vehicle.update');
        return Promise.resolve({});
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 0 }),
    },
    vehicleChange: {
      create: jest.fn(() => {
        order.push('vehicleChange.create');
        return Promise.resolve({});
      }),
    },
    garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
    issueCategory: { findMany: jest.fn().mockResolvedValue([]) },
    knowledgeEntry: { findMany: jest.fn().mockResolvedValue([]) },
    driver: {
      findFirst: jest.fn().mockResolvedValue({ id: 'd1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'd1' }),
      update: jest.fn().mockResolvedValue({ id: 'd1' }),
    },
    mechanic: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ id: 'v1', status: lockedStatus }]),
    repairTicket: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { odometer: null } }),
      create: jest.fn(() => {
        order.push('repairTicket.create');
        return Promise.resolve({
          id: 't1',
          repairNumber: 'REP-20261103-TEST',
          issues: [],
          vehicle: { id: 'v1', status: lockedStatus },
        });
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const service = new RepairsService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
    new FakeEmbeddings().asService(),
  );
  // The response mapper reads photos and more; it is not what these tests are about
  jest
    .spyOn(
      service as unknown as { present: (t: unknown) => unknown },
      'present',
    )
    .mockImplementation((ticket: unknown) => Promise.resolve(ticket));
  return { prisma, order, service };
}

describe('RepairsService.create status history (spec 0020, AC-6, AC-15)', () => {
  it('writes one Available to Under repair row for the new ticket, after the insert (AC-6)', async () => {
    const { prisma, order, service } = setup('AVAILABLE');
    const out = await service.create(dto, admin, defaultAbility(admin));

    expect(prisma.vehicleChange.create).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleChange.create).toHaveBeenCalledWith({
      data: {
        vehicleId: 'v1',
        field: 'status',
        before: 'AVAILABLE',
        after: 'UNDER_REPAIR',
        note: null,
        repairTicketId: 't1',
        actorUserId: admin.sub,
        actorName: 'Victor Ramos',
        actorEmail: admin.email,
      },
    });
    // The row points at the ticket, so the ticket goes in first
    expect(order.indexOf('repairTicket.create')).toBeLessThan(
      order.indexOf('vehicleChange.create'),
    );
    // The answer shows the truck as it is now
    expect((out as { vehicle: { status: string } }).vehicle.status).toBe(
      'UNDER_REPAIR',
    );
  });

  it('keeps the status read under the lock as before and as priorVehicleStatus on a Disabled truck (AC-6, AC-15)', async () => {
    const { prisma, service } = setup('DISABLED');
    await service.create(dto, admin, defaultAbility(admin));

    expect(prisma.vehicleChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        before: 'DISABLED',
        after: 'UNDER_REPAIR',
        repairTicketId: 't1',
      }) as unknown,
    });
    expect(prisma.repairTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priorVehicleStatus: 'DISABLED',
        }) as unknown,
      }) as unknown,
    );
  });

  it('writes no history row for a stuck truck that is already Under repair (AC-6)', async () => {
    const { prisma, service } = setup('UNDER_REPAIR');
    await service.create(dto, admin, defaultAbility(admin));

    expect(prisma.repairTicket.create).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleChange.create).not.toHaveBeenCalled();
  });
});
