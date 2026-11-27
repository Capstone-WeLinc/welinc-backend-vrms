import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/built-in-roles.testing';
import { PrismaService } from '../../shared/prisma.service';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { RepairsService } from './repairs.service';

// Spec 0021, AC-4 and AC-5: a step tick writes one STEP_CHECKED or STEP_UNCHECKED row in the same
// transaction as the conditional update, moves lastActivityAt, and never touches updatedAt.

const TICKET = '00000000-0000-4000-8000-0000000000aa';
const ISSUE = '00000000-0000-4000-8000-0000000000bb';
const STEP = '00000000-0000-4000-8000-0000000000cc';
const LOADED = new Date('2026-11-01T01:00:00.000Z');

const admin = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS',
};

function setup(
  opts: {
    status?: RepairStatus;
    changed?: boolean;
    step?: unknown;
    checkedAt?: Date | null;
  } = {},
) {
  const step =
    opts.step === undefined
      ? { id: STEP, position: 2, text: 'Check brake fluid' }
      : opts.step;
  const tx = {
    repairTicket: {
      findUnique: jest.fn().mockResolvedValue({
        id: TICKET,
        repairStatus: opts.status ?? RepairStatus.IN_PROGRESS,
        updatedAt: LOADED,
        assignments: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    repairIssueStep: {
      findFirst: jest.fn().mockResolvedValue(step),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.changed === false ? 0 : 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: STEP,
        position: 2,
        text: 'Check brake fluid',
        checkedAt: opts.checkedAt ?? null,
        checkedByEmail: opts.checkedAt ? 'someone@welinc.com' : null,
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  return {
    tx,
    service: new RepairsService(
      prisma as unknown as PrismaService,
      new FakeSettings(),
      new FakeEmbeddings().asService(),
      new FakeFleet().asClient(),
    ),
  };
}

const tick = (service: RepairsService, checked: boolean) =>
  service.checkStep(
    TICKET,
    ISSUE,
    STEP,
    { checked },
    admin,
    defaultAbility(admin),
  );

describe('RepairsService.checkStep (spec 0021, AC-4, AC-5)', () => {
  it('ticks with a conditional update, one STEP_CHECKED row and lastActivityAt at the row time', async () => {
    const { tx, service } = setup({ checkedAt: LOADED });
    const result = await tick(service, true);

    const [updateArgs] = tx.repairIssueStep.updateMany.mock.calls[0] as [
      { where: unknown; data: { checkedAt: Date } },
    ];
    expect(updateArgs.where).toEqual({ id: STEP, checkedAt: null });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const [{ data: row }] = tx.auditLog.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(row).toMatchObject({
      repairTicketId: TICKET,
      action: 'STEP_CHECKED',
      actorUserId: admin.sub,
      actorRole: 'ADMIN',
      note: null,
      changes: [
        { field: 'checked', before: 'false', after: 'true' },
        { field: 'step', before: null, after: '2. Check brake fluid' },
        { field: 'issueId', before: null, after: ISSUE },
        { field: 'stepId', before: null, after: STEP },
      ],
    });
    expect(row.createdAt).toBe(updateArgs.data.checkedAt);

    expect(tx.repairTicket.update).toHaveBeenCalledWith({
      where: { id: TICKET },
      data: { lastActivityAt: row.createdAt, updatedAt: LOADED },
    });
    expect(result).toMatchObject({ id: STEP, checkedAt: LOADED });
  });

  it('unticks with STEP_UNCHECKED, matching only a ticked step', async () => {
    const { tx, service } = setup();
    await tick(service, false);
    const [updateArgs] = tx.repairIssueStep.updateMany.mock.calls[0] as [
      { where: unknown },
    ];
    expect(updateArgs.where).toEqual({ id: STEP, checkedAt: { not: null } });
    const [{ data: row }] = tx.auditLog.create.mock.calls[0] as [
      { data: { action: string; changes: unknown[] } },
    ];
    expect(row.action).toBe('STEP_UNCHECKED');
    expect(row.changes[0]).toEqual({
      field: 'checked',
      before: 'true',
      after: 'false',
    });
  });

  it('writes nothing for a tick that changes nothing, and returns the step as it is', async () => {
    const { tx, service } = setup({ changed: false, checkedAt: LOADED });
    const result = await tick(service, true);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.repairTicket.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: STEP,
      position: 2,
      text: 'Check brake fluid',
      checkedAt: LOADED,
      checkedByEmail: 'someone@welinc.com',
    });
  });

  it('refuses a ticket that is not In progress, writing nothing', async () => {
    const { tx, service } = setup({ status: RepairStatus.FOR_VERIFICATION });
    await expect(tick(service, true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.repairIssueStep.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('answers 404 for a step that is not on this ticket', async () => {
    const { tx, service } = setup({ step: null });
    await expect(tick(service, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
