import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma.service';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  issueLine,
  VmmsRepairReadsService,
} from './vmms-repair-reads.service';

// Spec 0029 (child 0002), AC-14 and AC-15.

function ticket(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    repairNumber: `REP-20261101-${String(i).padStart(4, '0')}`,
    repairStatus: 'CLOSED',
    createdAt: new Date(Date.UTC(2026, 10, 1) - i * 60_000),
    closedAt: new Date('2026-11-05T00:00:00.000Z'),
    outsideShopName: null,
    totalCost: new Prisma.Decimal('12850.5'),
    issues: [
      {
        description: '[Brakes] Wear and tear: Pads worn',
        category: { name: 'Brakes' },
      },
    ],
    repairParts: [{ description: 'Brake pad set', quantity: 2 }],
    assignments: [
      { mechanic: { name: 'Ana Cruz' } },
      { mechanic: { name: 'Ana Cruz' } },
      { mechanic: { name: 'Leo Santos' } },
    ],
    ...over,
  };
}

function setup() {
  const prisma = {
    repairTicket: { findUnique: jest.fn(), findMany: jest.fn() },
  };
  return {
    service: new VmmsRepairReadsService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('VmmsRepairReadsService.status (AC-14)', () => {
  it('maps Pending approval to OUTSOURCED with the shop, and hides the shop elsewhere', async () => {
    const { service, prisma } = setup();
    prisma.repairTicket.findUnique.mockResolvedValueOnce({
      id: 't1',
      repairNumber: 'REP-1',
      repairStatus: 'PENDING_APPROVAL',
      outsideShopName: 'Bulacan Diesel Works',
    });
    await expect(service.status('t1')).resolves.toEqual({
      repairTicketId: 't1',
      repairTicketNumber: 'REP-1',
      status: 'OUTSOURCED',
      outsideShopName: 'Bulacan Diesel Works',
    });
    prisma.repairTicket.findUnique.mockResolvedValueOnce({
      id: 't1',
      repairNumber: 'REP-1',
      repairStatus: 'CLOSED',
      outsideShopName: 'Bulacan Diesel Works',
    });
    await expect(service.status('t1')).resolves.toMatchObject({
      status: 'CLOSED',
      outsideShopName: null,
    });
  });

  it('answers 404 REPAIR_NOT_FOUND for an unknown id', async () => {
    const { service, prisma } = setup();
    prisma.repairTicket.findUnique.mockResolvedValue(null);
    await expect(service.status('t9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('VmmsRepairReadsService.history (AC-15)', () => {
  it('answers text issues, parts with quantities and no prices, distinct mechanics and the total', async () => {
    const { service, prisma } = setup();
    prisma.repairTicket.findMany.mockResolvedValue([ticket(1)]);
    const page = await service.history('vv-1');
    expect(page).toEqual({
      items: [
        {
          repairTicketId: ticket(1).id,
          repairTicketNumber: 'REP-20261101-0001',
          openedAt: ticket(1).createdAt.toISOString(),
          closedAt: '2026-11-05T00:00:00.000Z',
          status: 'CLOSED',
          issues: ['Brakes: Wear and tear: Pads worn'],
          partsUsed: ['Brake pad set x2'],
          repairPersonnel: ['Ana Cruz', 'Leo Santos'],
          provider: null,
          totalRepairCost: '12850.5',
        },
      ],
      nextCursor: null,
    });
    const [[query]] = prisma.repairTicket.findMany.mock.calls as [
      [Prisma.RepairTicketFindManyArgs],
    ];
    expect(query.where).toMatchObject({
      vehicle: { vmmsVehicleId: 'vv-1' },
      repairStatus: { not: 'CANCELLED' },
    });
    // Never a part price
    expect(JSON.stringify(query.select)).not.toMatch(/unitCost|subtotal/);
  });

  it('pages by limit with an opaque cursor that continues after the last row', async () => {
    const { service, prisma } = setup();
    prisma.repairTicket.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ticket(i + 1)),
    );
    const page = await service.history('vv-1', 50);
    expect(page.items).toHaveLength(50);
    const at = decodeHistoryCursor(page.nextCursor!);
    expect(at).toEqual({ createdAt: ticket(50).createdAt, id: ticket(50).id });
    prisma.repairTicket.findMany.mockClear().mockResolvedValue([]);
    await expect(
      service.history('vv-1', 50, page.nextCursor!),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const [[next]] = prisma.repairTicket.findMany.mock.calls as [
      [Prisma.RepairTicketFindManyArgs],
    ];
    expect(next.where?.OR).toEqual([
      { createdAt: { lt: at.createdAt } },
      { createdAt: at.createdAt, id: { lt: at.id } },
    ]);
  });

  it('refuses a cursor it did not make', () => {
    expect(() => decodeHistoryCursor('bad')).toThrow(BadRequestException);
    const good = encodeHistoryCursor({
      createdAt: new Date(0),
      id: ticket(1).id,
    });
    expect(decodeHistoryCursor(good).id).toBe(ticket(1).id);
  });

  it('names the category in front of the issue text, or the text alone', () => {
    expect(issueLine('[Engine] Overheating: Fan clutch', 'Engine')).toBe(
      'Engine: Overheating: Fan clutch',
    );
    expect(issueLine('Loose mirror', null)).toBe('Loose mirror');
  });
});
