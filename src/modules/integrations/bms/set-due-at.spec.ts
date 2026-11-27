import type { Prisma } from '@prisma/client';
import { queueBmsRepairUpdate } from './bms-repair-updates';
import { setDueAt } from './set-due-at';

jest.mock('./bms-repair-updates', () => ({
  queueBmsRepairUpdate: jest.fn(() => Promise.resolve({ deliveryId: 'b-1' })),
}));

// covers: spec 0029 AC-17 and AC-19 (the one due date writer, child 0003)

const AT = new Date('2026-11-28T02:00:00.000Z');
const admin = {
  sub: 'u-1',
  email: 'vrms.admin@welinc.com',
  name: 'Ana Reyes',
  roles: [{ system: 'VRMS', role: 'ADMIN' }],
} as never;

function tx() {
  return {
    repairTicket: { update: jest.fn().mockResolvedValue({}) },
    auditLog: {
      create: jest
        .fn<Promise<object>, [{ data: Record<string, unknown> }]>()
        .mockResolvedValue({}),
    },
  };
}

describe('setDueAt', () => {
  beforeEach(() => jest.mocked(queueBmsRepairUpdate).mockClear());

  it('writes the date and its source, one TICKET_EDITED row with the reason, and tells BMS', async () => {
    const fake = tx();
    const due = new Date('2026-12-01T09:00:00.000Z');
    const changed = await setDueAt(
      fake as unknown as Prisma.TransactionClient,
      { id: 't1', dueAt: null },
      { dueAt: due, source: 'MANUAL', reason: 'Expedite JO-2026-0142' },
      admin,
      AT,
    );
    expect(changed).toBe(true);
    expect(fake.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { dueAt: due, dueAtSource: 'MANUAL' },
    });
    const row = fake.auditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      repairTicketId: 't1',
      action: 'TICKET_EDITED',
      changes: [{ field: 'dueAt', before: null, after: due.toISOString() }],
      note: 'Expedite JO-2026-0142',
      createdAt: AT,
    });
    expect(queueBmsRepairUpdate).toHaveBeenCalledWith(
      fake,
      't1',
      'Expedite JO-2026-0142',
    );
  });

  it('writes nothing for the same date', async () => {
    const fake = tx();
    const due = new Date('2026-12-01T09:00:00.000Z');
    await expect(
      setDueAt(
        fake as unknown as Prisma.TransactionClient,
        { id: 't1', dueAt: new Date(due) },
        { dueAt: due, source: 'MANUAL', reason: 'x' },
        admin,
        AT,
      ),
    ).resolves.toBe(false);
    expect(fake.repairTicket.update).not.toHaveBeenCalled();
    expect(fake.auditLog.create).not.toHaveBeenCalled();
    expect(queueBmsRepairUpdate).not.toHaveBeenCalled();
  });

  // covers: spec 0030 AC-5 (a tie between priority and issues moves only the source label)
  it('keeps the same date but fixes a changed source, with no audit row and no BMS update', async () => {
    const fake = tx();
    const due = new Date('2026-12-01T09:00:00.000Z');
    await expect(
      setDueAt(
        fake as unknown as Prisma.TransactionClient,
        { id: 't1', dueAt: new Date(due), dueAtSource: 'ISSUE_TYPE' },
        { dueAt: due, source: 'PRIORITY', reason: 'x' },
        admin,
        AT,
      ),
    ).resolves.toBe(false);
    expect(fake.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { dueAtSource: 'PRIORITY' },
    });
    expect(fake.auditLog.create).not.toHaveBeenCalled();
    expect(queueBmsRepairUpdate).not.toHaveBeenCalled();
  });

  it('leaves the source alone when the date and the source both match', async () => {
    const fake = tx();
    const due = new Date('2026-12-01T09:00:00.000Z');
    await setDueAt(
      fake as unknown as Prisma.TransactionClient,
      { id: 't1', dueAt: new Date(due), dueAtSource: 'PRIORITY' },
      { dueAt: due, source: 'PRIORITY', reason: 'x' },
      admin,
      AT,
    );
    expect(fake.repairTicket.update).not.toHaveBeenCalled();
  });

  // covers: spec 0030 AC-10 (create and referral queue their own update, so none twice)
  it('writes the date and the audit row but skips the BMS update when asked', async () => {
    const fake = tx();
    const changed = await setDueAt(
      fake as unknown as Prisma.TransactionClient,
      { id: 't1', dueAt: null },
      {
        dueAt: new Date('2026-12-01T09:00:00.000Z'),
        source: 'PRIORITY',
        reason: 'Due date from Low priority (168 h)',
      },
      admin,
      AT,
      { skipBmsUpdate: true },
    );
    expect(changed).toBe(true);
    expect(fake.auditLog.create).toHaveBeenCalledTimes(1);
    expect(queueBmsRepairUpdate).not.toHaveBeenCalled();
  });

  it('clears the source with the date', async () => {
    const fake = tx();
    await setDueAt(
      fake as unknown as Prisma.TransactionClient,
      { id: 't1', dueAt: new Date('2026-12-01T09:00:00.000Z') },
      { dueAt: null, source: 'MANUAL', reason: 'x' },
      admin,
      AT,
    );
    expect(fake.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { dueAt: null, dueAtSource: null },
    });
  });
});
