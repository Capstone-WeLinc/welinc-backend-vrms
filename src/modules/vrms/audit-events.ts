import { BadRequestException } from '@nestjs/common';

// Spec 0003. Pure helpers for the audit timeline: keyset cursor and event shaping.

export type CostSnapshot = {
  partsCost: number | null;
  laborCost: number | null;
  total: number | null;
  isLumpSum: boolean;
};

export type AuditActor = {
  id: string | null;
  name: string | null;
  email: string | null;
};

export type AuditEvent = {
  id: string;
  type: string;
  at: string;
  actor: AuditActor | null;
  ticket: { id: string; repairNumber: string };
  status?: { from: string | null; to: string };
  cost?: { from: CostSnapshot | null; to: CostSnapshot | null } | null;
  unlockReason?: string;
  garage?: { from: string | null; to: string | null };
  rawAction: string;
};

export type AuditRow = {
  id: string;
  action: string;
  userId: string | null;
  email: string | null;
  previousValue: string | null;
  newValue: string | null;
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

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The cost writer stores ₱0 as null, so a missing amount reads as 0.
// The old snapshot never stored a total or lump sum flag.
export function parsePreviousCost(value: string | null): CostSnapshot | null {
  const json = parseJsonObject(value);
  if (!json) return null;
  const partsCost = toNumber(json.partsCost) ?? 0;
  const laborCost = toNumber(json.laborCost) ?? 0;
  return {
    partsCost,
    laborCost,
    total: partsCost + laborCost,
    isLumpSum: false,
  };
}

export function parseNewCost(value: string | null): CostSnapshot | null {
  const json = parseJsonObject(value);
  if (!json) return null;
  const partsCost = toNumber(json.partsCost) ?? 0;
  const laborCost = toNumber(json.laborCost) ?? 0;
  return {
    partsCost,
    laborCost,
    total: toNumber(json.totalCost) ?? partsCost + laborCost,
    isLumpSum: json.isLumpSum === true,
  };
}

export type ActorUser = { id: string; name: string; email: string };

/** Lookup key for an actor. audit_logs.user_id is the auth service's id, so actors match VRMS users by email. */
export function emailKey(email: string | null | undefined): string | null {
  const key = email?.trim().toLowerCase();
  return key ? key : null;
}

export function toAuditEvent(
  row: AuditRow,
  usersByEmail: Map<string, ActorUser>,
): AuditEvent {
  const key = emailKey(row.email);
  const user = key ? usersByEmail.get(key) : undefined;
  const event: AuditEvent = {
    id: row.id,
    type: row.action,
    at: row.createdAt.toISOString(),
    actor: key
      ? { id: user?.id ?? null, name: user?.name ?? null, email: row.email }
      : null,
    ticket: {
      id: row.repairTicket.id,
      repairNumber: row.repairTicket.repairNumber,
    },
    rawAction: row.action,
  };

  switch (row.action) {
    case 'STATUS_CHANGE':
      event.status = { from: row.previousValue, to: row.newValue ?? '' };
      break;
    case 'COST_UPDATE': {
      const from = parsePreviousCost(row.previousValue);
      const to = parseNewCost(row.newValue);
      event.cost = from || to ? { from, to } : null;
      break;
    }
    case 'UNLOCK':
      event.unlockReason = row.newValue ?? '';
      break;
    case 'SHOP_CHANGE':
      event.garage = { from: row.previousValue, to: row.newValue };
      break;
  }
  return event;
}
