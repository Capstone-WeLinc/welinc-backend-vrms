import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, AuthUser } from '../../auth/account-check';
import { MechanicRoster } from './mechanic-roster.service';

// Spec 0009, AC-11, AC-13 and AC-14, against an in memory mechanics table.

type Row = {
  id: string;
  authUserId: string | null;
  name: string;
  email: string | null;
  isActive: boolean;
  isOutsourced: boolean;
};

function fakePrisma(rows: Row[]) {
  let next = rows.length;
  const find = (authUserId: string) =>
    rows.find((r) => r.authUserId === authUserId) ?? null;
  const mechanic = {
    findUnique: jest.fn(({ where }: { where: { authUserId: string } }) =>
      Promise.resolve(find(where.authUserId)),
    ),
    findMany: jest.fn(({ where }: { where: { isOutsourced: boolean } }) =>
      Promise.resolve(
        rows.filter((r) => r.isOutsourced === where.isOutsourced),
      ),
    ),
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
        isOutsourced: false,
      },
      {
        id: 'm2',
        authUserId: 'gone',
        name: 'Gone',
        email: null,
        isActive: true,
        isOutsourced: false,
      },
      {
        id: 'm3',
        authUserId: null,
        name: 'Shop guy',
        email: null,
        isActive: true,
        isOutsourced: true,
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
    // A locked mechanic leaves the picker until unlocked
    expect(rows.find((r) => r.authUserId === 'c')?.isActive).toBe(false);
    expect(rows.find((r) => r.id === 'm2')?.isActive).toBe(false);
    // Outsourced rows are never touched
    expect(rows.find((r) => r.id === 'm3')?.isActive).toBe(true);
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
          isOutsourced: false,
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
