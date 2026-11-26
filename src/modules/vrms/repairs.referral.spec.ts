import { UserRole } from '../../auth/roles';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { queueVmmsRepairEvent } from '../integrations/vmms-repair-events';
import { RepairsService } from './repairs.service';
import type { CreateRepairDto } from './dto/create-repair.dto';

jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn().mockResolvedValue({ deliveryId: 'e1' }),
}));

// covers: spec 0029 AC-8, AC-11, AC-12 and AC-13 (a ticket opened from a VMMS referral, and the
// repair events every create queues)

const REFERRAL = '7d4f6a8e-1c2b-4f3a-9e8d-0a1b2c3d4e5f';
const person = (role: UserRole) => ({
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role, system: 'VRMS' }],
  system: 'VRMS',
});
const admin = person(UserRole.ADMIN);

const dto = (over: Partial<CreateRepairDto> = {}) =>
  ({
    vehiclePlate: 'NBX 4821',
    garageLocation: 'Sta. Rosa',
    accountType: 'ONLINE',
    odometerReading: 84210,
    priority: 'MEDIUM',
    issues: [],
    referralId: REFERRAL,
    ...over,
  }) as unknown as CreateRepairDto;

function setup(
  referral: { vehicleId?: string; status?: string } | null = {},
  lockedReferralStatus = 'WAITING',
  mechanics = 0,
) {
  const prisma = {
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'v1', vmmsVehicleId: 'vmms-v1' }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 0 }),
    },
    vehicleChange: { create: jest.fn().mockResolvedValue({}) },
    garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
    issueCategory: { findMany: jest.fn().mockResolvedValue([]) },
    knowledgeEntry: { findMany: jest.fn().mockResolvedValue([]) },
    mechanic: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          mechanics ? [{ id: 'm1', name: 'Juan dela Cruz' }] : [],
        ),
    },
    referral: {
      findUnique: jest.fn().mockResolvedValue(
        referral && {
          id: REFERRAL,
          vehicleId: referral.vehicleId ?? 'v1',
          status: referral.status ?? 'WAITING',
          workOrderNumber: 'WO-2026-0412',
        },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    // Called as a tag (the strings array) or with Prisma.sql (an object holding them)
    $queryRaw: jest.fn((sql: readonly string[] | { strings: string[] }) => {
      const text = ('strings' in sql ? sql.strings : sql).join('?');
      return Promise.resolve(
        text.includes('FROM referrals')
          ? [{ status: lockedReferralStatus }]
          : [{ id: 'v1', status: 'AVAILABLE' }],
      );
    }),
    repairTicket: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { odometer: null } }),
      create: jest.fn((args: { data: { repairStatus: string } }) =>
        Promise.resolve({
          id: 't1',
          repairNumber: 'REP-20261127-TEST',
          repairStatus: args.data.repairStatus,
          issues: [],
          vehicle: { id: 'v1', status: 'AVAILABLE' },
        }),
      ),
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
    new FakeFleet().asClient(),
  );
  jest
    .spyOn(
      service as unknown as { present: (t: unknown) => unknown },
      'present',
    )
    .mockImplementation((ticket: unknown) => Promise.resolve(ticket));
  return { prisma, service };
}

const ticketData = (prisma: ReturnType<typeof setup>['prisma']) =>
  (
    prisma.repairTicket.create.mock.calls[0] as unknown as [
      {
        data: Record<string, unknown> & {
          auditLogs: { create: { action: string }[] };
        };
      },
    ]
  )[0].data;

beforeEach(() => jest.mocked(queueVmmsRepairEvent).mockClear());

describe('RepairsService.create from a VMMS referral', () => {
  it('opens the ticket with no driver, links the referral and audits it, in one transaction (AC-8, AC-12)', async () => {
    const { prisma, service } = setup();
    await service.create(dto(), admin, defaultAbility(admin));

    const data = ticketData(prisma);
    expect(data.driverId).toBeNull();
    expect(data.auditLogs.create.map((r) => r.action)).toEqual([
      'CREATED',
      'REFERRAL_OPENED_TICKET',
    ]);
    expect(prisma.referral.update).toHaveBeenCalledWith({
      where: { id: REFERRAL },
      data: expect.objectContaining({
        status: 'OPENED_TICKET',
        repairTicketId: 't1',
        decidedByUserId: admin.sub,
        decidedByName: 'Victor Ramos',
      }) as unknown,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('queues OPENED to VMMS on create, and STATUS_UPDATED after it for a ticket created Assigned (AC-13)', async () => {
    const open = setup();
    await open.service.create(dto(), admin, defaultAbility(admin));
    expect(
      jest.mocked(queueVmmsRepairEvent).mock.calls.map((c) => c.slice(1)),
    ).toEqual([['t1', 'OPENED']]);

    jest.mocked(queueVmmsRepairEvent).mockClear();
    const assigned = setup({}, 'WAITING', 1);
    await assigned.service.create(
      dto({ mechanics: [{ id: 'm1' }] }),
      admin,
      defaultAbility(admin),
    );
    expect(
      jest.mocked(queueVmmsRepairEvent).mock.calls.map((c) => c.slice(1)),
    ).toEqual([
      ['t1', 'OPENED'],
      ['t1', 'STATUS_UPDATED'],
    ]);
  });

  it('refuses a caller without integration.respond with 403 (AC-11)', async () => {
    const { prisma, service } = setup();
    const chief = person(UserRole.CHIEF_MECHANIC);
    await expect(
      service.create(dto(), chief, defaultAbility(chief)),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.repairTicket.create).not.toHaveBeenCalled();
  });

  it('answers 404 REFERRAL_NOT_FOUND and 422 REFERRAL_VEHICLE_MISMATCH', async () => {
    await expect(
      setup(null).service.create(dto(), admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'REFERRAL_NOT_FOUND' } });
    await expect(
      setup({ vehicleId: 'v2' }).service.create(
        dto(),
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({
      response: { code: 'REFERRAL_VEHICLE_MISMATCH' },
    });
  });

  it('answers 409 REFERRAL_ALREADY_DECIDED before and under the lock, writing nothing', async () => {
    const before = setup({ status: 'REJECTED' });
    await expect(
      before.service.create(dto(), admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'REFERRAL_ALREADY_DECIDED' } });

    // Another Admin decided it between the first read and the lock
    const raced = setup({}, 'OPENED_TICKET');
    await expect(
      raced.service.create(dto(), admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'REFERRAL_ALREADY_DECIDED' } });
    expect(raced.prisma.repairTicket.create).not.toHaveBeenCalled();
    expect(raced.prisma.referral.update).not.toHaveBeenCalled();
  });

  it('still needs a driver on a ticket a person opens without a referral', async () => {
    const { service } = setup();
    await expect(
      service.create(
        dto({ referralId: undefined }),
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
