import {
  HttpException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { UserRole } from '../../auth/roles';
import type { PrismaService } from '../../shared/prisma.service';
import { setDueAt } from '../integrations/bms/set-due-at';
import { ExpediteDecisionsService } from './expedite-decisions.service';
import type { RepairsService } from './repairs.service';

// covers: spec 0029 AC-11 and AC-19 (answering a BMS expedite request, child 0003)

jest.mock('../integrations/bms/set-due-at', () => ({
  setDueAt: jest.fn(() => Promise.resolve(true)),
}));

const admin = {
  sub: '00000000-0000-4000-8000-000000000010',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};

const LOADED = new Date('2026-11-28T01:00:00.000Z');
const CLOCK = new Date('2026-11-28T02:00:00.000Z');
const DUE = '2026-12-01T09:00:00.000Z';

/** The refusal a call ends in, typed for the assertions. */
const refusal = (call: Promise<unknown>): Promise<HttpException> =>
  call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: HttpException) => error,
  );

function setup(
  opts: { status?: string; lockedStatus?: string; stampCount?: number } = {},
) {
  const calls: string[] = [];
  const deliveries: { kind: string; payload: Record<string, unknown> }[] = [];
  const ticket = {
    id: 't1',
    repairNumber: 'REP-20261128-0003',
    repairStatus: RepairStatus.IN_PROGRESS,
    priority: 'MEDIUM',
    dueAt: null,
    isUnlocked: false,
    updatedAt: LOADED,
    assignments: [],
  };
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      if (strings.join('?').includes('FROM expedite_requests')) {
        calls.push('lock');
        return Promise.resolve([{ status: opts.lockedStatus ?? 'WAITING' }]);
      }
      return Promise.resolve([{ at: CLOCK }]);
    }),
    $executeRaw: jest.fn(() => {
      calls.push('ticket lock');
      return Promise.resolve(1);
    }),
    repairTicket: {
      updateMany: jest.fn(() => {
        calls.push('stamp');
        return Promise.resolve({ count: opts.stampCount ?? 1 });
      }),
    },
    expediteRequest: {
      update: jest.fn(() => {
        calls.push('request');
        return Promise.resolve({});
      }),
    },
    auditLog: {
      create: jest.fn((args: { data: { action: string } }) => {
        calls.push(args.data.action);
        return Promise.resolve({});
      }),
    },
    delivery: {
      create: jest.fn(
        (args: {
          data: { kind: string; payload: Record<string, unknown> };
        }) => {
          calls.push('delivery');
          deliveries.push(args.data);
          return Promise.resolve({});
        },
      ),
    },
  };
  const prisma = {
    expediteRequest: {
      findUnique: jest.fn().mockResolvedValue({
        status: opts.status ?? 'WAITING',
        repairTicketId: 't1',
        jobOrderNumber: 'JO-2026-0142',
      }),
    },
    repairTicket: { findUniqueOrThrow: jest.fn().mockResolvedValue(ticket) },
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
  };
  const repairs = { present: jest.fn(() => Promise.resolve({ id: 't1' })) };
  const service = new ExpediteDecisionsService(
    prisma as unknown as PrismaService,
    repairs as unknown as RepairsService,
  );
  return { service, tx, calls, deliveries, ticket };
}

describe('ExpediteDecisionsService.accept (AC-19)', () => {
  beforeEach(() => jest.mocked(setDueAt).mockClear());

  it('stamps the ticket first, then locks the request, audits, sets the date and answers', async () => {
    const { service, tx, calls, deliveries } = setup();
    await service.accept(
      'x1',
      { priority: 'HIGH', dueAt: DUE, updatedAt: LOADED.toISOString() },
      admin,
      defaultAbility(admin),
    );
    // Ticket lock before the request's: the same order as intake and the close
    expect(calls.slice(0, 2)).toEqual(['stamp', 'lock']);
    expect(calls).toContain('EXPEDITE_ACCEPTED');
    expect(tx.repairTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1', updatedAt: LOADED },
        data: expect.objectContaining({ priority: 'HIGH' }) as unknown,
      }),
    );
    const priorityRow = tx.auditLog.create.mock.calls
      .map((c) => c[0].data as Record<string, unknown>)
      .find((d) => d.action === 'TICKET_EDITED');
    expect(priorityRow).toMatchObject({
      changes: [{ field: 'priority', before: 'MEDIUM', after: 'HIGH' }],
      note: 'Expedite JO-2026-0142',
    });
    expect(setDueAt).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 't1' }),
      {
        dueAt: new Date(DUE),
        source: 'MANUAL',
        reason: 'Expedite JO-2026-0142',
      },
      admin,
      expect.any(Date),
    );
    expect(tx.expediteRequest.update).toHaveBeenCalledWith({
      where: { id: 'x1' },
      data: expect.objectContaining({
        status: 'ACCEPTED',
        newPriority: 'HIGH',
        newDueAt: new Date(DUE),
        decidedByName: 'Victor Ramos',
      }) as unknown,
    });
    expect(deliveries).toEqual([
      expect.objectContaining({
        kind: 'EXPEDITE_ANSWER',
        payload: expect.objectContaining({
          decision: 'ACCEPTED',
          priority: 'HIGH',
          expectedReturnAt: DUE,
        }) as unknown,
      }),
    ]);
  });

  it('writes no priority row and no date when neither changes', async () => {
    const { service, calls } = setup();
    await service.accept(
      'x1',
      { priority: 'MEDIUM', updatedAt: LOADED.toISOString() },
      admin,
      defaultAbility(admin),
    );
    expect(calls).not.toContain('TICKET_EDITED');
    expect(setDueAt).not.toHaveBeenCalled();
  });

  it('refuses a stale ticket and an answered request', async () => {
    const stale = await refusal(
      setup().service.accept(
        'x1',
        { priority: 'HIGH', updatedAt: '2026-11-28T00:00:00.000Z' },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(stale).toBeInstanceOf(ConflictException);
    expect(stale.getResponse()).toMatchObject({ code: 'STALE' });

    const answered = await refusal(
      setup({ lockedStatus: 'DECLINED' }).service.accept(
        'x1',
        { priority: 'HIGH', updatedAt: LOADED.toISOString() },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(answered.getResponse()).toMatchObject({
      code: 'EXPEDITE_ALREADY_DECIDED',
    });
  });
});

describe('ExpediteDecisionsService.decline (AC-19)', () => {
  it('declines with the reason, audits it and answers BMS, leaving the ticket’s updatedAt', async () => {
    const { service, tx, calls, deliveries } = setup();
    await service.decline(
      'x1',
      { reason: 'No parts until Thursday' },
      admin,
      defaultAbility(admin),
    );
    expect(calls).toEqual([
      'ticket lock',
      'lock',
      'request',
      'EXPEDITE_DECLINED',
      'delivery',
    ]);
    expect(tx.repairTicket.updateMany).not.toHaveBeenCalled();
    expect(deliveries[0].payload).toMatchObject({
      decision: 'DECLINED',
      reason: 'No parts until Thursday',
      priority: null,
      expectedReturnAt: null,
    });
  });

  it('answers 404 for an unknown request and 409 for one already answered', async () => {
    const { service } = setup();
    jest
      .mocked(
        (service as unknown as { prisma: PrismaService }).prisma.expediteRequest
          .findUnique,
      )
      .mockResolvedValueOnce(null);
    await expect(
      service.decline(
        'x9',
        { reason: 'Not now' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const answered = await refusal(
      setup({ status: 'ACCEPTED' }).service.decline(
        'x1',
        { reason: 'Not now' },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(answered.getResponse()).toMatchObject({
      code: 'EXPEDITE_ALREADY_DECIDED',
    });
  });
});
