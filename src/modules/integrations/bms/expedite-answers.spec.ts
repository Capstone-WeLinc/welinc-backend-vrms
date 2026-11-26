import type { Prisma } from '@prisma/client';
import {
  declineWaitingExpedites,
  queueExpediteAnswer,
} from './expedite-answers';

// covers: spec 0029 AC-19 and AC-25 (the expedite answer and the auto decline, child 0003)

const AT = new Date('2026-11-28T02:00:00.000Z');

function tx(waiting: { id: string; jobOrderNumber: string }[]) {
  const deliveries: { data: Record<string, unknown> }[] = [];
  const audits: { data: Record<string, unknown> }[] = [];
  const fake = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('clock_timestamp') ? [{ at: AT }] : waiting,
      ),
    ),
    repairTicket: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 't1', repairNumber: 'REP-20261128-0003' }),
    },
    expediteRequest: { update: jest.fn().mockResolvedValue({}) },
    auditLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        audits.push(args);
        return Promise.resolve({});
      }),
    },
    delivery: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        deliveries.push(args);
        return Promise.resolve({});
      }),
    },
  };
  return {
    fake,
    client: fake as unknown as Prisma.TransactionClient,
    deliveries,
    audits,
  };
}

describe('queueExpediteAnswer', () => {
  it('queues the answer to BMS on the ticket’s line, linked to its request', async () => {
    const { client, deliveries } = tx([]);
    await queueExpediteAnswer(client, {
      requestId: 'x1',
      repairTicketId: 't1',
      repairTicketNumber: 'REP-20261128-0003',
      decision: 'ACCEPTED',
      reason: null,
      priority: 'HIGH',
      expectedReturnAt: new Date('2026-12-01T09:00:00.000Z'),
    });
    const row = deliveries[0].data;
    expect(row).toMatchObject({
      target: 'BMS',
      kind: 'EXPEDITE_ANSWER',
      repairTicketId: 't1',
      expediteRequestId: 'x1',
    });
    expect(row.payload).toEqual({
      eventId: row.id,
      requestId: 'x1',
      repairTicketNumber: 'REP-20261128-0003',
      decision: 'ACCEPTED',
      reason: null,
      priority: 'HIGH',
      expectedReturnAt: '2026-12-01T09:00:00.000Z',
      occurredAt: AT.toISOString(),
    });
  });
});

describe('declineWaitingExpedites', () => {
  it('declines each waiting request as VRMS, audited 1 ms apart, and answers each', async () => {
    const { fake, client, deliveries, audits } = tx([
      { id: 'x1', jobOrderNumber: 'JO-2026-0142' },
      { id: 'x2', jobOrderNumber: 'JO-2026-0157' },
    ]);
    await expect(
      declineWaitingExpedites(client, 't1', 'CLOSED', AT),
    ).resolves.toBe(2);
    expect(fake.expediteRequest.update).toHaveBeenCalledWith({
      where: { id: 'x1' },
      data: {
        status: 'DECLINED',
        responseReason: 'Repair finished',
        decidedAt: AT,
      },
    });
    expect(audits.map((a) => a.data)).toEqual([
      expect.objectContaining({
        action: 'EXPEDITE_DECLINED',
        actorRole: 'SYSTEM',
        actorName: 'VRMS',
        note: 'Repair finished',
        createdAt: new Date(AT.getTime() + 1),
      }),
      expect.objectContaining({
        action: 'EXPEDITE_DECLINED',
        createdAt: new Date(AT.getTime() + 2),
      }),
    ]);
    expect(
      deliveries.map((d) => (d.data.payload as { decision: string }).decision),
    ).toEqual(['DECLINED', 'DECLINED']);
  });

  it('says Repair cancelled on a cancel, and does nothing when none wait', async () => {
    const one = tx([{ id: 'x1', jobOrderNumber: 'JO-1' }]);
    await declineWaitingExpedites(one.client, 't1', 'CANCELLED', AT);
    expect((one.deliveries[0].data.payload as { reason: string }).reason).toBe(
      'Repair cancelled',
    );

    const none = tx([]);
    await expect(
      declineWaitingExpedites(none.client, 't1', 'CLOSED', AT),
    ).resolves.toBe(0);
    expect(none.fake.repairTicket.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
