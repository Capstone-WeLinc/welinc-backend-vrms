import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { buildAbility } from '../../auth/permissions/ability.factory';
import {
  defaultAbility,
  defaultKeys,
} from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { ChecklistEditsService } from './checklist-edits.service';
import type { StoredStep } from './checklist-edits';
import { RepairsService } from './repairs.service';

// Spec 0023: the checklist save. The lock comes first, then access and status, then the steps read
// FOR UPDATE; the writes follow the Key invariants order and never move the ticket's updatedAt.

const TICKET = '00000000-0000-4000-8000-0000000000aa';
const ISSUE = '00000000-0000-4000-8000-0000000000bb';
const LOADED = new Date('2026-11-06T01:00:00.000Z');
const TICKED = new Date('2026-11-06T01:30:00.000Z');
const MECH_ID = '00000000-0000-4000-8000-000000000010';

const user = (sub: string, role: UserRole) => ({
  sub,
  email: `${role.toLowerCase()}@welinc.com`,
  name: role,
  roles: [{ role, system: 'VRMS' }],
  system: 'VRMS',
});
const mechanic = user(MECH_ID, UserRole.MECHANIC);
const otherMechanic = user(
  '00000000-0000-4000-8000-000000000011',
  UserRole.MECHANIC,
);
const chief = user(
  '00000000-0000-4000-8000-000000000012',
  UserRole.CHIEF_MECHANIC,
);

const step = (n: number, extra: Partial<StoredStep> = {}): StoredStep => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  position: n,
  text: `Step ${n}`,
  checkedAt: null,
  checkedByEmail: null,
  origin: 'KNOWN_FIX',
  editedAt: null,
  ...extra,
});

function setup(
  opts: {
    status?: RepairStatus;
    locked?: boolean;
    issueOnTicket?: boolean;
    stored?: StoredStep[];
  } = {},
) {
  const order: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    () => {
      order.push(name);
      return Promise.resolve(value);
    };
  const tx = {
    repairIssue: {
      updateMany: jest
        .fn()
        .mockImplementation(
          track('lock', { count: opts.locked === false ? 0 : 1 }),
        ),
      count: jest.fn().mockResolvedValue(opts.issueOnTicket === false ? 0 : 1),
    },
    repairTicket: {
      findUniqueOrThrow: jest.fn().mockImplementation(
        track('ticket', {
          id: TICKET,
          repairNumber: 'REP-1',
          repairStatus: opts.status ?? RepairStatus.IN_PROGRESS,
          updatedAt: LOADED,
          assignments: [{ mechanic: { authUserId: MECH_ID } }],
        }),
      ),
      update: jest.fn().mockImplementation(track('ticketUpdate', {})),
    },
    $queryRaw: jest
      .fn()
      .mockImplementation(
        track('read', opts.stored ?? [step(1), step(2), step(3)]),
      ),
    repairIssueStep: {
      deleteMany: jest.fn().mockImplementation(track('delete', {})),
      updateMany: jest.fn().mockImplementation(track('offset', {})),
      update: jest.fn().mockImplementation(track('place', {})),
      createMany: jest.fn().mockImplementation(track('create', {})),
    },
    auditLog: { createMany: jest.fn().mockImplementation(track('audit', {})) },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    repairTicket: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: TICKET }),
    },
  };
  const repairs = {
    present: jest.fn().mockResolvedValue({ id: TICKET, presented: true }),
  };
  return {
    tx,
    order,
    repairs,
    service: new ChecklistEditsService(
      prisma as unknown as PrismaService,
      repairs as unknown as RepairsService,
    ),
  };
}

type Caller = typeof mechanic;
const save = (
  service: ChecklistEditsService,
  steps: { id?: string; text: string }[],
  caller: Caller = mechanic,
  ability = defaultAbility(caller),
) =>
  service.save(TICKET, ISSUE, { checklistVersion: 4, steps }, caller, ability);

type AuditRow = { action: string; createdAt: Date; changes: unknown };
const auditRows = (tx: ReturnType<typeof setup>['tx']) =>
  (tx.auditLog.createMany.mock.calls[0] as [{ data: AuditRow[] }])[0].data;

describe('ChecklistEditsService.save (spec 0023)', () => {
  it('locks on checklistVersion, rewords and adds, and answers with the full ticket (AC-6, AC-8, AC-12)', async () => {
    const { tx, order, repairs, service } = setup();
    const [s1, s2, s3] = [step(1), step(2), step(3)];
    const res = await save(service, [
      { id: s1.id, text: s1.text },
      { id: s2.id, text: 'Step two,   reworded ' },
      { id: s3.id, text: s3.text },
      { text: 'Road test' },
    ]);

    expect(tx.repairIssue.updateMany).toHaveBeenCalledWith({
      where: { id: ISSUE, repairTicketId: TICKET, checklistVersion: 4 },
      data: { checklistVersion: 5 },
    });
    // Key invariants: lock, checks, read, offset, place, create, audit, ticket
    expect(order).toEqual([
      'lock',
      'ticket',
      'read',
      'offset',
      'place',
      'place',
      'place',
      'create',
      'audit',
      'ticketUpdate',
    ]);
    const rowSql = (tx.$queryRaw.mock.calls[0] as [string[]])[0].join('?');
    expect(rowSql).toMatch(/FOR UPDATE/);

    expect(tx.repairIssueStep.update).toHaveBeenCalledWith({
      where: { id: s2.id },
      data: {
        position: 2,
        text: 'Step two, reworded',
        checkedAt: null,
        checkedByEmail: null,
        editedAt: expect.any(Date) as Date,
      },
    });
    // An unchanged step only takes its place back
    expect(tx.repairIssueStep.update).toHaveBeenCalledWith({
      where: { id: s1.id },
      data: { position: 1 },
    });
    const created = (
      tx.repairIssueStep.createMany.mock.calls[0] as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data;
    expect(created).toEqual([
      expect.objectContaining({
        repairIssueId: ISSUE,
        position: 4,
        text: 'Road test',
        origin: 'ADDED',
      }),
    ]);

    const rows = auditRows(tx);
    expect(rows.map((r) => r.action)).toEqual(['STEP_EDITED', 'STEP_ADDED']);
    expect(rows[1].createdAt.getTime() - rows[0].createdAt.getTime()).toBe(1);
    // AC-6: lastActivityAt is the newest stamp, and updatedAt passes through as stored
    expect(tx.repairTicket.update).toHaveBeenCalledWith({
      where: { id: TICKET },
      data: { lastActivityAt: rows[1].createdAt, updatedAt: LOADED },
    });
    expect(repairs.present).toHaveBeenCalled();
    expect(res).toEqual({ id: TICKET, presented: true });
  });

  it('removes and moves, keeps a tick made while the dialog was open, and writes rows in AC-10 order', async () => {
    const stored = [
      step(1),
      step(2, { checkedAt: TICKED, checkedByEmail: 'm@welinc.com' }),
      step(3, { checkedAt: TICKED, checkedByEmail: 'm@welinc.com' }),
      step(4),
    ];
    const { tx, order, service } = setup({ stored });
    // Remove s1, move s4 to the top, keep the ticked s2 and s3 as they are
    await save(service, [
      { id: stored[3].id, text: 'Step 4' },
      { id: stored[1].id, text: 'Step 2' },
      { id: stored[2].id, text: 'Step 3' },
    ]);
    expect(order.slice(0, 4)).toEqual(['lock', 'ticket', 'read', 'delete']);
    expect(tx.repairIssueStep.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [stored[0].id] } },
    });
    // The ticked steps keep their tick: only their place is written
    expect(tx.repairIssueStep.update).toHaveBeenCalledWith({
      where: { id: stored[1].id },
      data: { position: 2 },
    });
    expect(tx.repairIssueStep.createMany).not.toHaveBeenCalled();
    expect(auditRows(tx).map((r) => r.action)).toEqual([
      'STEP_REMOVED',
      'STEP_MOVED',
    ]);
  });

  it('never sets editedAt on a reworded ADDED step (AC-8)', async () => {
    const added = step(1, { origin: 'ADDED' });
    const { tx, service } = setup({ stored: [added] });
    await save(service, [{ id: added.id, text: 'Better words' }]);
    expect(tx.repairIssueStep.update).toHaveBeenCalledWith({
      where: { id: added.id },
      data: {
        position: 1,
        text: 'Better words',
        checkedAt: null,
        checkedByEmail: null,
      },
    });
  });

  it('writes nothing and keeps the version when nothing changed (AC-11)', async () => {
    const { tx, repairs, service } = setup();
    const res = await save(service, [
      { id: step(1).id, text: ' Step  1' },
      { id: step(2).id, text: 'Step 2' },
      { id: step(3).id, text: 'Step 3' },
    ]);
    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.repairIssueStep.update).not.toHaveBeenCalled();
    expect(tx.repairTicket.update).not.toHaveBeenCalled();
    expect(res).toEqual({ id: TICKET, presented: true });
    expect(repairs.present).toHaveBeenCalled();
  });

  it('saves 0 steps (AC-5)', async () => {
    const { tx, service } = setup();
    await save(service, []);
    expect(tx.repairIssueStep.deleteMany).toHaveBeenCalled();
    expect(auditRows(tx)).toHaveLength(3);
  });

  it('answers 409 STALE_CHECKLIST when the version moved (AC-6)', async () => {
    const { tx, service } = setup({ locked: false });
    const err = (await save(service, []).catch((e: unknown) => e)) as
      | ConflictException
      | undefined;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.getResponse()).toMatchObject({ code: 'STALE_CHECKLIST' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers 404 when the issue is not on the ticket (AC-3)', async () => {
    const { service } = setup({ locked: false, issueOnTicket: false });
    await expect(save(service, [])).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    RepairStatus.OPEN,
    RepairStatus.ON_HOLD,
    RepairStatus.FOR_VERIFICATION,
    RepairStatus.CLOSED,
  ])('answers 400 in %s, after the lock (AC-3)', async (status) => {
    const { tx, service } = setup({ status });
    await expect(save(service, [])).rejects.toThrow(
      'Steps can only be edited while the ticket is Assigned or In progress.',
    );
    expect(tx.repairIssue.updateMany).toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('lets a mechanic edit only tickets assigned to them, and a chief any ticket (AC-1, AC-3)', async () => {
    await expect(
      save(setup().service, [], otherMechanic),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(save(setup().service, [], chief)).resolves.toBeDefined();
    await expect(save(setup().service, [], mechanic)).resolves.toBeDefined();
  });

  it('answers 403 when the key is off for the role (AC-1)', async () => {
    const keys = defaultKeys([UserRole.MECHANIC]);
    keys.delete('ticket.checklist.edit');
    await expect(
      save(setup().service, [], mechanic, buildAbility(MECH_ID, keys)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 400 with fieldErrors by sent index, before any lock (AC-5)', async () => {
    const { tx, service } = setup();
    const err = (await save(service, [{ text: '' }, { text: 'ok' }]).catch(
      (e: unknown) => e,
    )) as BadRequestException;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      fieldErrors: [{ index: 1, message: 'Write at least 3 characters.' }],
    });
    expect(tx.repairIssue.updateMany).not.toHaveBeenCalled();
  });

  it('answers 400 for a foreign or a repeated step id (AC-7)', async () => {
    await expect(
      save(setup().service, [
        { id: '00000000-0000-4000-8000-000000000999', text: 'Ghost' },
      ]),
    ).rejects.toThrow(/not on this issue/);
    await expect(
      save(setup().service, [
        { id: step(1).id, text: 'Step 1' },
        { id: step(1).id, text: 'Step 1' },
      ]),
    ).rejects.toThrow(/twice/);
  });
});
