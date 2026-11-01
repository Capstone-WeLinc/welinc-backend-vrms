import { BadRequestException, ConflictException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { PrismaService } from '../../shared/prisma.service';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { RepairsService } from './repairs.service';

// Spec 0016, AC-16 and AC-17: assign mechanics to an Open ticket (move M1).

const chief = {
  sub: '00000000-0000-4000-8000-000000000020',
  email: 'vrms.chief@welinc.com',
  name: 'Ramon Villanueva',
  roles: [{ role: UserRole.CHIEF_MECHANIC, system: 'VRMS' }],
  system: 'VRMS',
};
const LOADED = new Date('2026-11-01T01:00:00.000Z');
const AT = LOADED.toISOString();
const M1 = '00000000-0000-4000-8000-0000000000b1';
const M2 = '00000000-0000-4000-8000-0000000000b2';

function ticketRow(status: RepairStatus) {
  return {
    id: 't1',
    repairNumber: 'REP-1',
    repairStatus: status,
    updatedAt: LOADED,
    vehicleId: 'v1',
    odometer: 1000,
    priorVehicleStatus: null,
    assignments: [],
  };
}

function setup(
  status: RepairStatus,
  mechanics = [
    { id: M1, name: 'Ana' },
    { id: M2, name: 'Ben' },
  ],
) {
  const tx = {
    ticketAssignment: { createMany: jest.fn().mockResolvedValue({}) },
    repairTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...ticketRow(RepairStatus.ASSIGNED),
        priority: 'HIGH',
        dueAt: null,
        dueAtSource: null,
        reportedByName: 'Victor Ramos',
        verifiedByName: null,
        verifiedAt: null,
        createdAt: LOADED,
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
        assignments: [],
        issues: [],
        repairParts: [],
        vehicle: { plateNumber: 'A', model: 'M', status: 'UNDER_REPAIR' },
        driver: { name: 'D', licenseNumber: 'x', isVerified: true },
        garage: { name: 'G' },
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    repairIssue: { updateMany: jest.fn() },
    vehicle: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue(ticketRow(status)),
    },
    mechanic: { findMany: jest.fn().mockResolvedValue(mechanics) },
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  const service = new RepairsService(
    prisma as unknown as PrismaService,
    new FakeSettings({}),
    new FakeEmbeddings().asService(),
  );
  return { service, tx, prisma };
}

const ability = () => defaultAbility(chief);

describe('RepairsService.assignMechanics', () => {
  it('creates the assignments and moves the ticket to Assigned with one MECHANIC_ASSIGNED row', async () => {
    const { service, tx } = setup(RepairStatus.OPEN);
    await service.assignMechanics(
      't1',
      { mechanics: [{ id: M1 }, { id: M2 }], lastUpdatedAt: AT },
      chief,
      ability(),
    );
    const created = tx.ticketAssignment.createMany.mock.calls[0] as [
      { data: { mechanicId: string; assignedByUserId: string }[] },
    ];
    expect(created[0].data.map((d) => d.mechanicId)).toEqual([M1, M2]);
    expect(created[0].data[0].assignedByUserId).toBe(chief.sub);
    const update = tx.repairTicket.updateMany.mock.calls[0] as [
      { data: { repairStatus: string } },
    ];
    expect(update[0].data.repairStatus).toBe('ASSIGNED');
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0] as [
      { data: { action: string; changes: unknown } },
    ];
    expect(audit[0].data.action).toBe('MECHANIC_ASSIGNED');
    expect(JSON.stringify(audit[0].data.changes)).toContain('Ana');
    expect(JSON.stringify(audit[0].data.changes)).toContain('ASSIGNED');
  });

  it('refuses a ticket that is not Open', async () => {
    const { service } = setup(RepairStatus.IN_PROGRESS);
    await expect(
      service.assignMechanics(
        't1',
        { mechanics: [{ id: M1 }], lastUpdatedAt: AT },
        chief,
        ability(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 409 on a stale lastUpdatedAt', async () => {
    const { service } = setup(RepairStatus.OPEN);
    await expect(
      service.assignMechanics(
        't1',
        { mechanics: [{ id: M1 }], lastUpdatedAt: '2026-01-01T00:00:00.000Z' },
        chief,
        ability(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a mechanic who is not active or does not exist', async () => {
    const { service, tx } = setup(RepairStatus.OPEN, [{ id: M1, name: 'Ana' }]);
    await expect(
      service.assignMechanics(
        't1',
        { mechanics: [{ id: M1 }, { id: M2 }], lastUpdatedAt: AT },
        chief,
        ability(),
      ),
    ).rejects.toThrow('In house mechanic not found');
    expect(tx.ticketAssignment.createMany).not.toHaveBeenCalled();
  });

  it('refuses the same mechanic twice', async () => {
    const { service } = setup(RepairStatus.OPEN);
    await expect(
      service.assignMechanics(
        't1',
        { mechanics: [{ id: M1 }, { id: M1 }], lastUpdatedAt: AT },
        chief,
        ability(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
