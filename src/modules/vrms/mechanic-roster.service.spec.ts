import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, AuthUser } from '../../auth/account-check';
import { MechanicRoster } from './mechanic-roster.service';

// Spec 0009, AC-11, AC-13 and AC-14, against an in memory mechanics table.

type Row = {
  id: string;
  authUserId: string;
  name: string;
  email: string | null;
  isActive: boolean;
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
    update: jest.fn(),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: Partial<Row>;
      }) => {
        const hit = rows.filter(
          (r) => where.id.in.includes(r.id) && r.isActive,
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

function setup(rows: Row[], users: unknown[]) {
  global.fetch = jest.fn(() =>
    Promise.resolve(new Response(JSON.stringify(users), { status: 200 })),
  );
  const prisma = fakePrisma(rows);
  const env = {
    getOrThrow: () => 'http://auth-service:3001',
  } as unknown as ConfigService;
  const roster = new MechanicRoster(
    prisma as unknown as PrismaService,
    { whenConfirmed: jest.fn() } as unknown as AccountCheck,
    env,
  );
  return { roster, prisma, rows };
}

describe('MechanicRoster.sync', () => {
  it('creates, updates and deactivates, then a second call changes nothing', async () => {
    const rows: Row[] = [
      {
        id: 'm1',
        authUserId: 'b',
        name: 'Old',
        email: 'b@welinc.com',
        isActive: true,
      },
      {
        id: 'm2',
        authUserId: 'gone',
        name: 'Gone',
        email: null,
        isActive: true,
      },
    ];
    const { roster } = setup(rows, [
      user('a', 'MECHANIC'),
      user('b', 'CHIEF_MECHANIC'),
      user('c', 'MECHANIC', { isLocked: true }),
      user('d', 'ADMIN'),
      user('e', 'MECHANIC', { system: 'VMMS' }),
    ]);

    expect(await roster.sync('tok')).toEqual({
      created: 2,
      updated: 1,
      deactivated: 1,
    });
    expect(rows.find((r) => r.authUserId === 'a')).toMatchObject({
      name: 'Name a',
      email: 'a@welinc.com',
      isActive: true,
    });
    // A locked mechanic stays active (spec 0011, AC-31)
    expect(rows.find((r) => r.authUserId === 'c')?.isActive).toBe(true);
    expect(rows.find((r) => r.id === 'm2')?.isActive).toBe(false);
    expect(rows.some((r) => r.authUserId === 'd' || r.authUserId === 'e')).toBe(
      false,
    );

    expect(await roster.sync('tok')).toEqual({
      created: 0,
      updated: 0,
      deactivated: 0,
    });
  });

  it('asks welinc-auth for the VRMS users with the admin token', async () => {
    const { roster } = setup([], []);
    await roster.sync('tok');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://auth-service:3001/auth/users?system=VRMS');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });
});

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
    ...over,
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sync', () => {
    // covers: AC-11
    it('counts nothing when the winner already wrote the same values', async () => {
      const { roster, prisma, rows } = setup([], [user('a', 'MECHANIC')]);
      prisma.mechanic.upsert.mockImplementationOnce(() => {
        rows.push(rowFor('a'));
        return Promise.reject(uniqueViolation());
      });

      const result = await roster.sync('tok');

      expect(result).toEqual({ created: 0, updated: 0, deactivated: 0 });
      expect(prisma.mechanic.update).not.toHaveBeenCalled();
      expect(rows.filter((r) => r.authUserId === 'a')).toHaveLength(1);
    });

    it('updates the row the winner wrote when its values still differ', async () => {
      const { roster, prisma, rows } = setup([], [user('a', 'MECHANIC')]);
      prisma.mechanic.upsert.mockImplementationOnce(() => {
        rows.push(rowFor('a', { name: 'Stale name', isActive: false }));
        return Promise.reject(uniqueViolation());
      });

      const result = await roster.sync('tok');

      expect(result).toEqual({ created: 0, updated: 1, deactivated: 0 });
      expect(prisma.mechanic.update).toHaveBeenCalledWith({
        where: { authUserId: 'a' },
        data: { name: 'Name a', email: 'a@welinc.com', isActive: true },
      });
    });

    it('counts nothing when the row is gone again after the violation', async () => {
      const { roster, prisma } = setup([], [user('a', 'MECHANIC')]);
      prisma.mechanic.upsert.mockRejectedValueOnce(uniqueViolation());

      const result = await roster.sync('tok');

      expect(result).toEqual({ created: 0, updated: 0, deactivated: 0 });
      expect(prisma.mechanic.update).not.toHaveBeenCalled();
    });

    it('rethrows an error that is not a unique violation', async () => {
      const { roster, prisma } = setup([], [user('a', 'MECHANIC')]);
      prisma.mechanic.upsert.mockRejectedValueOnce(new Error('db down'));

      await expect(roster.sync('tok')).rejects.toThrow('db down');
    });

    it('rethrows a different Prisma error code', async () => {
      const { roster, prisma } = setup([], [user('a', 'MECHANIC')]);
      prisma.mechanic.upsert.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(roster.sync('tok')).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    // covers: AC-11 (two concurrent calls leave one row per authUserId and never answer 500)
    it('leaves one row per authUserId when two syncs run at the same time', async () => {
      const { roster, prisma, rows } = setup([], [user('a', 'MECHANIC')]);
      // Each upsert decides at its start whether the row exists, like the unique index would
      prisma.mechanic.upsert.mockImplementation(
        async ({
          where,
          create,
          update,
        }: {
          where: { authUserId: string };
          create: Omit<Row, 'id'>;
          update: Partial<Row>;
        }) => {
          const existedAtStart = rows.find(
            (r) => r.authUserId === where.authUserId,
          );
          await Promise.resolve();
          const now = rows.find((r) => r.authUserId === where.authUserId);
          if (existedAtStart) Object.assign(existedAtStart, update);
          else if (now) throw uniqueViolation();
          else rows.push({ id: 'm-new', ...create });
          return {};
        },
      );

      const [first, second] = await Promise.all([
        roster.sync('tok'),
        roster.sync('tok'),
      ]);

      expect(rows.filter((r) => r.authUserId === 'a')).toHaveLength(1);
      expect(first.created + second.created).toBeGreaterThanOrEqual(1);
      expect(first.updated + second.updated).toBe(0);
    });
  });

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
        data: { name: 'Name a', email: 'a@welinc.com', isActive: true },
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
