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
import type { SettingKey } from '../../settings/catalog';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { photoRows } from './photo-rules.fake';

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
  opts: {
    stale?: boolean;
    requireCosts?: boolean;
    /** Spec 0018: live Before and After photos, one of each unless given. */
    photos?: { before: number; after: number };
    settings?: Partial<Record<SettingKey, number | boolean>>;
  } = {},
) {
  const loaded = { ...fullTicket(status), ...over };
  // Separate mocks: the transaction's count is the rule check, prisma's is the response read
  const rows = photoRows(opts.photos?.before ?? 1, opts.photos?.after ?? 1);
  const tx = {
    attachment: { groupBy: jest.fn().mockResolvedValue(rows) },
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
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ odometer: 900, status: 'UNDER_REPAIR' }),
      update: jest.fn().mockResolvedValue({}),
    },
    vehicleChange: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    repairTicket: { findUnique: jest.fn().mockResolvedValue(loaded) },
    attachment: { groupBy: jest.fn().mockResolvedValue(rows) },
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
      new FakeSettings({
        ...(opts.requireCosts && { 'tickets.require_costs_to_close': true }),
        ...opts.settings,
      }),
      new FakeEmbeddings().asService(),
      new FakeFleet().asClient(),
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

  it('verifies: records the closer, and leaves the truck to VMMS (spec 0029, AC-4)', async () => {
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
    expect(tx.vehicle.update).not.toHaveBeenCalled();
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

  it('cancels from any open status with the reason and no verifier, leaving the truck to VMMS', async () => {
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
    expect(tx.vehicle.update).not.toHaveBeenCalled();
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

  // Spec 0021, AC-1 to AC-3b: the relocking save through the status endpoint
  describe('saving an unlocked finished ticket', () => {
    const unlocked = {
      isUnlocked: true,
      unlockReason: 'Supplier refund on brake pads',
      remarks: 'Old note',
      partsCost: 1000,
      laborCost: 500,
      totalCost: 1500,
    };
    const rowsOf = (create: jest.Mock) =>
      create.mock.calls.map(
        ([arg]) =>
          (arg as { data: Record<string, unknown> }).data as {
            action: string;
            changes: unknown[];
            note: string | null;
            createdAt: Date;
          },
      );

    it('saves with no move and writes COST_UPDATE, TICKET_EDITED and LOCKED in order', async () => {
      const { tx, service } = setup(RepairStatus.CLOSED, unlocked);
      await service.updateStatus(
        TICKET,
        {
          status: RepairStatus.CLOSED,
          remarks: '  Fixed note ',
          partsCost: 1200,
          lastUpdatedAt: AT,
        },
        admin,
        defaultAbility(admin),
      );
      const data = firstData(tx.repairTicket.updateMany) as {
        updatedAt: Date;
        lastActivityAt: Date;
      };
      expect(data).toMatchObject({ isUnlocked: false, remarks: 'Fixed note' });
      expect(data).not.toHaveProperty('closedAt');
      expect(data).not.toHaveProperty('repairStatus');

      const rows = rowsOf(tx.auditLog.create);
      expect(rows.map((r) => r.action)).toEqual([
        'COST_UPDATE',
        'TICKET_EDITED',
        'LOCKED',
      ]);
      expect(rows[0].changes).toEqual([
        { field: 'partsCost', before: '1000.00', after: '1200.00' },
        { field: 'totalCost', before: '1500.00', after: '1700.00' },
      ]);
      expect(rows[1].changes).toEqual([
        { field: 'remarks', before: 'Old note', after: 'Fixed note' },
      ]);
      expect(rows[2]).toMatchObject({
        changes: [{ field: 'isUnlocked', before: 'true', after: 'false' }],
        note: null,
      });
      expect(rows[0].note).toBe(unlocked.unlockReason);
      expect(rows[1].note).toBe(unlocked.unlockReason);
      // AC-3b: 1 ms apart from now, updatedAt is now, lastActivityAt the newest row
      const now = data.updatedAt.getTime();
      expect(rows.map((r) => r.createdAt.getTime())).toEqual([
        now,
        now + 1,
        now + 2,
      ]);
      expect(data.lastActivityAt.getTime()).toBe(now + 2);
    });

    it('writes only LOCKED when nothing else changes, and blank text never clears a value', async () => {
      const { tx, service } = setup(RepairStatus.CANCELLED, unlocked);
      await service.updateStatus(
        TICKET,
        {
          status: RepairStatus.CANCELLED,
          remarks: '   ',
          cancellationReason: ' ',
          lastUpdatedAt: AT,
        },
        admin,
        defaultAbility(admin),
      );
      const data = firstData(tx.repairTicket.updateMany);
      expect(data).not.toHaveProperty('remarks');
      expect(data).not.toHaveProperty('cancellationReason');
      expect(rowsOf(tx.auditLog.create).map((r) => r.action)).toEqual([
        'LOCKED',
      ]);
    });

    it('lists the cancel reason when it changes', async () => {
      const { tx, service } = setup(RepairStatus.CANCELLED, {
        ...unlocked,
        cancellationReason: 'Duplicate',
      });
      await service.updateStatus(
        TICKET,
        {
          status: RepairStatus.CANCELLED,
          cancellationReason: 'Truck sold',
          lastUpdatedAt: AT,
        },
        admin,
        defaultAbility(admin),
      );
      const [edited] = rowsOf(tx.auditLog.create);
      expect(edited).toMatchObject({
        action: 'TICKET_EDITED',
        changes: [
          {
            field: 'cancellationReason',
            before: 'Duplicate',
            after: 'Truck sold',
          },
        ],
      });
    });

    it('writes no row when the save loses the stale race (409)', async () => {
      const { tx, service } = setup(RepairStatus.CLOSED, unlocked, {
        stale: true,
      });
      await expect(
        service.updateStatus(
          TICKET,
          { status: RepairStatus.CLOSED, partsCost: 1200, lastUpdatedAt: AT },
          admin,
          defaultAbility(admin),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
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
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  // Spec 0021, AC-1, AC-3 and AC-3b: the costs endpoint relocks an unlocked closed ticket
  it('on an unlocked closed ticket writes COST_UPDATE with the unlock reason, then LOCKED', async () => {
    const { tx, service } = setup(RepairStatus.CLOSED, {
      ...costed,
      isUnlocked: true,
      unlockReason: 'Wrong labor amount',
    });
    await service.updateCosts(
      TICKET,
      {
        isLumpSum: false,
        laborCost: 1200,
        parts: [{ description: 'Pads', unitCost: 3000, quantity: 1 }],
        lastUpdatedAt: AT,
      },
      admin,
      defaultAbility(admin),
    );
    type Row = { action: string; note: string | null; createdAt: Date };
    const rows = tx.auditLog.create.mock.calls.map(
      ([arg]) => (arg as { data: Row }).data,
    );
    expect(rows.map((r) => r.action)).toEqual(['COST_UPDATE', 'LOCKED']);
    expect(rows[0].note).toBe('Wrong labor amount');
    expect(rows[1].note).toBeNull();
    expect(rows[1].createdAt.getTime() - rows[0].createdAt.getTime()).toBe(1);
    expect(firstData(tx.repairTicket.updateMany).lastActivityAt).toEqual(
      rows[1].createdAt,
    );
  });

  it('on an unlocked ticket with no cost change writes only LOCKED', async () => {
    const { tx, service } = setup(RepairStatus.CLOSED, {
      ...costed,
      isLumpSum: true,
      isUnlocked: true,
      unlockReason: 'Check the amounts',
    });
    await service.updateCosts(
      TICKET,
      { isLumpSum: true, partsCost: 3000, laborCost: 1000, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(firstData(tx.auditLog.create)).toMatchObject({
      action: 'LOCKED',
      note: null,
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
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

describe('photo rules on the moves (spec 0018, AC-4 to AC-8)', () => {
  const none = { before: 0, after: 0 };

  it('refuses Start work with 400 BEFORE_PHOTO_REQUIRED after the row lock, writing no audit row', async () => {
    const { tx, service } = setup(RepairStatus.ASSIGNED, {}, { photos: none });
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.IN_PROGRESS, lastUpdatedAt: AT },
        chief,
        defaultAbility(chief),
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 400, code: 'BEFORE_PHOTO_REQUIRED' },
    });
    // Counted inside the transaction, after the conditional update took the lock (AC-7)
    expect(tx.repairTicket.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.attachment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repairTicketId: TICKET,
          deletedAt: null,
        }) as unknown,
      }),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('lets Start work through with the switch off', async () => {
    const { tx, service } = setup(
      RepairStatus.ASSIGNED,
      {},
      {
        photos: none,
        settings: { 'tickets.require_before_photo_to_start': false },
      },
    );
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.IN_PROGRESS, lastUpdatedAt: AT },
      chief,
      defaultAbility(chief),
    );
    expect(tx.attachment.groupBy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('refuses Send for verification with 400 AFTER_PHOTO_REQUIRED when only Before photos exist', async () => {
    const { service } = setup(
      RepairStatus.IN_PROGRESS,
      {},
      { photos: { before: 2, after: 0 } },
    );
    await expect(
      service.updateStatus(
        TICKET,
        {
          status: RepairStatus.FOR_VERIFICATION,
          lastUpdatedAt: AT,
          resolutions: [],
        },
        chief,
        defaultAbility(chief),
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 400, code: 'AFTER_PHOTO_REQUIRED' },
    });
  });

  it('answers the "What fixed it" error before the photo rule (AC-7)', async () => {
    const issue = {
      id: 'issue-1',
      description: 'Brakes squeal',
      knowledgeEntryId: null,
    };
    const { tx, service } = setup(
      RepairStatus.IN_PROGRESS,
      { issues: [issue] },
      { photos: none },
    );
    await expect(
      service.updateStatus(
        TICKET,
        {
          status: RepairStatus.FOR_VERIFICATION,
          lastUpdatedAt: AT,
          resolutions: [],
        },
        chief,
        defaultAbility(chief),
      ),
    ).rejects.toThrow(/Add what fixed each issue/);
    expect(tx.attachment.groupBy).not.toHaveBeenCalled();
  });

  it('closes without an After photo by default, and refuses with the close switch on', async () => {
    const open = setup(RepairStatus.FOR_VERIFICATION, {}, { photos: none });
    await open.service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(open.tx.auditLog.create).toHaveBeenCalledTimes(1);

    const strict = setup(
      RepairStatus.FOR_VERIFICATION,
      {},
      {
        photos: none,
        settings: { 'tickets.require_after_photo_to_close': true },
      },
    );
    await expect(
      strict.service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'AFTER_PHOTO_REQUIRED',
        message: 'Add an after photo before closing.',
      },
    });
  });

  it('answers COSTS_REQUIRED before the close photo rule (AC-7)', async () => {
    const { tx, service } = setup(
      RepairStatus.FOR_VERIFICATION,
      {},
      {
        photos: none,
        requireCosts: true,
        settings: { 'tickets.require_after_photo_to_close': true },
      },
    );
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ response: { code: 'COSTS_REQUIRED' } });
    expect(tx.attachment.groupBy).not.toHaveBeenCalled();
  });

  it('carries no photo rule on Cancel (AC-8)', async () => {
    const { tx, service } = setup(RepairStatus.ASSIGNED, {}, { photos: none });
    await service.updateStatus(
      TICKET,
      {
        status: RepairStatus.CANCELLED,
        lastUpdatedAt: AT,
        cancellationReason: 'Duplicate ticket',
      },
      admin,
      defaultAbility(admin),
    );
    expect(tx.attachment.groupBy).not.toHaveBeenCalled();
  });

  it('marks the blocked move in moves[].blockedBy, from the same check (AC-4)', async () => {
    const blocked = setup(RepairStatus.ASSIGNED, {}, { photos: none });
    const res = await blocked.service.findOne(TICKET, defaultAbility(chief));
    expect(res.moves).toEqual([
      expect.objectContaining({ to: 'IN_PROGRESS', blockedBy: 'beforePhoto' }),
    ]);

    const ready = setup(RepairStatus.ASSIGNED);
    const ok = await ready.service.findOne(TICKET, defaultAbility(chief));
    expect(ok.moves).toEqual([
      expect.objectContaining({ to: 'IN_PROGRESS', blockedBy: null }),
    ]);
  });
});
