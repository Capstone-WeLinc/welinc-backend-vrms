import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma.service';
import type { AuthUser } from '../account-check';
import { SystemType, UserRole } from '../roles';
import { PERMISSION_CATALOG } from './catalog';
import {
  PermissionMatrixService,
  STALE_MATRIX,
} from './permission-matrix.service';

// Spec 0011, AC-4, AC-6 and AC-17 to AC-19.

const admin: AuthUser = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  system: SystemType.VRMS,
  roles: [{ role: UserRole.ADMIN, system: SystemType.VRMS }],
};

type Row = { role: string; permission: string; allowed: boolean };

function setup(rows: Row[], version = 4) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ version }]),
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { OR: Row[] } }) =>
        Promise.resolve(
          rows.filter((r) =>
            where.OR.some(
              (w) => w.role === r.role && w.permission === r.permission,
            ),
          ),
        ),
      ),
      upsert: jest.fn().mockResolvedValue({}),
    },
    permissionChange: { createMany: jest.fn().mockResolvedValue({}) },
    permissionMatrix: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    permissionMatrix: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ version }),
    },
    rolePermission: { findMany: jest.fn().mockResolvedValue(rows) },
    permissionChange: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return {
    prisma,
    tx,
    service: new PermissionMatrixService(prisma as unknown as PrismaService),
  };
}

const knowledgeEdit = (allowed: boolean) => ({
  role: 'CHIEF_MECHANIC',
  permission: 'knowledge.edit',
  allowed,
});

describe('PermissionMatrixService.view (AC-17)', () => {
  it('lists every catalog key once, grouped, with the three role labels and the version', async () => {
    const res = await setup([]).service.view();
    expect(res.roles).toEqual([
      { role: 'ADMIN', label: 'Admin' },
      { role: 'CHIEF_MECHANIC', label: 'Chief Mechanic' },
      { role: 'MECHANIC', label: 'Mechanic' },
    ]);
    expect(res.groups.map((g) => g.name)).toEqual([
      'Tickets',
      'Records',
      'Knowledge',
      'Admin',
    ]);
    expect(res.groups.flatMap((g) => g.keys)).toHaveLength(
      PERMISSION_CATALOG.length,
    );
    expect(res.version).toBe(4);
  });

  it('shows a locked cell at its catalog value whatever its row says, and a missing row as not allowed', async () => {
    const res = await setup([
      { role: 'ADMIN', permission: 'users.manage', allowed: false },
    ]).service.view();
    const keys = res.groups.flatMap(
      (g) =>
        g.keys as {
          key: string;
          grants: Record<string, { allowed: boolean; locked: boolean }>;
        }[],
    );
    expect(keys.find((k) => k.key === 'users.manage')?.grants.ADMIN).toEqual({
      allowed: true,
      locked: true,
    });
    expect(keys.find((k) => k.key === 'ticket.view')?.grants.MECHANIC).toEqual({
      allowed: false,
      locked: false,
    });
  });
});

describe('PermissionMatrixService.update (AC-4, AC-18, AC-19)', () => {
  it.each([
    [{ role: 'ADMIN', permission: 'users.manage', allowed: false }, 'locked'],
    [
      { role: 'OPERATIONS', permission: 'ticket.view', allowed: true },
      'Unknown role',
    ],
    [
      { role: 'MECHANIC', permission: 'ticket.fly', allowed: true },
      'Unknown permission',
    ],
  ])('refuses %j with 400 and changes nothing', async (change, message) => {
    const { prisma, service } = setup([]);
    const run = service.update({ changes: [change], version: 4 }, admin);
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(message);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the same cell twice in one save', async () => {
    const { service } = setup([]);
    await expect(
      service.update(
        { changes: [knowledgeEdit(false), knowledgeEdit(true)], version: 4 },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 409 when the version moved, under the row lock', async () => {
    const { tx, service } = setup([knowledgeEdit(true)], 5);
    const run = service.update(
      { changes: [knowledgeEdit(false)], version: 4 },
      admin,
    );
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(run).rejects.toThrow(STALE_MATRIX);
    expect(String((tx.$queryRaw.mock.calls[0] as [string[]])[0])).toContain(
      'FOR UPDATE',
    );
    expect(tx.rolePermission.upsert).not.toHaveBeenCalled();
  });

  it('applies a change with one change row, the actor from the token, and a version bump', async () => {
    const { tx, service } = setup([knowledgeEdit(true)]);
    await service.update(
      { changes: [knowledgeEdit(false)], note: '  Chiefs left  ', version: 4 },
      admin,
    );
    expect(tx.rolePermission.upsert).toHaveBeenCalledTimes(1);
    expect(tx.permissionChange.createMany).toHaveBeenCalledWith({
      data: [
        {
          role: 'CHIEF_MECHANIC',
          permission: 'knowledge.edit',
          before: true,
          after: false,
          actorUserId: admin.sub,
          actorName: 'Victor Ramos',
          actorEmail: 'vrms.admin@welinc.com',
          note: 'Chiefs left',
        },
      ],
    });
    expect(tx.permissionMatrix.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    });
  });

  it('skips a change to the value a cell already has: no row, no log, same version', async () => {
    const { tx, service } = setup([knowledgeEdit(true)]);
    await service.update(
      { changes: [knowledgeEdit(true)], note: ' ', version: 4 },
      admin,
    );
    expect(tx.rolePermission.upsert).not.toHaveBeenCalled();
    expect(tx.permissionChange.createMany).not.toHaveBeenCalled();
    expect(tx.permissionMatrix.update).not.toHaveBeenCalled();
  });

  it('stores an empty note as null and a missing row as before null', async () => {
    const { tx, service } = setup([]);
    await service.update(
      { changes: [knowledgeEdit(true)], note: '   ', version: 4 },
      admin,
    );
    const [{ data }] = tx.permissionChange.createMany.mock.calls[0] as [
      { data: { before: boolean | null; note: string | null }[] },
    ];
    expect(data[0]).toMatchObject({ before: null, note: null });
  });
});

describe('PermissionMatrixService.changes (AC-19)', () => {
  it('pages newest first with one extra row, and answers 400 for a bad cursor', async () => {
    const { prisma, service } = setup([]);
    const rows = [1, 2, 3].map((n) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      createdAt: new Date(`2026-10-2${n}T00:00:00Z`),
    }));
    prisma.permissionChange.findMany.mockResolvedValue(rows);
    const res = await service.changes({ limit: 2 });
    expect(res.data).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
    expect(prisma.permissionChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    await expect(service.changes({ cursor: 'nope' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
