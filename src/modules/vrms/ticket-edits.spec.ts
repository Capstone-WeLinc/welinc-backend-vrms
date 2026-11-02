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
import { FakeSettings } from '../../settings/settings.fake';
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
    driverId: 'd1',
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    driver: { name: 'Juan Cruz', licenseNumber: 'A01-23-456789' },
    assignments: [],
    ...overrides,
  };
}

type Bound = { odometer: number; repairNumber: string } | null;

function setup(
  row = ticketRow(),
  bounds: { before?: Bound; after?: Bound; vehicle?: number } = {},
) {
  const tx = {
    repairTicket: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...row, saved: true }),
    },
    driver: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'd3',
        name: 'Pedro Reyes',
        licenseNumber: 'B02-34-567890',
      }),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue(row),
      // ticketOdometerBounds: the floor query first, then the ceiling query
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(bounds.before ?? null)
        .mockResolvedValueOnce(bounds.after ?? null),
    },
    vehicle: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ odometer: bounds.vehicle ?? 100000 }),
    },
    driver: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'd2',
        name: 'Maria Santos',
        licenseNumber: 'C03-45-678901',
      }),
      findUnique: jest.fn(),
    },
    lookupValue: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Acme Logistics' }),
    },
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  const repairs = { present: jest.fn((t: unknown) => Promise.resolve(t)) };
  const service = new TicketEditsService(
    prisma as unknown as PrismaService,
    repairs as unknown as RepairsService,
    new FakeSettings({ 'tickets.odometer_jump_warn_km': 5000 }),
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

/** The `code` of the 400 or 409 a promise rejects with. */
async function rejectedCode(run: Promise<unknown>): Promise<unknown> {
  const err = await run.catch((e: unknown) => e);
  if (err instanceof BadRequestException || err instanceof ConflictException) {
    return (err.getResponse() as { code?: unknown }).code;
  }
  return err;
}

describe('TicketEditsService.editDetails (driver, odometer, account)', () => {
  const save = (service: TicketEditsService, body: Record<string, unknown>) =>
    service.editDetails(
      't1',
      { lastUpdatedAt: AT, ...body },
      admin,
      defaultAbility(admin),
    );

  it('swaps the driver, corrects the odometer and raises priority in one row (AC-4, AC-5, AC-6, AC-8)', async () => {
    const { service, tx } = setup(ticketRow(), {
      before: { odometer: 119000, repairNumber: 'REP-0' },
    });
    await save(service, {
      driverId: 'd2',
      odometerReading: 120040,
      priority: 'HIGH',
    });

    const [update] = tx.repairTicket.updateMany.mock.calls[0] as UpdateCall;
    expect(update.data).toMatchObject({ odometer: 120040, priority: 'HIGH' });
    expect(tx.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { driverId: 'd2', updatedAt: update.data.updatedAt },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const [audit] = tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.changes).toEqual([
      {
        field: 'driver',
        before: 'Juan Cruz (A01-23-456789)',
        after: 'Maria Santos (C03-45-678901)',
      },
      { field: 'odometer', before: '120400', after: '120040' },
      { field: 'priority', before: 'MEDIUM', after: 'HIGH' },
    ]);
  });

  it('adds a new driver by license after the stamp, never before (AC-4, AC-19)', async () => {
    const { service, tx } = setup();
    await save(service, {
      newDriver: { name: 'Pedro Reyes', licenseNumber: 'B02-34-567890' },
    });
    const stampOrder = tx.repairTicket.updateMany.mock.invocationCallOrder[0];
    const createOrder = tx.driver.create.mock.invocationCallOrder[0];
    expect(stampOrder).toBeLessThan(createOrder);
    const [audit] = tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.changes).toEqual([
      {
        field: 'driver',
        before: 'Juan Cruz (A01-23-456789)',
        after: 'Pedro Reyes (B02-34-567890)',
      },
    ]);
  });

  it('refuses both a driver and a new driver', async () => {
    const { service } = setup();
    await expect(
      save(service, {
        driverId: 'd2',
        newDriver: { name: 'Pedro', licenseNumber: 'B02-34-567890' },
      }),
    ).rejects.toThrow('Choose or add a driver.');
  });

  it('answers ODOMETER_BELOW_LAST naming the earlier ticket (AC-5)', async () => {
    const { service } = setup(ticketRow(), {
      before: { odometer: 121000, repairNumber: 'REP-0' },
    });
    const err = await save(service, { odometerReading: 120500 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ODOMETER_BELOW_LAST',
      last: 121000,
      repairNumber: 'REP-0',
    });
  });

  it('answers ODOMETER_ABOVE_NEXT naming the later ticket (AC-5)', async () => {
    const { service } = setup(ticketRow(), {
      before: { odometer: 119000, repairNumber: 'REP-0' },
      after: { odometer: 121000, repairNumber: 'REP-2' },
    });
    const err = await save(service, { odometerReading: 121500 }).catch(
      (e: unknown) => e,
    );
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ODOMETER_ABOVE_NEXT',
      next: 121000,
      repairNumber: 'REP-2',
    });
  });

  it('falls back to the vehicle reading with no earlier ticket, and asks to confirm a big jump (AC-5)', async () => {
    const first = setup(ticketRow(), { vehicle: 100000 });
    expect(
      await rejectedCode(save(first.service, { odometerReading: 130000 })),
    ).toBe('ODOMETER_JUMP_UNCONFIRMED');

    const confirmed = setup(ticketRow(), { vehicle: 100000 });
    await save(confirmed.service, {
      odometerReading: 130000,
      confirmOdometerJump: true,
    });
    expect(confirmed.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('switches to Corporate with the corporation snapshot (AC-7)', async () => {
    const { service, tx } = setup();
    await save(service, { accountType: 'CORPORATE', corporationId: 'c1' });
    const [audit] = tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.changes).toEqual([
      { field: 'accountType', before: 'ONLINE', after: 'CORPORATE' },
      { field: 'corporation', before: null, after: 'Acme Logistics' },
    ]);
  });

  it('needs a corporation for Corporate, and refuses one on Online (AC-7)', async () => {
    const corporate = setup();
    await expect(
      save(corporate.service, { accountType: 'CORPORATE' }),
    ).rejects.toThrow('Choose a corporation.');

    const online = setup();
    await expect(
      save(online.service, { corporationId: 'c1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the corporation when the ticket goes Online (AC-7)', async () => {
    const { service, tx } = setup(
      ticketRow({ accountType: 'CORPORATE', corporation: 'Acme Logistics' }),
    );
    await save(service, { accountType: 'ONLINE' });
    const [update] = tx.repairTicket.updateMany.mock.calls[0] as UpdateCall;
    expect(update.data).toMatchObject({
      accountType: 'ONLINE',
      corporation: null,
    });
  });

  it('writes nothing when the same driver and reading are sent back (AC-8b)', async () => {
    const { service, prisma } = setup();
    await save(service, { driverId: 'd1', odometerReading: 120400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
