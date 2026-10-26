import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../shared/prisma.service';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';

type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

const admin: JwtUser = {
  sub: 'a',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};
const mechanic: JwtUser = {
  sub: 'm',
  email: 'mech.juan@welinc.com',
  name: 'Juan dela Cruz',
  roles: [{ role: UserRole.MECHANIC, system: 'VRMS' }],
  system: 'VRMS',
};

function ticket(status: RepairStatus, totalCost: number | null) {
  return {
    id: `id-${Math.random()}`,
    repairNumber: 'REP-1',
    repairStatus: status,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    completedAt: new Date('2026-10-02T00:00:00Z'),
    cancellationReason: null,
    isUnlocked: false,
    totalCost,
    vehicle: { plateNumber: 'ABC 123', model: 'Hilux' },
    driver: { name: 'Driver' },
    garage: { name: 'Sta. Rosa' },
  };
}

function setup(mechanicRecord: { id: string } | null = null) {
  const prisma = {
    mechanic: { findUnique: jest.fn().mockResolvedValue(mechanicRecord) },
    repairTicket: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          ticket(RepairStatus.COMPLETED, 4000),
          ticket(RepairStatus.CANCELLED, null),
        ]),
      groupBy: jest.fn().mockResolvedValue([
        {
          repairStatus: RepairStatus.COMPLETED,
          _count: { _all: 30 },
          _sum: { totalCost: 120000 },
        },
        {
          repairStatus: RepairStatus.CANCELLED,
          _count: { _all: 5 },
          _sum: { totalCost: 999 },
        },
      ]),
    },
  };
  return {
    prisma,
    service: new RepairsService(prisma as unknown as PrismaService),
  };
}

/** The `where` of the first call to a mocked Prisma query. */
function whereOf(mock: jest.Mock): Prisma.RepairTicketWhereInput {
  const [args] = mock.mock.calls[0] as [
    { where: Prisma.RepairTicketWhereInput },
  ];
  return args.where;
}

describe('RepairsService.findHistory', () => {
  it('summarises every matching row with the same where as the list, spend from completed rows only', async () => {
    const { prisma, service } = setup();
    const res = await service.findHistory(
      {
        garageId: '00000000-0000-4000-8000-000000000001',
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        page: 1,
        limit: 2,
      },
      admin,
    );
    expect(res.summary).toEqual({
      closed: 35,
      completed: 30,
      cancelled: 5,
      spend: 120000,
    });
    expect(res.total).toBe(35);
    const listWhere = whereOf(prisma.repairTicket.findMany);
    expect(whereOf(prisma.repairTicket.groupBy)).toBe(listWhere);
    expect(listWhere.completedAt).toEqual({
      gte: new Date('2026-10-01T00:00:00Z'),
      lt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(res.data[0]).toMatchObject({
      totalCost: 4000,
      closedAt: '2026-10-02T00:00:00.000Z',
      isUnlocked: false,
    });
  });

  it('gives a mechanic only assigned tickets, with no costs and spend null', async () => {
    const { prisma, service } = setup({ id: 'mech-1' });
    const res = await service.findHistory({}, mechanic);
    expect(whereOf(prisma.repairTicket.findMany).mechanics).toEqual({
      some: { id: 'mech-1' },
    });
    expect(res.summary.spend).toBeNull();
    expect(res.data.every((row) => !('totalCost' in row))).toBe(true);
    expect(res.data[0]).toHaveProperty('isUnlocked');
  });

  it('fails closed for a mechanic login with no mechanic record', async () => {
    const { prisma, service } = setup(null);
    const res = await service.findHistory({}, mechanic);
    expect(res).toEqual({
      data: [],
      total: 0,
      summary: { closed: 0, completed: 0, cancelled: 0, spend: null },
    });
    expect(prisma.repairTicket.findMany).not.toHaveBeenCalled();
  });

  it('rejects a range where from is not before to', async () => {
    const { service } = setup();
    await expect(
      service.findHistory(
        { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
        admin,
      ),
    ).rejects.toThrow('"from" must be before "to"');
  });
});

describe('audit routes', () => {
  const guard = new RolesGuard(new Reflector());
  const context = (handler: (...args: never[]) => unknown, user: JwtUser) =>
    ({
      getHandler: () => handler,
      getClass: () => RepairsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          headers: {},
          path: '/vrms/repairs/audit-logs',
        }),
      }),
    }) as unknown as ExecutionContext;

  it.each(['findAuditEvents', 'findAuditActors'] as const)(
    '%s answers admins only (a mechanic gets 403)',
    (name) => {
      const handler = RepairsController.prototype[name];
      expect(guard.canActivate(context(handler, admin))).toBe(true);
      expect(guard.canActivate(context(handler, mechanic))).toBe(false);
    },
  );
});

function openTicket(costs: {
  partsCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
}) {
  return {
    ...ticket(RepairStatus.PENDING, costs.totalCost),
    ...costs,
    completedAt: null,
    odometer: 1000,
    targetDueDate: null,
    failedVerificationReason: null,
    remarks: null,
    isLumpSum: true,
    unlockReason: null,
    driver: { name: 'Driver', isVerified: true },
    issues: [],
    mechanics: [],
    repairParts: [],
    shopChangeLogs: [],
    auditLogs: [],
  };
}

function listSetup(mechanicRecord: { id: string } | null = null) {
  const prisma = {
    mechanic: { findUnique: jest.fn().mockResolvedValue(mechanicRecord) },
    repairTicket: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest
        .fn()
        .mockResolvedValue([
          openTicket({ partsCost: 0, laborCost: 0, totalCost: 0 }),
        ]),
    },
  };
  return {
    prisma,
    service: new RepairsService(prisma as unknown as PrismaService),
  };
}

/** The full args of the first call to a mocked Prisma query. */
function argsOf(mock: jest.Mock) {
  return (mock.mock.calls[0] as [Record<string, unknown>])[0];
}

const GARAGE = '00000000-0000-4000-8000-000000000001';
const MECHANIC = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-22T08:00:00Z');

describe('RepairsService.findAll', () => {
  it('orders by due date with no due date last, then newest, then id, the same for count and rows', async () => {
    const { prisma, service } = listSetup();
    await service.findAll({ page: 2, limit: 20 }, admin);
    const args = argsOf(prisma.repairTicket.findMany);
    expect(args.orderBy).toEqual([
      { targetDueDate: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(args).toMatchObject({ skip: 20, take: 20 });
    expect(whereOf(prisma.repairTicket.count)).toBe(args.where);
  });

  it('holds open tickets only by default and returns every row with no paging', async () => {
    const { prisma, service } = listSetup();
    await service.findAll({}, admin);
    const args = argsOf(prisma.repairTicket.findMany);
    expect(args.where).toEqual({
      repairStatus: {
        in: [
          RepairStatus.PENDING,
          RepairStatus.IN_PROGRESS,
          RepairStatus.FOR_VERIFICATION,
        ],
      },
    });
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('take');
  });

  it('defaults the missing half of page and limit', async () => {
    const { prisma, service } = listSetup();
    await service.findAll({ page: 3 }, admin);
    expect(argsOf(prisma.repairTicket.findMany)).toMatchObject({
      skip: 40,
      take: 20,
    });
  });

  it('narrows by status, garage and mechanic on the server', async () => {
    const { prisma, service } = listSetup();
    await service.findAll(
      {
        status: RepairStatus.IN_PROGRESS,
        garageId: GARAGE,
        mechanicId: MECHANIC,
      },
      admin,
    );
    expect(whereOf(prisma.repairTicket.findMany)).toMatchObject({
      repairStatus: RepairStatus.IN_PROGRESS,
      garageId: GARAGE,
      mechanics: { some: { id: MECHANIC } },
    });
  });

  it('keeps only open tickets past their due date for overdue, whatever the status', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { prisma, service } = listSetup();
    await service.findAll(
      { overdue: true, status: RepairStatus.COMPLETED },
      admin,
    );
    const where = whereOf(prisma.repairTicket.findMany);
    expect(where.repairStatus).toBe(RepairStatus.COMPLETED);
    expect(where.AND).toEqual([
      {
        repairStatus: {
          in: [
            RepairStatus.PENDING,
            RepairStatus.IN_PROGRESS,
            RepairStatus.FOR_VERIFICATION,
          ],
        },
      },
      { targetDueDate: { lt: NOW } },
    ]);
    jest.useRealTimers();
  });

  it('ignores mechanicId for a mechanic and scopes to their own tickets', async () => {
    const { prisma, service } = listSetup({ id: 'mech-1' });
    await service.findAll({ mechanicId: MECHANIC }, mechanic);
    expect(whereOf(prisma.repairTicket.findMany).mechanics).toEqual({
      some: { id: 'mech-1' },
    });
  });

  it('fails closed for a mechanic login with no mechanic record', async () => {
    const { prisma, service } = listSetup(null);
    expect(await service.findAll({}, mechanic)).toEqual({ data: [], total: 0 });
    expect(prisma.repairTicket.findMany).not.toHaveBeenCalled();
  });

  it('sends a stored 0 cost as 0, not null', async () => {
    const { service } = listSetup();
    const res = await service.findAll({}, admin);
    expect(res.data[0]).toMatchObject({
      partsCost: 0,
      laborCost: 0,
      totalCost: 0,
    });
  });
});

describe('RepairsService.findAuditEvents', () => {
  it("keeps one ticket's events for ticketId", async () => {
    const prisma = { auditLog: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RepairsService(prisma as unknown as PrismaService);
    await service.findAuditEvents({ ticketId: GARAGE });
    const [args] = prisma.auditLog.findMany.mock.calls[0] as [
      { where: Prisma.AuditLogWhereInput },
    ];
    expect(args.where.AND).toEqual([{ repairTicketId: GARAGE }]);
  });

  it('matches the Person filter on the welinc-auth id in userId (spec 0009, AC-10)', async () => {
    const prisma = { auditLog: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RepairsService(prisma as unknown as PrismaService);
    await service.findAuditEvents({ actorId: GARAGE });
    const [args] = prisma.auditLog.findMany.mock.calls[0] as [
      { where: Prisma.AuditLogWhereInput },
    ];
    expect(args.where.AND).toEqual([{ userId: GARAGE }]);
  });
});

describe('request limits', () => {
  it.each(['remarks', 'cancellationReason'] as const)(
    'rejects a %s over 500 characters and accepts 500',
    async (field) => {
      const errorsFor = (length: number) =>
        validate(
          plainToInstance(UpdateRepairStatusDto, {
            status: RepairStatus.CANCELLED,
            [field]: 'x'.repeat(length),
          }),
        );
      expect(await errorsFor(500)).toHaveLength(0);
      expect((await errorsFor(501)).map((e) => e.property)).toEqual([field]);
    },
  );

  it.each([
    [{ overdue: 'yes' }, 'overdue'],
    [{ garageId: 'not-a-uuid' }, 'garageId'],
    [{ status: 'DONE' }, 'status'],
    [{ page: '0' }, 'page'],
  ])('rejects a bad list query %j', async (query, property) => {
    const errors = await validate(plainToInstance(FindRepairsQueryDto, query));
    expect(errors.map((e) => e.property)).toEqual([property]);
  });

  it('reads overdue=true as a boolean', () => {
    expect(
      plainToInstance(FindRepairsQueryDto, { overdue: 'true' }).overdue,
    ).toBe(true);
  });
});
