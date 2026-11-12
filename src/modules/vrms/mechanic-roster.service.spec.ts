import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, AuthUser } from '../../auth/account-check';
import { MechanicRoster, roleOf } from './mechanic-roster.service';
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

function setup(rows: Row[], users: ListedUser[]) {
  const prisma = fakePrisma(rows);
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
  );
  return { roster, prisma, rows };
}

describe('MechanicRoster.ensure', () => {
  const caller = (role: string): AuthUser => ({
    sub: 'a',
    email: 'A@welinc.com',
    name: 'Name a',
    system: 'VRMS',
    roles: [
      { role: role as AuthUser['roles'][number]['role'], system: 'VRMS' },
    ],
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

  it('reads only VRMS mechanic roles, with Chief Mechanic winning', () => {
    expect(roleOf([{ role: 'MECHANIC', system: 'VRMS' }])).toBe('MECHANIC');
    expect(
      roleOf([
        { role: 'MECHANIC', system: 'VRMS' },
        { role: 'CHIEF_MECHANIC', system: 'VRMS' },
      ]),
    ).toBe('CHIEF_MECHANIC');
    expect(roleOf([{ role: 'CHIEF_MECHANIC', system: 'VMMS' }])).toBeNull();
    expect(roleOf([{ role: 'ADMIN', system: 'VRMS' }])).toBeNull();
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

  it('keeps the last known role when the person loses VRMS access', async () => {
    const rows = [row({ role: 'CHIEF_MECHANIC' })];
    const { roster, prisma } = setup(rows, [user('a', 'ADMIN')]);
    expect(await roster.apply(asDirectoryUser(user('a', 'ADMIN')))).toBe(
      'deactivated',
    );
    expect(rows[0]).toMatchObject({ isActive: false, role: 'CHIEF_MECHANIC' });
    expect(await roster.refreshOne('a')).toMatchObject({
      stillActive: false,
    });
    expect(prisma.mechanic.upsert).not.toHaveBeenCalled();
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
