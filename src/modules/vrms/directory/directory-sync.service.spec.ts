import { HttpException, Logger } from '@nestjs/common';
import type { PrismaService } from '../../../shared/prisma.service';
import type { MechanicRoster } from '../mechanic-roster.service';
import {
  DirectoryCursorError,
  DirectoryUnavailableError,
  type AuthDirectoryClient,
  type ChangesPage,
  type DirectoryUser,
  type UsersPage,
} from './auth-directory.client';
import { DirectorySync } from './directory-sync.service';

// Spec 0005, AC-12 to AC-17: the poll job's tick and the recovery sync, against an in memory
// directory_sync_state row, a fake welinc-auth directory and a fake roster.

type State = {
  cursor: string | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  failingSince: Date | null;
};

type MechanicRow = { id: string; authUserId: string; isActive: boolean };

const person = (id: string): DirectoryUser => ({
  id,
  name: `Name ${id}`,
  email: `${id}@welinc.com`,
  phone: null,
  phoneVerified: false,
  picture: null,
  isActive: true,
  deleted: false,
  roles: ['MECHANIC'],
  updatedAt: '2026-11-09T00:00:00.000Z',
});

const change = (cursor: string, id: string) => ({
  cursor,
  type: 'updated',
  at: '2026-11-09T00:00:00.000Z',
  user: person(id),
});

function fakePrisma(state: State, mechanics: MechanicRow[] = []) {
  const stateUpdate = jest.fn(
    ({
      where,
      data,
    }: {
      where: { leaseOwner: string };
      data: Partial<State>;
    }) => {
      if (state.leaseOwner !== where.leaseOwner) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    },
  );
  const prisma = {
    // claim(): values are [owner, seconds, id]
    $queryRaw: jest.fn((_s: TemplateStringsArray, owner: string) => {
      const free = state.leaseUntil === null || state.leaseUntil < new Date();
      if (!free) return Promise.resolve([]);
      state.leaseOwner = owner;
      state.leaseUntil = new Date(Date.now() + 120_000);
      return Promise.resolve([
        { cursor: state.cursor, failing_since: state.failingSince },
      ]);
    }),
    // renew(): values are [seconds, id, owner]
    $executeRaw: jest.fn(
      (_s: TemplateStringsArray, _secs: number, _id: string, owner: string) =>
        Promise.resolve(state.leaseOwner === owner ? 1 : 0),
    ),
    directorySyncState: {
      updateMany: jest.fn((args: Parameters<typeof stateUpdate>[0]) =>
        Promise.resolve(stateUpdate(args)),
      ),
    },
    mechanic: {
      findMany: jest.fn(() =>
        Promise.resolve(mechanics.filter((m) => m.isActive)),
      ),
      updateMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
        const hit = mechanics.filter(
          (m) => where.id.in.includes(m.id) && m.isActive,
        );
        hit.forEach((m) => (m.isActive = false));
        return Promise.resolve({ count: hit.length });
      }),
    },
  };
  // The transaction hands the same fake to the work, like a real interactive transaction
  return Object.assign(prisma, {
    $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
  });
}

function setup(
  state: Partial<State>,
  directory: Partial<Record<keyof AuthDirectoryClient, jest.Mock>>,
  mechanics: MechanicRow[] = [],
) {
  const row: State = {
    cursor: null,
    leaseOwner: null,
    leaseUntil: null,
    failingSince: null,
    ...state,
  };
  const prisma = fakePrisma(row, mechanics);
  const applied: string[] = [];
  const roster = {
    apply: jest.fn((user: DirectoryUser) => {
      applied.push(user.id);
      return Promise.resolve('updated');
    }),
  };
  const sync = new DirectorySync(
    prisma as unknown as PrismaService,
    roster as unknown as MechanicRoster,
    directory as unknown as AuthDirectoryClient,
  );
  return { sync, row, prisma, roster, applied };
}

describe('DirectorySync', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('full read (no cursor)', () => {
    // covers: AC-12, AC-13
    it('pages every user, deactivates rows that did not appear, then saves the first changesCursor', async () => {
      const pages: UsersPage[] = [
        { users: [person('a')], next: 'p2', changesCursor: 'start' },
        { users: [person('b')], next: null, changesCursor: 'later' },
      ];
      const listUsers = jest.fn((cursor: string | null) =>
        Promise.resolve(cursor === null ? pages[0] : pages[1]),
      );
      const mechanics = [
        { id: 'm1', authUserId: 'a', isActive: true },
        { id: 'm2', authUserId: 'gone', isActive: true },
      ];
      const { sync, row, applied } = setup({}, { listUsers }, mechanics);

      const outcome = await sync.tick();

      expect(applied).toEqual(['a', 'b']);
      expect(mechanics[1].isActive).toBe(false);
      expect(row.cursor).toBe('start');
      expect(outcome).toEqual({
        kind: 'full',
        result: { created: 0, updated: 2, deactivated: 1 },
      });
      // AC-16: released
      expect(row.leaseOwner).toBeNull();
      expect(row.leaseUntil).toBeNull();
    });

    it('leaves the cursor null when a page fails halfway, so the next tick starts over', async () => {
      const listUsers = jest
        .fn()
        .mockResolvedValueOnce({
          users: [person('a')],
          next: 'p2',
          changesCursor: 'start',
        })
        .mockRejectedValueOnce(new DirectoryUnavailableError('status 503'));
      const { sync, row } = setup({}, { listUsers });

      expect(await sync.tick()).toEqual({ kind: 'failing' });
      expect(row.cursor).toBeNull();
    });
  });

  describe('feed (with a cursor)', () => {
    // covers: AC-12
    it('applies changes in order, moving the cursor past each, then to the safe point', async () => {
      const changes = jest.fn().mockResolvedValueOnce({
        changes: [change('c1', 'a'), change('c2', 'b')],
        next: 'safe',
        hasMore: false,
      } satisfies ChangesPage);
      const { sync, row, applied, prisma } = setup(
        { cursor: 'c0' },
        { changes },
      );

      expect(await sync.tick()).toEqual({ kind: 'changes', applied: 2 });
      expect(changes).toHaveBeenCalledWith('c0');
      expect(applied).toEqual(['a', 'b']);
      expect(row.cursor).toBe('safe');
      // each change in its own transaction with its cursor
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('moves to a new next when the page has no changes', async () => {
      const changes = jest
        .fn()
        .mockResolvedValueOnce({ changes: [], next: 'safe', hasMore: false });
      const { sync, row } = setup({ cursor: 'c0' }, { changes });
      await sync.tick();
      expect(row.cursor).toBe('safe');
    });

    it('reads at most 10 pages a tick', async () => {
      let n = 0;
      const changes = jest.fn(() => {
        n++;
        return Promise.resolve({
          changes: [change(`c${n}`, `u${n}`)],
          next: `c${n}`,
          hasMore: true,
        });
      });
      const { sync, row } = setup({ cursor: 'c0' }, { changes });
      expect(await sync.tick()).toEqual({ kind: 'changes', applied: 10 });
      expect(changes).toHaveBeenCalledTimes(10);
      expect(row.cursor).toBe('c10');
    });

    // covers: AC-14
    it('stops on a change that fails to apply, keeping the cursor before it', async () => {
      const changes = jest.fn().mockResolvedValue({
        changes: [change('c1', 'a'), change('c2', 'b'), change('c3', 'c')],
        next: 'safe',
        hasMore: false,
      });
      const { sync, row, roster } = setup({ cursor: 'c0' }, { changes });
      roster.apply.mockImplementation((user: DirectoryUser) =>
        user.id === 'b'
          ? Promise.reject(new Error('db hiccup'))
          : Promise.resolve('updated'),
      );

      expect(await sync.tick()).toEqual({ kind: 'stopped' });
      expect(row.cursor).toBe('c1');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('c2'));

      // the next tick tries the same change again
      roster.apply.mockResolvedValue('updated');
      await sync.tick();
      expect(changes).toHaveBeenLastCalledWith('c1');
      expect(row.cursor).toBe('safe');
    });

    // covers: AC-12
    it('drops the cursor on INVALID_CURSOR, with one warning, so the next tick reads everything', async () => {
      const changes = jest.fn().mockRejectedValue(new DirectoryCursorError());
      const { sync, row } = setup({ cursor: 'old-epoch' }, { changes });
      expect(await sync.tick()).toEqual({ kind: 'reset' });
      expect(row.cursor).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('welinc-auth failing', () => {
    // covers: AC-15
    it('warns once while failing, then logs one line on the first good tick', async () => {
      const changes = jest
        .fn()
        .mockRejectedValueOnce(new DirectoryUnavailableError('status 503'))
        .mockRejectedValueOnce(new DirectoryUnavailableError('status 429'))
        .mockRejectedValueOnce(new DirectoryUnavailableError('TimeoutError'))
        .mockResolvedValueOnce({ changes: [], next: 'c0', hasMore: false });
      const { sync, row } = setup({ cursor: 'c0' }, { changes });

      for (let i = 0; i < 3; i++) {
        expect(await sync.tick()).toEqual({ kind: 'failing' });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(row.failingSince).toBeInstanceOf(Date);

      await sync.tick();
      expect(row.failingSince).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/back after \d+ s/),
      );
    });
  });

  describe('lease', () => {
    // covers: AC-16
    it('does nothing and logs nothing while another copy holds the lease', async () => {
      const changes = jest.fn();
      const { sync, row } = setup(
        {
          cursor: 'c0',
          leaseOwner: 'other',
          leaseUntil: new Date(Date.now() + 60_000),
        },
        { changes },
      );
      expect(await sync.tick()).toEqual({ kind: 'skipped' });
      expect(changes).not.toHaveBeenCalled();
      expect(row.leaseOwner).toBe('other');
      expect(warn).not.toHaveBeenCalled();
    });

    it('takes over an expired lease', async () => {
      const changes = jest
        .fn()
        .mockResolvedValue({ changes: [], next: 'c0', hasMore: false });
      const { sync } = setup(
        { cursor: 'c0', leaseOwner: 'crashed', leaseUntil: new Date(0) },
        { changes },
      );
      expect(await sync.tick()).toEqual({ kind: 'changes', applied: 0 });
    });

    it('stops without writing when the lease was taken during the tick', async () => {
      const { sync, row, prisma } = setup({ cursor: 'c0' }, {});
      const changes = jest.fn(() => {
        // another copy took over after our lease ran out
        row.leaseOwner = 'thief';
        return Promise.resolve({
          changes: [change('c1', 'a')],
          next: 'c1',
          hasMore: false,
        });
      });
      (sync as unknown as { directory: { changes: jest.Mock } }).directory = {
        changes,
      };

      expect(await sync.tick()).toEqual({ kind: 'stopped' });
      expect(row.cursor).toBe('c0');
      expect(row.leaseOwner).toBe('thief');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('recover (POST /vrms/mechanics/sync)', () => {
    // covers: AC-17
    it('runs the full read and saves the new changesCursor over an old one', async () => {
      const listUsers = jest.fn().mockResolvedValue({
        users: [person('a')],
        next: null,
        changesCursor: 'fresh',
      });
      const { sync, row } = setup({ cursor: 'old' }, { listUsers });
      expect(await sync.recover()).toEqual({
        created: 0,
        updated: 1,
        deactivated: 0,
      });
      expect(row.cursor).toBe('fresh');
      expect(row.leaseOwner).toBeNull();
    });

    it('answers 409 SYNC_RUNNING while another copy holds the lease', async () => {
      const { sync } = setup(
        { leaseOwner: 'other', leaseUntil: new Date(Date.now() + 60_000) },
        {},
      );
      const err: unknown = await sync.recover().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(409);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: 'SYNC_RUNNING',
      });
    });

    it('answers 503 AUTH_UNAVAILABLE when welinc-auth is down, and releases the lease', async () => {
      const listUsers = jest
        .fn()
        .mockRejectedValue(new DirectoryUnavailableError('status 502'));
      const { sync, row } = setup({}, { listUsers });
      const err: unknown = await sync.recover().catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(503);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: 'AUTH_UNAVAILABLE',
      });
      expect(row.leaseOwner).toBeNull();
    });
  });
});
