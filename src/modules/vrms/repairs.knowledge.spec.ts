import { BadRequestException, ConflictException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { PrismaService } from '../../shared/prisma.service';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { RepairsService } from './repairs.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { photoRows } from './photo-rules.fake';

// Spec 0029: the VMMS repair event has its own tests (repairs.referral.spec.ts)
jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn().mockResolvedValue({ skipped: 'NOT_LINKED' }),
}));

// Spec 0007, AC-26 (create copies the entry's steps) and AC-29 (link, relink and unlink).

type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

const admin: JwtUser = {
  sub: 'a',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};

const TICKET = '00000000-0000-4000-8000-0000000000aa';
const ISSUE = '00000000-0000-4000-8000-0000000000bb';
const LOADED = new Date('2026-10-25T01:00:00.000Z');

const entry = {
  id: 'entry-new',
  name: 'Brake pads worn',
  categoryId: 'cat-brakes',
  steps: [
    { position: 1, text: 'Lift the vehicle' },
    { position: 2, text: 'Replace the pads' },
  ],
};

/** A ticket shaped like ticketInclude(), for formatTicket. */
function fullTicket() {
  return {
    id: TICKET,
    repairNumber: 'REP-1',
    repairStatus: RepairStatus.IN_PROGRESS,
    priority: 'HIGH',
    odometer: 1000,
    dueAt: null,
    dueAtSource: null,
    reportedByName: 'Victor Ramos',
    verifiedByName: null,
    verifiedAt: null,
    createdAt: LOADED,
    updatedAt: new Date('2026-10-25T02:00:00.000Z'),
    lastActivityAt: new Date('2026-10-25T02:00:00.000Z'),
    statusChangedAt: new Date('2026-10-25T02:00:00.000Z'),
    closedAt: null,
    cancellationReason: null,
    remarks: null,
    partsCost: null,
    laborCost: null,
    totalCost: null,
    isLumpSum: false,
    isUnlocked: false,
    unlockReason: null,
    vehicle: { plateNumber: 'ABC 123', model: 'Hilux', status: 'UNDER_REPAIR' },
    driver: { name: 'Driver', licenseNumber: 'driver', isVerified: true },
    garage: { name: 'Sta. Rosa' },
    assignments: [],
    repairParts: [],
    issues: [
      {
        id: ISSUE,
        description: '[Brakes] Wear and tear: grinding',
        categoryId: 'cat-brakes',
        category: { name: 'Brakes' },
        knowledgeEntryId: entry.id,
        knowledgeEntry: {
          id: entry.id,
          name: entry.name,
          status: 'ACTIVE',
          safetyNotes: null,
          estimatedHours: null,
          parts: [],
        },
        steps: [],
        resolutionNote: null,
        hoursSpent: null,
        followedKnownFix: null,
        resolvedAt: null,
      },
    ],
  };
}

function setupLink(
  overrides: {
    status?: RepairStatus;
    entryFound?: boolean;
    updated?: number;
  } = {},
) {
  const tx = {
    repairTicket: {
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: overrides.updated ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(fullTicket()),
    },
    repairIssueStep: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    repairIssue: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue({
        id: TICKET,
        repairNumber: 'REP-1',
        repairStatus: overrides.status ?? RepairStatus.IN_PROGRESS,
        updatedAt: LOADED,
        assignments: [],
        issues: [
          {
            id: ISSUE,
            categoryId: 'cat-brakes',
            knowledgeEntry: { name: 'Old fix' },
          },
        ],
      }),
    },
    knowledgeEntry: {
      findFirst: jest
        .fn()
        .mockResolvedValue(overrides.entryFound === false ? null : entry),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    // loadStats for the typical hours on the response
    $queryRaw: jest.fn().mockResolvedValue([]),
    // lastRejection on an In progress response (spec 0014, AC-14)
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    attachment: { groupBy: jest.fn().mockResolvedValue(photoRows()) },
  };
  return {
    tx,
    prisma,
    service: new RepairsService(
      prisma as unknown as PrismaService,
      new FakeSettings(),
      new FakeEmbeddings().asService(),
      new FakeFleet().asClient(),
    ),
  };
}

describe('RepairsService.linkKnowledge', () => {
  it('relinks: clears the old checklist, copies the new steps and logs KNOWLEDGE_LINK', async () => {
    const { tx, service } = setupLink();
    const res = await service.linkKnowledge(
      TICKET,
      ISSUE,
      { knowledgeEntryId: entry.id, lastUpdatedAt: LOADED.toISOString() },
      admin,
      defaultAbility(admin),
    );

    expect(tx.repairIssueStep.deleteMany).toHaveBeenCalledWith({
      where: { repairIssueId: ISSUE },
    });
    // Spec 0023, AC-14: the checklist lock moves first, before the steps are replaced
    expect(tx.repairIssue.update).toHaveBeenNthCalledWith(1, {
      where: { id: ISSUE },
      data: { checklistVersion: { increment: 1 } },
    });
    expect(tx.repairIssue.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.repairIssueStep.deleteMany.mock.invocationCallOrder[0],
    );
    expect(tx.repairIssue.update).toHaveBeenCalledWith({
      where: { id: ISSUE },
      data: {
        knowledgeEntryId: entry.id,
        steps: { create: entry.steps },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'KNOWLEDGE_LINK',
        changes: [
          { field: 'knowledgeEntry', before: 'Old fix', after: entry.name },
          { field: 'issueId', before: null, after: ISSUE },
        ],
        actorUserId: admin.sub,
        actorName: admin.name,
        actorRole: 'ADMIN',
      }) as unknown,
    });
    // The ticket's updatedAt and lastActivityAt move together with the row's createdAt (spec 0010,
    // AC-10), guarded by the updatedAt the client loaded
    const [{ data }] = tx.repairTicket.updateMany.mock.calls[0] as [
      { data: { updatedAt: Date; lastActivityAt: Date } },
    ];
    expect(tx.repairTicket.updateMany).toHaveBeenCalledWith({
      where: { id: TICKET, updatedAt: LOADED },
      data: {
        updatedAt: data.lastActivityAt,
        lastActivityAt: data.lastActivityAt,
      },
    });
    const [{ data: row }] = tx.auditLog.create.mock.calls[0] as [
      { data: { createdAt: Date } },
    ];
    expect(row.createdAt).toBe(data.lastActivityAt);
    const issues = res.issues as { knowledgeEntry: { name: string } | null }[];
    expect(issues[0].knowledgeEntry?.name).toBe(entry.name);
  });

  it('unlinks with null: no steps copied and the new value is empty', async () => {
    const { tx, prisma, service } = setupLink();
    await service.linkKnowledge(
      TICKET,
      ISSUE,
      { knowledgeEntryId: null, lastUpdatedAt: LOADED.toISOString() },
      admin,
      defaultAbility(admin),
    );
    expect(prisma.knowledgeEntry.findFirst).not.toHaveBeenCalled();
    expect(tx.repairIssue.update).toHaveBeenCalledWith({
      where: { id: ISSUE },
      data: { knowledgeEntryId: null, steps: undefined },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: [
          { field: 'knowledgeEntry', before: 'Old fix', after: null },
          { field: 'issueId', before: null, after: ISSUE },
        ],
      }) as unknown,
    });
  });

  it('answers 409 for a stale lastUpdatedAt before writing anything', async () => {
    const { prisma, service } = setupLink();
    await expect(
      service.linkKnowledge(
        TICKET,
        ISSUE,
        {
          knowledgeEntryId: entry.id,
          lastUpdatedAt: '2020-01-01T00:00:00.000Z',
        },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 when another write lands between the read and the transaction', async () => {
    const { tx, service } = setupLink({ updated: 0 });
    await expect(
      service.linkKnowledge(
        TICKET,
        ISSUE,
        { knowledgeEntryId: entry.id, lastUpdatedAt: LOADED.toISOString() },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.repairIssue.update).not.toHaveBeenCalled();
  });

  it('refuses outside Pending and In progress', async () => {
    const { service } = setupLink({ status: RepairStatus.FOR_VERIFICATION });
    await expect(
      service.linkKnowledge(
        TICKET,
        ISSUE,
        { knowledgeEntryId: entry.id, lastUpdatedAt: LOADED.toISOString() },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an entry that is not Active', async () => {
    const { prisma, service } = setupLink({ entryFound: false });
    await expect(
      service.linkKnowledge(
        TICKET,
        ISSUE,
        {
          knowledgeEntryId: 'entry-draft',
          lastUpdatedAt: LOADED.toISOString(),
        },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.knowledgeEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'entry-draft', status: 'ACTIVE' },
      }),
    );
  });
});

describe('RepairsService.create with a common issue', () => {
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(null));
  afterAll(() => fetchSpy.mockRestore());

  function setupCreate(entryRows: unknown[] = [entry]) {
    const prisma = {
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'v1', vmmsVehicleId: 'vmms-v1' }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 0 }),
      },
      vehicleChange: { create: jest.fn().mockResolvedValue({}) },
      garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
      issueCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'cat-brakes', name: 'Brakes' }]),
      },
      knowledgeEntry: { findMany: jest.fn().mockResolvedValue(entryRows) },
      driver: {
        findFirst: jest.fn().mockResolvedValue({ id: 'd1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'd1' }),
      },
      mechanic: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: '00000000-0000-4000-8000-0000000000cc', name: 'Mia Cruz' },
          ]),
      },
      lookupValue: {
        findFirst: jest.fn().mockResolvedValue({ name: 'Metro Freight Corp' }),
      },
      repairTicket: {
        create: jest.fn().mockResolvedValue(fullTicket()),
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { odometer: null } }),
      },
      // The row lock read, then lastRejection reads (spec 0016, AC-2)
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'v1', status: 'AVAILABLE' }]),
      // lastRejection, as the fixture ticket is In progress (spec 0014, AC-14)
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { groupBy: jest.fn().mockResolvedValue(photoRows()) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    return {
      prisma,
      service: new RepairsService(
        prisma as unknown as PrismaService,
        new FakeSettings(),
        new FakeEmbeddings().asService(),
        new FakeFleet().asClient(),
      ),
    };
  }

  const dto = {
    vehiclePlate: 'ABC 123',
    driverId: '00000000-0000-4000-8000-0000000000d1',
    accountType: 'ONLINE' as const,
    garageLocation: 'Sta. Rosa',
    odometerReading: 1000,
    mechanics: [{ id: '00000000-0000-4000-8000-0000000000cc' }],
    priority: 'HIGH' as const,
    issues: [
      {
        categoryId: 'cat-brakes',
        knowledgeEntryId: entry.id,
        rootCause: 'Wear and tear',
        description: 'grinding',
      },
      { categoryId: 'cat-brakes', rootCause: 'Unknown', description: 'noise' },
    ],
  };

  it('writes the category name into the description and copies steps for the linked issue only', async () => {
    const { prisma, service } = setupCreate();
    await service.create(dto, admin, defaultAbility(admin));
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: { issues: { create: Record<string, unknown>[] } } },
    ];
    expect(args.data.issues.create).toEqual([
      {
        description: '[Brakes] Wear and tear: grinding',
        categoryId: 'cat-brakes',
        knowledgeEntryId: entry.id,
        steps: { create: entry.steps },
      },
      {
        description: '[Brakes] Unknown: noise',
        categoryId: 'cat-brakes',
        knowledgeEntryId: null,
      },
    ]);
  });

  // Spec 0010, AC-3, AC-5 and AC-10
  it('saves the ticket as Assigned with its priority, reporter, assignments and one clock', async () => {
    const { prisma, service } = setupCreate();
    await service.create(dto, admin, defaultAbility(admin));
    const [{ data }] = prisma.repairTicket.create.mock.calls[0] as [
      {
        data: {
          lastActivityAt: Date;
          assignments: { create: Record<string, unknown>[] };
          auditLogs: { create: Record<string, unknown>[] };
          statusChangedAt: Date;
        } & Record<string, unknown>;
      },
    ];
    const now = data.statusChangedAt;
    expect(data).toMatchObject({
      repairStatus: RepairStatus.ASSIGNED,
      priority: 'HIGH',
      reportedByUserId: admin.sub,
      reportedByName: 'Victor Ramos',
    });
    expect(data.assignments.create).toEqual([
      {
        mechanicId: '00000000-0000-4000-8000-0000000000cc',
        assignedAt: now,
        assignedByUserId: admin.sub,
        assignedByName: 'Victor Ramos',
      },
    ]);
    // Spec 0021, AC-5b and AC-3b: CREATED at now, MECHANIC_ASSIGNED 1 ms later, which is the
    // newest row and so the ticket's lastActivityAt
    expect(data.auditLogs.create).toEqual([
      expect.objectContaining({
        action: 'CREATED',
        changes: [],
        createdAt: now,
      }),
      expect.objectContaining({
        action: 'MECHANIC_ASSIGNED',
        changes: [{ field: 'mechanic', before: null, after: 'Mia Cruz' }],
        note: null,
        createdAt: new Date(now.getTime() + 1),
      }),
    ]);
    expect(data.lastActivityAt).toEqual(new Date(now.getTime() + 1));
  });

  it('starts the ticket Open when no mechanic is given (spec 0016, AC-1)', async () => {
    const { prisma, service } = setupCreate();
    await service.create(
      { ...dto, mechanics: undefined },
      admin,
      defaultAbility(admin),
    );
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data).toMatchObject({
      repairStatus: RepairStatus.OPEN,
    });
    // Spec 0029, AC-4: no longer written; VMMS owns the truck's status
    expect(args.data).not.toHaveProperty('priorVehicleStatus');
    expect(args.data.assignments).toEqual({ create: [] });
    // Spec 0021, AC-5b: a ticket created Open writes only CREATED, and lastActivityAt is its time
    const logs = (args.data.auditLogs as { create: { action: string }[] })
      .create;
    expect(logs.map((r) => r.action)).toEqual(['CREATED']);
    expect(args.data.lastActivityAt).toEqual(args.data.statusChangedAt);
  });

  it('never writes the truck or its status history (spec 0029, AC-4)', async () => {
    const { prisma, service } = setupCreate();
    await service.create(dto, admin, defaultAbility(admin));
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.vehicleChange.create).not.toHaveBeenCalled();
  });

  it('answers 409 OPEN_TICKET_EXISTS and writes nothing when the truck has an open ticket (spec 0016, AC-3)', async () => {
    const { prisma, service } = setupCreate();
    prisma.repairTicket.findFirst.mockResolvedValue({
      id: 't9',
      repairNumber: 'REP-20261101-AAAA',
    });
    const run = service.create(dto, admin, defaultAbility(admin));
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(run).rejects.toMatchObject({
      response: {
        code: 'OPEN_TICKET_EXISTS',
        ticket: { id: 't9', repairNumber: 'REP-20261101-AAAA' },
      },
    });
    expect(prisma.driver.create).not.toHaveBeenCalled();
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.repairTicket.create).not.toHaveBeenCalled();
  });

  it('refuses an entry that is not Active, before any write', async () => {
    const { prisma, service } = setupCreate([]);
    await expect(
      service.create(dto, admin, defaultAbility(admin)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.driver.create).not.toHaveBeenCalled();
    expect(prisma.repairTicket.create).not.toHaveBeenCalled();
  });

  // ── Spec 0016, step 5 to 7: the form data rules ─────────────────────────

  const NEW_DRIVER = { name: 'Juan Dela Cruz', licenseNumber: 'N01-23-456789' };
  const CORP_ID = '00000000-0000-4000-8000-0000000000c1';

  it('refuses a body with neither or both of driverId and newDriver (AC-6)', async () => {
    const { service } = setupCreate();
    const neither = { ...dto, driverId: undefined };
    await expect(
      service.create(neither, admin, defaultAbility(admin)),
    ).rejects.toThrow('Choose or add a driver.');
    const both = { ...dto, newDriver: NEW_DRIVER };
    await expect(
      service.create(both, admin, defaultAbility(admin)),
    ).rejects.toThrow('Choose or add a driver.');
  });

  it('refuses a driverId that is not an active driver (AC-6)', async () => {
    const { prisma, service } = setupCreate();
    prisma.driver.findFirst.mockResolvedValue(null);
    await expect(
      service.create(dto, admin, defaultAbility(admin)),
    ).rejects.toThrow('This driver is no longer available. Choose another.');
  });

  it('answers 409 DRIVER_EXISTS when the license belongs to an active driver (AC-6)', async () => {
    const { prisma, service } = setupCreate();
    prisma.driver.findUnique.mockResolvedValue({
      id: 'd7',
      name: 'Pedro',
      isActive: true,
      deletedAt: null,
    });
    const run = service.create(
      { ...dto, driverId: undefined, newDriver: NEW_DRIVER },
      admin,
      defaultAbility(admin),
    );
    await expect(run).rejects.toMatchObject({
      response: { code: 'DRIVER_EXISTS', driver: { id: 'd7', name: 'Pedro' } },
    });
    expect(prisma.repairTicket.create).not.toHaveBeenCalled();
  });

  it('reactivates an inactive driver with that license and keeps the stored name (AC-6)', async () => {
    const { prisma, service } = setupCreate();
    prisma.driver.findUnique.mockResolvedValue({
      id: 'd8',
      name: 'Old Name',
      isActive: false,
      deletedAt: new Date(),
    });
    (prisma.driver as Record<string, unknown>).update = jest
      .fn()
      .mockResolvedValue({});
    await service.create(
      { ...dto, driverId: undefined, newDriver: NEW_DRIVER },
      admin,
      defaultAbility(admin),
    );
    expect(
      (prisma.driver as unknown as { update: jest.Mock }).update,
    ).toHaveBeenCalledWith({
      where: { id: 'd8' },
      data: { isActive: true, deletedAt: null },
    });
    expect(prisma.driver.create).not.toHaveBeenCalled();
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: { driverId: string } },
    ];
    expect(args.data.driverId).toBe('d8');
  });

  it('requires an active corporation for a corporate account and stores its name (AC-4)', async () => {
    const { prisma, service } = setupCreate();
    const corporate = { ...dto, accountType: 'CORPORATE' as const };
    await expect(
      service.create(corporate, admin, defaultAbility(admin)),
    ).rejects.toThrow('Choose a corporation.');

    prisma.lookupValue.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create(
        { ...corporate, corporationId: CORP_ID },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toThrow(
      'This corporation is no longer available. Choose another.',
    );

    await service.create(
      { ...corporate, corporationId: CORP_ID },
      admin,
      defaultAbility(admin),
    );
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data).toMatchObject({
      accountType: 'CORPORATE',
      corporation: 'Metro Freight Corp',
    });
  });

  it('stores no corporation for an online account, whatever corporationId says (AC-4)', async () => {
    const { prisma, service } = setupCreate();
    await service.create(
      { ...dto, corporationId: CORP_ID },
      admin,
      defaultAbility(admin),
    );
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data).toMatchObject({
      accountType: 'ONLINE',
      corporation: null,
    });
    expect(prisma.lookupValue.findFirst).not.toHaveBeenCalled();
  });

  it('uses the entry name when a linked issue has a blank description (AC-5)', async () => {
    const { prisma, service } = setupCreate();
    await service.create(
      { ...dto, issues: [{ ...dto.issues[0], description: undefined }] },
      admin,
      defaultAbility(admin),
    );
    const [args] = prisma.repairTicket.create.mock.calls[0] as [
      { data: { issues: { create: { description: string }[] } } },
    ];
    expect(args.data.issues.create[0].description).toBe(
      '[Brakes] Wear and tear: Brake pads worn',
    );
  });

  describe('odometer (AC-7)', () => {
    it('refuses a reading below the last one and names it', async () => {
      const { prisma, service } = setupCreate();
      prisma.repairTicket.aggregate.mockResolvedValue({
        _max: { odometer: 45210 },
      });
      const run = service.create(dto, admin, defaultAbility(admin));
      await expect(run).rejects.toMatchObject({
        response: { code: 'ODOMETER_BELOW_LAST', last: 45210 },
      });
      expect(prisma.repairTicket.create).not.toHaveBeenCalled();
    });

    it('accepts a reading equal to the last one', async () => {
      const { prisma, service } = setupCreate();
      prisma.repairTicket.aggregate.mockResolvedValue({
        _max: { odometer: 1000 },
      });
      await service.create(dto, admin, defaultAbility(admin));
      expect(prisma.repairTicket.create).toHaveBeenCalled();
    });

    it('needs confirmOdometerJump above the warn distance, and passes with it', async () => {
      const { prisma, service } = setupCreate();
      prisma.repairTicket.aggregate.mockResolvedValue({
        _max: { odometer: 1000 },
      });
      const far = { ...dto, odometerReading: 26000 };
      await expect(
        service.create(far, admin, defaultAbility(admin)),
      ).rejects.toMatchObject({
        response: { code: 'ODOMETER_JUMP_UNCONFIRMED', last: 1000 },
      });
      await service.create(
        { ...far, confirmOdometerJump: true },
        admin,
        defaultAbility(admin),
      );
      expect(prisma.repairTicket.create).toHaveBeenCalledTimes(1);
    });

    it('never asks about a jump when the truck has no baseline (floor 0)', async () => {
      const { prisma, service } = setupCreate();
      await service.create(
        { ...dto, odometerReading: 150000 },
        admin,
        defaultAbility(admin),
      );
      expect(prisma.repairTicket.create).toHaveBeenCalled();
    });

    it('falls back to the vehicle reading only when the truck has no tickets', async () => {
      const { prisma, service } = setupCreate();
      prisma.vehicle.findUniqueOrThrow.mockResolvedValue({ odometer: 5000 });
      await expect(
        service.create(dto, admin, defaultAbility(admin)),
      ).rejects.toMatchObject({
        response: { code: 'ODOMETER_BELOW_LAST', last: 5000 },
      });
    });
  });
});
