import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserRole } from '../../auth/roles';

// Spec 0003 and spec 0010. One audit row per event: who did it, the action, its field changes as a
// JSON list, and an optional note. Pure helpers, so the shapes test without a database.

/** One changed field. Values are raw strings ("IN_PROGRESS", "1200.00", "true") or null. */
export type AuditChange = {
  field: string;
  before: string | null;
  after: string | null;
};

export const AUDIT_ACTIONS = [
  'CREATED',
  'STATUS_CHANGE',
  'COST_UPDATE',
  'UNLOCK',
  'GARAGE_CHANGE',
  'KNOWLEDGE_LINK',
  'MECHANIC_UNASSIGNED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What a builder returns: the action, its changes and its note. */
export type AuditEventData = {
  action: AuditAction;
  changes: AuditChange[];
  note: string | null;
};

/** The caller as the token describes them, after the welinc-auth account check (spec 0009). */
export type Actor = {
  sub: string;
  email: string;
  name: string;
  roles: { role: string; system: string }[];
  system: string;
};

export type ActorFields = {
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
};

// When a caller holds several VRMS roles, the widest one is recorded.
const ROLE_ORDER: string[] = [
  UserRole.ADMIN,
  UserRole.CHIEF_MECHANIC,
  UserRole.MECHANIC,
];

/** A "who" name: the account name, else the email, cut to 100 characters (spec 0010, Value sourcing). */
export function whoName(user: Pick<Actor, 'name' | 'email'>) {
  return (user.name?.trim() || user.email).slice(0, 100);
}

/** The actor columns, copied from the verified token, never from a request body. */
export function actorFields(user: Actor): ActorFields {
  const held = user.roles
    .filter((r) => r.system === user.system)
    .map((r) => r.role);
  return {
    actorUserId: user.sub,
    actorName: whoName(user),
    actorEmail: user.email,
    actorRole: ROLE_ORDER.find((r) => held.includes(r)) ?? held[0] ?? null,
  };
}

/** The columns of one audit row: actor, event and the shared `now` (AC-10). */
export function auditData(user: Actor, event: AuditEventData, now: Date) {
  return {
    ...actorFields(user),
    action: event.action,
    changes: event.changes as Prisma.InputJsonValue,
    note: event.note,
    createdAt: now,
  };
}

// ── Event builders (the Audit events table in spec 0010) ────────────────────────

export function createdEvent(): AuditEventData {
  return { action: 'CREATED', changes: [], note: null };
}

/** The note is the cancel reason on a move to CANCELLED, else the optional remarks. */
export function statusEvent(
  from: string,
  to: string,
  note?: string | null,
): AuditEventData {
  return {
    action: 'STATUS_CHANGE',
    changes: [{ field: 'repairStatus', before: from, after: to }],
    note: note?.trim() || null,
  };
}

export type CostValues = {
  partsCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
  isLumpSum: boolean;
};

function money(value: number | null) {
  return value == null ? null : value.toFixed(2);
}

/** One row for the whole save, with every cost field that changed. */
export function costEvent(
  before: CostValues,
  after: CostValues,
): AuditEventData {
  const pairs: [keyof CostValues, string | null, string | null][] = [
    ['partsCost', money(before.partsCost), money(after.partsCost)],
    ['laborCost', money(before.laborCost), money(after.laborCost)],
    ['totalCost', money(before.totalCost), money(after.totalCost)],
    ['isLumpSum', String(before.isLumpSum), String(after.isLumpSum)],
  ];
  return {
    action: 'COST_UPDATE',
    changes: pairs
      .filter(([, b, a]) => b !== a)
      .map(([field, b, a]) => ({ field, before: b, after: a })),
    note: null,
  };
}

export function unlockEvent(reason: string): AuditEventData {
  return {
    action: 'UNLOCK',
    changes: [{ field: 'isUnlocked', before: 'false', after: 'true' }],
    note: reason.trim(),
  };
}

/** Garage names before and after. */
export function garageEvent(
  from: string | null,
  to: string | null,
): AuditEventData {
  return {
    action: 'GARAGE_CHANGE',
    changes: [{ field: 'garage', before: from, after: to }],
    note: null,
  };
}

/** Entry names before and after (null is none), plus the issue it applies to. */
export function knowledgeLinkEvent(
  issueId: string,
  from: string | null,
  to: string | null,
): AuditEventData {
  return {
    action: 'KNOWLEDGE_LINK',
    changes: [
      { field: 'knowledgeEntry', before: from, after: to },
      { field: 'issueId', before: null, after: issueId },
    ],
    note: null,
  };
}

/** A mechanic's assignment ended because they left VRMS (spec 0011, AC-33). The note says why. */
export function mechanicUnassignedEvent(
  mechanicName: string,
  reason: 'DEACTIVATED' | 'ROLE_REMOVED',
  reopened = false,
): AuditEventData {
  return {
    action: 'MECHANIC_UNASSIGNED',
    changes: [
      { field: 'mechanic', before: mechanicName, after: null },
      ...(reopened
        ? [{ field: 'repairStatus', before: 'ASSIGNED', after: 'OPEN' }]
        : []),
    ],
    note:
      reason === 'DEACTIVATED' ? 'Account deactivated' : 'VRMS role removed',
  };
}

// ── Reading: keyset cursor and the timeline item ────────────────────────────────

export type AuditActor = {
  id: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
};

export type AuditEvent = {
  id: string;
  type: string;
  at: string;
  actor: AuditActor | null;
  ticket: { id: string; repairNumber: string };
  changes: AuditChange[];
  note: string | null;
};

export type AuditRow = {
  id: string;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  changes: Prisma.JsonValue;
  note: string | null;
  createdAt: Date;
  repairTicket: { id: string; repairNumber: string };
};

export type AuditCursor = { createdAt: Date; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    `${row.createdAt.toISOString()}|${row.id}`,
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(cursor: string): AuditCursor {
  const [iso, id, extra] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const createdAt = new Date(iso ?? '');
  if (
    extra !== undefined ||
    !id ||
    !UUID_RE.test(id) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt, id };
}

/** Rows strictly older than the cursor, in (createdAt desc, id desc) order. */
export function olderThan(cursor: AuditCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return value == null ? null : JSON.stringify(value);
}

/** The stored JSON list, read defensively: anything that isn't a change is skipped. */
export function readChanges(value: Prisma.JsonValue): AuditChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const { field, before, after } = item as Record<string, unknown>;
    if (typeof field !== 'string') return [];
    return [{ field, before: asText(before), after: asText(after) }];
  });
}

/** One STATUS_CHANGE row, as lastRejectionFrom reads it. */
export type StatusRow = {
  changes: Prisma.JsonValue;
  note: string | null;
  actorName: string | null;
  actorEmail: string | null;
  createdAt: Date;
};

export type LastRejection = { remarks: string; byName: string; at: string };

/**
 * Spec 0014, AC-14: the Send back still in force. Rows come newest first (createdAt desc, id
 * desc). A move into For verification ends the scan with null (the work was resent); the first
 * For verification to In progress move is the rejection.
 */
export function lastRejectionFrom(rows: StatusRow[]): LastRejection | null {
  for (const row of rows) {
    const move = readChanges(row.changes).find(
      (c) => c.field === 'repairStatus',
    );
    if (!move) continue;
    if (move.after === 'FOR_VERIFICATION') return null;
    if (move.before === 'FOR_VERIFICATION' && move.after === 'IN_PROGRESS') {
      return {
        remarks: row.note ?? '',
        byName: row.actorName ?? row.actorEmail ?? '',
        at: row.createdAt.toISOString(),
      };
    }
  }
  return null;
}

/** The actor is stored on the row itself: welinc-auth id, email, name and role at write time. */
export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    type: row.action,
    at: row.createdAt.toISOString(),
    actor:
      row.actorUserId || row.actorEmail
        ? {
            id: row.actorUserId,
            name: row.actorName ?? row.actorEmail,
            email: row.actorEmail,
            role: row.actorRole,
          }
        : null,
    ticket: {
      id: row.repairTicket.id,
      repairNumber: row.repairTicket.repairNumber,
    },
    changes: readChanges(row.changes),
    note: row.note,
  };
}
