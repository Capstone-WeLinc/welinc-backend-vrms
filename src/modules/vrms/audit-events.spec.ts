import { BadRequestException } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  olderThan,
  parseNewCost,
  parsePreviousCost,
  toAuditEvent,
} from './audit-events';

type Row = { createdAt: Date; id: string };

// Applies olderThan() the way Postgres would, for keyset paging checks without a database
function isOlder(row: Row, cursor: Row) {
  const t = row.createdAt.getTime();
  const c = cursor.createdAt.getTime();
  return t < c || (t === c && row.id < cursor.id);
}

const byKeyDesc = (a: Row, b: Row) =>
  b.createdAt.getTime() - a.createdAt.getTime() ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('audit cursor', () => {
  it('round trips the time and id', () => {
    const row = {
      createdAt: new Date('2026-10-22T03:04:05.678Z'),
      id: uuid(7),
    };
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
  });

  it.each([
    'garbage',
    '',
    Buffer.from('2026-10-22T00:00:00Z|not-a-uuid').toString('base64url'),
    Buffer.from(`nope|${uuid(1)}`).toString('base64url'),
    Buffer.from(`2026-10-22T00:00:00Z|${uuid(1)}|extra`).toString('base64url'),
  ])('rejects a malformed cursor %p', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });

  it('builds a strictly older filter on (createdAt, id)', () => {
    const cursor = { createdAt: new Date('2026-10-22T00:00:00Z'), id: uuid(5) };
    expect(olderThan(cursor)).toEqual({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  });

  it('pages through rows that share a timestamp with no repeats or gaps', () => {
    const same = new Date('2026-10-22T10:00:00.000Z');
    const rows: Row[] = [];
    for (let i = 0; i < 120; i++) {
      // Every third row shares one timestamp, the rest are spread out
      const createdAt =
        i % 3 === 0 ? same : new Date(same.getTime() - i * 1000);
      rows.push({ createdAt, id: uuid(i) });
    }
    const ordered = [...rows].sort(byKeyDesc);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const position: Row | null = cursor ? decodeCursor(cursor) : null;
      const candidates: Row[] = position
        ? ordered.filter((r) => isOlder(r, position))
        : ordered;
      const page = candidates.slice(0, 50);
      seen.push(...page.map((r) => r.id));
      cursor =
        candidates.length > 50 ? encodeCursor(page[page.length - 1]) : null;
    } while (cursor);

    expect(seen).toEqual(ordered.map((r) => r.id));
    expect(new Set(seen).size).toBe(120);
  });
});

describe('toAuditEvent actor', () => {
  const base = {
    id: uuid(1),
    action: 'UNLOCK',
    userId: 'c439b079-0000-4000-8000-000000000000', // auth service id, never a VRMS users.id
    previousValue: null,
    newValue: 'Fix labor cost',
    createdAt: new Date('2026-10-22T02:42:00Z'),
    repairTicket: { id: uuid(9), repairNumber: 'REP-1' },
  };
  const users = new Map([
    [
      'vrms.admin@welinc.com',
      { id: uuid(2), name: 'VRMS Admin', email: 'vrms.admin@welinc.com' },
    ],
  ]);

  it('matches the VRMS user by email, ignoring case, and keeps the stored email', () => {
    const event = toAuditEvent(
      { ...base, email: 'VRMS.Admin@welinc.com' },
      users,
    );
    expect(event.actor).toEqual({
      id: uuid(2),
      name: 'VRMS Admin',
      email: 'VRMS.Admin@welinc.com',
    });
    expect(event.unlockReason).toBe('Fix labor cost');
  });

  it('keeps the email with no name when no VRMS user has it', () => {
    const event = toAuditEvent({ ...base, email: 'gone@welinc.com' }, users);
    expect(event.actor).toEqual({
      id: null,
      name: null,
      email: 'gone@welinc.com',
    });
  });

  it.each([null, '', '  '])(
    'has no actor when the email is %p, even with a user id',
    (email) => {
      expect(toAuditEvent({ ...base, email }, users).actor).toBeNull();
    },
  );

  it('shapes a status change and leaves unreadable costs as null', () => {
    const status = toAuditEvent(
      {
        ...base,
        email: null,
        action: 'STATUS_CHANGE',
        previousValue: 'PENDING',
        newValue: 'IN_PROGRESS',
      },
      users,
    );
    expect(status.status).toEqual({ from: 'PENDING', to: 'IN_PROGRESS' });
    const cost = toAuditEvent(
      {
        ...base,
        email: null,
        action: 'COST_UPDATE',
        previousValue: 'x',
        newValue: 'y',
      },
      users,
    );
    expect(cost.cost).toBeNull();
  });
});

describe('cost snapshots', () => {
  it('reads null parts and labor on the old snapshot as 0 and derives the total', () => {
    expect(
      parsePreviousCost(JSON.stringify({ partsCost: null, laborCost: 1000 })),
    ).toEqual({
      partsCost: 0,
      laborCost: 1000,
      total: 1000,
      isLumpSum: false,
    });
  });

  it('takes the new total and lump sum flag from the stored JSON', () => {
    expect(
      parseNewCost(
        JSON.stringify({
          partsCost: 3500,
          laborCost: 1700,
          totalCost: 5200,
          isLumpSum: true,
        }),
      ),
    ).toEqual({
      partsCost: 3500,
      laborCost: 1700,
      total: 5200,
      isLumpSum: true,
    });
  });

  it.each([null, '', 'not json', '[1,2]', '"text"'])(
    'returns null for unreadable JSON %p',
    (value) => {
      expect(parsePreviousCost(value)).toBeNull();
      expect(parseNewCost(value)).toBeNull();
    },
  );
});
