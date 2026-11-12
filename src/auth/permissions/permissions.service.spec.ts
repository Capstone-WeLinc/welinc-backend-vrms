import { ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../../shared/prisma.service';
import { MATRIX_ROLES, PERMISSION_CATALOG } from './catalog';
import { defaultKeys } from './permissions.fake';
import type { UserRole } from '../roles';
import { PermissionsService } from './permissions.service';
import { FakeSettings } from '../../settings/settings.fake';

type Row = { role: string; permission: string; allowed: boolean };

/** Every role and key at welinc-auth's defaults, as the matrix sync writes them (suite spec 0013). */
function defaultRows(): Row[] {
  return MATRIX_ROLES.flatMap((role) => {
    const held = defaultKeys([role]);
    return PERMISSION_CATALOG.map((entry) => ({
      role,
      permission: entry.key,
      allowed: held.has(entry.key),
    }));
  });
}

function setup(
  rows: Row[] = defaultRows(),
  version = 1,
  settings = new FakeSettings(),
) {
  const state = { rows, version, settingsVersion: 1 };
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
    // ensureFresh reads both versions in one query (spec 0012, AC-4)
    $queryRaw: jest.fn(() =>
      Promise.resolve([
        { matrix: state.version, settings: state.settingsVersion },
      ]),
    ),
    $transaction: jest.fn((run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const service = new PermissionsService(
    prisma as unknown as PrismaService,
    settings,
  );
  return { service, prisma, tx, state, settings };
}

const vrms = (...roles: UserRole[]) =>
  roles.map((role) => ({ role, system: 'VRMS' }));

describe('PermissionsService', () => {
  it('grants the union of every matrix role held (AC-5)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    const keys = service.keysFor(['MECHANIC', 'ADMIN']);

    expect(keys.has('ticket.work')).toBe(true); // Mechanic only
    expect(keys.has('ticket.administer')).toBe(true); // Admin only
  });

  // Spec 0014, AC-5: what /vrms/permissions/me sends each role equals the catalog defaults with
  // every module on, so a new key such as ticket.verify reaches the right roles
  it.each(MATRIX_ROLES)(
    'grants %s exactly its catalog defaults under the default matrix',
    async (role) => {
      const { service } = setup();
      await service.onApplicationBootstrap();

      const expected = [...defaultKeys([role])];
      expect([...service.keysFor([role])].sort()).toEqual(expected.sort());
    },
  );

  it('grants ticket.verify to Admin and Chief Mechanic, not Mechanic (spec 0014, AC-5)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    expect(service.keysFor(['ADMIN']).has('ticket.verify')).toBe(true);
    expect(service.keysFor(['CHIEF_MECHANIC']).has('ticket.verify')).toBe(true);
    expect(service.keysFor(['MECHANIC']).has('ticket.verify')).toBe(false);
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
    const { service } = setup(rows);
    await service.onApplicationBootstrap();

    expect(service.keysFor(['MECHANIC']).has('knowledge.view')).toBe(false);
  });

  it('takes every cell from its row, locks included: welinc-auth keeps the locks (suite spec 0013, AC-29)', async () => {
    const rows = defaultRows().map((r) =>
      r.role === 'MECHANIC' && r.permission === 'ticket.files.remove_any'
        ? { ...r, allowed: true }
        : r,
    );
    const { service } = setup(rows);
    await service.onApplicationBootstrap();

    expect(service.keysFor(['MECHANIC']).has('ticket.files.remove_any')).toBe(
      true,
    );
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
    prisma.$queryRaw.mockRejectedValueOnce(new Error('down'));

    await expect(service.ensureFresh()).resolves.toBeUndefined();
    expect(service.keysFor(['ADMIN']).has('ticket.create')).toBe(true);
  });

  it('answers 503 and stays not ready until a cold replica loads (AC-21)', async () => {
    const { service, prisma } = setup();
    prisma.permissionMatrix.findUnique.mockRejectedValueOnce(new Error('down'));
    await service.onApplicationBootstrap();
    expect(service.isReady).toBe(false);

    prisma.permissionMatrix.findUnique.mockRejectedValueOnce(new Error('down'));
    await expect(service.ensureFresh()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await service.ensureFresh();
    expect(service.isReady).toBe(true);
  });

  it('writes nothing at startup: the sync owns role_permissions (suite spec 0013, AC-30)', async () => {
    const { service, tx, state } = setup([]);
    await service.onApplicationBootstrap();

    expect(tx.rolePermission.createMany).not.toHaveBeenCalled();
    expect(tx.permissionChange.createMany).not.toHaveBeenCalled();
    expect(state.version).toBe(1);
    expect(service.keysFor(['ADMIN']).size).toBe(0);
  });

  it('builds a separate ability per caller, even with the same roles (AC-9)', async () => {
    const { service } = setup();
    await service.onApplicationBootstrap();

    const a = service.abilityFor({ sub: 'a', roles: vrms('MECHANIC') });
    const b = service.abilityFor({ sub: 'b', roles: vrms('MECHANIC') });

    expect(a).not.toBe(b);
    expect(service.keysFor(['MECHANIC'])).toBe(service.keysFor(['MECHANIC']));
  });

  describe('module switches (spec 0012)', () => {
    // covers: AC-10
    it('removes the keys of an off module from every role, whatever the matrix says', async () => {
      const settings = new FakeSettings();
      const { service, state } = setup(defaultRows(), 1, settings);
      await service.onApplicationBootstrap();
      expect(service.keysFor(['ADMIN']).has('knowledge.edit')).toBe(true);

      settings.turnOff('knowledge');
      state.settingsVersion += 1;
      await service.ensureFresh();

      const admin = service.keysFor(['ADMIN']);
      expect(admin.has('knowledge.view')).toBe(false);
      expect(admin.has('knowledge.suggest')).toBe(false);
      expect(admin.has('knowledge.edit')).toBe(false);
      // Keys of other modules and of no module stay
      expect(admin.has('lookups.manage')).toBe(true);
      expect(admin.has('ai.use')).toBe(true);
      expect(
        service
          .abilityFor({ sub: 'u1', roles: vrms('ADMIN') })
          .can('knowledge.view', 'Permission'),
      ).toBe(false);
    });

    // covers: AC-16
    it('restores the same grants when the module comes back on', async () => {
      const settings = new FakeSettings({ 'module.ai': false });
      const { service, state } = setup(defaultRows(), 1, settings);
      await service.onApplicationBootstrap();
      expect(service.keysFor(['MECHANIC']).has('ai.use')).toBe(false);

      settings.set('module.ai', true);
      state.settingsVersion += 1;
      await service.ensureFresh();

      expect(service.keysFor(['MECHANIC']).has('ai.use')).toBe(true);
    });
  });
});
