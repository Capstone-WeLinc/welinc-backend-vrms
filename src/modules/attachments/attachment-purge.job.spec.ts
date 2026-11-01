import { AttachmentPurgeJob, purgeDueWhere } from './attachment-purge.job';
import type { FileStore, ListedBlob } from './file-store';
import type { PrismaService } from '../../shared/prisma.service';

// Spec 0017, AC-19: purge after 30 days, sweep orphans after 24 hours, one replica at a time.

const NOW = new Date('2026-11-01T19:00:00Z');
const HOUR = 60 * 60 * 1000;
const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const id = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number, file = 'file.jpg') => `tickets/${T}/${id(n)}/${file}`;

type Row = {
  id: string;
  storageKey: string;
  thumbnailKey: string | null;
  deletedAt: Date | null;
  purgedAt: Date | null;
};

function setup(opts: {
  rows?: Row[];
  blobs?: ListedBlob[];
  locked?: boolean;
  failDelete?: string[];
  configured?: boolean;
}) {
  const rows = opts.rows ?? [];
  const deleted: string[] = [];
  const store: FileStore = {
    configured: opts.configured ?? true,
    put: jest.fn(),
    readUrl: jest.fn(),
    delete: jest.fn((k: string) => {
      if (opts.failDelete?.includes(k))
        return Promise.reject(new Error('boom'));
      deleted.push(k);
      return Promise.resolve();
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    list: async function* () {
      for (const b of opts.blobs ?? []) yield b;
    },
  };

  const due = (r: Row, notIn: string[]) =>
    r.deletedAt !== null &&
    r.deletedAt < (purgeDueWhere(NOW).deletedAt as { lt: Date }).lt &&
    r.purgedAt === null &&
    !notIn.includes(r.id);

  const findMany = jest.fn(
    (args: {
      where: { id: { notIn?: string[]; in?: string[] } };
      take?: number;
    }) => {
      if (args.where.id.in) {
        return Promise.resolve(
          rows
            .filter((r) => args.where.id.in!.includes(r.id))
            .map((r) => ({ id: r.id })),
        );
      }
      return Promise.resolve(
        rows
          .filter((r) => due(r, args.where.id.notIn ?? []))
          .slice(0, args.take),
      );
    },
  );
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: opts.locked ?? true }]),
    attachment: {
      findMany,
      updateMany: jest.fn(
        (args: {
          where: { id: { in: string[] } };
          data: { purgedAt: Date };
        }) => {
          for (const r of rows)
            if (args.where.id.in.includes(r.id))
              r.purgedAt = args.data.purgedAt;
          return Promise.resolve({ count: args.where.id.in.length });
        },
      ),
    },
  };
  const transaction = jest.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const prisma = {
    $transaction: transaction,
    attachment: {
      count: jest.fn(() =>
        Promise.resolve(rows.filter((r) => due(r, [])).length),
      ),
    },
  } as unknown as PrismaService;

  return {
    job: new AttachmentPurgeJob(prisma, store),
    rows,
    deleted,
    findMany,
    transaction,
  };
}

const row = (n: number, deletedDaysAgo: number | null, thumb = true): Row => ({
  id: id(n),
  storageKey: key(n),
  thumbnailKey: thumb ? key(n, 'thumb.webp') : null,
  deletedAt:
    deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - deletedDaysAgo * 24 * HOUR),
  purgedAt: null,
});

describe('AttachmentPurgeJob', () => {
  it('purges rows removed over 30 days ago, blobs first, and keeps the row', async () => {
    const { job, rows, deleted } = setup({
      rows: [row(1, 31), row(2, 29), row(3, null)],
    });
    const result = await job.run(NOW);
    expect(result).toEqual({ purged: 1, orphans: 0 });
    expect(deleted).toEqual([key(1), key(1, 'thumb.webp')]);
    expect(rows[0].purgedAt).toEqual(NOW);
    expect(rows[1].purgedAt).toBeNull();
  });

  it('works through more than one batch of 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => row(i + 1, 40, false));
    const { job, rows } = setup({ rows: many });
    expect((await job.run(NOW)).purged).toBe(150);
    expect(rows.every((r) => r.purgedAt)).toBe(true);
  });

  it('leaves a row unpurged when its blob delete fails, and goes on', async () => {
    const { job, rows } = setup({
      rows: [row(1, 40), row(2, 40)],
      failDelete: [key(1)],
    });
    expect((await job.run(NOW)).purged).toBe(1);
    expect(rows[0].purgedAt).toBeNull();
    expect(rows[1].purgedAt).toEqual(NOW);
  });

  it('sweeps blobs with no row older than 24 hours, by createdOn', async () => {
    const old = new Date(NOW.getTime() - 25 * HOUR);
    const fresh = new Date(NOW.getTime() - 2 * HOUR);
    const { job, deleted } = setup({
      rows: [row(1, null)],
      blobs: [
        { name: key(1), createdOn: old }, // has a row
        { name: key(2), createdOn: old }, // orphan
        { name: key(2, 'thumb.webp'), createdOn: old }, // orphan
        { name: key(3), createdOn: fresh }, // in flight upload
        { name: key(4), createdOn: undefined }, // no createdOn, left alone
        { name: `tickets/${T}/not-a-uuid/file.jpg`, createdOn: old },
      ],
    });
    expect(await job.run(NOW)).toEqual({ purged: 0, orphans: 2 });
    expect(deleted).toEqual([key(2), key(2, 'thumb.webp')]);
  });

  it('skips when another replica holds the lock', async () => {
    const { job, deleted, findMany } = setup({
      rows: [row(1, 40)],
      locked: false,
    });
    expect(await job.run(NOW)).toEqual({
      purged: 0,
      orphans: 0,
      skipped: true,
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it('does nothing when storage is not configured', async () => {
    const { job, transaction } = setup({
      rows: [row(1, 40)],
      configured: false,
    });
    expect((await job.run(NOW)).skipped).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('runs after boot only when a due row exists', async () => {
    const none = setup({ rows: [row(1, 5)] });
    await none.job.runAfterBoot();
    expect(none.transaction).not.toHaveBeenCalled();

    const some = setup({ rows: [row(1, 40)] });
    await some.job.runAfterBoot();
    expect(some.transaction).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second pass finds nothing to do', async () => {
    const { job } = setup({ rows: [row(1, 40)] });
    await job.run(NOW);
    expect(await job.run(NOW)).toEqual({ purged: 0, orphans: 0 });
  });
});
