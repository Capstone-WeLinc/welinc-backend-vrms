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
import { FakeEmbeddings } from '../ai/embedding.fake';
import { RepairsService } from './repairs.service';
import { editNote } from './ticket-edits';
import { TicketEditsService } from './ticket-edits.service';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { OutsideShopsService } from '../integrations/fleet/outside-shops.service';

// Spec 0029 (child 0003): the BMS writers and the banner read, tested in their own specs
jest.mock('../integrations/bms/bms-repair-updates', () => ({
  ...jest.requireActual<object>('../integrations/bms/bms-repair-updates'),
  queueBmsRepairUpdate: jest.fn(() => Promise.resolve({ deliveryId: 'b-1' })),
}));
jest.mock('../integrations/bms/expedite-answers', () => ({
  ...jest.requireActual<object>('../integrations/bms/expedite-answers'),
  declineWaitingExpedites: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('./expedite-views', () => ({
  ...jest.requireActual<object>('./expedite-views'),
  waitingExpedites: jest.fn(() => Promise.resolve([])),
}));

// Spec 0029, AC-13: the VMMS event's reads and insert are tested in apply-status-move.spec
jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn(() => Promise.resolve({ deliveryId: 'd-1' })),
}));

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
  bounds: { before?: Bound; after?: Bound } = {},
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
  const repairs = {
    // Spec 0030: the due date recompute (its own rules are tested in due-dates.spec.ts)
    recomputeDueAt: jest.fn().mockResolvedValue(false),
    present: jest.fn((t: unknown) => Promise.resolve(t)),
  };
  const embeddings = new FakeEmbeddings();
  const fleet = new FakeFleet();
  const service = new TicketEditsService(
    prisma as unknown as PrismaService,
    repairs as unknown as RepairsService,
    new FakeSettings({ 'tickets.odometer_jump_warn_km': 5000 }),
    embeddings.asService(),
    new OutsideShopsService(fleet.asClient()),
  );
  return { service, tx, prisma, repairs, embeddings, fleet };
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
    const { service, tx, repairs } = setup();
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
    // Spec 0030, AC-5: a new priority works the due date out again, after the edit row
    expect(repairs.recomputeDueAt).toHaveBeenCalledWith(
      tx,
      't1',
      expect.objectContaining({ trigger: 'PRIORITY' }),
    );
  });

  it('leaves the due date alone when the priority stays (spec 0030, AC-5)', async () => {
    const { service, repairs } = setup();
    await service.editDetails(
      't1',
      { lastUpdatedAt: AT, odometerReading: 1200 },
      admin,
      defaultAbility(admin),
    );
    expect(repairs.recomputeDueAt).not.toHaveBeenCalled();
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

  it('has no floor and no jump check with no earlier ticket, so the oldest ticket can be corrected (AC-5)', async () => {
    // Far below any vehicle reading, and a big jump from nothing: both save with no confirm
    const low = setup(ticketRow());
    await save(low.service, { odometerReading: 50000 });
    expect(low.tx.auditLog.create).toHaveBeenCalledTimes(1);

    const high = setup(ticketRow());
    await save(high.service, { odometerReading: 900000 });
    expect(high.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('still holds the ceiling when there is no earlier ticket (AC-5)', async () => {
    const { service } = setup(ticketRow(), {
      after: { odometer: 121000, repairNumber: 'REP-2' },
    });
    expect(await rejectedCode(save(service, { odometerReading: 121500 }))).toBe(
      'ODOMETER_ABOVE_NEXT',
    );
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

describe('TicketEditsService mechanics (AC-9 to AC-12)', () => {
  const ANA = { id: 'm1', name: 'Ana', authUserId: 'u-ana', isActive: true };
  const BEN = { id: 'm2', name: 'Ben', authUserId: 'u-ben', isActive: true };
  const CHIEF = {
    id: 'm3',
    name: 'Ramon',
    authUserId: 'u-chief',
    isActive: true,
  };

  function mechanicsSetup(
    status: RepairStatus,
    assigned: (typeof ANA)[],
    extra: Record<string, unknown> = {},
  ) {
    const row = ticketRow({
      repairStatus: status,
      priorVehicleStatus: null,
      verifiedByUserId: null,
      assignments: assigned.map((m) => ({ mechanicId: m.id, mechanic: m })),
      ...extra,
    });
    const ctx = setup(row);
    const all = [ANA, BEN, CHIEF];
    Object.assign(ctx.prisma, {
      mechanic: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(all.filter((m) => where.id.in.includes(m.id))),
        ),
      },
    });
    Object.assign(ctx.tx, {
      ticketAssignment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      repairIssue: { updateMany: jest.fn() },
      vehicle: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    });
    return ctx as typeof ctx & {
      tx: typeof ctx.tx & {
        ticketAssignment: { deleteMany: jest.Mock; createMany: jest.Mock };
      };
    };
  }

  const put = (service: TicketEditsService, ids: string[], user = admin) =>
    service.setMechanics(
      't1',
      { lastUpdatedAt: AT, mechanics: ids.map((id) => ({ id })) },
      user,
      defaultAbility(user),
    );

  const audits = (tx: { auditLog: { create: jest.Mock } }) =>
    (tx.auditLog.create.mock.calls as AuditCall[]).map(([c]) => c.data);

  it('moves an Open ticket to Assigned on its first mechanic, with one MECHANIC_ASSIGNED row (M1)', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.OPEN, []);
    await put(service, ['m1', 'm2']);
    const rows = audits(tx);
    expect(rows.map((r) => r.action)).toEqual(['MECHANIC_ASSIGNED']);
    expect(rows[0].changes).toEqual([
      { field: 'mechanic', before: null, after: 'Ana' },
      { field: 'mechanic', before: null, after: 'Ben' },
      { field: 'repairStatus', before: 'OPEN', after: 'ASSIGNED' },
    ]);
    const updates = tx.repairTicket.updateMany.mock.calls as UpdateCall[];
    // The stamp first, then the move's own guarded update on the stamped version
    expect(updates[0][0].data).toHaveProperty('editedByUserId', admin.sub);
    expect(updates[1][0].data).toMatchObject({ repairStatus: 'ASSIGNED' });
    expect(updates[1][0].where).toEqual({
      id: 't1',
      updatedAt: updates[0][0].data.updatedAt,
    });
  });

  it('sends an Assigned ticket back to Open when its last mechanic leaves (M2)', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.ASSIGNED, [ANA]);
    await put(service, []);
    const rows = audits(tx);
    expect(rows.map((r) => r.action)).toEqual(['MECHANIC_UNASSIGNED']);
    expect(rows[0].changes).toEqual([
      { field: 'mechanic', before: 'Ana', after: null },
      { field: 'repairStatus', before: 'ASSIGNED', after: 'OPEN' },
    ]);
    expect(tx.ticketAssignment.deleteMany).toHaveBeenCalledWith({
      where: { repairTicketId: 't1', mechanicId: { in: ['m1'] } },
    });
  });

  // Spec 0021, AC-3b: rows from one action never share a time
  it('swaps on Assigned with no move: unassigned then assigned, 1 ms apart', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.ASSIGNED, [ANA]);
    await put(service, ['m2']);
    const rows = audits(tx);
    expect(rows.map((r) => r.action)).toEqual([
      'MECHANIC_UNASSIGNED',
      'MECHANIC_ASSIGNED',
    ]);
    expect(rows[0].changes).toEqual([
      { field: 'mechanic', before: 'Ana', after: null },
    ]);
    const at = rows.map((r) => (r as unknown as { createdAt: Date }).createdAt);
    expect(at[1].getTime() - at[0].getTime()).toBe(1);
    // Only the stamp updates the ticket: no status write. updatedAt is now (the first row's
    // time), lastActivityAt the newest row's
    expect(tx.repairTicket.updateMany).toHaveBeenCalledTimes(1);
    const [stamp] = tx.repairTicket.updateMany.mock.calls[0] as UpdateCall;
    expect(stamp.data.updatedAt).toEqual(at[0]);
    expect(stamp.data).toMatchObject({ lastActivityAt: at[1] });
  });

  it('a single row (including a move) keeps the action time for the row and lastActivityAt', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.OPEN, []);
    await put(service, ['m1']);
    const [row] = audits(tx) as unknown as { createdAt: Date }[];
    const [stamp, move] = tx.repairTicket.updateMany.mock.calls as UpdateCall[];
    expect(row.createdAt).toEqual(stamp[0].data.updatedAt);
    expect(stamp[0].data).toMatchObject({ lastActivityAt: row.createdAt });
    expect(move[0].data).toMatchObject({ lastActivityAt: row.createdAt });
  });

  it('empties an In progress ticket without changing its status (AC-10)', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.IN_PROGRESS, [ANA]);
    await put(service, []);
    expect(audits(tx).map((r) => r.action)).toEqual(['MECHANIC_UNASSIGNED']);
    const [stamp] = tx.repairTicket.updateMany.mock.calls[0] as UpdateCall;
    expect(stamp.data).not.toHaveProperty('repairStatus');
    expect(tx.repairTicket.updateMany).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for the same list (AC-8b)', async () => {
    const { service, prisma } = mechanicsSetup(RepairStatus.IN_PROGRESS, [ANA]);
    await put(service, ['m1']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a duplicate, an unknown or inactive mechanic (AC-9)', async () => {
    const dup = mechanicsSetup(RepairStatus.OPEN, []);
    await expect(put(dup.service, ['m1', 'm1'])).rejects.toThrow(
      'Choose each mechanic only once.',
    );
    const unknown = mechanicsSetup(RepairStatus.OPEN, []);
    await expect(put(unknown.service, ['m9'])).rejects.toThrow(
      'In house mechanic not found',
    );
  });

  it('never adds the verifier, but keeps the closed status and takes the reason (AC-3, AC-11)', async () => {
    const closed = {
      isUnlocked: true,
      verifiedByUserId: 'u-chief',
    };
    const blocked = mechanicsSetup(RepairStatus.CLOSED, [ANA], closed);
    await expect(
      blocked.service.setMechanics(
        't1',
        {
          lastUpdatedAt: AT,
          reason: 'Wrong mechanic recorded',
          mechanics: [{ id: 'm1' }, { id: 'm3' }],
        },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toThrow(
      "The person who verified this ticket can't be added to it.",
    );

    const ok = mechanicsSetup(RepairStatus.CLOSED, [ANA], closed);
    await ok.service.setMechanics(
      't1',
      {
        lastUpdatedAt: AT,
        reason: 'Wrong mechanic recorded',
        mechanics: [{ id: 'm2' }],
      },
      admin,
      defaultAbility(admin),
    );
    const rows = audits(ok.tx);
    expect(rows.map((r) => r.note)).toEqual([
      'Wrong mechanic recorded',
      'Wrong mechanic recorded',
    ]);
    expect(ok.tx.repairTicket.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps the old POST working: it adds to the current list (alias)', async () => {
    const { service, tx } = mechanicsSetup(RepairStatus.ASSIGNED, [ANA]);
    await service.addMechanics(
      't1',
      { lastUpdatedAt: AT, mechanics: [{ id: 'm2' }] },
      admin,
      defaultAbility(admin),
    );
    expect(tx.ticketAssignment.deleteMany).not.toHaveBeenCalled();
    expect(audits(tx).map((r) => r.action)).toEqual(['MECHANIC_ASSIGNED']);
  });
});

describe('TicketEditsService issues (AC-14 to AC-17)', () => {
  const BRAKES = { id: 'cat-brakes', name: 'Brakes', isActive: true };
  const ENGINE = { id: 'cat-engine', name: 'Engine', isActive: true };
  const issue = (over: Record<string, unknown> = {}) => ({
    id: 'i1',
    description: '[Brakes] Wear and tear: Pads worn',
    categoryId: BRAKES.id,
    category: { name: 'Brakes' },
    knowledgeEntry: null,
    resolutionNote: null,
    steps: [],
    ...over,
  });

  function issuesSetup(issues: unknown[], extra: Record<string, unknown> = {}) {
    const ctx = setup(ticketRow({ issues, ...extra }));
    Object.assign(ctx.prisma, {
      issueCategory: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            [BRAKES, ENGINE].find((c) => c.id === where.id) ?? null,
          ),
        ),
      },
      knowledgeEntry: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'k1',
          name: 'Replace brake pads',
          steps: [
            { position: 1, text: 'Lift the truck' },
            { position: 2, text: 'Swap the pads' },
          ],
        }),
      },
    });
    Object.assign(ctx.tx, {
      repairIssue: {
        create: jest.fn().mockResolvedValue({ id: 'i-new' }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      repairIssueStep: { deleteMany: jest.fn().mockResolvedValue({}) },
    });
    return ctx as typeof ctx & {
      tx: typeof ctx.tx & {
        repairIssue: {
          create: jest.Mock;
          update: jest.Mock;
          delete: jest.Mock;
        };
        repairIssueStep: { deleteMany: jest.Mock };
      };
    };
  }

  const auditOf = (tx: { auditLog: { create: jest.Mock } }) =>
    (tx.auditLog.create.mock.calls[0] as AuditCall)[0].data;

  it('adds an issue the way create builds it, with the copied steps and an ISSUE_ADDED row (AC-14)', async () => {
    const { service, tx, embeddings } = issuesSetup([issue()]);
    await service.addIssue(
      't1',
      {
        lastUpdatedAt: AT,
        categoryId: BRAKES.id,
        rootCause: 'Hydraulic leak',
        knowledgeEntryId: 'k1',
      },
      admin,
      defaultAbility(admin),
    );
    const [created] = tx.repairIssue.create.mock.calls[0] as [
      { data: { description: string; steps: { create: unknown[] } } },
    ];
    // A blank description with a known fix takes the entry's name
    expect(created.data.description).toBe(
      '[Brakes] Hydraulic leak: Replace brake pads',
    );
    expect(created.data.steps.create).toHaveLength(2);
    expect(auditOf(tx).action).toBe('ISSUE_ADDED');
    expect(embeddings.calls).toEqual([['i-new']]);
  });

  it('rewords an issue under a new system and clears a known fix from the old one (AC-15)', async () => {
    const linked = issue({
      knowledgeEntry: { name: 'Replace brake pads', categoryId: BRAKES.id },
    });
    const { service, tx, embeddings } = issuesSetup([
      linked,
      issue({ id: 'i2' }),
    ]);
    await service.editIssue(
      't1',
      'i1',
      {
        lastUpdatedAt: AT,
        categoryId: ENGINE.id,
        text: 'Overheating: Fan stuck',
      },
      admin,
      defaultAbility(admin),
    );
    expect(tx.repairIssueStep.deleteMany).toHaveBeenCalledWith({
      where: { repairIssueId: 'i1' },
    });
    // Spec 0023, AC-14: the checklist lock moves before the steps go
    expect(tx.repairIssue.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'i1' },
      data: { checklistVersion: { increment: 1 } },
    });
    expect(tx.repairIssue.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.repairIssueStep.deleteMany.mock.invocationCallOrder[0],
    );
    expect(tx.repairIssue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: {
        description: '[Engine] Overheating: Fan stuck',
        categoryId: ENGINE.id,
        knowledgeEntryId: null,
      },
    });
    const audit = auditOf(tx);
    expect(audit.action).toBe('ISSUE_EDITED');
    expect(audit.changes).toEqual([
      {
        field: 'description',
        before: '[Brakes] Wear and tear: Pads worn',
        after: '[Engine] Overheating: Fan stuck',
      },
      { field: 'system', before: 'Brakes', after: 'Engine' },
      { field: 'knowledgeEntry', before: 'Replace brake pads', after: null },
      { field: 'issueId', before: null, after: 'i1' },
    ]);
    expect(embeddings.calls).toEqual([['i1']]);
  });

  it('keeps the known fix when the system stays, and writes nothing for the same text (AC-8b)', async () => {
    const linked = issue({
      knowledgeEntry: { name: 'Replace brake pads', categoryId: BRAKES.id },
    });
    const { service, prisma } = issuesSetup([linked]);
    await service.editIssue(
      't1',
      'i1',
      {
        lastUpdatedAt: AT,
        categoryId: BRAKES.id,
        text: 'Wear and tear: Pads worn',
      },
      admin,
      defaultAbility(admin),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('due date recompute (spec 0030, AC-5)', () => {
    const triggerOf = (repairs: { recomputeDueAt: jest.Mock }) =>
      (
        repairs.recomputeDueAt.mock.calls as [
          unknown,
          string,
          { trigger: unknown; at: Date; now: Date },
        ][]
      ).map(([, id, options]) => ({
        id,
        trigger: options.trigger,
        after: options.at.getTime() - options.now.getTime(),
      }));

    it('works the date out again when an issue is added, 1 ms after its row', async () => {
      const { service, repairs } = issuesSetup([issue()]);
      await service.addIssue(
        't1',
        {
          lastUpdatedAt: AT,
          categoryId: ENGINE.id,
          rootCause: 'Wear',
          description: 'Knocking',
        },
        admin,
        defaultAbility(admin),
      );
      expect(triggerOf(repairs)).toEqual([
        { id: 't1', trigger: 'ISSUE_ADDED', after: 1 },
      ]);
    });

    it('works it out on another system, but not for new words alone', async () => {
      const moved = issuesSetup([issue(), issue({ id: 'i2' })]);
      await moved.service.editIssue(
        't1',
        'i1',
        {
          lastUpdatedAt: AT,
          categoryId: ENGINE.id,
          text: 'Overheating: Fan stuck',
        },
        admin,
        defaultAbility(admin),
      );
      expect(triggerOf(moved.repairs)).toEqual([
        { id: 't1', trigger: 'ISSUE_CHANGED', after: 1 },
      ]);

      const reworded = issuesSetup([issue()]);
      await reworded.service.editIssue(
        't1',
        'i1',
        {
          lastUpdatedAt: AT,
          categoryId: BRAKES.id,
          text: 'Wear and tear: Pads squeal',
        },
        admin,
        defaultAbility(admin),
      );
      expect(reworded.repairs.recomputeDueAt).not.toHaveBeenCalled();
    });

    it('works it out when an issue is removed', async () => {
      const { service, repairs } = issuesSetup([issue(), issue({ id: 'i2' })]);
      await service.removeIssue(
        't1',
        'i2',
        { lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      );
      expect(triggerOf(repairs)).toEqual([
        { id: 't1', trigger: 'ISSUE_REMOVED', after: 1 },
      ]);
    });
  });

  it('removes an issue with its record kept in ISSUE_REMOVED (AC-16)', async () => {
    const worked = issue({ resolutionNote: 'Bled the lines' });
    const { service, tx } = issuesSetup([worked, issue({ id: 'i2' })]);
    await service.removeIssue(
      't1',
      'i1',
      { lastUpdatedAt: AT },
      admin,
      defaultAbility(admin),
    );
    expect(tx.repairIssue.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
    const audit = auditOf(tx);
    expect(audit.action).toBe('ISSUE_REMOVED');
    expect(audit.changes).toEqual([
      {
        field: 'issue',
        before: '[Brakes] Wear and tear: Pads worn',
        after: null,
      },
      { field: 'system', before: 'Brakes', after: null },
      { field: 'resolutionNote', before: 'Bled the lines', after: null },
      { field: 'issueId', before: null, after: 'i1' },
    ]);
  });

  it('refuses to remove the last issue (AC-17) and an issue from another ticket', async () => {
    const last = issuesSetup([issue()]);
    expect(
      await rejectedCode(
        last.service.removeIssue(
          't1',
          'i1',
          { lastUpdatedAt: AT },
          admin,
          defaultAbility(admin),
        ),
      ),
    ).toBe('LAST_ISSUE');

    const other = issuesSetup([issue(), issue({ id: 'i2' })]);
    await expect(
      other.service.removeIssue(
        't1',
        'i9',
        { lastUpdatedAt: AT },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// Spec 0029, AC-36: the late outside shop pick on a ticket outsourced before the picker
describe('TicketEditsService.pickOutsideShop (spec 0029, AC-36)', () => {
  const SHOP = {
    id: '6f1c2a8e-4b1d-4c55-9a51-0c3e7b9d1a01',
    name: 'Bulacan Diesel Works',
  };
  const outsourced = (over: Record<string, unknown> = {}) =>
    ticketRow({
      repairStatus: RepairStatus.OUTSOURCED,
      vmmsProviderId: null,
      outsideShopName: null,
      ...over,
    });
  const ability = defaultAbility(admin);
  const body = { lastUpdatedAt: AT, vmmsProviderId: SHOP.id };

  it('stores the shop with the stamp, writes TICKET_EDITED and queues STATUS_UPDATED', async () => {
    const ctx = setup(outsourced());
    ctx.fleet.shops = [SHOP];
    const { queueVmmsRepairEvent } = jest.requireMock<{
      queueVmmsRepairEvent: jest.Mock;
    }>('../integrations/vmms-repair-events');
    queueVmmsRepairEvent.mockClear();
    await ctx.service.pickOutsideShop('t1', body, admin, ability);
    expect(ctx.tx.repairTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1', updatedAt: LOADED },
        data: expect.objectContaining({
          vmmsProviderId: SHOP.id,
          outsideShopName: SHOP.name,
        }) as Record<string, unknown>,
      }),
    );
    expect(ctx.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: 't1',
        action: 'TICKET_EDITED',
        changes: [{ field: 'outsideShop', before: null, after: SHOP.name }],
      }) as Record<string, unknown>,
    });
    expect(queueVmmsRepairEvent).toHaveBeenCalledWith(
      ctx.tx,
      't1',
      'STATUS_UPDATED',
    );
  });

  it('refuses a ticket not at an outside shop, or one that has its shop', async () => {
    const notOut = setup(ticketRow());
    await expect(
      notOut.service.pickOutsideShop('t1', body, admin, ability),
    ).rejects.toMatchObject({ response: { code: 'NOT_OUTSOURCED' } });
    const done = setup(
      outsourced({ vmmsProviderId: SHOP.id, outsideShopName: SHOP.name }),
    );
    await expect(
      done.service.pickOutsideShop('t1', body, admin, ability),
    ).rejects.toMatchObject({ response: { code: 'SHOP_ALREADY_SET' } });
    expect(done.tx.repairTicket.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a shop not on the list, and answers 503 when VMMS is down with no list kept', async () => {
    const ctx = setup(
      outsourced({ repairStatus: RepairStatus.PENDING_APPROVAL }),
    );
    ctx.fleet.shops = [SHOP];
    await expect(
      ctx.service.pickOutsideShop(
        't1',
        { ...body, vmmsProviderId: '00000000-0000-4000-8000-0000000000aa' },
        admin,
        ability,
      ),
    ).rejects.toMatchObject({ response: { code: 'SHOP_NOT_FOUND' } });
    const down = setup(outsourced());
    down.fleet.shops = 'unavailable';
    await expect(
      down.service.pickOutsideShop('t1', body, admin, ability),
    ).rejects.toMatchObject({ response: { code: 'VMMS_UNAVAILABLE' } });
  });
});

describe('TicketEditsService due date (spec 0030, AC-8, AC-9, AC-14, AC-15)', () => {
  const HOUR = 3_600_000;
  const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
  const reason = 'Parts arrive Friday';
  const auto = {
    dueAt: new Date(Date.now() + 10 * HOUR),
    dueAtSource: 'PRIORITY',
  };

  it('sets a hand date as MANUAL with the stamp first and one audit row (AC-8)', async () => {
    const { service, tx } = setup(ticketRow(auto));
    const dueAt = inHours(72);
    await service.changeDueDate(
      't1',
      { lastUpdatedAt: AT, dueAt, reason },
      admin,
      defaultAbility(admin),
    );
    expect(tx.repairTicket.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.repairTicket.update.mock.invocationCallOrder[0],
    );
    expect(tx.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { dueAt: new Date(dueAt), dueAtSource: 'MANUAL' },
    });
    const [audit] = tx.auditLog.create.mock.calls[0] as AuditCall;
    expect(audit.data.note).toBe(reason);
  });

  it('refuses a past date or one over 90 days out (AC-8)', async () => {
    const { service } = setup(ticketRow(auto));
    for (const dueAt of [inHours(-1), inHours(24 * 91)]) {
      await expect(
        service.changeDueDate(
          't1',
          { lastUpdatedAt: AT, dueAt, reason },
          admin,
          defaultAbility(admin),
        ),
      ).rejects.toMatchObject({ response: { code: 'DUE_DATE_OUT_OF_RANGE' } });
    }
  });

  it('writes nothing for the same date', async () => {
    const { service, prisma } = setup(ticketRow(auto));
    await service.changeDueDate(
      't1',
      { lastUpdatedAt: AT, dueAt: auto.dueAt.toISOString(), reason },
      admin,
      defaultAbility(admin),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 TICKET_NOT_OPEN on a closed ticket, unlocked or not (AC-14)', async () => {
    for (const isUnlocked of [false, true]) {
      const { service } = setup(
        ticketRow({ ...auto, repairStatus: RepairStatus.CLOSED, isUnlocked }),
      );
      await expect(
        service.changeDueDate(
          't1',
          { lastUpdatedAt: AT, dueAt: inHours(5), reason },
          admin,
          defaultAbility(admin),
        ),
      ).rejects.toMatchObject({ response: { code: 'TICKET_NOT_OPEN' } });
      await expect(
        service.automaticDueDate('t1', defaultAbility(admin)),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('answers 409 when the ticket moved on, and writes nothing (AC-15)', async () => {
    const { service, prisma } = setup(ticketRow(auto));
    await expect(
      service.changeDueDate(
        't1',
        {
          lastUpdatedAt: '2026-11-03T00:00:00.000Z',
          dueAt: inHours(5),
          reason,
        },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 when a second save loses the guarded stamp (AC-15)', async () => {
    const { service, tx } = setup(ticketRow(auto));
    tx.repairTicket.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.changeDueDate(
        't1',
        { lastUpdatedAt: AT, dueAt: inHours(5), reason },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.repairTicket.update).not.toHaveBeenCalled();
  });

  it('answers 404 and 403 before anything else', async () => {
    const missing = setup();
    missing.prisma.repairTicket.findUnique.mockResolvedValue(null);
    await expect(
      missing.service.automaticDueDate('t1', defaultAbility(admin)),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Without ticket.view_all a mechanic sees only assigned tickets
    const hidden = setup(ticketRow(auto));
    await expect(
      hidden.service.changeDueDate(
        't1',
        { lastUpdatedAt: AT, dueAt: inHours(5), reason },
        mechanic,
        defaultAbility(mechanic),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resets a MANUAL date through the recompute, MANUAL included (AC-9)', async () => {
    const { service, repairs } = setup(
      ticketRow({ ...auto, dueAtSource: 'MANUAL' }),
    );
    await service.resetDueDate(
      't1',
      { lastUpdatedAt: AT, reason },
      admin,
      defaultAbility(admin),
    );
    expect(repairs.recomputeDueAt).toHaveBeenCalledWith(
      expect.anything(),
      't1',
      expect.objectContaining({
        trigger: { reset: reason },
        includeManual: true,
      }),
    );
  });

  it('answers 409 NOT_MANUAL for a date that is already automatic (AC-9)', async () => {
    const { service } = setup(ticketRow(auto));
    await expect(
      service.resetDueDate(
        't1',
        { lastUpdatedAt: AT, reason },
        admin,
        defaultAbility(admin),
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_MANUAL' } });
  });

  it('previews the automatic date without writing (AC-9)', async () => {
    const { service, tx } = setup(
      ticketRow({ ...auto, dueAtSource: 'MANUAL' }),
    );
    Object.assign(tx, { $queryRaw: jest.fn().mockResolvedValue([]) });
    tx.repairTicket.findUniqueOrThrow.mockResolvedValue({
      ...ticketRow({ ...auto, dueAtSource: 'MANUAL', createdAt: new Date() }),
      priority: 'HIGH',
      issues: [],
    });
    const preview = await service.automaticDueDate('t1', defaultAbility(admin));
    expect(preview).toMatchObject({
      source: 'PRIORITY',
      priorityHours: 24,
      issueHours: 0,
      escalated: false,
      issues: [],
    });
    expect(tx.repairTicket.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
