import { ForbiddenException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import {
  defaultAbility,
  defaultKeys,
} from '../../auth/permissions/permissions.fake';
import { buildAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { RepairsService } from './repairs.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';

// Spec 0011, AC-11, AC-12 and AC-12a under the default matrix: who may work or administer a
// ticket, what costs they see, and the per ticket flags the web app shows buttons from.

type Caller = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

const caller = (sub: string, ...roles: UserRole[]): Caller => ({
  sub,
  email: `${sub}@welinc.com`,
  name: sub,
  roles: roles.map((role) => ({ role, system: 'VRMS' })),
  system: 'VRMS',
});

const admin = caller('admin', UserRole.ADMIN);
const chief = caller('chief', UserRole.CHIEF_MECHANIC);
const mechanic = caller('mechanic', UserRole.MECHANIC);
const adminMechanic = caller('both', UserRole.ADMIN, UserRole.MECHANIC);

const TICKET = '00000000-0000-4000-8000-0000000000aa';
const LOADED = new Date('2026-10-29T01:00:00.000Z');
const AT = LOADED.toISOString();

/** A ticket shaped like ticketInclude(), assigned to the welinc-auth user `owner`. */
function ticketOf(owner: string, status: RepairStatus) {
  return {
    id: TICKET,
    repairNumber: 'REP-1',
    repairStatus: status,
    priority: 'HIGH',
    odometer: 1000,
    dueAt: null,
    dueAtSource: null,
    reportedByName: 'admin',
    verifiedByName: null,
    verifiedAt: null,
    createdAt: LOADED,
    updatedAt: LOADED,
    lastActivityAt: LOADED,
    closedAt: null,
    cancellationReason: null,
    remarks: null,
    partsCost: 3000,
    laborCost: 1000,
    totalCost: 4000,
    isLumpSum: true,
    isUnlocked: false,
    unlockReason: null,
    vehicleId: 'v1',
    vehicle: { plateNumber: 'ABC 123', model: 'Hilux', status: 'UNDER_REPAIR' },
    driver: { name: 'Driver', licenseNumber: 'driver', isVerified: true },
    garage: { name: 'Sta. Rosa' },
    assignments: [
      {
        mechanicId: `row-${owner}`,
        mechanic: { id: `row-${owner}`, name: owner, authUserId: owner },
      },
    ],
    repairParts: [],
    issues: [],
  };
}

function setup(owner: string, status: RepairStatus = RepairStatus.ASSIGNED) {
  const row = ticketOf(owner, status);
  const tx = {
    repairTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
    },
    repairIssue: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    vehicle: {
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 900 }),
    },
  };
  const prisma = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(1),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    // Typical hours for linked entries; this ticket has none
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
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

const updateData = (mock: jest.Mock) =>
  (mock.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

describe('ticket can flags (AC-12a)', () => {
  it("gives a chief work on their own ticket and nothing on another mechanic's", async () => {
    const own = await setup('chief').service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    const other = await setup('mechanic').service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    const none = {
      work: false,
      administer: false,
      verify: false,
      editCosts: false,
      unlock: false,
    };
    // Spec 0014, AC-6: verify on any readable ticket except their own
    expect(own.can).toEqual({ ...none, work: true });
    expect(other.can).toEqual({ ...none, verify: true });
  });

  it('gives an admin administer, verify, cost editing and unlock on any ticket, and no work', async () => {
    const res = await setup('mechanic').service.findOne(
      TICKET,
      defaultAbility(admin),
    );
    expect(res.can).toEqual({
      work: false,
      administer: true,
      verify: true,
      editCosts: true,
      unlock: true,
    });
  });

  // Spec 0014, AC-13: the moves this caller may make now, on single ticket responses only
  it('sends a chief only Start work on their own Assigned ticket, and nothing on another', async () => {
    const own = await setup('chief').service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    const other = await setup('mechanic').service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    expect(own.moves).toEqual([
      { to: 'IN_PROGRESS', label: 'Start work', kind: 'forward', needs: null },
    ]);
    expect(other.moves).toEqual([]);
  });

  it('sends resolutions as the need of Send for verification while the knowledge base is on', async () => {
    const res = await setup('chief', RepairStatus.IN_PROGRESS).service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    expect(res.moves).toEqual([
      {
        to: 'FOR_VERIFICATION',
        label: 'Send for verification',
        kind: 'forward',
        needs: 'resolutions',
      },
    ]);
  });

  it('sends no moves on a finished ticket, and none on list rows', async () => {
    const closed = await setup('mechanic', RepairStatus.CLOSED).service.findOne(
      TICKET,
      defaultAbility(admin),
    );
    expect(closed.moves).toEqual([]);
    const { data } = await setup('mechanic').service.findAll(
      {},
      defaultAbility(admin),
    );
    expect(data[0]).not.toHaveProperty('moves');
  });

  it('puts the flags on every list row too', async () => {
    const { data } = await setup('mechanic').service.findAll(
      {},
      defaultAbility(mechanic),
    );
    expect(data[0].can.work).toBe(true);
  });
});

describe('cost fields (AC-11)', () => {
  it('nulls costs for a chief reading every ticket, and keeps them for an admin', async () => {
    const asChief = await setup('mechanic').service.findOne(
      TICKET,
      defaultAbility(chief),
    );
    const asAdmin = await setup('mechanic').service.findOne(
      TICKET,
      defaultAbility(admin),
    );
    expect(asChief).toMatchObject({
      partsCost: null,
      laborCost: null,
      totalCost: null,
    });
    expect(asChief).not.toHaveProperty('repairParts');
    expect(asAdmin).toMatchObject({
      partsCost: 3000,
      laborCost: 1000,
      totalCost: 4000,
    });
  });

  it('ignores cost fields a chief sends with a status move', async () => {
    const { tx, service } = setup('chief', RepairStatus.ASSIGNED);
    await service.updateStatus(
      TICKET,
      {
        status: RepairStatus.IN_PROGRESS,
        partsCost: 1,
        laborCost: 1,
        lastUpdatedAt: AT,
      },
      chief,
      defaultAbility(chief),
    );
    const data = updateData(tx.repairTicket.updateMany);
    expect(data).not.toHaveProperty('partsCost');
    expect(data).not.toHaveProperty('totalCost');
  });
});

describe('work and administer (AC-12)', () => {
  it("refuses a chief moving another mechanic's ticket, though they may read it", async () => {
    const { prisma, service } = setup('mechanic', RepairStatus.ASSIGNED);
    const run = service.updateStatus(
      TICKET,
      { status: RepairStatus.IN_PROGRESS, lastUpdatedAt: AT },
      chief,
      defaultAbility(chief),
    );
    await expect(run).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run).rejects.toThrow(
      "You can't make this move on this ticket.",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a mechanic reading another mechanic's ticket", async () => {
    await expect(
      setup('chief').service.findOne(TICKET, defaultAbility(mechanic)),
    ).rejects.toThrow('You are not assigned to this repair ticket');
  });

  it('lets an admin close a ticket assigned to someone else', async () => {
    const { tx, service } = setup('mechanic', RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(updateData(tx.repairTicket.updateMany).repairStatus).toBe(
      RepairStatus.CLOSED,
    );
  });

  // Spec 0014, AC-6: being assigned blocks verifying, whatever else the caller holds
  it('refuses an assigned admin verifying their own ticket, and offers them no Verify', async () => {
    const { prisma, service } = setup('both', RepairStatus.FOR_VERIFICATION);
    const run = service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      adminMechanic,
      defaultAbility(adminMechanic),
    );
    await expect(run).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run).rejects.toThrow(
      "Someone else must verify work on a ticket you're assigned to.",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const read = await setup(
      'both',
      RepairStatus.FOR_VERIFICATION,
    ).service.findOne(TICKET, defaultAbility(adminMechanic));
    expect(read.moves.map((m) => m.to)).toEqual([RepairStatus.CANCELLED]);
  });

  it('lets a chief verify a ticket they are not assigned to, recording them as verifier', async () => {
    const { tx, service } = setup('mechanic', RepairStatus.FOR_VERIFICATION);
    await service.updateStatus(
      TICKET,
      { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
      chief,
      defaultAbility(chief),
    );
    expect(updateData(tx.repairTicket.updateMany)).toMatchObject({
      repairStatus: RepairStatus.CLOSED,
      verifiedByUserId: 'chief',
    });
  });

  it('lets an admin without ticket.verify cancel but not close', async () => {
    const keys = defaultKeys(['ADMIN']);
    keys.delete('ticket.verify');
    const ability = buildAbility(admin.sub, keys);

    const close = setup('mechanic', RepairStatus.FOR_VERIFICATION);
    await expect(
      close.service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        admin,
        ability,
      ),
    ).rejects.toThrow("You can't make this move on this ticket.");

    const cancel = setup('mechanic', RepairStatus.FOR_VERIFICATION);
    await cancel.service.updateStatus(
      TICKET,
      {
        status: RepairStatus.CANCELLED,
        cancellationReason: 'Duplicate',
        lastUpdatedAt: AT,
      },
      admin,
      ability,
    );
    expect(updateData(cancel.tx.repairTicket.updateMany).repairStatus).toBe(
      RepairStatus.CANCELLED,
    );
  });

  it('refuses a mechanic verifying, though the ticket is theirs to work', async () => {
    const { service } = setup('mechanic', RepairStatus.FOR_VERIFICATION);
    await expect(
      service.updateStatus(
        TICKET,
        { status: RepairStatus.CLOSED, lastUpdatedAt: AT },
        mechanic,
        defaultAbility(mechanic),
      ),
    ).rejects.toThrow("You can't make this move on this ticket.");
  });

  it('refuses ticket steps on a ticket the caller does not own', async () => {
    const { service } = setup('chief', RepairStatus.IN_PROGRESS);
    await expect(
      service.checkStep(
        TICKET,
        TICKET,
        TICKET,
        { checked: true },
        mechanic,
        defaultAbility(mechanic),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
