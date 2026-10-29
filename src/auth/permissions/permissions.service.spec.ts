import { ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../../shared/prisma.service';
import { MATRIX_ROLES, PERMISSION_CATALOG } from './catalog';
import { PermissionsService } from './permissions.service';

type Row = { role: string; permission: string; allowed: boolean };

/** Every role and key at its catalog default, as the backfill would write them. */
function defaultRows(): Row[] {
  return MATRIX_ROLES.flatMap((role) =>
    PERMISSION_CATALOG.map((entry) => ({
      role,
      permission: entry.key,
      allowed: entry.defaults[role],
    })),
  );
}

function setup(rows: Row[] = defaultRows(), version = 1) {
  const state = { rows, version };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rolePermission: {
      findMany: jest.fn(() => Promise.resolve(state.rows)),
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        state.rows = [...state.rows, ...data];
        return Promise.resolve({ count: data.length });
      }),
    },
    permissionChange: { createMany: jest.fn() },
    permissionMatrix: {
      update: jest.fn(() => {
        state.version += 1;
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    ...tx,
    permissionMatrix: {
      ...tx.permissionMatrix,
      findUnique: jest.fn(() => Promise.resolve({ version: state.version })),
    },
    $transaction: jest.fn((run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const service = new PermissionsService(prisma as unknown as PrismaService);
  return { service, prisma, tx, state };
}

const vrms = (...roles: string[]) =>
  roles.map((role) => ({ role, system: 'VRMS' }));

describe('PermissionsService', () => {
  it('grants the union of every matrix role held (AC-5)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    const keys = service.keysFor(['MECHANIC', 'ADMIN']);

    expect(keys.has('ticket.work')).toBe(true); // Mechanic only
    expect(keys.has('ticket.administer')).toBe(true); // Admin only
  });

  it('grants nothing for a role outside the matrix (AC-5, AC-6)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    expect(service.keysFor(['CUSTOMER_SUPPORT', 'OPERATIONS']).size).toBe(0);
  });

  it('denies a key with no row (AC-6)', async () => {
    const rows = defaultRows().filter(
      (r) => !(r.role === 'MECHANIC' && r.permission === 'knowledge.view'),
    );
    const { service, tx } = setup(rows);
    // Stop the backfill from restoring the row, so the load sees it missing
    tx.rolePermission.createMany.mockResolvedValueOnce({ count: 0 });
    await service.onApplicationBootstrap();

    expect(service.keysFor(['MECHANIC']).has('knowledge.view')).toBe(false);
  });

  it('takes a locked cell from the catalog, whatever its row says (AC-4)', async () => {
    const rows = defaultRows().map((r) =>
      r.permission === 'users.manage'
        ? { ...r, allowed: r.role !== 'ADMIN' }
        : r,
    );
    const { service } = setup(rows);
    await service.onApplicationBootstrap();

    expect(service.keysFor(['ADMIN']).has('users.manage')).toBe(true);
    expect(service.keysFor(['MECHANIC']).has('users.manage')).toBe(false);
  });

  it('follows an unlocked edit stored in the database', async () => {
    const rows = defaultRows().map((r) =>
      r.role === 'CHIEF_MECHANIC' && r.permission === 'knowledge.edit'
        ? { ...r, allowed: false }
        : r,
    );
    const { service } = setup(rows);
    await service.onApplicationBootstrap();

    expect(service.keysFor(['CHIEF_MECHANIC']).has('knowledge.edit')).toBe(
      false,
    );
  });

  it('reloads the grants when the version moves (AC-20)', async () => {
    const { service, state } = setup();
    await service.onApplicationBootstrap();
    expect(service.keysFor(['MECHANIC']).has('audit.view')).toBe(false);

    state.rows = state.rows.map((r) =>
      r.role === 'MECHANIC' && r.permission === 'audit.view'
        ? { ...r, allowed: true }
        : r,
    );
    state.version += 1;
    await service.ensureFresh();

    expect(service.keysFor(['MECHANIC']).has('audit.view')).toBe(true);
    expect(service.currentVersion).toBe(state.version);
  });

  it('keeps the last matrix when the version read fails on a warm replica (AC-21)', async () => {
    const { service, prisma } = setup();
    await service.onApplicationBootstrap();
    prisma.permissionMatrix.findUnique.mockRejectedValueOnce(new Error('down'));

    await expect(service.ensureFresh()).resolves.toBeUndefined();
    expect(service.keysFor(['ADMIN']).has('ticket.create')).toBe(true);
  });

  it('answers 503 and stays not ready until a cold replica loads (AC-21)', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(new Error('down'));
    await service.onApplicationBootstrap();
    expect(service.isReady).toBe(false);

    prisma.$transaction.mockRejectedValueOnce(new Error('down'));
    await expect(service.ensureFresh()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await service.ensureFresh();
    expect(service.isReady).toBe(true);
  });

  describe('startup backfill (AC-3)', () => {
    it('inserts every row on an empty table, logs each as System and bumps the version once', async () => {
      const { service, tx, state } = setup([]);
      await service.onApplicationBootstrap();

      const total = MATRIX_ROLES.length * PERMISSION_CATALOG.length;
      expect(state.rows).toHaveLength(total);
      const [[{ data: changes }]] = tx.permissionChange.createMany.mock
        .calls as [[{ data: { before: unknown; actorUserId?: unknown }[] }]];
      expect(changes).toHaveLength(total);
      expect(changes.every((c) => c.before === null && !c.actorUserId)).toBe(
        true,
      );
      expect(state.version).toBe(2);
    });

    it('takes the advisory lock before reading the rows', async () => {
      const { service, tx } = setup([]);
      await service.onApplicationBootstrap();

      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.rolePermission.findMany.mock.invocationCallOrder[0],
      );
    });

    it('inserts only the missing rows and never changes an existing one', async () => {
      const edited = defaultRows().map((r) =>
        r.role === 'MECHANIC' && r.permission === 'knowledge.suggest'
          ? { ...r, allowed: false }
          : r,
      );
      const missing = edited.filter((r) => r.permission !== 'audit.view');
      const { service, tx, state } = setup(missing);
      await service.onApplicationBootstrap();

      const [[{ data }]] = tx.rolePermission.createMany.mock.calls as [
        [{ data: Row[] }],
      ];
      expect(data.map((r) => r.permission)).toEqual([
        'audit.view',
        'audit.view',
        'audit.view',
      ]);
      expect(service.keysFor(['MECHANIC']).has('knowledge.suggest')).toBe(
        false,
      );
      expect(state.version).toBe(2);
    });

    it('writes nothing and keeps the version when every row exists', async () => {
      const { service, tx, state } = setup();
      await service.onApplicationBootstrap();

      expect(tx.rolePermission.createMany).not.toHaveBeenCalled();
      expect(tx.permissionChange.createMany).not.toHaveBeenCalled();
      expect(state.version).toBe(1);
    });
  });

  it('builds a separate ability per caller, even with the same roles (AC-9)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    const a = service.abilityFor({ sub: 'a', roles: vrms('MECHANIC') });
    const b = service.abilityFor({ sub: 'b', roles: vrms('MECHANIC') });

    expect(a).not.toBe(b);
    expect(service.keysFor(['MECHANIC'])).toBe(service.keysFor(['MECHANIC']));
  });
});
