import { BadRequestException } from '@nestjs/common';
import {
  actorFields,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY,
  attachmentMovedEvent,
  auditCatalog,
  auditData,
  auditKindFilter,
  auditRoleFilter,
  categoryOf,
  closedTicketTextEvent,
  costEvent,
  decodeCursor,
  encodeCursor,
  hiddenAuditEvents,
  knowledgeLinkEvent,
  lastRejectionFrom,
  lastReturnAt,
  lockedEvent,
  olderThan,
  readChanges,
  stampedAt,
  statusEvent,
  stepTickEvent,
  storedCosts,
  toAuditEvent,
  unlockEvent,
  whoName,
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

describe('toAuditEvent', () => {
  const base = {
    id: uuid(1),
    action: 'UNLOCK',
    actorUserId: 'c439b079-0000-4000-8000-000000000000', // the welinc-auth user id
    actorEmail: 'vrms.admin@welinc.com',
    actorName: 'Victor Ramos',
    actorRole: 'ADMIN',
    changes: [{ field: 'isUnlocked', before: 'false', after: 'true' }],
    note: 'Fix labor cost',
    createdAt: new Date('2026-10-22T02:42:00Z'),
    repairTicket: { id: uuid(9), repairNumber: 'REP-1' },
  };

  it('takes the actor, changes and note stored on the row', () => {
    const event = toAuditEvent(base);
    expect(event.actor).toEqual({
      id: base.actorUserId,
      name: 'Victor Ramos',
      email: 'vrms.admin@welinc.com',
      role: 'ADMIN',
    });
    expect(event.changes).toEqual(base.changes);
    expect(event.note).toBe('Fix labor cost');
  });

  it('shows the email as the name when the row has no name', () => {
    const event = toAuditEvent({ ...base, actorName: null });
    expect(event.actor?.name).toBe('vrms.admin@welinc.com');
  });

  it('has no actor for a system event', () => {
    expect(
      toAuditEvent({ ...base, actorUserId: null, actorEmail: null }).actor,
    ).toBeNull();
  });

  it('skips anything in the stored list that is not a change', () => {
    expect(
      readChanges([
        { field: 'partsCost', before: null, after: '1200.00' },
        'junk',
        { before: 'x' },
        null,
      ]),
    ).toEqual([{ field: 'partsCost', before: null, after: '1200.00' }]);
    expect(readChanges({ not: 'a list' })).toEqual([]);
  });
});

describe('event builders (spec 0010, Audit events)', () => {
  it('writes one status change, with the reason or remarks as its note', () => {
    expect(statusEvent('FOR_VERIFICATION', 'CANCELLED', ' Duplicate ')).toEqual(
      {
        action: 'STATUS_CHANGE',
        changes: [
          {
            field: 'repairStatus',
            before: 'FOR_VERIFICATION',
            after: 'CANCELLED',
          },
        ],
        note: 'Duplicate',
      },
    );
    expect(statusEvent('ASSIGNED', 'IN_PROGRESS').note).toBeNull();
  });

  it('puts every changed cost field in one event, as raw strings', () => {
    const event = costEvent(
      { partsCost: 3000, laborCost: 1000, totalCost: 4000, isLumpSum: false },
      { partsCost: 3500, laborCost: 1700, totalCost: 5200, isLumpSum: false },
    );
    expect(event.action).toBe('COST_UPDATE');
    expect(event.changes).toEqual([
      { field: 'partsCost', before: '3000.00', after: '3500.00' },
      { field: 'laborCost', before: '1000.00', after: '1700.00' },
      { field: 'totalCost', before: '4000.00', after: '5200.00' },
    ]);
  });

  it('leaves unchanged cost fields out, and an empty amount as null', () => {
    const event = costEvent(
      { partsCost: null, laborCost: 500, totalCost: 500, isLumpSum: false },
      { partsCost: 0, laborCost: 500, totalCost: 500, isLumpSum: true },
    );
    expect(event.changes).toEqual([
      { field: 'partsCost', before: null, after: '0.00' },
      { field: 'isLumpSum', before: 'false', after: 'true' },
    ]);
  });

  it('records the unlock as a change plus the reason', () => {
    expect(unlockEvent(' Late invoice ')).toEqual({
      action: 'UNLOCK',
      changes: [{ field: 'isUnlocked', before: 'false', after: 'true' }],
      note: 'Late invoice',
    });
  });

  it('records a photo move as a kind change with the file name (spec 0018, AC-18)', () => {
    const event = attachmentMovedEvent(
      { id: 'a1', kind: 'PROOF', kindLabel: 'After photo', fileName: 'x.jpg' },
      {
        id: 'a1',
        kind: 'VEHICLE_PHOTO',
        kindLabel: 'Before photo',
        fileName: 'x.jpg',
      },
    );
    expect(event.action).toBe('ATTACHMENT_MOVED');
    expect(event.changes).toEqual([
      { field: 'kind', before: 'PROOF', after: 'VEHICLE_PHOTO' },
      {
        field: 'attachment',
        before: 'After photo: x.jpg',
        after: 'Before photo: x.jpg',
      },
      { field: 'attachmentId', before: null, after: 'a1' },
    ]);
    expect(event.note).toBeNull();
  });

  it('names the issue on a known fix link', () => {
    expect(
      knowledgeLinkEvent(uuid(3), null, 'Brake pads worn').changes,
    ).toEqual([
      { field: 'knowledgeEntry', before: null, after: 'Brake pads worn' },
      { field: 'issueId', before: null, after: uuid(3) },
    ]);
  });
});

describe('actor fields', () => {
  const user = {
    sub: uuid(2),
    email: 'vrms.chief@welinc.com',
    name: 'Ramon Villanueva',
    roles: [
      { role: 'MECHANIC', system: 'VRMS' },
      { role: 'CHIEF_MECHANIC', system: 'VRMS' },
      { role: 'ADMIN', system: 'BMS' },
    ],
    system: 'VRMS',
  };

  it('copies the caller from the token, with the widest VRMS role', () => {
    expect(actorFields(user)).toEqual({
      actorUserId: uuid(2),
      actorName: 'Ramon Villanueva',
      actorEmail: 'vrms.chief@welinc.com',
      actorRole: 'CHIEF_MECHANIC',
    });
  });

  it('falls back to the email for an empty name, cut to 100 characters', () => {
    expect(whoName({ name: '  ', email: 'a@welinc.com' })).toBe('a@welinc.com');
    expect(
      whoName({ name: 'x'.repeat(150), email: 'a@welinc.com' }),
    ).toHaveLength(100);
  });

  it('writes one now to the row', () => {
    const now = new Date('2026-10-29T01:00:00.000Z');
    expect(auditData(user, statusEvent('A', 'B'), now).createdAt).toBe(now);
  });
});

// Spec 0014, AC-14: the newest first scan behind lastRejection
describe('lastRejectionFrom', () => {
  const row = (
    before: string,
    after: string,
    minute: number,
    note: string | null = null,
  ) => ({
    changes: [{ field: 'repairStatus', before, after }],
    note,
    actorName: 'Ramon Villanueva',
    actorEmail: 'vrms.chief@welinc.com',
    createdAt: new Date(Date.UTC(2026, 9, 31, 8, minute)),
  });

  it('finds the send back, skipping hold moves after it', () => {
    expect(
      lastRejectionFrom([
        row('ON_HOLD', 'IN_PROGRESS', 30),
        row('IN_PROGRESS', 'ON_HOLD', 20),
        row('FOR_VERIFICATION', 'IN_PROGRESS', 10, 'Rear pads still squeal'),
        row('IN_PROGRESS', 'FOR_VERIFICATION', 5),
      ]),
    ).toEqual({
      remarks: 'Rear pads still squeal',
      byName: 'Ramon Villanueva',
      at: '2026-10-31T08:10:00.000Z',
    });
  });

  it('ends with null once the work was sent for verification again', () => {
    expect(
      lastRejectionFrom([
        row('IN_PROGRESS', 'FOR_VERIFICATION', 20),
        row('FOR_VERIFICATION', 'IN_PROGRESS', 10, 'Fix it'),
      ]),
    ).toBeNull();
  });

  it('is null with no send back, and falls back to the email for the name', () => {
    expect(lastRejectionFrom([row('ASSIGNED', 'IN_PROGRESS', 1)])).toBeNull();
    expect(
      lastRejectionFrom([
        { ...row('FOR_VERIFICATION', 'IN_PROGRESS', 1, 'x'), actorName: null },
      ])?.byName,
    ).toBe('vrms.chief@welinc.com');
  });
});

// Spec 0018, AC-14: the latest Return to mechanic, kept after a resend
describe('lastReturnAt', () => {
  const row = (before: string, after: string, minute: number) => ({
    changes: [{ field: 'repairStatus', before, after }],
    createdAt: new Date(Date.UTC(2026, 10, 2, 8, minute)),
  });

  it('keeps the return after the ticket was sent for verification again', () => {
    expect(
      lastReturnAt([
        row('IN_PROGRESS', 'FOR_VERIFICATION', 20),
        row('FOR_VERIFICATION', 'IN_PROGRESS', 10),
      ]),
    ).toEqual(new Date(Date.UTC(2026, 10, 2, 8, 10)));
  });

  it('answers the latest return when there were two', () => {
    expect(
      lastReturnAt([
        row('FOR_VERIFICATION', 'IN_PROGRESS', 40),
        row('IN_PROGRESS', 'FOR_VERIFICATION', 30),
        row('FOR_VERIFICATION', 'IN_PROGRESS', 10),
      ]),
    ).toEqual(new Date(Date.UTC(2026, 10, 2, 8, 40)));
  });

  it('is null with no return, and skips rows without a status change', () => {
    expect(
      lastReturnAt([
        {
          changes: [{ field: 'remarks', before: null, after: 'x' }],
          createdAt: new Date(),
        },
        row('ASSIGNED', 'IN_PROGRESS', 1),
      ]),
    ).toBeNull();
    expect(lastReturnAt([])).toBeNull();
  });
});

// ── Spec 0021 ───────────────────────────────────────────────────────────────────

describe('categories (spec 0021, AC-7, AC-8)', () => {
  it('puts every event type in exactly one of the seven categories (AC-7)', () => {
    expect(AUDIT_CATEGORIES).toHaveLength(7);
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_CATEGORIES).toContain(AUDIT_CATEGORY[action]);
    }
    expect(Object.keys(AUDIT_CATEGORY).sort()).toEqual(
      [...AUDIT_ACTIONS].sort(),
    );
  });

  it('files each type under the category the spec table names (AC-7)', () => {
    expect(AUDIT_CATEGORY).toMatchObject({
      CREATED: 'STATUS',
      LOCKED: 'STATUS',
      STATUS_OVERRIDE: 'STATUS',
      MECHANIC_ASSIGNED: 'ASSIGNMENT',
      TRANSFER_CANCELLED: 'ASSIGNMENT',
      GARAGE_CHANGE: 'EDITS',
      TICKET_EDITED: 'EDITS',
      COST_UPDATE: 'COSTS',
      ATTACHMENT_MOVED: 'FILES',
      STEP_CHECKED: 'CHECKLIST',
      STEP_UNCHECKED: 'CHECKLIST',
      KNOWLEDGE_LINK: 'KNOWLEDGE',
    });
  });

  it('reads a stored action outside the catalog as category null (AC-8)', () => {
    expect(categoryOf('STEP_CHECKED')).toBe('CHECKLIST');
    expect(categoryOf('OLD_THING')).toBeNull();
    expect(categoryOf('')).toBeNull();
    // Inherited object keys are not categories
    expect(categoryOf('constructor')).toBeNull();
    expect(categoryOf('toString')).toBeNull();
  });
});

describe('auditCatalog (spec 0021, AC-11, AC-12)', () => {
  it('lists the categories in the spec order, each with its types', () => {
    const catalog = auditCatalog(true);
    expect(catalog.map((c) => c.category)).toEqual([...AUDIT_CATEGORIES]);
    expect(catalog.find((c) => c.category === 'COSTS')?.types).toEqual([
      'COST_UPDATE',
    ]);
    expect(catalog.flatMap((c) => c.types).sort()).toEqual(
      [...AUDIT_ACTIONS].sort(),
    );
  });

  it('leaves COSTS out without ticket.costs.view', () => {
    const catalog = auditCatalog(false);
    expect(catalog.map((c) => c.category)).not.toContain('COSTS');
    expect(catalog).toHaveLength(6);
    expect(catalog.flatMap((c) => c.types)).not.toContain('COST_UPDATE');
  });
});

describe('stampedAt (spec 0021, AC-3b)', () => {
  it('adds one millisecond per write position and leaves the input alone', () => {
    const now = new Date('2026-11-04T00:00:00.000Z');
    expect(stampedAt(now, 0).getTime()).toBe(now.getTime());
    expect(stampedAt(now, 2).toISOString()).toBe('2026-11-04T00:00:00.002Z');
    expect(now.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });
});

describe('cost, locked and closed ticket text events (spec 0021, AC-1 to AC-3)', () => {
  const costs = {
    partsCost: null,
    laborCost: null,
    totalCost: null,
    isLumpSum: false,
  };

  it('reads stored costs as numbers, keeping null for none (AC-1)', () => {
    expect(
      storedCosts({
        partsCost: '1000.50',
        laborCost: null,
        totalCost: 1000.5,
        isLumpSum: true,
      }),
    ).toEqual({
      partsCost: 1000.5,
      laborCost: null,
      totalCost: 1000.5,
      isLumpSum: true,
    });
  });

  it('carries the unlock reason as the cost event note, and no note by default (AC-1)', () => {
    const after = { ...costs, partsCost: 10, totalCost: 10 };
    expect(costEvent(costs, after, 'Supplier refund').note).toBe(
      'Supplier refund',
    );
    expect(costEvent(costs, after).note).toBeNull();
  });

  it('writes LOCKED as isUnlocked true to false with no note (AC-3)', () => {
    expect(lockedEvent()).toEqual({
      action: 'LOCKED',
      changes: [{ field: 'isUnlocked', before: 'true', after: 'false' }],
      note: null,
    });
  });

  it('lists only the text fields that changed, with the note (AC-2)', () => {
    const event = closedTicketTextEvent(
      { remarks: 'Old', cancellationReason: 'Duplicate' },
      { remarks: 'New', cancellationReason: 'Duplicate' },
      'Fixing a typo',
    );
    expect(event).toEqual({
      action: 'TICKET_EDITED',
      changes: [{ field: 'remarks', before: 'Old', after: 'New' }],
      note: 'Fixing a typo',
    });
  });

  it('records a first value as before null, and both fields when both change (AC-2)', () => {
    const event = closedTicketTextEvent(
      { remarks: null, cancellationReason: 'A' },
      { remarks: 'Pads replaced', cancellationReason: 'B' },
      null,
    );
    expect(event?.changes).toEqual([
      { field: 'remarks', before: null, after: 'Pads replaced' },
      { field: 'cancellationReason', before: 'A', after: 'B' },
    ]);
    expect(event?.note).toBeNull();
  });

  it('is null when nothing changed, so no row is written (AC-2)', () => {
    expect(
      closedTicketTextEvent(
        { remarks: 'Same', cancellationReason: null },
        { remarks: 'Same', cancellationReason: null },
        'x',
      ),
    ).toBeNull();
  });
});

describe('stepTickEvent (spec 0021, AC-4)', () => {
  const step = { id: 's1', position: 2, text: 'Check brake fluid' };

  it('writes STEP_CHECKED with the numbered step and both ids', () => {
    expect(stepTickEvent(true, step, 'i1')).toEqual({
      action: 'STEP_CHECKED',
      changes: [
        { field: 'checked', before: 'false', after: 'true' },
        { field: 'step', before: null, after: '2. Check brake fluid' },
        { field: 'issueId', before: null, after: 'i1' },
        { field: 'stepId', before: null, after: 's1' },
      ],
      note: null,
    });
  });

  it('writes STEP_UNCHECKED with the checked change reversed', () => {
    const event = stepTickEvent(false, step, 'i1');
    expect(event.action).toBe('STEP_UNCHECKED');
    expect(event.changes[0]).toEqual({
      field: 'checked',
      before: 'true',
      after: 'false',
    });
  });
});

describe('audit filters (spec 0021, AC-9, AC-12)', () => {
  it('expands a category to its types and unions it with exact types (AC-9)', () => {
    expect(auditKindFilter(['CHECKLIST'], ['COST_UPDATE'])).toEqual({
      action: {
        in: [
          'COST_UPDATE',
          'STEP_CHECKED',
          'STEP_UNCHECKED',
          'STEP_ADDED',
          'STEP_REMOVED',
          'STEP_EDITED',
          'STEP_MOVED',
        ],
      },
    });
  });

  it('does not repeat a type that is also in a chosen category', () => {
    expect(auditKindFilter(['COSTS'], ['COST_UPDATE'])).toEqual({
      action: { in: ['COST_UPDATE'] },
    });
  });

  it('accepts reserved types before anything writes them', () => {
    expect(auditKindFilter([], ['STATUS_OVERRIDE'])).toEqual({
      action: { in: ['STATUS_OVERRIDE'] },
    });
    const assignment = auditKindFilter(['ASSIGNMENT'], []) as {
      action: { in: string[] };
    };
    expect(assignment.action.in).toEqual(
      expect.arrayContaining(['TRANSFER_REQUESTED', 'MECHANIC_ASSIGNED']),
    );
  });

  it('is null with no categories and no types', () => {
    expect(auditKindFilter()).toBeNull();
    expect(auditKindFilter([], [])).toBeNull();
  });

  it('matches SYSTEM on no user id and no email, other roles on the stored role', () => {
    expect(auditRoleFilter('SYSTEM')).toEqual({
      actorUserId: null,
      actorEmail: null,
    });
    expect(auditRoleFilter('MECHANIC')).toEqual({ actorRole: 'MECHANIC' });
    expect(auditRoleFilter(undefined)).toBeNull();
  });

  it('hides cost events only from a caller without ticket.costs.view (AC-12)', () => {
    expect(hiddenAuditEvents(true)).toBeNull();
    const hidden = hiddenAuditEvents(false) as { AND: unknown[] };
    expect(hidden.AND).toContainEqual({ action: { not: 'COST_UPDATE' } });
  });
});

describe('toAuditEvent category (spec 0021, AC-8)', () => {
  const base = {
    id: uuid(9),
    actorUserId: 'u1',
    actorName: 'Victor',
    actorEmail: 'v@welinc.com',
    actorRole: 'ADMIN',
    changes: [],
    note: null,
    createdAt: new Date('2026-11-04T00:00:00.000Z'),
    repairTicket: { id: 't1', repairNumber: 'REP-1' },
  };

  it('carries the category of a catalog action and null for any other', () => {
    expect(toAuditEvent({ ...base, action: 'LOCKED' }).category).toBe('STATUS');
    expect(toAuditEvent({ ...base, action: 'GONE' }).category).toBeNull();
  });
});
