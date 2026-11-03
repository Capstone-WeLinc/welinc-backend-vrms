import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { decodeCursor, encodeCursor } from '../audit-events';
import { VehiclesService } from './vehicles.service';

// Spec 0020, AC-9: GET /vrms/vehicles/:id/changes.

const VEHICLE = '00000000-0000-4000-8000-0000000000a1';

function change(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    field: n % 2 ? 'status' : 'vehicleType',
    before: 'AVAILABLE',
    after: 'DISABLED',
    note: null,
    actorName: 'Victor Ramos',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, 60 - n)),
    repairTicket: n === 1 ? { id: 't1', repairNumber: 'R-0123' } : null,
  };
}

function setup(
  rows: ReturnType<typeof change>[],
  vehicle: unknown = { id: VEHICLE },
) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    vehicle: { findFirst: jest.fn().mockResolvedValue(vehicle) },
    vehicleChange: { findMany },
  };
  return {
    findMany,
    service: new VehiclesService(prisma as unknown as PrismaService),
  };
}

type FindArgs = {
  where: { AND: unknown[] };
  take: number;
  orderBy: unknown;
};

describe('VehiclesService.changes', () => {
  it('returns 20 newest first with the ticket, and a cursor when an extra row exists', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => change(i + 1));
    const { service, findMany } = setup(rows);
    const out = await service.changes(VEHICLE, {});
    const [args] = findMany.mock.calls[0] as [FindArgs];
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.where.AND).toEqual([{ vehicleId: VEHICLE }]);
    expect(out.items).toHaveLength(20);
    expect(out.items[0]).toEqual({
      id: rows[0].id,
      field: 'status',
      before: 'AVAILABLE',
      after: 'DISABLED',
      note: null,
      actorName: 'Victor Ramos',
      createdAt: rows[0].createdAt,
      ticket: { id: 't1', repairNumber: 'R-0123' },
    });
    expect(out.items[1].ticket).toBeNull();
    expect(decodeCursor(out.nextCursor!)).toEqual({
      createdAt: rows[19].createdAt,
      id: rows[19].id,
    });
  });

  it('returns no cursor on the last page', async () => {
    const { service } = setup([change(1), change(2)]);
    const out = await service.changes(VEHICLE, { limit: 5 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
  });

  it('reads only rows older than the cursor', async () => {
    const { service, findMany } = setup([]);
    const at = {
      createdAt: new Date('2026-11-01T00:00:10.000Z'),
      id: change(3).id,
    };
    await service.changes(VEHICLE, { cursor: encodeCursor(at), limit: 50 });
    const [args] = findMany.mock.calls[0] as [FindArgs];
    expect(args.take).toBe(51);
    expect(args.where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: at.createdAt } },
        { createdAt: at.createdAt, id: { lt: at.id } },
      ],
    });
  });

  it('answers 400 for a bad cursor and 404 for an unknown or inactive truck', async () => {
    await expect(
      setup([]).service.changes(VEHICLE, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup([], null).service.changes(VEHICLE, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
