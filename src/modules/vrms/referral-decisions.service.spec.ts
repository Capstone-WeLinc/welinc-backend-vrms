import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { UserRole } from '../../auth/roles';
import type { PrismaService } from '../../shared/prisma.service';
import { FakeEmbeddings } from '../ai/embedding.fake';
import type { ReferralsService } from '../integrations/referrals/referrals.service';
import { queueVmmsRepairEvent } from '../integrations/vmms-repair-events';
import { queueBmsRepairUpdate } from '../integrations/bms/bms-repair-updates';
import { ReferralDecisionsService } from './referral-decisions.service';
import type { RepairsService } from './repairs.service';

// Spec 0029 (child 0002), AC-9 to AC-11: Add to the open ticket, and Reject.

jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn(() => Promise.resolve({ deliveryId: 'd-1' })),
}));
const queued = jest.mocked(queueVmmsRepairEvent);
jest.mock('../integrations/bms/bms-repair-updates', () => ({
  ...jest.requireActual<object>('../integrations/bms/bms-repair-updates'),
  queueBmsRepairUpdate: jest.fn(() => Promise.resolve({ deliveryId: 'b-1' })),
}));
const bmsQueued = jest.mocked(queueBmsRepairUpdate);

const admin = {
  sub: '00000000-0000-4000-8000-000000000010',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};
const mechanic = {
  ...admin,
  sub: '00000000-0000-4000-8000-000000000030',
  roles: [{ role: UserRole.MECHANIC, system: 'VRMS' }],
};

const LOADED = new Date('2026-11-27T02:00:00.000Z');
const NOW_ISO = '2026-11-27T03:00:00.000Z';
const SCHEDULE = '11111111-1111-4111-8111-111111111111';
const BRAKES = { id: 'cat-brakes', name: 'Brakes', isActive: true };

function setup(
  opts: {
    status?: string;
    lockedStatus?: string;
    ticket?: Record<string, unknown> | null;
    linkedSchedules?: string[];
    stampCount?: number;
  } = {},
) {
  const referral = {
    status: opts.status ?? 'WAITING',
    vehicleId: 'v1',
    workOrderNumber: 'WO-2026-0042',
    maintenanceScheduleId: SCHEDULE,
  };
  const ticket =
    opts.ticket === null
      ? null
      : {
          id: 't1',
          repairNumber: 'REP-20261120-0007',
          repairStatus: RepairStatus.IN_PROGRESS,
          isUnlocked: false,
          updatedAt: LOADED,
          assignments: [],
          ...opts.ticket,
        };
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM referrals')) {
        calls.push('lock');
        return Promise.resolve([{ status: opts.lockedStatus ?? 'WAITING' }]);
      }
      // queueReferralRejected's clock
      return Promise.resolve([{ at: new Date(NOW_ISO) }]);
    }),
    repairTicket: {
      updateMany: jest.fn(() => {
        calls.push('stamp');
        return Promise.resolve({ count: opts.stampCount ?? 1 });
      }),
    },
    referral: {
      findMany: jest.fn(() =>
        Promise.resolve(
          (opts.linkedSchedules ?? []).map((id) => ({
            maintenanceScheduleId: id,
          })),
        ),
      ),
      update: jest.fn(() => {
        calls.push('referral');
        return Promise.resolve({});
      }),
    },
    repairIssue: {
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'i-a' })
        .mockResolvedValueOnce({ id: 'i-b' }),
    },
    auditLog: {
      create: jest.fn((args: { data: { action: string } }) => {
        calls.push(args.data.action);
        return Promise.resolve({});
      }),
    },
    delivery: {
      create: jest.fn(() => {
        calls.push('delivery');
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    referral: { findUnique: jest.fn().mockResolvedValue(referral) },
    repairTicket: {
      findFirst: jest.fn().mockResolvedValue(ticket),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ ...ticket, saved: true }),
    },
    issueCategory: { findMany: jest.fn().mockResolvedValue([BRAKES]) },
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
  };
  const repairs = { present: jest.fn((t: unknown) => Promise.resolve(t)) };
  const referrals = {
    detail: jest.fn().mockResolvedValue({ id: 'r1', status: 'REJECTED' }),
  };
  const embeddings = new FakeEmbeddings();
  const service = new ReferralDecisionsService(
    prisma as unknown as PrismaService,
    repairs as unknown as RepairsService,
    referrals as unknown as ReferralsService,
    embeddings.asService(),
  );
  return { service, prisma, tx, calls };
}

const body = {
  updatedAt: LOADED.toISOString(),
  issues: [
    { description: 'Brake pads: worn to 2 mm', categoryId: BRAKES.id },
    { description: 'Brake lights', categoryId: BRAKES.id },
  ],
};

describe('ReferralDecisionsService.addToTicket (AC-9)', () => {
  it('tells BMS too, since the new issues can change the reason it shows (child 0003, AC-17)', async () => {
    bmsQueued.mockClear();
    const { service, tx } = setup();
    await service.addToTicket('r1', body, admin, defaultAbility(admin));
    expect(bmsQueued).toHaveBeenCalledTimes(1);
    expect(bmsQueued).toHaveBeenCalledWith(
      tx,
      't1',
      'Issues added from VMMS WO-2026-0042',
    );
  });

  beforeEach(() => queued.mockClear());

  it('stamps the ticket, writes REFERRAL_ADDED then one ISSUE_ADDED per line, links the referral and queues LINKS_UPDATED', async () => {
    const { service, tx, calls } = setup();
    await service.addToTicket('r1', body, admin, defaultAbility(admin));
    expect(calls).toEqual([
      'lock',
      'stamp',
      'REFERRAL_ADDED',
      'ISSUE_ADDED',
      'ISSUE_ADDED',
      'referral',
    ]);
    expect(tx.repairIssue.create).toHaveBeenNthCalledWith(1, {
      data: {
        repairTicketId: 't1',
        description: '[Brakes] Brake pads: worn to 2 mm',
        categoryId: BRAKES.id,
      },
    });
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({
        status: 'ADDED_TO_TICKET',
        repairTicketId: 't1',
        decidedByUserId: admin.sub,
      }) as Record<string, unknown>,
    });
    expect(queued).toHaveBeenCalledWith(tx, 't1', 'LINKS_UPDATED');
  });

  it('sends STATUS_UPDATED when the schedule is already linked to the ticket (ask 5)', async () => {
    const { service, tx } = setup({ linkedSchedules: [SCHEDULE] });
    await service.addToTicket('r1', body, admin, defaultAbility(admin));
    expect(queued).toHaveBeenCalledWith(tx, 't1', 'STATUS_UPDATED');
  });

  it('answers NO_OPEN_TICKET, STALE, and 403 for a ticket the caller may not read', async () => {
    await expect(
      setup({ ticket: null }).service.addToTicket(
        'r1',
        body,
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ response: { code: 'NO_OPEN_TICKET' } });
    await expect(
      setup().service.addToTicket(
        'r1',
        { ...body, updatedAt: '2026-11-27T01:00:00.000Z' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ response: { code: 'STALE' } });
    // The stamp's guarded update lost a race: still STALE, nothing queued
    const raced = setup({ stampCount: 0 });
    await expect(
      raced.service.addToTicket('r1', body, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'STALE' } });
    expect(queued).not.toHaveBeenCalled();
    await expect(
      setup().service.addToTicket(
        'r1',
        body,
        mechanic,
        defaultAbility(mechanic),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a referral already decided, before and under the lock (AC-8)', async () => {
    await expect(
      setup({ status: 'REJECTED' }).service.addToTicket(
        'r1',
        body,
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ response: { code: 'REFERRAL_ALREADY_DECIDED' } });
    const late = setup({ lockedStatus: 'OPENED_TICKET' });
    await expect(
      late.service.addToTicket('r1', body, admin, defaultAbility(admin)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(late.tx.repairTicket.updateMany).not.toHaveBeenCalled();
  });
});

describe('ReferralDecisionsService.reject (AC-10)', () => {
  it('sets REJECTED, writes REFERRAL_REJECTED with no ticket, and queues the referral event to VMMS', async () => {
    const { service, tx, calls } = setup();
    await service.reject('r1', { reason: 'Already fixed on site' }, admin);
    expect(calls).toEqual([
      'lock',
      'referral',
      'REFERRAL_REJECTED',
      'delivery',
    ]);
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({
        status: 'REJECTED',
        rejectionReason: 'Already fixed on site',
      }) as Record<string, unknown>,
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: null,
        action: 'REFERRAL_REJECTED',
        note: 'Already fixed on site',
      }) as Record<string, unknown>,
    });
    const [[{ data }]] = tx.delivery.create.mock.calls as unknown as [
      [
        {
          data: {
            kind: string;
            target: string;
            referralId: string;
            payload: Record<string, unknown>;
          };
        },
      ],
    ];
    expect(data).toMatchObject({
      kind: 'REFERRAL_REJECTED',
      target: 'VMMS',
      referralId: 'r1',
      payload: {
        referralId: 'r1',
        eventType: 'REJECTED',
        reason: 'Already fixed on site',
        occurredAt: NOW_ISO,
      },
    });
    expect(data.payload.eventId).toEqual(expect.any(String));
  });

  it('answers 404 for an unknown referral and 409 when it was decided meanwhile', async () => {
    const missing = setup();
    missing.prisma.referral.findUnique.mockResolvedValue(null);
    await expect(
      missing.service.reject('r1', { reason: 'Wrong truck' }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    const late = setup({ lockedStatus: 'ADDED_TO_TICKET' });
    await expect(
      late.service.reject('r1', { reason: 'Wrong truck' }, admin),
    ).rejects.toMatchObject({
      response: { code: 'REFERRAL_ALREADY_DECIDED' },
    });
    expect(late.tx.delivery.create).not.toHaveBeenCalled();
  });
});
