import type { Prisma } from '@prisma/client';
import { FakeSettings } from '../../settings/settings.fake';
import { setDueAt } from '../integrations/bms/set-due-at';
import { previewDueAt, recomputeDueAt } from './due-dates';
import type { RowActor } from './audit-events';

// Spec 0030: recomputeDueAt and previewDueAt, the part that loads a ticket and decides whether
// to write. The pure calculator is in due-dates.spec.ts; setDueAt is mocked here.

jest.mock('../integrations/bms/set-due-at', () => ({
  setDueAt: jest.fn(() => Promise.resolve(true)),
}));

const HOUR = 3_600_000;
const CREATED = new Date('2026-11-27T00:00:00.000Z');
const NOW = new Date('2026-11-27T10:00:00.000Z');
const actor = {
  kind: 'USER',
  userId: 'u-1',
  name: 'Ana Reyes',
} as never as RowActor;

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    priority: 'HIGH',
    createdAt: CREATED,
    dueAt: new Date(CREATED.getTime() + 24 * HOUR),
    dueAtSource: 'PRIORITY',
    repairStatus: 'OPEN',
    issues: [
      {
        id: 'i1',
        description: '[Brakes] Wear: grinding',
        knowledgeEntryId: null,
        category: { name: 'Brakes', fixHours: 6 },
        knowledgeEntry: null,
      },
      {
        id: 'i2',
        description: '[Engine] Wear: misfire',
        knowledgeEntryId: null,
        category: { name: 'Engine', fixHours: 48 },
        knowledgeEntry: null,
      },
    ],
    ...overrides,
  };
}

function setup(row: Record<string, unknown>, settings = new FakeSettings()) {
  const tx = {
    repairTicket: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, settings };
}

describe('recomputeDueAt (spec 0030, AC-5, AC-9, AC-14)', () => {
  beforeEach(() => jest.mocked(setDueAt).mockClear());

  it('writes the worked out date through setDueAt, with the trigger prefix in the reason (AC-5)', async () => {
    const { tx, settings } = setup(ticketRow());
    const changed = await recomputeDueAt(tx, 't1', settings, {
      trigger: 'ISSUE_ADDED',
      actor,
      now: NOW,
    });
    expect(changed).toBe(true);
    // Brakes 6 h plus Engine 48 h beats High (24 h), counted from creation
    const call = jest.mocked(setDueAt).mock.calls[0];
    expect(call[2]).toEqual({
      dueAt: new Date(CREATED.getTime() + 54 * HOUR),
      source: 'ISSUE_TYPE',
      reason:
        'Issue added. Due date from issue times (54 h: Brakes 6 h, Engine 48 h)',
    });
    expect(call[3]).toBe(actor);
    expect(call[4]).toEqual(NOW);
  });

  it.each(['CLOSED', 'CANCELLED'])(
    'never works out a date for a %s ticket (AC-14)',
    async (repairStatus) => {
      const { tx, settings } = setup(ticketRow({ repairStatus }));
      await expect(
        recomputeDueAt(tx, 't1', settings, {
          trigger: 'PRIORITY',
          actor,
          now: NOW,
        }),
      ).resolves.toBe(false);
      expect(setDueAt).not.toHaveBeenCalled();
    },
  );

  it('leaves a hand set date alone (AC-5)', async () => {
    const { tx, settings } = setup(ticketRow({ dueAtSource: 'MANUAL' }));
    await expect(
      recomputeDueAt(tx, 't1', settings, {
        trigger: 'PRIORITY',
        actor,
        now: NOW,
      }),
    ).resolves.toBe(false);
    expect(setDueAt).not.toHaveBeenCalled();
  });

  it('works out a hand set date when asked, for the reset and the backfill (AC-9)', async () => {
    const { tx, settings } = setup(ticketRow({ dueAtSource: 'MANUAL' }));
    await recomputeDueAt(tx, 't1', settings, {
      trigger: { reset: 'Wrong estimate' },
      actor,
      now: NOW,
      includeManual: true,
    });
    expect(jest.mocked(setDueAt).mock.calls[0][2].reason).toMatch(
      /^Back to the automatic date: Wrong estimate\. /,
    );
  });

  it('treats a MANUAL source with no date as automatic (the backfill case)', async () => {
    const { tx, settings } = setup(
      ticketRow({ dueAtSource: 'MANUAL', dueAt: null }),
    );
    await recomputeDueAt(tx, 't1', settings, {
      trigger: 'BACKFILL',
      actor,
      now: NOW,
    });
    expect(setDueAt).toHaveBeenCalledTimes(1);
  });

  it('escalates to now plus the priority hours when the date has passed (AC-6)', async () => {
    const { tx, settings } = setup(
      ticketRow({
        createdAt: new Date(NOW.getTime() - 5 * 24 * HOUR),
        issues: [],
      }),
    );
    await recomputeDueAt(tx, 't1', settings, {
      trigger: 'PRIORITY',
      actor,
      now: NOW,
    });
    const change = jest.mocked(setDueAt).mock.calls[0][2];
    expect(change.dueAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    expect(change.source).toBe('PRIORITY');
    expect(change.reason).toBe(
      'Priority changed. Raised to High after its time had passed: due 24 h from now',
    );
  });

  it('reads the priority hours from the settings, not from code (AC-2)', async () => {
    const { tx } = setup(ticketRow({ issues: [] }));
    await recomputeDueAt(
      tx,
      't1',
      new FakeSettings({ 'tickets.due_hours_high': 30 }),
      {
        trigger: 'PRIORITY',
        actor,
        now: NOW,
      },
    );
    expect(jest.mocked(setDueAt).mock.calls[0][2].dueAt).toEqual(
      new Date(CREATED.getTime() + 30 * HOUR),
    );
  });

  it("stamps the ticket with the audit row time when it sorts after the path's own rows", async () => {
    const at = new Date(NOW.getTime() + 1);
    const { tx, raw, settings } = setup(ticketRow());
    await recomputeDueAt(tx, 't1', settings, {
      trigger: 'ISSUE_ADDED',
      actor,
      now: NOW,
      at,
    });
    expect(raw.repairTicket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { lastActivityAt: at },
    });
  });

  it('does not touch the ticket when the date did not change', async () => {
    jest.mocked(setDueAt).mockResolvedValueOnce(false);
    const { tx, raw, settings } = setup(ticketRow());
    await expect(
      recomputeDueAt(tx, 't1', settings, {
        trigger: 'ISSUE_ADDED',
        actor,
        now: NOW,
        at: new Date(NOW.getTime() + 1),
      }),
    ).resolves.toBe(false);
    expect(raw.repairTicket.update).not.toHaveBeenCalled();
  });

  it('passes skipBmsUpdate on, so create and referrals send one update', async () => {
    const { tx, settings } = setup(ticketRow());
    await recomputeDueAt(tx, 't1', settings, {
      trigger: 'CREATE',
      actor,
      now: NOW,
      skipBmsUpdate: true,
    });
    expect(jest.mocked(setDueAt).mock.calls[0][5]).toEqual({
      skipBmsUpdate: true,
    });
  });
});

describe('previewDueAt (spec 0030, AC-9)', () => {
  beforeEach(() => jest.mocked(setDueAt).mockClear());

  it('works the date out for the dialog and writes nothing', async () => {
    const { tx, raw, settings } = setup(ticketRow({ dueAtSource: 'MANUAL' }));
    const { result } = await previewDueAt(tx, 't1', settings, NOW);
    expect(result.dueAt).toEqual(new Date(CREATED.getTime() + 54 * HOUR));
    expect(result.source).toBe('ISSUE_TYPE');
    expect(setDueAt).not.toHaveBeenCalled();
    expect(raw.repairTicket.update).not.toHaveBeenCalled();
  });
});
