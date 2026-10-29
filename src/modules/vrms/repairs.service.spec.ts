import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { buildAbility } from '../../auth/permissions/ability.factory';
import {
  defaultAbility,
  FakePermissions,
} from '../../auth/permissions/permissions.fake';
import { PermissionsGuard } from '../../auth/permissions/permissions.guard';
import type { PermissionsService } from '../../auth/permissions/permissions.service';
import { PrismaService } from '../../shared/prisma.service';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import {
  CreateRepairDto,
  MechanicAssignmentDto,
} from './dto/create-repair.dto';
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

// Under the default matrix (spec 0011, AC-14)
const asAdmin = defaultAbility(admin);
const asMechanic = defaultAbility(mechanic);
const readsNothing = buildAbility('x', new Set());
const MINE = {
  OR: [{ assignments: { some: { mechanic: { is: { authUserId: 'm' } } } } }],
};

function ticket(status: RepairStatus, totalCost: number | null) {
  return {
    id: `id-${Math.random()}`,
    repairNumber: 'REP-1',
    repairStatus: status,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    closedAt: new Date('2026-10-02T00:00:00Z'),
    cancellationReason: null,
    isUnlocked: false,
    totalCost,
    vehicle: { plateNumber: 'ABC 123', model: 'Hilux' },
    driver: { name: 'Driver' },
    garage: { name: 'Sta. Rosa' },
  };
}

function setup() {
  const prisma = {
    repairTicket: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          ticket(RepairStatus.CLOSED, 4000),
          ticket(RepairStatus.CANCELLED, null),
        ]),
      groupBy: jest.fn().mockResolvedValue([
        {
          repairStatus: RepairStatus.CLOSED,
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
  it('summarises every matching row with the same where as the list, spend from closed rows only', async () => {
    const { prisma, service } = setup();
    const res = await service.findHistory(
      {
        garageId: '00000000-0000-4000-8000-000000000001',
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        page: 1,
        limit: 2,
      },
      asAdmin,
    );
    expect(res.summary).toEqual({
      finished: 35,
      closed: 30,
      cancelled: 5,
      spend: 120000,
    });
    expect(res.total).toBe(35);
    const listWhere = whereOf(prisma.repairTicket.findMany);
    expect(whereOf(prisma.repairTicket.groupBy)).toBe(listWhere);
    expect(listWhere.closedAt).toEqual({
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
    const { prisma, service } = setup();
    const res = await service.findHistory({}, asMechanic);
    expect(whereOf(prisma.repairTicket.findMany).AND).toEqual([MINE]);
    expect(res.summary.spend).toBeNull();
    expect(res.data.every((row) => row.totalCost === null)).toBe(true);
    expect(res.data[0]).toHaveProperty('isUnlocked');
  });

  it('answers empty with no query when the caller may read no ticket', async () => {
    const { prisma, service } = setup();
    const res = await service.findHistory({}, readsNothing);
    expect(res).toEqual({
      data: [],
      total: 0,
      summary: { finished: 0, closed: 0, cancelled: 0, spend: null },
    });
    expect(prisma.repairTicket.findMany).not.toHaveBeenCalled();
  });

  it('holds only finished tickets by default, never an open one like ON_HOLD (AC-4a)', async () => {
    const { prisma, service } = setup();
    await service.findHistory({}, asAdmin);
    expect(whereOf(prisma.repairTicket.findMany).repairStatus).toEqual({
      in: [RepairStatus.CLOSED, RepairStatus.CANCELLED],
    });
  });

  it('rejects a range where from is not before to', async () => {
    const { service } = setup();
    await expect(
      service.findHistory(
        { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
        asAdmin,
      ),
    ).rejects.toThrow('"from" must be before "to"');
  });
});

describe('audit routes', () => {
  const guard = new PermissionsGuard(
    new Reflector(),
    new FakePermissions() as unknown as PermissionsService,
  );
  const context = (handler: (...args: never[]) => unknown, user: JwtUser) =>
    ({
      getHandler: () => handler,
      getClass: () => RepairsController,
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          headers: {},
          method: 'GET',
          path: '/vrms/repairs/audit-logs',
        }),
      }),
    }) as unknown as ExecutionContext;

  it.each(['findAuditEvents', 'findAuditActors'] as const)(
    '%s needs audit.view, which only Admin holds by default (a mechanic gets 403)',
    async (name) => {
      const handler = RepairsController.prototype[name];
      await expect(guard.canActivate(context(handler, admin))).resolves.toBe(
        true,
      );
      await expect(
        guard.canActivate(context(handler, mechanic)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});

function openTicket(costs: {
  partsCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
}) {
  return {
    ...ticket(RepairStatus.ASSIGNED, costs.totalCost),
    ...costs,
    closedAt: null,
    priority: 'MEDIUM',
    odometer: 1000,
    dueAt: null,
    dueAtSource: null,
    reportedByName: 'Victor Ramos',
    verifiedByName: null,
    verifiedAt: null,
    lastActivityAt: new Date('2026-10-02T00:00:00Z'),
    remarks: null,
    isLumpSum: true,
    unlockReason: null,
    driver: { name: 'Driver', isVerified: true },
    issues: [],
    assignments: [],
    repairParts: [],
    auditLogs: [],
  };
}

function listSetup() {
  const prisma = {
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
    await service.findAll({ page: 2, limit: 20 }, asAdmin);
    const args = argsOf(prisma.repairTicket.findMany);
    expect(args.orderBy).toEqual([
      { dueAt: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(args).toMatchObject({ skip: 20, take: 20 });
    expect(whereOf(prisma.repairTicket.count)).toBe(args.where);
  });

  it('holds every open status by default (ON_HOLD included) and returns every row with no paging', async () => {
    const { prisma, service } = listSetup();
    await service.findAll({}, asAdmin);
    const args = argsOf(prisma.repairTicket.findMany);
    expect(args.where).toEqual({
      // ticket.view_all: every ticket
      AND: [{}],
      repairStatus: {
        in: [
          RepairStatus.OPEN,
          RepairStatus.ASSIGNED,
          RepairStatus.IN_PROGRESS,
          RepairStatus.ON_HOLD,
          RepairStatus.FOR_VERIFICATION,
          RepairStatus.OUTSOURCED,
          RepairStatus.PENDING_APPROVAL,
        ],
      },
    });
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('take');
  });

  it('defaults the missing half of page and limit', async () => {
    const { prisma, service } = listSetup();
    await service.findAll({ page: 3 }, asAdmin);
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
      asAdmin,
    );
    expect(whereOf(prisma.repairTicket.findMany)).toMatchObject({
      repairStatus: RepairStatus.IN_PROGRESS,
      garageId: GARAGE,
      assignments: { some: { mechanicId: MECHANIC } },
    });
  });

  it('keeps only open tickets past their due date for overdue, whatever the status', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { prisma, service } = listSetup();
    await service.findAll(
      { overdue: true, status: RepairStatus.CLOSED },
      asAdmin,
    );
    const where = whereOf(prisma.repairTicket.findMany);
    expect(where.repairStatus).toBe(RepairStatus.CLOSED);
    expect(where.AND).toEqual([
      {},
      {
        repairStatus: {
          in: [
            RepairStatus.OPEN,
            RepairStatus.ASSIGNED,
            RepairStatus.IN_PROGRESS,
            RepairStatus.ON_HOLD,
            RepairStatus.FOR_VERIFICATION,
            RepairStatus.OUTSOURCED,
            RepairStatus.PENDING_APPROVAL,
          ],
        },
      },
      { dueAt: { lt: NOW } },
    ]);
    jest.useRealTimers();
  });

  it("keeps a mechanic's own scope even with a mechanicId filter", async () => {
    const { prisma, service } = listSetup();
    await service.findAll({ mechanicId: MECHANIC }, asMechanic);
    const where = whereOf(prisma.repairTicket.findMany);
    expect(where.AND).toEqual([MINE]);
    expect(where.assignments).toEqual({ some: { mechanicId: MECHANIC } });
  });

  it('answers empty with no query when the caller may read no ticket', async () => {
    const { prisma, service } = listSetup();
    expect(await service.findAll({}, readsNothing)).toEqual({
      data: [],
      total: 0,
    });
    expect(prisma.repairTicket.findMany).not.toHaveBeenCalled();
  });

  it('sends a stored 0 cost as 0, not null', async () => {
    const { service } = listSetup();
    const res = await service.findAll({}, asAdmin);
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

  it('matches the Person filter on the welinc-auth id in actorUserId (spec 0009, AC-10)', async () => {
    const prisma = { auditLog: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RepairsService(prisma as unknown as PrismaService);
    await service.findAuditEvents({ actorId: GARAGE });
    const [args] = prisma.auditLog.findMany.mock.calls[0] as [
      { where: Prisma.AuditLogWhereInput },
    ];
    expect(args.where.AND).toEqual([{ actorUserId: GARAGE }]);
  });
});

describe('RepairsService.create mechanics (spec 0009 AC-27, spec 0010 AC-12)', () => {
  const MECH_ID = '00000000-0000-4000-8000-0000000000aa';
  const dto = (mechanics: object[]) =>
    ({
      vehiclePlate: 'ABC 123',
      garageLocation: 'Sta. Rosa',
      driverName: 'Driver One',
      issues: [],
      mechanics,
    }) as unknown as CreateRepairDto;

  function createSetup(activeCount: number) {
    const prisma = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'v1' }),
        update: jest.fn().mockRejectedValue(new Error('stop here')),
      },
      garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
      issueCategory: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeEntry: { findMany: jest.fn().mockResolvedValue([]) },
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'd1' }),
        update: jest.fn().mockResolvedValue({ id: 'd1' }),
        create: jest.fn(),
      },
      mechanic: { count: jest.fn().mockResolvedValue(activeCount) },
    };
    return {
      prisma,
      service: new RepairsService(prisma as unknown as PrismaService),
    };
  }

  it('answers 400 for an unknown or inactive id', async () => {
    const { service, prisma } = createSetup(0);

    const run = service.create(
      dto([{ id: MECH_ID }]),
      admin,
      defaultAbility(admin),
    );

    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow('In house mechanic not found');
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  // Follow up from the review: a rejected ticket leaves nothing behind
  it('writes no driver row when a mechanic is rejected', async () => {
    const { service, prisma } = createSetup(0);

    await service
      .create(dto([{ id: MECH_ID }]), admin, defaultAbility(admin))
      .catch(() => {});

    expect(prisma.driver.findUnique).not.toHaveBeenCalled();
    expect(prisma.driver.update).not.toHaveBeenCalled();
    expect(prisma.driver.create).not.toHaveBeenCalled();
  });

  it('looks mechanics up by id and active only, never by name', async () => {
    const { service, prisma } = createSetup(0);

    await service
      .create(dto([{ id: MECH_ID }]), admin, defaultAbility(admin))
      .catch(() => {});

    expect(prisma.mechanic.count).toHaveBeenCalledWith({
      where: { id: { in: [MECH_ID] }, isActive: true },
    });
  });

  it('goes on to the ticket when every id is an active row', async () => {
    const { service, prisma } = createSetup(1);

    await expect(
      service.create(dto([{ id: MECH_ID }]), admin, defaultAbility(admin)),
    ).rejects.toThrow('stop here');

    expect(prisma.vehicle.update).toHaveBeenCalled();
  });

  describe('the mechanic item in the request body', () => {
    // The same options as the global ValidationPipe in main.ts
    const check = (body: object) =>
      validate(plainToInstance(MechanicAssignmentDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it('needs a uuid id', async () => {
      expect(await check({})).not.toHaveLength(0);
      expect(await check({ id: 'not-a-uuid' })).not.toHaveLength(0);
      expect(await check({ id: MECH_ID })).toHaveLength(0);
    });

    it('rejects an outsourced mechanic (400)', async () => {
      expect(
        await check({
          isOutsourced: true,
          name: 'Shop Guy',
          shopName: 'Fix It',
        }),
      ).not.toHaveLength(0);
    });
  });
});

describe('RepairsService.findAuditActors (AC-10)', () => {
  function actorsSetup(
    rows: { userId: string; actorName: string | null; email: string | null }[],
  ) {
    const queryRaw = jest.fn().mockResolvedValue(rows);
    const prisma = { $queryRaw: queryRaw };
    return {
      queryRaw,
      service: new RepairsService(prisma as unknown as PrismaService),
    };
  }

  it('maps each row to an id, a name and an email', async () => {
    const { service } = actorsSetup([
      { userId: 'u1', actorName: 'Ana', email: 'ana@welinc.com' },
    ]);

    expect(await service.findAuditActors()).toEqual([
      { id: 'u1', name: 'Ana', email: 'ana@welinc.com' },
    ]);
  });

  it('falls back to the email when the name is null, and to an empty name when both are', async () => {
    const { service } = actorsSetup([
      { userId: 'u1', actorName: null, email: 'ana@welinc.com' },
      { userId: 'u2', actorName: null, email: null },
    ]);

    const actors = await service.findAuditActors();

    expect(actors.find((a) => a.id === 'u1')?.name).toBe('ana@welinc.com');
    expect(actors.find((a) => a.id === 'u2')?.name).toBe('');
  });

  it('sorts the list by name', async () => {
    const { service } = actorsSetup([
      { userId: 'u1', actorName: 'Zed', email: null },
      { userId: 'u2', actorName: 'Ana', email: null },
      { userId: 'u3', actorName: 'Mia', email: null },
    ]);

    const actors = await service.findAuditActors();

    expect(actors.map((a) => a.name)).toEqual(['Ana', 'Mia', 'Zed']);
  });

  it('asks for one newest row per user and leaves out null user ids', async () => {
    const { service, queryRaw } = actorsSetup([]);

    await service.findAuditActors();

    const [strings] = queryRaw.mock.calls[0] as [string[]];
    const sql = strings.join(' ').replace(/\s+/g, ' ');
    expect(sql).toContain('DISTINCT ON (actor_user_id)');
    expect(sql).toContain('WHERE actor_user_id IS NOT NULL');
    expect(sql).toContain('ORDER BY actor_user_id, created_at DESC, id DESC');
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
