import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { RepairsService } from './repairs.service';
import { editNote } from './ticket-edits';
import { TicketEditsService } from './ticket-edits.service';

// Spec 0019: the shared edit rules and the details save.

const admin = {
  sub: '00000000-0000-4000-8000-000000000010',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};
const mechanic = {
  sub: '00000000-0000-4000-8000-000000000030',
  email: 'vrms.mech@welinc.com',
  name: 'Ana Cruz',
  roles: [{ role: UserRole.MECHANIC, system: 'VRMS' }],
  system: 'VRMS',
};
const LOADED = new Date('2026-11-03T01:00:00.000Z');
const AT = LOADED.toISOString();

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    repairNumber: 'REP-1',
    repairStatus: RepairStatus.IN_PROGRESS,
    isUnlocked: false,
    updatedAt: LOADED,
    vehicleId: 'v1',
    odometer: 120400,
    priority: 'MEDIUM',
    accountType: 'ONLINE',
    corporation: null,
    driver: { name: 'Juan Cruz', licenseNumber: 'A01-23-456789' },
    assignments: [],
    ...overrides,
  };
}

function setup(row = ticketRow()) {
  const tx = {
    repairTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...row, saved: true }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    repairTicket: { findUnique: jest.fn().mockResolvedValue(row) },
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  const repairs = { present: jest.fn((t: unknown) => Promise.resolve(t)) };
  const service = new TicketEditsService(
    prisma as unknown as PrismaService,
    repairs as unknown as RepairsService,
  );
  return { service, tx, prisma, repairs };
}

type UpdateCall = [{ where: unknown; data: Record<string, unknown> }];
type AuditCall = [
  { data: { action: string; changes: unknown; note: unknown } },
];

/** The `code` of the 400 a call throws, or undefined when it throws none. */
function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    if (err instanceof BadRequestException) {
      return (err.getResponse() as { code?: unknown }).code;
    }
    throw err;
  }
  return undefined;
}

describe('editNote (AC-2, AC-3)', () => {
  it.each([
    RepairStatus.OPEN,
    RepairStatus.ASSIGNED,
    RepairStatus.IN_PROGRESS,
    RepairStatus.ON_HOLD,
    RepairStatus.FOR_VERIFICATION,
    RepairStatus.OUTSOURCED,
    RepairStatus.PENDING_APPROVAL,
  ])('needs no reason on %s', (status) => {
    expect(
      editNote({ repairStatus: status, isUnlocked: false }, undefined),
    ).toBeNull();
  });

  it.each([RepairStatus.CLOSED, RepairStatus.CANCELLED])(
    'answers TICKET_LOCKED on a locked %s ticket',
    (status) => {
      expect(
        codeOf(() =>
          editNote(
            { repairStatus: status, isUnlocked: false },
            'A good reason',
          ),
        ),
      ).toBe('TICKET_LOCKED');
    },
  );

  it.each([undefined, '', '   ', 'abcd', 'x'.repeat(501)])(
    'answers REASON_REQUIRED on an unlocked closed ticket for %p',
    (reason) => {
      expect(
        codeOf(() =>
          editNote(
            { repairStatus: RepairStatus.CLOSED, isUnlocked: true },
            reason,
          ),
        ),
      ).toBe('REASON_REQUIRED');
    },
  );

  it('returns the trimmed reason as the note', () => {
    expect(
      editNote(
        { repairStatus: RepairStatus.CANCELLED, isUnlocked: true },
        '  Wrong truck priority  ',
      ),
    ).toBe('Wrong truck priority');
  });
});

describe('TicketEditsService.editDetails (priority)', () => {
  it('saves the priority with the stamp and one TICKET_EDITED row', async () => {
    const { service, tx } = setup();
    await service.editDetails(
      't1',
      { lastUpdatedAt: AT, priority: 'HIGH' },
      admin,
      defaultAbility(admin),
    );

    const [update] = tx.repairTicket.updateMany.mock.calls[0] as UpdateCall;
    // AC-19: the guarded write carries the stamp and the change
    expect(update.where).toEqual({ id: 't1', updatedAt: LOADED });
    expect(update.data).toMatchObject({
      priority: 'HIGH',
      editedByUserId: admin.sub,
      editedByName: 'Victor Ramos',
    });
    expect(update.data.editedAt).toBe(update.data.updatedAt);
    expect(update.data.lastActivityAt).toBe(update.data.updatedAt);
    // isUnlocked is never touched by an edit (AC-3)
    expect(update.data).not.toHaveProperty('isUnlocked');

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const [audit] = tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.action).toBe('TICKET_EDITED');
    expect(audit.data.changes).toEqual([
      { field: 'priority', before: 'MEDIUM', after: 'HIGH' },
    ]);
    expect(audit.data.note).toBeNull();
  });

  it('answers with the ticket and writes nothing when nothing changed (AC-8b)', async () => {
    const { service, prisma, repairs } = setup();
    await service.editDetails(
      't1',
      { lastUpdatedAt: AT, priority: 'MEDIUM' },
      admin,
      defaultAbility(admin),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(repairs.present).toHaveBeenCalledTimes(1);
  });

  it('answers 409 when lastUpdatedAt is stale (AC-18)', async () => {
    const { service } = setup();
    await expect(
      service.editDetails(
        't1',
        { lastUpdatedAt: '2026-01-01T00:00:00.000Z', priority: 'HIGH' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 409 when another save moved updatedAt inside the transaction (AC-19)', async () => {
    const { service, tx } = setup();
    tx.repairTicket.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.editDetails(
        't1',
        { lastUpdatedAt: AT, priority: 'HIGH' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing ticket', async () => {
    const { service, prisma } = setup();
    prisma.repairTicket.findUnique.mockResolvedValue(null);
    await expect(
      service.editDetails(
        't1',
        { lastUpdatedAt: AT, priority: 'HIGH' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 403 on a ticket the caller can not read', async () => {
    const { service } = setup();
    await expect(
      service.editDetails(
        't1',
        { lastUpdatedAt: AT, priority: 'HIGH' },
        mechanic,
        defaultAbility(mechanic),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a locked closed ticket and takes the reason as the note once unlocked', async () => {
    const locked = setup(ticketRow({ repairStatus: RepairStatus.CLOSED }));
    await expect(
      locked.service.editDetails(
        't1',
        { lastUpdatedAt: AT, priority: 'HIGH' },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const unlocked = setup(
      ticketRow({ repairStatus: RepairStatus.CLOSED, isUnlocked: true }),
    );
    await unlocked.service.editDetails(
      't1',
      {
        lastUpdatedAt: AT,
        priority: 'HIGH',
        reason: 'Priority was entered wrong',
      },
      admin,
      defaultAbility(admin),
    );
    const [audit] = unlocked.tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.note).toBe('Priority was entered wrong');
    const [update] = unlocked.tx.repairTicket.updateMany.mock
      .calls[0] as UpdateCall;
    // The status never changes from an edit
    expect(update.data).not.toHaveProperty('repairStatus');
  });
});
