import type { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { backfillDueDates } from './due-backfill';
import { recomputeDueAt } from './due-dates';

// Spec 0030, AC-13: the backfill loop. The date itself comes from recomputeDueAt (due-dates.spec).

jest.mock('./due-dates', () => ({
  recomputeDueAt: jest.fn(() => Promise.resolve(true)),
}));

function setup(ids: string[], dated: Set<string> = new Set()) {
  const tx = {
    $queryRaw: jest.fn((sql: { values: unknown[] }) =>
      Promise.resolve([
        { due_at: dated.has(sql.values[0] as string) ? new Date() : null },
      ]),
    ),
  };
  const prisma = {
    repairTicket: {
      findMany: jest.fn(
        ({ where, take }: { where: { id?: { gt: string } }; take: number }) => {
          const from = where.id
            ? ids.findIndex((id) => id === where.id!.gt) + 1
            : 0;
          return Promise.resolve(
            ids.slice(from, from + take).map((id) => ({ id })),
          );
        },
      ),
    },
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
  };
  return { prisma, tx };
}

describe('backfillDueDates (spec 0030, AC-13)', () => {
  beforeEach(() => jest.mocked(recomputeDueAt).mockClear());

  it('works through every open undated ticket in batches of 50, as the VRMS system actor', async () => {
    const ids = Array.from(
      { length: 120 },
      (_, i) => `t${String(i).padStart(3, '0')}`,
    );
    const { prisma } = setup(ids);
    const result = await backfillDueDates(
      prisma as unknown as PrismaService,
      new FakeSettings(),
    );
    expect(result).toEqual({ checked: 120, written: 120 });
    expect(prisma.repairTicket.findMany).toHaveBeenCalledTimes(4);
    expect(jest.mocked(recomputeDueAt).mock.calls[0][3]).toMatchObject({
      trigger: 'BACKFILL',
      includeManual: true,
      actor: { kind: 'SYSTEM', name: 'VRMS' },
    });
  });

  it('skips a ticket that got a date under its lock, so a second run changes nothing', async () => {
    const { prisma } = setup(['a', 'b'], new Set(['a', 'b']));
    const result = await backfillDueDates(
      prisma as unknown as PrismaService,
      new FakeSettings(),
    );
    expect(result).toEqual({ checked: 2, written: 0 });
    expect(recomputeDueAt).not.toHaveBeenCalled();
  });
});
