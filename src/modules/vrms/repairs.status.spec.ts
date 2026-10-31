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

// Spec 0010, AC-3, AC-4, AC-4a, AC-6 and AC-10: today's forward moves on the v2 names, the
// verifier on close, one audit row per event, and lastActivityAt moving with it.

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
    assignments: [
      {
        mechanicId: MECH,
        mechanic: { id: MECH, name: 'Ramon', authUserId: chief.sub },
      },
    ],
    repairParts: [],
    issues: [],
  };
}

function setup(status: RepairStatus, over: Record<string, unknown> = {}) {
  const loaded = {
    ...fullTicket(status),
    vehicleId: 'v1',
    issues: [],
    ...over,
  };
  const tx = {
    repairPart: {
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    repairTicket: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue(loaded),
      update: jest.fn().mockResolvedValue(fullTicket(status)),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    vehicle: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ odometer: 900 }),
    },
    mechanic: { findUnique: jest.fn().mockResolvedValue({ id: MECH }) },
    // The status update passes an array of queries; costs pass a callback
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (client: typeof tx) => unknown)(tx)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return {
    prisma,
    tx,
    service: new RepairsService(
      prisma as unknown as PrismaService,
      new FakeSettings(),
      new FakeEmbeddings().asService(),
    ),
  };
}

type UpdateData = Record<string, unknown>;
const ticketData = (mock: jest.Mock) =>
  (mock.mock.calls[0] as [{ data: UpdateData }])[0].data;
const auditRow = (mock: jest.Mock) =>
  (mock.mock.calls[0] as [{ data: UpdateData }])[0].data;

describe('status sets (AC-4a)', () => {
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

describe('RepairsService.updateStatus on the v2 names', () => {
  it.each([
    [RepairStatus.ASSIGNED, RepairStatus.IN_PROGRESS],
    [RepairStatus.IN_PROGRESS, RepairStatus.FOR_VERIFICATION],
  ])(
    'lets an assigned chief mechanic move %s to %s, moving lastActivityAt with the audit row',
    async (from, to) => {
      const { prisma, service } = setup(from);
      await service.updateStatus(
        TICKET,
        { status: to, lastUpdatedAt: LOADED.toISOString(), resolutions: [] },
        chief,
        defaultAbility(chief),
      );
      const data = ticketData(prisma.repairTicket.update);
      const row = auditRow(prisma.auditLog.create);
      expect(data.repairStatus).toBe(to);
      expect(row).toMatchObject({
        action: 'STATUS_CHANGE',
        changes: [{ field: 'repairStatus', before: from, after: to }],
        actorRole: 'CHIEF_MECHANIC',
      });
      expect(data.lastActivityAt).toBeInstanceOf(Date);
      expect(data.lastActivityAt).toBe(row.createdAt);
      expect(data).not.toHaveProperty('verifiedByUserId');
      expect(data).not.toHaveProperty('closedAt');
    },
  );

  it('records the admin who closes as the verifier, with closedAt at the same instant', async () => {
    const { prisma, service } = setup(RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED },
      admin,
      defaultAbility(admin),
    );
    const data = ticketData(prisma.repairTicket.update);
    expect(data).toMatchObject({
      repairStatus: RepairStatus.CLOSED,
      verifiedByUserId: admin.sub,
      verifiedByName: 'Victor Ramos',
    });
    expect(data.verifiedAt).toBe(data.closedAt);
    expect(data.closedAt).toBe(auditRow(prisma.auditLog.create).createdAt);
  });

  it('sets closedAt but no verifier on cancel, with the reason as the note', async () => {
    const { prisma, service } = setup(RepairStatus.IN_PROGRESS);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CANCELLED, cancellationReason: ' Duplicate ' },
      admin,
      defaultAbility(admin),
    );
    const data = ticketData(prisma.repairTicket.update);
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('verifiedByUserId');
    expect(data.cancellationReason).toBe('Duplicate');
    expect(auditRow(prisma.auditLog.create).note).toBe('Duplicate');
  });

  it.each([RepairStatus.CLOSED, RepairStatus.CANCELLED])(
    'refuses a chief mechanic moving to %s, naming the statuses',
    async (to) => {
      const { prisma, service } = setup(RepairStatus.FOR_VERIFICATION);
      const run = service.updateStatus(
        TICKET,
        { status: to, cancellationReason: 'x' },
        chief,
        defaultAbility(chief),
      );
      await expect(run).rejects.toBeInstanceOf(ForbiddenException);
      await expect(run).rejects.toThrow(
        'Allowed: In progress, For verification.',
      );
      expect(prisma.repairTicket.update).not.toHaveBeenCalled();
    },
  );

  it('rejects a skipped move with the new labels', async () => {
    const { service } = setup(RepairStatus.ASSIGNED);
    const run = service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED },
      admin,
      defaultAbility(admin),
    );
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(
      "Cannot change status from 'Assigned' to 'Closed'",
    );
  });

  it('only cancels from an open status, not an unlocked closed ticket', async () => {
    const { service } = setup(RepairStatus.CLOSED, { isUnlocked: true });
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CANCELLED, cancellationReason: 'x' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toThrow("from 'Closed' to 'Cancelled'");
  });

  it('answers 409 for a stale lastUpdatedAt', async () => {
    const { service } = setup(RepairStatus.ASSIGNED);
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

  it('writes no audit row and leaves lastActivityAt alone on an unlocked save with no move', async () => {
    const { prisma, service } = setup(RepairStatus.CLOSED, {
      isUnlocked: true,
    });
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED },
      admin,
      defaultAbility(admin),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    const data = ticketData(prisma.repairTicket.update);
    expect(data).not.toHaveProperty('lastActivityAt');
    expect(data).not.toHaveProperty('closedAt');
  });
});

describe('RepairsService.updateCosts (AC-6, AC-10)', () => {
  it('writes one COST_UPDATE row with three changes, and moves lastActivityAt with it', async () => {
    const { prisma, tx, service } = setup(RepairStatus.FOR_VERIFICATION, {
      partsCost: 3000,
      laborCost: 1000,
      totalCost: 4000,
      repairParts: [],
    });
    await service.updateCosts(
      TICKET,
      { isLumpSum: true, partsCost: 3500, laborCost: 1700 },
      admin,
      defaultAbility(admin),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const row = auditRow(tx.auditLog.create);
    expect(row).toMatchObject({
      action: 'COST_UPDATE',
      changes: [
        { field: 'partsCost', before: '3000.00', after: '3500.00' },
        { field: 'laborCost', before: '1000.00', after: '1700.00' },
        { field: 'totalCost', before: '4000.00', after: '5200.00' },
        { field: 'isLumpSum', before: 'false', after: 'true' },
      ],
    });
    expect(ticketData(tx.repairTicket.update).lastActivityAt).toBe(
      row.createdAt,
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes no row and keeps lastActivityAt when nothing changed', async () => {
    const { tx, service } = setup(RepairStatus.FOR_VERIFICATION, {
      partsCost: 3000,
      laborCost: 1000,
      totalCost: 4000,
      isLumpSum: true,
      repairParts: [],
    });
    await service.updateCosts(
      TICKET,
      { isLumpSum: true, partsCost: 3000, laborCost: 1000 },
      admin,
      defaultAbility(admin),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(ticketData(tx.repairTicket.update)).not.toHaveProperty(
      'lastActivityAt',
    );
  });
});
