import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRole } from '../../../auth/roles';
import type { PrismaService } from '../../../shared/prisma.service';
import { queueBmsRepairUpdate } from '../bms/bms-repair-updates';
import { DeliveriesService } from './deliveries.service';

jest.mock('../bms/bms-repair-updates', () => ({
  ...jest.requireActual<object>('../bms/bms-repair-updates'),
  queueBmsRepairUpdate: jest.fn(() => Promise.resolve({ deliveryId: 'b-2' })),
}));

// Spec 0029 (child 0004), AC-22: the Deliveries tab's reads, Retry and Dismiss.

const admin = {
  sub: '00000000-0000-4000-8000-000000000010',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};

const row = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-00000000d001',
  createdAt: new Date('2026-11-27T02:00:00.000Z'),
  target: 'VMMS',
  kind: 'REPAIR_EVENT',
  status: 'FAILED',
  attempts: 4,
  lastStatusCode: 409,
  lastError: 'INVALID_REPAIR_EVENT',
  repairTicket: { id: 't1', repairNumber: 'REP-20261120-0007' },
  referral: null,
  ...over,
});

function setup(
  opts: { count?: number; found?: Record<string, unknown> | null } = {},
) {
  const tx = {
    delivery: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.found === undefined
            ? { kind: 'REPAIR_EVENT', target: 'VMMS', repairTicketId: 't1' }
            : opts.found,
        ),
      updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    delivery: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        ...row(),
        payload: { eventId: 'x' },
        firstAttemptAt: null,
        lastAttemptAt: null,
        nextAttemptAt: new Date('2026-11-27T03:00:00.000Z'),
        sentAt: null,
        manualRetryCount: 1,
        dismissReason: null,
      }),
      count: jest.fn().mockResolvedValue(2),
    },
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
  };
  return {
    service: new DeliveriesService(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

describe('DeliveriesService.retry and dismiss (AC-22)', () => {
  it('retry restarts the window of a FAILED row and writes DELIVERY_RETRIED on its ticket', async () => {
    const { service, tx } = setup();
    await service.retry('d1', admin);
    expect(tx.delivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'FAILED' },
      data: expect.objectContaining({
        status: 'PENDING',
        attempts: 0,
        firstAttemptAt: null,
        manualRetryCount: { increment: 1 },
      }) as Record<string, unknown>,
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: 't1',
        action: 'DELIVERY_RETRIED',
        actorUserId: admin.sub,
        changes: [
          { field: 'delivery', before: null, after: 'VMMS REPAIR_EVENT' },
        ],
      }) as Record<string, unknown>,
    });
  });

  it('dismiss keeps the reason, and a row with no ticket audits with none', async () => {
    const { service, tx } = setup({
      found: {
        kind: 'REFERRAL_REJECTED',
        target: 'VMMS',
        repairTicketId: null,
      },
    });
    await service.dismiss('d1', 'VMMS removed this referral', admin);
    expect(tx.delivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'FAILED' },
      data: {
        status: 'DISMISSED',
        dismissReason: 'VMMS removed this referral',
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: null,
        action: 'DELIVERY_DISMISSED',
        note: 'VMMS removed this referral',
      }) as Record<string, unknown>,
    });
  });

  it('dismissing a BMS repair update queues a fresh one with the ticket’s state (child 0003)', async () => {
    const queued = jest.mocked(queueBmsRepairUpdate);
    queued.mockClear();
    const bms = setup({
      found: { kind: 'REPAIR_UPDATE', target: 'BMS', repairTicketId: 't1' },
    });
    await bms.service.dismiss('d1', 'BMS was rebuilding its receiver', admin);
    expect(queued).toHaveBeenCalledWith(
      bms.tx,
      't1',
      'Resent after a failed delivery',
    );
    // Any other kind is just dismissed
    queued.mockClear();
    await setup().service.dismiss('d1', 'Refused by VMMS', admin);
    expect(queued).not.toHaveBeenCalled();
  });

  it('answers NOT_FAILED for a row that is not failed, and 404 for none', async () => {
    const pending = setup({ count: 0 });
    await expect(pending.service.retry('d1', admin)).rejects.toMatchObject({
      response: { code: 'NOT_FAILED' },
    });
    expect(pending.tx.auditLog.create).not.toHaveBeenCalled();
    await expect(
      setup({ found: null }).service.dismiss('d1', 'Gone now', admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DeliveriesService.list (AC-22)', () => {
  it('lists failed rows first, then the rest, with the failed count and the warning after 3 attempts', async () => {
    const { service, prisma } = setup();
    prisma.delivery.findMany
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([
        row({
          id: '00000000-0000-4000-8000-00000000d002',
          status: 'PENDING',
          attempts: 3,
          lastStatusCode: 403,
        }),
        row({
          id: '00000000-0000-4000-8000-00000000d003',
          status: 'SENT',
          attempts: 1,
        }),
      ]);
    const page = await service.list({ limit: 2 });
    expect(page.items.map((i) => [i.status, i.warning])).toEqual([
      ['FAILED', false],
      ['PENDING', true],
    ]);
    expect(page.failedCount).toBe(2);
    expect(page.nextCursor).toMatch(/^O\./);

    // The next page starts in the second part, after the cursor's row, and skips the failed part
    prisma.delivery.findMany.mockReset().mockResolvedValueOnce([]);
    await service.list({ limit: 2, cursor: page.nextCursor! });
    expect(prisma.delivery.findMany).toHaveBeenCalledTimes(1);
    const [[{ where }]] = prisma.delivery.findMany.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(where.AND).toContainEqual({ status: { not: 'FAILED' } });
  });

  it('refuses a cursor it did not make', async () => {
    await expect(
      setup().service.list({ cursor: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
