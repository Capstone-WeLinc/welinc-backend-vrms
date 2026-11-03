import { RepairStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { MechanicRoster } from './mechanic-roster.service';
import { MechanicWorkService } from './mechanic-work.service';
import { ConfigService } from './config/config.service';
import { isOccupied, openStatusRank, workloadOf } from './mechanic-workload';
import { OPEN_STATUSES } from './ticket-statuses';

// Feature 57: the Occupied rule, the workload counts and the two Users page reads.

const S = RepairStatus;

describe('workloadOf', () => {
  it('counts every open status, zeros included', () => {
    const w = workloadOf([S.ASSIGNED, S.ASSIGNED, S.IN_PROGRESS]);
    expect(w.total).toBe(3);
    expect(Object.keys(w.byStatus)).toEqual(OPEN_STATUSES);
    expect(w.byStatus.ASSIGNED).toBe(2);
    expect(w.byStatus.IN_PROGRESS).toBe(1);
    expect(w.byStatus.ON_HOLD).toBe(0);
    expect(w.occupied).toBe(true);
  });

  it('is free with no In Progress ticket, even with other open work', () => {
    expect(workloadOf([S.ASSIGNED, S.FOR_VERIFICATION]).occupied).toBe(false);
    expect(workloadOf([])).toMatchObject({ total: 0, occupied: false });
  });

  it('ignores finished statuses', () => {
    expect(workloadOf([S.CLOSED, S.CANCELLED]).total).toBe(0);
  });

  it('isOccupied matches only In Progress', () => {
    expect(isOccupied([S.ON_HOLD])).toBe(false);
    expect(isOccupied([S.ON_HOLD, S.IN_PROGRESS])).toBe(true);
  });

  it('ranks open statuses in workflow order and finished ones last', () => {
    expect(openStatusRank(S.ASSIGNED)).toBeLessThan(
      openStatusRank(S.FOR_VERIFICATION),
    );
    expect(openStatusRank(S.CLOSED)).toBe(OPEN_STATUSES.length);
  });
});

describe('MechanicWorkService workload and openTickets', () => {
  function service(prisma: unknown) {
    return new MechanicWorkService(
      prisma as PrismaService,
      {} as MechanicRoster,
    );
  }

  it('returns one row per mechanic, keyed by auth user id', async () => {
    const prisma = {
      mechanic: {
        findMany: jest.fn().mockResolvedValue([
          {
            authUserId: 'u1',
            assignments: [{ repairTicket: { repairStatus: S.IN_PROGRESS } }],
          },
          { authUserId: 'u2', assignments: [] },
        ]),
      },
    };
    const rows = await service(prisma).workload();
    expect(rows).toEqual([
      expect.objectContaining({ authUserId: 'u1', total: 1, occupied: true }),
      expect.objectContaining({ authUserId: 'u2', total: 0, occupied: false }),
    ]);
  });

  it('answers an empty list for a person with no mechanic row', async () => {
    const prisma = {
      mechanic: { findUnique: jest.fn().mockResolvedValue(null) },
      repairTicket: { findMany: jest.fn() },
    };
    await expect(service(prisma).openTickets('u9')).resolves.toEqual({
      mechanicId: null,
      tickets: [],
    });
    expect(prisma.repairTicket.findMany).not.toHaveBeenCalled();
  });

  it('lists open tickets in workflow order with every mechanic on each', async () => {
    const updatedAt = new Date('2026-11-03T02:00:00.000Z');
    const ticket = (id: string, repairStatus: RepairStatus) => ({
      id,
      repairNumber: `REP-${id}`,
      repairStatus,
      updatedAt,
      vehicle: { plateNumber: 'ABC 1234' },
      assignments: [
        { mechanic: { id: 'm1', name: 'Ana' } },
        { mechanic: { id: 'm2', name: 'Ben' } },
      ],
    });
    const prisma = {
      mechanic: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
      repairTicket: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            ticket('t1', S.FOR_VERIFICATION),
            ticket('t2', S.IN_PROGRESS),
          ]),
      },
    };
    const result = await service(prisma).openTickets('u1');
    expect(result.mechanicId).toBe('m1');
    expect(result.tickets.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(result.tickets[0]).toEqual({
      id: 't2',
      repairNumber: 'REP-t2',
      repairStatus: S.IN_PROGRESS,
      updatedAt: updatedAt.toISOString(),
      plateNumber: 'ABC 1234',
      mechanics: [
        { id: 'm1', name: 'Ana' },
        { id: 'm2', name: 'Ben' },
      ],
    });
    expect(prisma.repairTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repairStatus: { in: OPEN_STATUSES },
          assignments: { some: { mechanicId: 'm1' } },
        },
      }),
    );
  });
});

describe('MechanicWorkService.workload scope', () => {
  const service = (prisma: unknown) =>
    new MechanicWorkService(prisma as PrismaService, {} as MechanicRoster);

  it('reads every mechanic row, so a person who left still shows what they hold', async () => {
    const findMany = jest
      .fn<Promise<unknown[]>, [Record<string, unknown>]>()
      .mockResolvedValue([]);
    await service({ mechanic: { findMany } }).workload();
    const [args] = findMany.mock.calls[0];
    expect(args).not.toHaveProperty('where');
  });

  it('counts only tickets in an open status', async () => {
    const findMany = jest
      .fn<Promise<unknown[]>, [Record<string, unknown>]>()
      .mockResolvedValue([]);
    await service({ mechanic: { findMany } }).workload();
    const [args] = findMany.mock.calls[0] as [
      {
        select: {
          assignments: { where: { repairTicket: { repairStatus: unknown } } };
        };
      },
    ];
    expect(args.select.assignments.where.repairTicket.repairStatus).toEqual({
      in: OPEN_STATUSES,
    });
  });

  it('is Free with open work that is only on hold or waiting for verification', async () => {
    const prisma = {
      mechanic: {
        findMany: jest.fn().mockResolvedValue([
          {
            authUserId: 'u1',
            assignments: [
              { repairTicket: { repairStatus: S.ON_HOLD } },
              { repairTicket: { repairStatus: S.FOR_VERIFICATION } },
            ],
          },
        ]),
      },
    };
    const [row] = await service(prisma).workload();
    expect(row).toMatchObject({ total: 2, occupied: false });
    expect(row.byStatus.ON_HOLD).toBe(1);
    expect(row.byStatus.FOR_VERIFICATION).toBe(1);
  });
});

describe('MechanicWorkService.openTickets order', () => {
  it('keeps tickets of the same status in the order the query returned them', async () => {
    const t = (id: string, repairStatus: RepairStatus) => ({
      id,
      repairNumber: `REP-${id}`,
      repairStatus,
      updatedAt: new Date('2026-11-03T02:00:00.000Z'),
      vehicle: { plateNumber: 'ABC 1234' },
      assignments: [{ mechanic: { id: 'm1', name: 'Ana' } }],
    });
    const prisma = {
      mechanic: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
      repairTicket: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            t('first', S.ASSIGNED),
            t('second', S.ASSIGNED),
            t('mid', S.IN_PROGRESS),
          ]),
      },
    };
    const service = new MechanicWorkService(
      prisma as unknown as PrismaService,
      {} as MechanicRoster,
    );
    const { tickets } = await service.openTickets('u1');
    // Workflow order puts Assigned before In progress; the query's order holds within a status
    expect(tickets.map((x) => x.id)).toEqual(['first', 'second', 'mid']);
    expect(prisma.repairTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { statusChangedAt: 'asc' } }),
    );
  });
});

describe('the picker and the Users page share one Occupied rule', () => {
  it('flags busy only for In Progress, never for on hold or waiting for verification', async () => {
    const prisma = {
      mechanic: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            name: 'Ana',
            authUserId: 'u1',
            email: 'a@x.com',
            assignments: [
              { repairTicket: { repairStatus: S.ON_HOLD } },
              { repairTicket: { repairStatus: S.FOR_VERIFICATION } },
            ],
          },
        ]),
      },
    };
    const rows = await new ConfigService(
      prisma as unknown as PrismaService,
    ).listAvailableMechanics();
    expect(rows[0]).toMatchObject({ openCount: 2, busy: false });
    expect(isOccupied([S.ON_HOLD, S.FOR_VERIFICATION])).toBe(false);
  });
});
