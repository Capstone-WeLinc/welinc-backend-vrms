import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { DOCUMENT_KINDS } from '../attachments/attachment-kinds';

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
  'MECHANIC_ASSIGNED',
  'ATTACHMENT_ADDED',
  'ATTACHMENT_REMOVED',
  'ATTACHMENT_MOVED',
  'TICKET_EDITED',
  'ISSUE_ADDED',
  'ISSUE_EDITED',
  'ISSUE_REMOVED',
  // Spec 0021
  'LOCKED',
  'STEP_CHECKED',
  'STEP_UNCHECKED',
  // Spec 0023
  'STEP_ADDED',
  'STEP_REMOVED',
  'STEP_EDITED',
  'STEP_MOVED',
  // Reserved: in the catalog so filters accept them, written by features 33 and 30
  'STATUS_OVERRIDE',
  'TRANSFER_REQUESTED',
  'TRANSFER_APPROVED',
  'TRANSFER_DECLINED',
  'TRANSFER_CANCELLED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Spec 0021, AC-7: the seven categories, in the order the catalog returns them. */
export const AUDIT_CATEGORIES = [
  'STATUS',
  'ASSIGNMENT',
  'EDITS',
  'COSTS',
  'FILES',
  'CHECKLIST',
  'KNOWLEDGE',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** A Record over the union, so a new type without a category is a compile error. */
export const AUDIT_CATEGORY: Record<AuditAction, AuditCategory> = {
  CREATED: 'STATUS',
  STATUS_CHANGE: 'STATUS',
  STATUS_OVERRIDE: 'STATUS',
  UNLOCK: 'STATUS',
  LOCKED: 'STATUS',
  MECHANIC_ASSIGNED: 'ASSIGNMENT',
  MECHANIC_UNASSIGNED: 'ASSIGNMENT',
  TRANSFER_REQUESTED: 'ASSIGNMENT',
  TRANSFER_APPROVED: 'ASSIGNMENT',
  TRANSFER_DECLINED: 'ASSIGNMENT',
  TRANSFER_CANCELLED: 'ASSIGNMENT',
  TICKET_EDITED: 'EDITS',
  ISSUE_ADDED: 'EDITS',
  ISSUE_EDITED: 'EDITS',
  ISSUE_REMOVED: 'EDITS',
  GARAGE_CHANGE: 'EDITS',
  COST_UPDATE: 'COSTS',
  ATTACHMENT_ADDED: 'FILES',
  ATTACHMENT_REMOVED: 'FILES',
  ATTACHMENT_MOVED: 'FILES',
  STEP_CHECKED: 'CHECKLIST',
  STEP_UNCHECKED: 'CHECKLIST',
  STEP_ADDED: 'CHECKLIST',
  STEP_REMOVED: 'CHECKLIST',
  STEP_EDITED: 'CHECKLIST',
  STEP_MOVED: 'CHECKLIST',
  KNOWLEDGE_LINK: 'KNOWLEDGE',
};

/** The category of a stored action, or null for one outside the catalog (AC-8). */
export function categoryOf(action: string): AuditCategory | null {
  // Own keys only: a stored name like "constructor" must not find an inherited member
  return Object.hasOwn(AUDIT_CATEGORY, action)
    ? AUDIT_CATEGORY[action as AuditAction]
    : null;
}

/** Spec 0021, AC-11: each category with its types, in AC-7 order. */
export function auditCatalog(canViewCosts: boolean) {
  return AUDIT_CATEGORIES.filter((c) => canViewCosts || c !== 'COSTS').map(
    (category) => ({
      category,
      types: AUDIT_ACTIONS.filter((a) => AUDIT_CATEGORY[a] === category),
    }),
  );
}

/**
 * Spec 0021, AC-3b: rows one action writes are stamped in write order, 1 ms apart from its `now`,
 * so the timeline order never depends on random ids.
 */
export function stampedAt(now: Date, index: number): Date {
  return new Date(now.getTime() + index);
}

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

/** A ticket's stored costs, as the cost event compares them. */
export function storedCosts(ticket: {
  partsCost: unknown;
  laborCost: unknown;
  totalCost: unknown;
  isLumpSum: boolean;
}): CostValues {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    partsCost: num(ticket.partsCost),
    laborCost: num(ticket.laborCost),
    totalCost: num(ticket.totalCost),
    isLumpSum: ticket.isLumpSum,
  };
}

/**
 * One row for the whole save, with every cost field that changed. The note is the unlock reason
 * when the save relocks an unlocked ticket (spec 0021, AC-1).
 */
export function costEvent(
  before: CostValues,
  after: CostValues,
  note: string | null = null,
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
    note,
  };
}

export function unlockEvent(reason: string): AuditEventData {
  return {
    action: 'UNLOCK',
    changes: [{ field: 'isUnlocked', before: 'false', after: 'true' }],
    note: reason.trim(),
  };
}

/** Spec 0021, AC-3: a relocking save closed an unlocked ticket again. */
export function lockedEvent(): AuditEventData {
  return {
    action: 'LOCKED',
    changes: [{ field: 'isUnlocked', before: 'true', after: 'false' }],
    note: null,
  };
}

export type ClosedTicketText = {
  remarks: string | null;
  cancellationReason: string | null;
};

/**
 * Spec 0021, AC-2: the TICKET_EDITED row for remarks and the cancel reason on an unlocked closed
 * ticket, listing only the fields that changed. `after` holds the trimmed sent value, or the
 * stored one when nothing (or only blank text) was sent. Null when nothing changed.
 */
export function closedTicketTextEvent(
  before: ClosedTicketText,
  after: ClosedTicketText,
  note: string | null,
): AuditEventData | null {
  const pairs: [keyof ClosedTicketText, string | null, string | null][] = [
    ['remarks', before.remarks, after.remarks],
    ['cancellationReason', before.cancellationReason, after.cancellationReason],
  ];
  const changes = pairs
    .filter(([, b, a]) => b !== a)
    .map(([field, b, a]) => ({ field, before: b, after: a }));
  return changes.length > 0 ? { action: 'TICKET_EDITED', changes, note } : null;
}

/**
 * Spec 0021, AC-4: a checklist step ticked or unticked. The step reads "2. Check brake fluid";
 * the issue and step ids ride as extras.
 */
export function stepTickEvent(
  checked: boolean,
  step: { id: string; position: number; text: string },
  issueId: string,
): AuditEventData {
  return {
    action: checked ? 'STEP_CHECKED' : 'STEP_UNCHECKED',
    changes: [
      {
        field: 'checked',
        before: String(!checked),
        after: String(checked),
      },
      { field: 'step', before: null, after: `${step.position}. ${step.text}` },
      { field: 'issueId', before: null, after: issueId },
      { field: 'stepId', before: null, after: step.id },
    ],
    note: null,
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

/**
 * Spec 0019, AC-12: one side of a mechanics save, the names removed (MECHANIC_UNASSIGNED) or
 * added (MECHANIC_ASSIGNED). A status move the save makes rides on the side that triggered it (M1
 * on the added row, M2 on the removed row, the spec 0016 pattern). The note is the reason on an
 * unlocked closed ticket.
 */
export function mechanicsChangedEvent(
  side: 'removed' | 'added',
  names: string[],
  move: { from: string; to: string } | null = null,
  note: string | null = null,
): AuditEventData {
  const added = side === 'added';
  return {
    action: added ? 'MECHANIC_ASSIGNED' : 'MECHANIC_UNASSIGNED',
    changes: [
      ...names.map((name) => ({
        field: 'mechanic',
        before: added ? null : name,
        after: added ? name : null,
      })),
      ...(move
        ? [{ field: 'repairStatus', before: move.from, after: move.to }]
        : []),
    ],
    note,
  };
}

/**
 * Spec 0019, AC-8: the details a ticket edit can change, as the audit row shows them. The driver
 * is "name (license)", the corporation its name, the rest their raw values.
 */
export type TicketDetailValues = {
  driver: string;
  odometer: number;
  priority: string;
  accountType: string | null;
  corporation: string | null;
};

/**
 * Spec 0019, AC-8: one row per details save, listing only the fields that changed. The note is the
 * reason on an unlocked closed ticket (AC-3).
 */
export function ticketEditedEvent(
  before: TicketDetailValues,
  after: TicketDetailValues,
  note?: string | null,
): AuditEventData {
  const pairs: [keyof TicketDetailValues, string | null, string | null][] = [
    ['driver', before.driver, after.driver],
    ['odometer', String(before.odometer), String(after.odometer)],
    ['priority', before.priority, after.priority],
    ['accountType', before.accountType, after.accountType],
    ['corporation', before.corporation, after.corporation],
  ];
  return {
    action: 'TICKET_EDITED',
    changes: pairs
      .filter(([, b, a]) => b !== a)
      .map(([field, b, a]) => ({ field, before: b, after: a })),
    note: note?.trim() || null,
  };
}

/** Spec 0019, AC-14: the stored description of the new issue, plus its id. */
export function issueAddedEvent(
  issueId: string,
  description: string,
  note: string | null = null,
): AuditEventData {
  return {
    action: 'ISSUE_ADDED',
    changes: [
      { field: 'issue', before: null, after: description },
      { field: 'issueId', before: null, after: issueId },
    ],
    note,
  };
}

/** Spec 0019, AC-15: the issue fields that changed (description, system, a cleared known fix). */
export function issueEditedEvent(
  issueId: string,
  changes: AuditChange[],
  note: string | null = null,
): AuditEventData {
  return {
    action: 'ISSUE_EDITED',
    changes: [...changes, { field: 'issueId', before: null, after: issueId }],
    note,
  };
}

/** Spec 0019, AC-16: what the removed issue said, so the record outlives the row. */
export function issueRemovedEvent(
  issue: {
    id: string;
    description: string;
    system: string | null;
    resolutionNote: string | null;
  },
  note: string | null = null,
): AuditEventData {
  return {
    action: 'ISSUE_REMOVED',
    changes: [
      { field: 'issue', before: issue.description, after: null },
      ...(issue.system
        ? [{ field: 'system', before: issue.system, after: null }]
        : []),
      ...(issue.resolutionNote
        ? [
            {
              field: 'resolutionNote',
              before: issue.resolutionNote,
              after: null,
            },
          ]
        : []),
      { field: 'issueId', before: null, after: issue.id },
    ],
    note,
  };
}

/** What an attachment event names: the file, its id and its kind (spec 0017, AC-18). */
export type AttachmentRef = {
  id: string;
  kind: string;
  kindLabel: string;
  fileName: string;
};

function attachmentChanges(file: AttachmentRef, added: boolean): AuditChange[] {
  const name = `${file.kindLabel}: ${file.fileName}`;
  return [
    {
      field: 'attachment',
      before: added ? null : name,
      after: added ? name : null,
    },
    // Extras ride in changes, the way KNOWLEDGE_LINK carries issueId
    { field: 'attachmentId', before: null, after: file.id },
    { field: 'kind', before: null, after: file.kind },
  ];
}

export function attachmentAddedEvent(file: AttachmentRef): AuditEventData {
  return {
    action: 'ATTACHMENT_ADDED',
    changes: attachmentChanges(file, true),
    note: null,
  };
}

export function attachmentRemovedEvent(file: AttachmentRef): AuditEventData {
  return {
    action: 'ATTACHMENT_REMOVED',
    changes: attachmentChanges(file, false),
    note: null,
  };
}

/**
 * Spec 0018, AC-9 and AC-18: a photo moved between Before and After. `kind` carries the move;
 * the file name with its group label and the id ride along like the add and remove events.
 */
export function attachmentMovedEvent(
  before: AttachmentRef,
  after: AttachmentRef,
): AuditEventData {
  return {
    action: 'ATTACHMENT_MOVED',
    changes: [
      { field: 'kind', before: before.kind, after: after.kind },
      {
        field: 'attachment',
        before: `${before.kindLabel}: ${before.fileName}`,
        after: `${after.kindLabel}: ${after.fileName}`,
      },
      { field: 'attachmentId', before: null, after: after.id },
    ],
    note: null,
  };
}

/**
 * Spec 0017, AC-16 and spec 0021, AC-12: the where fragment that hides document add and remove
 * events and COST_UPDATE rows from a caller without ticket.costs.view. Every reader that shows
 * rows to a person applies it. Null means nothing to hide.
 */
export function hiddenAuditEvents(
  canViewCosts: boolean,
): Prisma.AuditLogWhereInput | null {
  if (canViewCosts) return null;
  return {
    AND: [
      {
        NOT: {
          action: { in: ['ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED'] },
          // jsonb containment (@>): matches a changes element with this field and value
          OR: DOCUMENT_KINDS.map((kind) => ({
            changes: { array_contains: [{ field: 'kind', after: kind }] },
          })),
        },
      },
      { action: { not: 'COST_UPDATE' } },
    ],
  };
}

export const AUDIT_ROLES = [
  'ADMIN',
  'CHIEF_MECHANIC',
  'MECHANIC',
  'SYSTEM',
] as const;
export type AuditRoleFilter = (typeof AUDIT_ROLES)[number];

/**
 * Spec 0021, AC-9: the category, type and role filters. A row matches when its type is in `types`
 * or its category is in `categories`, expanded to one `action IN (...)` list. SYSTEM is the "no
 * actor" rule toAuditEvent uses. Null means no filter.
 */
export function auditKindFilter(
  categories: readonly AuditCategory[] = [],
  types: readonly AuditAction[] = [],
): Prisma.AuditLogWhereInput | null {
  if (categories.length === 0 && types.length === 0) return null;
  const actions = new Set<string>(types);
  for (const action of AUDIT_ACTIONS) {
    if (categories.includes(AUDIT_CATEGORY[action])) actions.add(action);
  }
  return { action: { in: [...actions] } };
}

export function auditRoleFilter(
  role: AuditRoleFilter | undefined,
): Prisma.AuditLogWhereInput | null {
  if (!role) return null;
  if (role === 'SYSTEM') return { actorUserId: null, actorEmail: null };
  return { actorRole: role };
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
  /** Spec 0021, AC-8: null for a stored action outside the catalog. */
  category: AuditCategory | null;
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

/**
 * How many STATUS_CHANGE rows, newest first, the rejection and return scans read. Hold moves are
 * the only rows between a send and a return, so a short window is enough.
 */
export const REJECTION_SCAN_ROWS = 20;

/**
 * Spec 0018, AC-14: when the ticket was last returned to the mechanic (M6, For verification to
 * In progress), or null. Unlike lastRejectionFrom it does not stop at a resend, so the mark on
 * photos added after the return stays once the ticket is sent again. Rows come newest first.
 */
export function lastReturnAt(
  rows: Pick<StatusRow, 'changes' | 'createdAt'>[],
): Date | null {
  for (const row of rows) {
    const move = readChanges(row.changes).find(
      (c) => c.field === 'repairStatus',
    );
    if (move?.before === 'FOR_VERIFICATION' && move.after === 'IN_PROGRESS') {
      return row.createdAt;
    }
  }
  return null;
}

/** The actor is stored on the row itself: welinc-auth id, email, name and role at write time. */
export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    type: row.action,
    category: categoryOf(row.action),
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
