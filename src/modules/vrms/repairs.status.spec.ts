import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { PrismaService } from '../../shared/prisma.service';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { RepairsService } from './repairs.service';
import { FINISHED_STATUSES, OPEN_STATUSES } from './ticket-statuses';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';

// Spec 0014 on the status endpoint: the table, the check order, every effect of a move inside
// one transaction, and the required stale check. Spec 0010, AC-4a and AC-10 still hold.

type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

const admin: JwtUser = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};
const chief: JwtUser = {
  sub: '00000000-0000-4000-8000-000000000020',
  email: 'vrms.chief@welinc.com',
  name: 'Ramon Villanueva',
  roles: [{ role: UserRole.CHIEF_MECHANIC, system: 'VRMS' }],
  system: 'VRMS',
};

const TICKET = '00000000-0000-4000-8000-0000000000aa';
const MECH = 'mech-chief';
const LOADED = new Date('2026-10-29T01:00:00.000Z');
const AT = LOADED.toISOString();

/** A ticket shaped like ticketInclude(), for formatTicket. */
function fullTicket(status: RepairStatus) {
  return {
    id: TICKET,
    repairNumber: 'REP-1',
    repairStatus: status,
    priority: 'HIGH',
    odometer: 1000,
    dueAt: null,
    dueAtSource: null,
    reportedByName: 'Victor Ramos',
    verifiedByName: null,
    verifiedAt: null,
    createdAt: LOADED,
    updatedAt: LOADED,
    lastActivityAt: LOADED,
    statusChangedAt: LOADED,
    closedAt: null,
    cancellationReason: null,
    remarks: null,
    partsCost: null,
    laborCost: null,
    totalCost: null,
    isLumpSum: false,
    isUnlocked: false,
    unlockReason: null,
    vehicleId: 'v1',
    vehicle: { plateNumber: 'ABC 123', model: 'Hilux', status: 'UNDER_REPAIR' },
    driver: { name: 'Driver', licenseNumber: 'driver', isVerified: true },
    garage: { name: 'Sta. Rosa' },
    assignments: [
      {
        mechanicId: MECH,
        mechanic: {
          id: MECH,
          name: 'Ramon',
          authUserId: chief.sub,
          isActive: true,
        },
      },
    ],
    repairParts: [],
    issues: [],
  };
}

function setup(
  status: RepairStatus,
  over: Record<string, unknown> = {},
  opts: { stale?: boolean; requireCosts?: boolean } = {},
) {
  const loaded = { ...fullTicket(status), ...over };
  const tx = {
    repairPart: {
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    repairTicket: {
      // count 0 is the race lost inside the transaction
      updateMany: jest.fn().mockResolvedValue({ count: opts.stale ? 0 : 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(loaded),
    },
    repairIssue: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    vehicle: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 900 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    repairTicket: { findUnique: jest.fn().mockResolvedValue(loaded) },
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  return {
    prisma,
    tx,
    service: new RepairsService(
      prisma as unknown as PrismaService,
      new FakeSettings(
        opts.requireCosts ? { 'tickets.require_costs_to_close': true } : {},
      ),
      new FakeEmbeddings().asService(),
    ),
  };
}

type Data = Record<string, unknown>;
const firstData = (mock: jest.Mock) =>
  (mock.mock.calls[0] as [{ data: Data }])[0].data;

/** The 400 body of an INVALID_TRANSITION. */
async function invalidBody(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse() as Data;
}

describe('status sets (spec 0010, AC-4a)', () => {
  it('splits the nine statuses into open and finished, with ON_HOLD open', () => {
    expect(FINISHED_STATUSES).toEqual([
      RepairStatus.CLOSED,
      RepairStatus.CANCELLED,
    ]);
    expect(OPEN_STATUSES).toHaveLength(7);
    expect(OPEN_STATUSES).toContain(RepairStatus.ON_HOLD);
    expect(OPEN_STATUSES).not.toContain(RepairStatus.CLOSED);
  });
});

describe('RepairsService.updateStatus moves (AC-1, AC-7, AC-10, AC-12)', () => {
  it.each([
    [RepairStatus.ASSIGNED, RepairStatus.IN_PROGRESS],
    [RepairStatus.IN_PROGRESS, RepairStatus.FOR_VERIFICATION],
  ])(
    'lets an assigned chief mechanic move %s to %s through the conditional update',
    async (from, to) => {
      const { tx, service } = setup(from);
      await service.updateStatus(
        TICKET,
        { status: to, lastUpdatedAt: AT, resolutions: [] },
        chief,
        defaultAbility(chief),
      );
      expect(tx.repairTicket.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TICKET, updatedAt: LOADED } }),
      );
      const data = firstData(tx.repairTicket.updateMany);
      const row = firstData(tx.auditLog.create);
      expect(data.repairStatus).toBe(to);
      expect(row).toMatchObject({
        action: 'STATUS_CHANGE',
        changes: [{ field: 'repairStatus', before: from, after: to }],
        actorRole: 'CHIEF_MECHANIC',
      });
      expect(data.lastActivityAt).toBe(row.createdAt);
      expect(data.updatedAt).toBe(row.createdAt);
      expect(data).not.toHaveProperty('verifiedByUserId');
      expect(data).not.toHaveProperty('closedAt');
      expect(tx.vehicle.update).not.toHaveBeenCalled();
    },
  );

  it('verifies: records the closer, frees the truck and syncs the odometer in the same transaction', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    const data = firstData(tx.repairTicket.updateMany);
    expect(data).toMatchObject({
      repairStatus: RepairStatus.CLOSED,
      verifiedByUserId: admin.sub,
      verifiedByName: 'Victor Ramos',
    });
    expect(data.verifiedAt).toBe(data.closedAt);
    expect(data.closedAt).toBe(firstData(tx.auditLog.create).createdAt);
    expect(firstData(tx.vehicle.update)).toEqual({
      status: 'AVAILABLE',
      odometer: 1000,
    });
  });

  it('writes statusChangedAt with the move, from the same clock reading as the audit row (spec 0015, AC-7)', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    const data = firstData(tx.repairTicket.updateMany);
    expect(data.statusChangedAt).toBe(data.updatedAt);
    expect(data.statusChangedAt).toBe(firstData(tx.auditLog.create).createdAt);
  });

  it('refuses the close with 422 COSTS_REQUIRED while the setting is on and no costs exist (spec 0015, AC-5)', async () => {
    const { tx, service } = setup(
      RepairStatus.FOR_VERIFICATION,
      {},
      { requireCosts: true },
    );
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 422,
        code: 'COSTS_REQUIRED',
        message: 'Add the costs before closing this ticket.',
      },
    });
    expect(tx.repairTicket.updateMany).not.toHaveBeenCalled();
  });

  it('lets the close through when a cost, a part or costs in the same request exist, or the setting is off (spec 0015, AC-5)', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ totalCost: 10 }, {}],
      [{ repairParts: [{ id: 'p1' }] }, {}],
      [{}, { partsCost: 5 }],
    ];
    for (const [over, dto] of cases) {
      const { tx, service } = setup(RepairStatus.FOR_VERIFICATION, over, {
        requireCosts: true,
      });
      await service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT, ...dto },
        admin,
        defaultAbility(admin),
      );
      expect(tx.repairTicket.updateMany).toHaveBeenCalled();
    }
    const off = setup(RepairStatus.FOR_VERIFICATION);
    await off.service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(off.tx.repairTicket.updateMany).toHaveBeenCalled();
  });

  it('cancels from any open status with the reason, no verifier, and the truck freed', async () => {
    const { tx, service } = setup(RepairStatus.ON_HOLD);
    await service.updateStatus(
      TICKET,
      {
        status: RepairStatus.CANCELLED,
        cancellationReason: ' Duplicate ',
        lastUpdatedAt: AT,
      },
      admin,
      defaultAbility(admin),
    );
    const data = firstData(tx.repairTicket.updateMany);
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('verifiedByUserId');
    expect(data.cancellationReason).toBe('Duplicate');
    expect(firstData(tx.auditLog.create).note).toBe('Duplicate');
    expect(firstData(tx.vehicle.update)).toEqual({ status: 'AVAILABLE' });
  });

  it('answers 400 without a cancellation reason, after the right check', async () => {
    const { tx, service } = setup(RepairStatus.IN_PROGRESS);
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CANCELLED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toThrow('A cancellation reason is required');
    expect(tx.repairTicket.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a chief mechanic cancelling, with the move message', async () => {
    const { prisma, service } = setup(RepairStatus.IN_PROGRESS);
    const run = service.updateStatus(
      TICKET,
      {
        status: RepairStatus.CANCELLED,
        cancellationReason: 'x',
        lastUpdatedAt: AT,
      },
      chief,
      defaultAbility(chief),
    );
    await expect(run).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run).rejects.toThrow(
      "You can't make this move on this ticket.",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('moves outside the table (AC-3, AC-3a, AC-4)', () => {
  it('rejects a skipped move with INVALID_TRANSITION, both labels and the allowed list', async () => {
    const { service } = setup(RepairStatus.ASSIGNED);
    const body = await invalidBody(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(body).toEqual({
      statusCode: 400,
      code: 'INVALID_TRANSITION',
      message: "Can't move a ticket from 'Assigned' to 'Closed'.",
      allowed: [RepairStatus.IN_PROGRESS, RepairStatus.CANCELLED],
    });
  });

  it('names the owning action for a move a later feature makes', async () => {
    const { service } = setup(RepairStatus.IN_PROGRESS);
    const body = await invalidBody(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.ON_HOLD, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(body.message).toBe(
      'A ticket goes On hold when a hold is filed, not from here.',
    );
  });

  it.each([false, true])(
    'never leaves Closed through the status endpoint (unlocked: %s)',
    async (isUnlocked) => {
      const { service } = setup(RepairStatus.CLOSED, { isUnlocked });
      const body = await invalidBody(
        service.updateStatus(
          TICKET,
          { status: RepairStatus.IN_PROGRESS, lastUpdatedAt: AT },
          admin,
          defaultAbility(admin),
        ),
      );
      expect(body).toMatchObject({ code: 'INVALID_TRANSITION', allowed: [] });
    },
  );

  it('rejects the same status on an open ticket', async () => {
    const { service } = setup(RepairStatus.IN_PROGRESS);
    const body = await invalidBody(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.IN_PROGRESS, lastUpdatedAt: AT },
        chief,
        defaultAbility(chief),
      ),
    );
    expect(body.message).toBe('This ticket is already In progress.');
  });

  it('keeps the finished lock as an INVALID_TRANSITION', async () => {
    const { service } = setup(RepairStatus.CLOSED);
    const body = await invalidBody(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    );
    expect(body.code).toBe('INVALID_TRANSITION');
  });

  it('answers 409 before the move check when lastUpdatedAt is stale', async () => {
    const { service } = setup(RepairStatus.CLOSED);
    await expect(
      service.updateStatus(
        TICKET,
        {
          status: RepairStatus.IN_PROGRESS,
          lastUpdatedAt: '2026-10-28T00:00:00.000Z',
        },
        chief,
        defaultAbility(chief),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 409 and writes nothing more when the race is lost inside the transaction', async () => {
    const { tx, service } = setup(
      RepairStatus.FOR_VERIFICATION,
      {},
      { stale: true },
    );
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('saves an unlocked finished ticket with no move, no audit row and no lastActivityAt', async () => {
    const { tx, service } = setup(RepairStatus.CLOSED, { isUnlocked: true });
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, remarks: 'Fixed note', lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    const data = firstData(tx.repairTicket.updateMany);
    expect(data).toMatchObject({ isUnlocked: false, remarks: 'Fixed note' });
    expect(data).not.toHaveProperty('lastActivityAt');
    expect(data).not.toHaveProperty('closedAt');
    expect(data).not.toHaveProperty('repairStatus');
  });
});

describe('Send back (AC-8, AC-9)', () => {
  it('needs remarks of 5 to 500 characters', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION);
    await expect(
      service.updateStatus(
        TICKET,
        {
          status: RepairStatus.IN_PROGRESS,
          remarks: ' ok ',
          lastUpdatedAt: AT,
        },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toThrow('Say what needs fixing.');
    expect(tx.repairTicket.updateMany).not.toHaveBeenCalled();
  });

  it('goes back to In progress, keeps the comment in the audit row only, and clears resolvedAt', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      {
        status: RepairStatus.IN_PROGRESS,
        remarks: ' Rear pads still squeal ',
        lastUpdatedAt: AT,
      },
      admin,
      defaultAbility(admin),
    );
    const data = firstData(tx.repairTicket.updateMany);
    expect(data.repairStatus).toBe(RepairStatus.IN_PROGRESS);
    expect(data).not.toHaveProperty('remarks');
    expect(firstData(tx.auditLog.create).note).toBe('Rear pads still squeal');
    expect(tx.repairIssue.updateMany).toHaveBeenCalledWith({
      where: { repairTicketId: TICKET },
      data: { resolvedAt: null },
    });
    expect(tx.vehicle.update).not.toHaveBeenCalled();
  });
});

describe('RepairsService.updateCosts (spec 0010, AC-6, AC-10; spec 0014, AC-12)', () => {
  const costed = {
    partsCost: 3000,
    laborCost: 1000,
    totalCost: 4000,
    repairParts: [],
  };

  it('writes one COST_UPDATE row with every change, and moves lastActivityAt with it', async () => {
    const { prisma, tx, service } = setup(
      RepairStatus.FOR_VERIFICATION,
      costed,
    );
    await service.updateCosts(
      TICKET,
      { isLumpSum: true, partsCost: 3500, laborCost: 1700, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const row = firstData(tx.auditLog.create);
    expect(row).toMatchObject({
      action: 'COST_UPDATE',
      changes: [
        { field: 'partsCost', before: '3000.00', after: '3500.00' },
        { field: 'laborCost', before: '1000.00', after: '1700.00' },
        { field: 'totalCost', before: '4000.00', after: '5200.00' },
        { field: 'isLumpSum', before: 'false', after: 'true' },
      ],
    });
    expect(firstData(tx.repairTicket.updateMany).lastActivityAt).toBe(
      row.createdAt,
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes no row and keeps lastActivityAt when nothing changed', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION, {
      ...costed,
      isLumpSum: true,
    });
    await service.updateCosts(
      TICKET,
      { isLumpSum: true, partsCost: 3000, laborCost: 1000, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(firstData(tx.repairTicket.updateMany)).not.toHaveProperty(
      'lastActivityAt',
    );
  });

  it('answers 409 when the race is lost inside the transaction, before touching parts', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION, costed, {
      stale: true,
    });
    await expect(
      service.updateCosts(
        TICKET,
        { isLumpSum: true, partsCost: 1, laborCost: 1, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.repairPart.deleteMany).not.toHaveBeenCalled();
  });
});

describe('RepairsService.unlockTicket (AC-12)', () => {
  it('answers 409 for a stale lastUpdatedAt', async () => {
    const { prisma, service } = setup(RepairStatus.CLOSED);
    await expect(
      service.unlockTicket(
        TICKET,
        { unlockReason: 'Fix cost', lastUpdatedAt: '2026-10-28T00:00:00.000Z' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('unlocks through the conditional update with one UNLOCK row', async () => {
    const { tx, service } = setup(RepairStatus.CLOSED);
    await service.unlockTicket(
      TICKET,
      { unlockReason: 'Fix cost', lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(firstData(tx.repairTicket.updateMany)).toMatchObject({
      isUnlocked: true,
      unlockReason: 'Fix cost',
    });
    expect(firstData(tx.auditLog.create).action).toBe('UNLOCK');
  });
});

describe('lastRejection on the detail read (AC-14)', () => {
  const rejected = {
    changes: [
      {
        field: 'repairStatus',
        before: 'FOR_VERIFICATION',
        after: 'IN_PROGRESS',
      },
    ],
    note: 'Rear pads still squeal',
    actorName: 'Ramon Villanueva',
    actorEmail: 'vrms.chief@welinc.com',
    createdAt: LOADED,
  };

  it('sends the Send back still in force while In progress, read newest first', async () => {
    const { prisma, service } = setup(RepairStatus.IN_PROGRESS);
    prisma.auditLog.findMany.mockResolvedValue([rejected]);
    const res = await service.findOne(TICKET, defaultAbility(admin));
    expect(res.lastRejection).toEqual({
      remarks: 'Rear pads still squeal',
      byName: 'Ramon Villanueva',
      at: AT,
    });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repairTicketId: TICKET, action: 'STATUS_CHANGE' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('is null and reads nothing outside In progress and On hold', async () => {
    const { prisma, service } = setup(RepairStatus.FOR_VERIFICATION);
    prisma.auditLog.findMany.mockResolvedValue([rejected]);
    const res = await service.findOne(TICKET, defaultAbility(admin));
    expect(res.lastRejection).toBeNull();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
