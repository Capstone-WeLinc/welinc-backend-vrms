import type { Prisma } from '@prisma/client';
import {
  CHANGE_REASON,
  NOT_DIAGNOSED,
  queueBmsRepairUpdate,
  repairReason,
} from './bms-repair-updates';

// covers: spec 0029 AC-17 and AC-20 (the repair update to BMS, child 0003)

const AT = new Date('2026-11-28T02:00:00.000Z');
const TRUCK = '0b5e1f2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b';

function tx(ticket: Record<string, unknown>) {
  const created: { data: Record<string, unknown> }[] = [];
  const fake = {
    repairTicket: { findUniqueOrThrow: jest.fn().mockResolvedValue(ticket) },
    $queryRaw: jest.fn().mockResolvedValue([{ at: AT }]),
    delivery: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args);
        return Promise.resolve({});
      }),
    },
  };
  return { client: fake as unknown as Prisma.TransactionClient, created };
}

const cat = (name: string, sortOrder: number) => ({
  category: { name, sortOrder },
});

const base = {
  repairNumber: 'REP-20261128-0003',
  repairStatus: 'ON_HOLD',
  dueAt: new Date('2026-12-01T09:00:00.000Z'),
  vehicle: { vmmsVehicleId: TRUCK, plateNumber: 'CAK 9043' },
  issues: [cat('Electrical', 3), cat('Brakes', 1), cat('Electrical', 3)],
};

describe('repairReason', () => {
  it('lists each category once, in the categories’ order', () => {
    expect(
      repairReason([
        cat('Electrical', 3),
        cat('Brakes', 1),
        cat('Electrical', 3),
      ]),
    ).toBe('Brakes, Electrical');
  });

  it('says not yet diagnosed when no issue has a category', () => {
    expect(repairReason([])).toBe(NOT_DIAGNOSED);
    expect(repairReason([{ category: null }])).toBe(NOT_DIAGNOSED);
  });
});

describe('queueBmsRepairUpdate', () => {
  it('queues the ticket’s state for BMS, with no version and nothing beyond the agreed fields', async () => {
    const { client, created } = tx(base);
    await queueBmsRepairUpdate(client, 't1', CHANGE_REASON.status('On hold'));
    const row = created[0].data;
    expect(row).toMatchObject({
      target: 'BMS',
      kind: 'REPAIR_UPDATE',
      repairTicketId: 't1',
    });
    // AC-20's privacy rule holds for the update too: no cost, note or person field
    expect(row.payload).toEqual({
      eventId: row.id,
      vmmsVehicleId: TRUCK,
      vehiclePlate: 'CAK 9043',
      repairTicketId: 't1',
      repairTicketNumber: 'REP-20261128-0003',
      repairStatus: 'ON_HOLD',
      repairStatusLabel: 'On hold',
      reason: 'Brakes, Electrical',
      expectedReturnAt: '2026-12-01T09:00:00.000Z',
      changeReason: 'Status changed to On hold',
      occurredAt: AT.toISOString(),
    });
  });

  it.each(['CLOSED', 'CANCELLED'])(
    'sends no expected return date once the ticket is %s',
    async (repairStatus) => {
      const { client, created } = tx({ ...base, repairStatus });
      await queueBmsRepairUpdate(client, 't1', CHANGE_REASON.finished);
      expect(
        (created[0].data.payload as Record<string, unknown>).expectedReturnAt,
      ).toBeNull();
    },
  );

  it('skips a truck not linked to VMMS, which BMS can’t know', async () => {
    const { client, created } = tx({
      ...base,
      vehicle: { vmmsVehicleId: null, plateNumber: 'OLD 1' },
    });
    await expect(queueBmsRepairUpdate(client, 't1', 'x')).resolves.toEqual({
      skipped: 'NOT_LINKED',
    });
    expect(created).toHaveLength(0);
  });
});
