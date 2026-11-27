import type { EntryStats } from '../knowledge/knowledge-stats';
import {
  computeDueAt,
  dueReason,
  dueSoonAt,
  hoursText,
  issueHours,
  MAX_ISSUE_HOURS,
  type DueIssueInput,
  type DueSettings,
} from './due-dates';

// Spec 0030: the pure calculator, its reason text and the Due soon time.

const HOUR = 3_600_000;
const created = new Date('2026-11-27T00:00:00.000Z');
const settings: DueSettings = {
  priorityHours: { CRITICAL: 8, HIGH: 24, MEDIUM: 72, LOW: 168 },
  knowledgeOn: true,
};
const noStats = new Map<string, EntryStats>();

const issue = (overrides: Partial<DueIssueInput> = {}): DueIssueInput => ({
  id: 'i1',
  description: '[Brakes] Wear: grinding',
  categoryName: 'Brakes',
  categoryFixHours: 6,
  knowledgeEntryId: null,
  estimatedHours: null,
  ...overrides,
});

const stats = (typicalHours: number | null, hoursSamples: number) =>
  new Map<string, EntryStats>([
    [
      'k1',
      {
        seenCount: hoursSamples,
        lastSeenAt: null,
        typicalHours,
        hoursSamples,
        typicalDays: null,
        typicalCost: null,
      },
    ],
  ]);

describe('computeDueAt (spec 0030)', () => {
  it('takes the priority hours when they are larger, a tie included (AC-1, AC-2)', () => {
    const result = computeDueAt(
      { priority: 'HIGH', createdAt: created },
      [issue({ categoryFixHours: 24 })],
      settings,
      noStats,
      created,
    );
    expect(result.source).toBe('PRIORITY');
    expect(result.dueAt).toEqual(new Date(created.getTime() + 24 * HOUR));
    expect(result.escalated).toBe(false);
  });

  it('takes the summed issue hours when they are larger (AC-1, AC-3)', () => {
    const result = computeDueAt(
      { priority: 'HIGH', createdAt: created },
      [
        issue(),
        issue({ id: 'i2', categoryName: 'Engine', categoryFixHours: 48 }),
      ],
      settings,
      noStats,
      created,
    );
    expect(result.source).toBe('ISSUE_TYPE');
    expect(result.issueHours).toBe(54);
    expect(result.dueAt).toEqual(new Date(created.getTime() + 54 * HOUR));
  });

  it('caps the issue hours at 90 days (AC-3)', () => {
    const result = computeDueAt(
      { priority: 'LOW', createdAt: created },
      Array.from({ length: 4 }, (_, i) =>
        issue({ id: `i${i}`, categoryFixHours: 720 }),
      ),
      settings,
      noStats,
      created,
    );
    expect(result.issueHours).toBe(MAX_ISSUE_HOURS);
  });

  it('rounds the issue sum to two places', () => {
    const result = computeDueAt(
      { priority: 'CRITICAL', createdAt: created },
      [
        issue({ categoryFixHours: 0.1 }),
        issue({ id: 'i2', categoryFixHours: 8.2 }),
      ],
      settings,
      noStats,
      created,
    );
    expect(result.issueHours).toBe(8.3);
  });

  it('escalates to now plus the priority hours when the date has passed (AC-6)', () => {
    const now = new Date(created.getTime() + 72 * HOUR);
    const result = computeDueAt(
      { priority: 'CRITICAL', createdAt: created },
      [issue()],
      settings,
      noStats,
      now,
    );
    expect(result).toMatchObject({
      source: 'PRIORITY',
      escalated: true,
      dueAt: new Date(now.getTime() + 8 * HOUR),
    });
  });

  it('keeps a date that is exactly now (not earlier than now)', () => {
    const now = new Date(created.getTime() + 8 * HOUR);
    const result = computeDueAt(
      { priority: 'CRITICAL', createdAt: created },
      [],
      settings,
      noStats,
      now,
    );
    expect(result.escalated).toBe(false);
    expect(result.dueAt).toEqual(now);
  });
});

describe('issueHours, knowledge first (AC-3)', () => {
  const linked = issue({
    knowledgeEntryId: 'k1',
    estimatedHours: 5,
    categoryName: 'Engine',
    categoryFixHours: 48,
  });

  it('uses the known fix typical hours once it has enough repairs', () => {
    expect(issueHours(linked, stats(3, 5), true)).toEqual({
      hours: 3,
      from: 'KNOWLEDGE',
      samples: 5,
    });
  });

  it('falls back to the estimate under the minimum (typicalHours null)', () => {
    expect(issueHours(linked, stats(null, 2), true)).toEqual({
      hours: 5,
      from: 'ESTIMATE',
      samples: 0,
    });
  });

  it('falls back to the category without an estimate', () => {
    expect(
      issueHours({ ...linked, estimatedHours: null }, stats(null, 2), true)
        .hours,
    ).toBe(48);
  });

  it('counts only the category with the knowledge module off', () => {
    expect(issueHours(linked, stats(3, 5), false)).toEqual({
      hours: 48,
      from: 'CATEGORY',
      samples: 0,
    });
  });

  it('adds nothing for a category with no fix time', () => {
    expect(
      issueHours(issue({ categoryFixHours: null }), noStats, true),
    ).toEqual({ hours: 0, from: 'NONE', samples: 0 });
  });
});

describe('dueReason (rule step 5)', () => {
  it('names the priority when it wins', () => {
    const result = computeDueAt(
      { priority: 'HIGH', createdAt: created },
      [],
      settings,
      noStats,
      created,
    );
    expect(dueReason(result, 'CREATE')).toBe(
      'Due date from High priority (24 h)',
    );
    expect(dueReason(result, 'PRIORITY')).toBe(
      'Priority changed. Due date from High priority (24 h)',
    );
  });

  it('lists categories, never descriptions, and marks knowledge hours', () => {
    const result = computeDueAt(
      { priority: 'LOW', createdAt: created },
      [
        issue({
          categoryName: 'Engine',
          categoryFixHours: 200,
          description: 'secret driver note',
        }),
        issue({
          id: 'i2',
          categoryName: null,
          knowledgeEntryId: 'k1',
          categoryFixHours: null,
        }),
      ],
      settings,
      stats(2.5, 4),
      created,
    );
    const reason = dueReason(result, 'REFERRAL');
    expect(reason).toBe(
      'Issues added from VMMS. Due date from issue times (202.5 h: Engine 200 h, Other 2.5 h from 4 past repairs)',
    );
    expect(reason).not.toContain('secret');
  });

  it('says the ticket was escalated', () => {
    const result = computeDueAt(
      { priority: 'MEDIUM', createdAt: created },
      [],
      settings,
      noStats,
      new Date(created.getTime() + 100 * HOUR),
    );
    expect(dueReason(result, { reset: 'Parts came early' })).toBe(
      'Back to the automatic date: Parts came early. Raised to Medium after its time had passed: due 72 h from now',
    );
    expect(dueReason(result, { expedite: 'JO-2026-0142' })).toMatch(
      /^Expedite JO-2026-0142\. Raised to Medium/,
    );
    expect(dueReason(result, 'BACKFILL')).toMatch(
      /^Due date set by the new rules\. /,
    );
  });

  it('cuts the reason to 500 characters', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      issue({
        id: `i${i}`,
        categoryName: 'Transmission',
        categoryFixHours: 30,
      }),
    );
    const result = computeDueAt(
      { priority: 'LOW', createdAt: created },
      many,
      settings,
      noStats,
      created,
    );
    expect(dueReason(result, 'CREATE')).toHaveLength(500);
  });

  it('writes hours without trailing zeros', () => {
    expect(hoursText(6)).toBe('6');
    expect(hoursText(0.25)).toBe('0.25');
    expect(hoursText(1.5)).toBe('1.5');
  });
});

describe('dueSoonAt (AC-11)', () => {
  const at = (hours: number) => new Date(created.getTime() + hours * HOUR);

  it('uses half the time for a short ticket: an 8 h ticket turns at 4 h left', () => {
    expect(
      dueSoonAt({ dueAt: at(8), createdAt: created, repairStatus: 'OPEN' }, 24),
    ).toEqual(at(4));
  });

  it('uses the setting for a long ticket: a 168 h ticket turns at 24 h left', () => {
    expect(
      dueSoonAt(
        { dueAt: at(168), createdAt: created, repairStatus: 'ON_HOLD' },
        24,
      ),
    ).toEqual(at(144));
  });

  it('is null when closed, cancelled or undated', () => {
    expect(
      dueSoonAt(
        { dueAt: at(8), createdAt: created, repairStatus: 'CLOSED' },
        24,
      ),
    ).toBeNull();
    expect(
      dueSoonAt(
        { dueAt: at(8), createdAt: created, repairStatus: 'CANCELLED' },
        24,
      ),
    ).toBeNull();
    expect(
      dueSoonAt({ dueAt: null, createdAt: created, repairStatus: 'OPEN' }, 24),
    ).toBeNull();
  });
});
