import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, RepairStatus, UserRole } from '@prisma/client';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../shared/prisma.service';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';

type JwtUser = {
  sub: string;
  email: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

const admin: JwtUser = {
  sub: 'a',
  email: 'vrms.admin@welinc.com',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};
const mechanic: JwtUser = {
  sub: 'm',
  email: 'mech.juan@welinc.com',
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
    mechanic: { findFirst: jest.fn().mockResolvedValue(mechanicRecord) },
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
