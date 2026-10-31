import { BadRequestException, ConflictException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { PrismaService } from '../../shared/prisma.service';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { RepairsService } from './repairs.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';

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
  };
  return {
    tx,
    prisma,
    service: new RepairsService(
      prisma as unknown as PrismaService,
      new FakeSettings(),
      new FakeEmbeddings().asService(),
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
        findFirst: jest.fn().mockResolvedValue({ id: 'v1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
      issueCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'cat-brakes', name: 'Brakes' }]),
      },
      knowledgeEntry: { findMany: jest.fn().mockResolvedValue(entryRows) },
      driver: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'd1' }),
      },
      mechanic: { count: jest.fn().mockResolvedValue(1) },
      repairTicket: { create: jest.fn().mockResolvedValue(fullTicket()) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      // lastRejection, as the fixture ticket is In progress (spec 0014, AC-14)
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return {
      prisma,
      service: new RepairsService(
        prisma as unknown as PrismaService,
        new FakeSettings(),
        new FakeEmbeddings().asService(),
      ),
    };
  }

  const dto = {
    vehiclePlate: 'ABC 123',
    driverName: 'Driver',
    issueDescription: 'x',
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
          auditLogs: { create: Record<string, unknown> };
        } & Record<string, unknown>;
      },
    ];
    expect(data).toMatchObject({
      repairStatus: RepairStatus.ASSIGNED,
      priority: 'HIGH',
      reportedByUserId: admin.sub,
      reportedByName: 'Victor Ramos',
    });
    expect(data.assignments.create).toEqual([
      {
        mechanicId: '00000000-0000-4000-8000-0000000000cc',
        assignedAt: data.lastActivityAt,
        assignedByUserId: admin.sub,
        assignedByName: 'Victor Ramos',
      },
    ]);
    expect(data.auditLogs.create).toMatchObject({
      action: 'CREATED',
      changes: [],
      createdAt: data.lastActivityAt,
    });
  });

  it('refuses an entry that is not Active, before any write', async () => {
    const { prisma, service } = setupCreate([]);
    await expect(
      service.create(dto, admin, defaultAbility(admin)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.driver.create).not.toHaveBeenCalled();
    expect(prisma.repairTicket.create).not.toHaveBeenCalled();
  });
});
