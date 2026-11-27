import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, AuthUser } from '../../auth/account-check';
import {
  MechanicRoster,
  rosterSignature,
  standingOf,
} from './mechanic-roster.service';
import { FakePermissions } from '../../auth/permissions/permissions.fake';
import type { PermissionsService } from '../../auth/permissions/permissions.service';
import type {
  AuthDirectoryClient,
  DirectoryUser,
} from './directory/auth-directory.client';

// Spec 0009, AC-11, AC-13 and AC-14, against an in memory mechanics table.

type Row = {
  id: string;
  authUserId: string;
  name: string;
  email: string | null;
  isActive: boolean;
  role?: string | null;
  assignable?: boolean;
  isLead?: boolean;
};

function fakePrisma(rows: Row[]) {
  let next = rows.length;
  const find = (authUserId: string) =>
    rows.find((r) => r.authUserId === authUserId) ?? null;
  const mechanic = {
    findUnique: jest.fn(({ where }: { where: { authUserId: string } }) =>
      Promise.resolve(find(where.authUserId)),
    ),
    findMany: jest.fn(() => Promise.resolve([...rows])),
    upsert: jest.fn(
      ({
        where,
        create,
        update,
      }: {
        where: { authUserId: string };
        create: Omit<Row, 'id'>;
        update: Partial<Row>;
      }) => {
        const row = find(where.authUserId);
        if (row) Object.assign(row, update);
        else rows.push({ id: `m${++next}`, ...create });
        return Promise.resolve({});
      },
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { authUserId: string };
        data: Partial<Row>;
      }) => {
        const row = find(where.authUserId);
        if (row) Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id?: { in: string[] }; authUserId?: string };
        data: Partial<Row>;
      }) => {
        const hit = rows.filter(
          (r) =>
            (where.id ? where.id.in.includes(r.id) : true) &&
            (where.authUserId ? r.authUserId === where.authUserId : true) &&
            r.isActive,
        );
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      },
    ),
  };
  return { mechanic };
}

const user = (
  id: string,
  role: string,
  extra: Partial<{ isActive: boolean; isLocked: boolean; system: string }> = {},
) => ({
  id,
  name: `Name ${id}`,
  email: `${id.toUpperCase()}@welinc.com`,
  isActive: extra.isActive ?? true,
  isLocked: extra.isLocked ?? false,
  roles: [{ role, system: extra.system ?? 'VRMS' }],
});

type ListedUser = ReturnType<typeof user>;

/** A `/auth/users` row as welinc-auth's directory would answer it to VRMS (spec 0005, AC-7). */
const asDirectoryUser = (u: ListedUser): DirectoryUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: null,
  erased: false,
  picture: null,
  isActive: u.isActive,
  deleted: false,
  roles: u.roles.filter((r) => r.system === 'VRMS').map((r) => r.role),
  updatedAt: '2026-11-09T00:00:00.000Z',
});

/** The default matrix, as a fresh suite holds it (Mechanic and Chief assignable, Chief and Admin lead). */
class Permissions extends FakePermissions {
  synced = true;
  extra = new Map<string, string[]>();
  hasSynced(key: string) {
    return this.synced && super.hasSynced(key);
  }
  keysFor(roles: readonly string[]) {
    const keys = new Set<string>(super.keysFor(roles));
    for (const role of roles)
      for (const k of this.extra.get(role) ?? []) keys.add(k);
    return keys as ReturnType<FakePermissions['keysFor']>;
  }
}

function setup(
  rows: Row[],
  users: ListedUser[],
  permissions = new Permissions(),
  people: unknown[] = [],
) {
  const prisma = {
    ...fakePrisma(rows),
    vrmsPerson: { findMany: jest.fn(() => Promise.resolve(people)) },
  };
  const roster = new MechanicRoster(
    prisma as unknown as PrismaService,
    { whenConfirmed: jest.fn() } as unknown as AccountCheck,
    // Spec 0005, AC-18: refreshOne asks the directory lookup for one person
    {
      lookup: jest.fn((ids: string[]) =>
        Promise.resolve({
          users: users.filter((u) => ids.includes(u.id)).map(asDirectoryUser),
          missing: ids.filter((id) => !users.some((u) => u.id === id)),
        }),
      ),
    } as unknown as AuthDirectoryClient,
    permissions as unknown as PermissionsService,
  );
  return { roster, prisma, rows, permissions };
}

describe('MechanicRoster.ensure', () => {
  const caller = (role: string): AuthUser => ({
    sub: 'a',
    email: 'A@welinc.com',
    name: 'Name a',
    system: 'VRMS',
    roles: [{ role: role, system: 'VRMS' }],
  });

  it('creates a missing row for a mechanic, then reads without writing', async () => {
    const { roster, prisma, rows } = setup([], []);
    await roster.ensure(caller('MECHANIC'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      authUserId: 'a',
      email: 'a@welinc.com',
      isActive: true,
    });

    await roster.ensure(caller('MECHANIC'));
    expect(prisma.mechanic.upsert).toHaveBeenCalledTimes(1);
  });

  it('reactivates an inactive row', async () => {
    const { roster, rows } = setup(
      [
        {
          id: 'm1',
          authUserId: 'a',
          name: 'Name a',
          email: 'a@welinc.com',
          isActive: false,
        },
      ],
      [],
    );
    await roster.ensure(caller('CHIEF_MECHANIC'));
    expect(rows[0].isActive).toBe(true);
  });

  it('leaves admins alone and never throws on a failed write', async () => {
    const { roster, prisma } = setup([], []);
    await roster.ensure(caller('ADMIN'));
    expect(prisma.mechanic.findUnique).not.toHaveBeenCalled();

    prisma.mechanic.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(roster.ensure(caller('MECHANIC'))).resolves.toBeUndefined();
  });
});

// Spec 0009, AC-11 and AC-13: two writers can race for the same authUserId. The unique violation
// (P2002) is recovered by reading the row again, and counts only include rows that really changed.
describe('MechanicRoster duplicate row race', () => {
  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  const rowFor = (authUserId: string, over: Partial<Row> = {}): Row => ({
    id: `m-${authUserId}`,
    authUserId,
    name: `Name ${authUserId}`,
    email: `${authUserId}@welinc.com`,
    isActive: true,
    role: 'MECHANIC',
    assignable: true,
    isLead: false,
    ...over,
  });

  afterEach(() => jest.restoreAllMocks());

  describe('ensure', () => {
    const caller = (): AuthUser => ({
      sub: 'a',
      email: 'A@welinc.com',
      name: 'Name a',
      system: 'VRMS',
      roles: [{ role: 'MECHANIC', system: 'VRMS' }],
    });

    // covers: AC-13 (two first requests at once still end with exactly one row)
    it('recovers from a unique violation without writing again or failing', async () => {
      const { roster, prisma, rows } = setup([], []);
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      prisma.mechanic.upsert.mockImplementationOnce(() => {
        rows.push(rowFor('a'));
        return Promise.reject(uniqueViolation());
      });

      await expect(roster.ensure(caller())).resolves.toBeUndefined();

      expect(rows.filter((r) => r.authUserId === 'a')).toHaveLength(1);
      expect(prisma.mechanic.update).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
    });

    it('fixes the winner row when its values differ after a violation', async () => {
      const { roster, prisma, rows } = setup([], []);
      prisma.mechanic.upsert.mockImplementationOnce(() => {
        rows.push(rowFor('a', { isActive: false }));
        return Promise.reject(uniqueViolation());
      });

      await roster.ensure(caller());

      expect(prisma.mechanic.update).toHaveBeenCalledWith({
        where: { authUserId: 'a' },
        data: {
          name: 'Name a',
          email: 'a@welinc.com',
          isActive: true,
          role: 'MECHANIC',
          assignable: true,
          isLead: false,
        },
      });
    });

    it('logs and swallows a failed write so the request still runs', async () => {
      const { roster, prisma } = setup([], []);
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      prisma.mechanic.upsert.mockRejectedValueOnce(new Error('db down'));

      await expect(roster.ensure(caller())).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('db down');
    });

    it('logs and swallows a failed re-read after a violation', async () => {
      const { roster, prisma } = setup([], []);
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      prisma.mechanic.upsert.mockRejectedValueOnce(uniqueViolation());
      prisma.mechanic.findUnique
        .mockResolvedValueOnce(null) // the ensure read
        .mockResolvedValueOnce(null) // the write's own read
        .mockRejectedValueOnce(new Error('read failed'));

      await expect(roster.ensure(caller())).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledTimes(1);
    });
  });
});

// Spec 0022, AC-4: the VRMS role on each roster row, written by ensure, sync and refreshOne
describe('MechanicRoster role', () => {
  const row = (over: Partial<Row> = {}): Row => ({
    id: 'm1',
    authUserId: 'a',
    name: 'Name a',
    email: 'a@welinc.com',
    isActive: true,
    role: null,
    ...over,
  });

  // covers: suite spec 0018 child 0002 AC-33, AC-34
  it('reads the standing from the keys the roles grant, never a role code', () => {
    const permissions = new Permissions();
    const keysFor = (r: readonly string[]) => permissions.keysFor(r);
    expect(standingOf(['MECHANIC'], keysFor)).toEqual({
      role: 'MECHANIC',
      assignable: true,
      isLead: false,
    });
    expect(standingOf(['CHIEF_MECHANIC'], keysFor)).toEqual({
      role: 'CHIEF_MECHANIC',
      assignable: true,
      isLead: true,
    });
    expect(standingOf(['ADMIN'], keysFor)).toMatchObject({
      assignable: false,
    });
    expect(standingOf([], keysFor)).toBeNull();
  });

  it('fills an empty role on the next sign in', async () => {
    const rows = [row()];
    const { roster } = setup(rows, []);
    await roster.ensure({
      sub: 'a',
      email: 'a@welinc.com',
      name: 'Name a',
      system: 'VRMS',
      roles: [{ role: 'CHIEF_MECHANIC', system: 'VRMS' }],
    });
    expect(rows[0].role).toBe('CHIEF_MECHANIC');
  });

  it('writes a role change from the directory, and nothing more once it matches', async () => {
    const rows = [row({ role: 'MECHANIC' })];
    const { roster } = setup(rows, []);
    const chief = asDirectoryUser(user('a', 'CHIEF_MECHANIC'));
    expect(await roster.apply(chief)).toBe('updated');
    expect(rows[0].role).toBe('CHIEF_MECHANIC');
    expect(await roster.apply(chief)).toBe('unchanged');
  });

  it('refreshOne writes the role too', async () => {
    const rows = [row()];
    const { roster } = setup(rows, [user('a', 'MECHANIC')]);
    await roster.refreshOne('a');
    expect(rows[0].role).toBe('MECHANIC');
  });

  // Suite spec 0013, AC-11
  it("never makes a suite admin's temporary Mechanic role a roster mechanic", async () => {
    const rows: Row[] = [];
    const { roster } = setup(rows, []);
    const temporary = {
      ...asDirectoryUser(user('a', 'MECHANIC')),
      temporaryRoles: ['MECHANIC'],
    };
    expect(await roster.apply(temporary)).not.toBe('created');
    expect(rows.filter((r) => r.isActive)).toHaveLength(0);
  });

  it('keeps the last known role when the person loses every VRMS role', async () => {
    const rows = [row({ role: 'CHIEF_MECHANIC' })];
    const { roster, prisma } = setup(rows, []);
    expect(
      await roster.apply({ ...asDirectoryUser(user('a', 'ADMIN')), roles: [] }),
    ).toBe('deactivated');
    expect(rows[0]).toMatchObject({ isActive: false, role: 'CHIEF_MECHANIC' });
    expect(await roster.refreshOne('a')).toMatchObject({
      stillActive: false,
    });
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
  });

  // covers: suite spec 0018 child 0002 AC-33 (losing the key keeps the row active, off pickers)
  it('keeps someone moved to a role without ticket.assignable active, but not assignable', async () => {
    const rows = [row({ role: 'MECHANIC', assignable: true })];
    const { roster } = setup(rows, []);
    expect(await roster.apply(asDirectoryUser(user('a', 'ADMIN')))).toBe(
      'updated',
    );
    expect(rows[0]).toMatchObject({
      isActive: true,
      assignable: false,
      role: 'ADMIN',
    });
  });
});

// Suite spec 0018 child 0002, AC-33: the roster by ticket.assignable
describe('MechanicRoster by permission', () => {
  const vrmsPerson = (id: string, roles: string[], over = {}) => ({
    authUserId: id,
    name: `Name ${id}`,
    email: `${id}@welinc.com`,
    roles,
    temporaryRoles: [],
    isActive: true,
    deleted: false,
    ...over,
  });

  // covers: suite spec 0018 child 0002 AC-33 (parity: same people as the old role code rule)
  it('holds exactly the people the old role code rule did, with the built in roles only', async () => {
    const people = [
      vrmsPerson('admin', ['ADMIN']),
      vrmsPerson('chief', ['CHIEF_MECHANIC']),
      vrmsPerson('mech', ['MECHANIC']),
      vrmsPerson('temp', ['MECHANIC'], { temporaryRoles: ['MECHANIC'] }),
      vrmsPerson('off', ['MECHANIC'], { isActive: false }),
    ];
    const rows: Row[] = [];
    const { roster } = setup(rows, [], new Permissions(), people);
    await roster.recompute();

    const byCode = people
      .filter((p) =>
        p.roles
          .filter((r) => !p.temporaryRoles.includes(r as never))
          .some((r) => r === 'MECHANIC' || r === 'CHIEF_MECHANIC'),
      )
      .map((p) => p.authUserId)
      .sort();
    expect(rows.map((r) => r.authUserId).sort()).toEqual(byCode);
    expect(rows.find((r) => r.authUserId === 'chief')?.isLead).toBe(true);
    expect(rows.find((r) => r.authUserId === 'mech')?.isLead).toBe(false);
  });

  it('puts a custom role holding ticket.assignable on the roster', async () => {
    const permissions = new Permissions();
    permissions.extra.set('C_TIRE_SPECIALIST', [
      'ticket.assignable',
      'ticket.view',
    ]);
    const rows: Row[] = [];
    const { roster } = setup(rows, [], permissions, [
      vrmsPerson('t', ['C_TIRE_SPECIALIST']),
    ]);
    await roster.recompute();
    expect(rows).toEqual([
      expect.objectContaining({
        authUserId: 't',
        role: 'C_TIRE_SPECIALIST',
        assignable: true,
        isLead: false,
      }),
    ]);
  });

  // covers: suite spec 0018 child 0002 AC-33 (cold start guard)
  it('changes nothing before the grants carry ticket.assignable', async () => {
    const permissions = new Permissions();
    permissions.synced = false;
    const rows = [
      {
        id: 'm1',
        authUserId: 'a',
        name: 'Name a',
        email: 'a@welinc.com',
        isActive: true,
        role: 'MECHANIC',
        assignable: true,
      },
    ];
    const { roster, prisma } = setup(rows, [], permissions, [
      vrmsPerson('a', []),
    ]);
    expect(await roster.recompute()).toBeNull();
    expect(
      await roster.apply({
        ...asDirectoryUser(user('a', 'MECHANIC')),
        roles: [],
      }),
    ).toBe('unchanged');
    await roster.ensure({
      sub: 'b',
      email: 'b@welinc.com',
      name: 'b',
      system: 'VRMS',
      roles: [{ role: 'MECHANIC', system: 'VRMS' }],
    });
    expect(rows[0].isActive).toBe(true);
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
    expect(prisma.mechanic.update).not.toHaveBeenCalled();
  });

  it('recomputes only when who holds the two roster keys changes', () => {
    const loaded = (assignable: string[], synced = true) => ({
      version: 1,
      grants: new Map(
        ['ADMIN', 'MECHANIC'].map((r) => [
          r,
          new Set(assignable.includes(r) ? ['ticket.assignable'] : []),
        ]),
      ),
      syncedKeys: new Set(synced ? ['ticket.assignable'] : []),
    });
    expect(rosterSignature(loaded(['MECHANIC'], false) as never)).toBeNull();
    expect(rosterSignature(loaded(['MECHANIC']) as never)).toBe(
      rosterSignature(loaded(['MECHANIC']) as never),
    );
    expect(rosterSignature(loaded(['MECHANIC']) as never)).not.toBe(
      rosterSignature(loaded(['MECHANIC', 'ADMIN']) as never),
    );
  });
});

// Spec 0005, AC-13: applying one person from the directory (the poll, the full read, refreshOne)
describe('MechanicRoster.apply', () => {
  const person = (over: Partial<DirectoryUser> = {}): DirectoryUser => ({
    ...asDirectoryUser(user('a', 'MECHANIC')),
    ...over,
  });
  const row = (over: Partial<Row> = {}): Row => ({
    id: 'm1',
    authUserId: 'a',
    name: 'Name a',
    email: 'a@welinc.com',
    isActive: true,
    role: 'MECHANIC',
    ...over,
  });

  it('creates a row for a new mechanic with a lower case email', async () => {
    const rows: Row[] = [];
    const { roster } = setup(rows, []);
    expect(await roster.apply(person())).toBe('created');
    expect(rows[0]).toMatchObject({
      authUserId: 'a',
      email: 'a@welinc.com',
      isActive: true,
      role: 'MECHANIC',
    });
  });

  it('updates a changed name, and applying the same person twice changes nothing', async () => {
    const rows = [row()];
    const { roster, prisma } = setup(rows, []);
    const renamed = person({ name: 'Ana Cruz' });
    expect(await roster.apply(renamed)).toBe('updated');
    expect(rows[0].name).toBe('Ana Cruz');
    prisma.mechanic.upsert.mockClear();
    expect(await roster.apply(renamed)).toBe('unchanged');
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
  });

  it('follows a deactivated account and keeps the row', async () => {
    const rows = [row()];
    const { roster } = setup(rows, []);
    expect(await roster.apply(person({ isActive: false }))).toBe('deactivated');
    expect(rows[0]).toMatchObject({ isActive: false, role: 'MECHANIC' });
  });

  it('sets a deleted person inactive, keeping their last role', async () => {
    const rows = [row({ role: 'CHIEF_MECHANIC' })];
    const { roster } = setup(rows, []);
    expect(
      await roster.apply(person({ deleted: true, roles: ['CHIEF_MECHANIC'] })),
    ).toBe('deactivated');
    expect(rows[0]).toMatchObject({ isActive: false, role: 'CHIEF_MECHANIC' });
  });

  it('sets inactive someone who lost every VRMS role (roles: [])', async () => {
    const rows = [row()];
    const { roster } = setup(rows, []);
    expect(await roster.apply(person({ roles: [] }))).toBe('deactivated');
    expect(rows[0].isActive).toBe(false);
    expect(await roster.apply(person({ roles: [] }))).toBe('unchanged');
  });

  it('ignores a person with no mechanic role and no row', async () => {
    const rows: Row[] = [];
    const { roster, prisma } = setup(rows, []);
    expect(await roster.apply(person({ roles: ['ADMIN'] }))).toBe('unchanged');
    expect(rows).toHaveLength(0);
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
  });

  it('reactivates a row when the role comes back', async () => {
    const rows = [row({ isActive: false })];
    const { roster } = setup(rows, []);
    expect(await roster.apply(person())).toBe('updated');
    expect(rows[0].isActive).toBe(true);
  });

  it('writes through the transaction it is given', async () => {
    const rows: Row[] = [];
    const { roster, prisma } = setup(rows, []);
    const tx = fakePrisma(rows);
    await roster.apply(person(), tx as never);
    expect(tx.mechanic.upsert).toHaveBeenCalled();
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
  });
});

// Spec 0005, AC-18: refreshOne reads one person through the directory lookup
describe('MechanicRoster.refreshOne', () => {
  it('sets inactive a person the lookup puts in missing', async () => {
    const rows: Row[] = [
      {
        id: 'm1',
        authUserId: 'gone',
        name: 'Gone',
        email: null,
        isActive: true,
      },
    ];
    const { roster } = setup(rows, []);
    expect(await roster.refreshOne('gone')).toEqual({
      mechanicId: 'm1',
      stillActive: false,
    });
    expect(rows[0].isActive).toBe(false);
  });

  it('creates the row for a mechanic the lookup returns, and answers null for nobody', async () => {
    const rows: Row[] = [];
    const { roster } = setup(rows, [user('a', 'MECHANIC')]);
    expect(await roster.refreshOne('a')).toMatchObject({ stillActive: true });
    expect(await roster.refreshOne('nobody')).toBeNull();
  });
});
